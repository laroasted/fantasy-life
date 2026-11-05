-- Phase 19: Self-service draft picking — the roadmap's "step 2".
--
-- Everything through phase17 assumed exactly one writer (the
-- commissioner). The moment multiple members' own browsers can submit
-- picks, the existing pattern — client reads state, decides the new
-- state, pushes a full JSON patch via a plain UPDATE — stops being safe:
-- two clients can both read "it's Adam's turn, Lakers is open" and both
-- decide to write, corrupting picks/pick_history/current_pick. ESPN/
-- Sleeper-grade draft rooms don't solve this with clever client code;
-- they solve it by never letting the client decide the outcome. The
-- client expresses intent ("I want Lakers for NBA"); one locked,
-- server-side transaction decides whether that's legal and, if so,
-- applies it. These two functions are that transaction.
--
-- Two independent, deliberately redundant correctness mechanisms:
--   1. `for update` takes a row lock the instant the transaction starts
--      reading draft_sessions. If two picks land within milliseconds of
--      each other, Postgres makes the second WAIT for the first to
--      commit before it can even read the row — there is no window
--      where both see the same stale state. This is what actually
--      prevents corruption; it isn't optional.
--   2. The `current_pick != p_expected_pick` version check is redundant
--      with the lock for correctness, but gives a specific, nameable
--      error (stale_pick) instead of a confusing partial failure — that
--      distinction is what lets the client react correctly (silently
--      refetch) instead of showing a scary error for what's usually
--      just this client's view being one Realtime tick behind.
--
-- `security definer` + pinned `search_path` (same pattern as
-- claim_member_identity/unlock_paywall) is what lets an otherwise-RLS-
-- blocked non-commissioner browser make exactly this one write and
-- nothing else — the "commissioners can write draft_sessions" RLS
-- policy (phase14) still blocks any OTHER direct write from a
-- non-commissioner; only these two scoped functions bypass it, and only
-- for exactly what they implement. A short statement_timeout is set so
-- one stuck connection can never hold this lock, and therefore the whole
-- draft room, hostage.
--
-- last_notified_pick (below) is unrelated to picking itself — it backs
-- the notify-turn push dedup in api/push.js (Codex-caught, real finding:
-- the 15s updated_at freshness check there only bounds WHEN a call can
-- do anything, not how many repeated/concurrent calls land inside that
-- window, so without this a caller could flood the on-clock member's
-- device with duplicate "you're on the clock" pushes for the same turn).
alter table public.draft_sessions
  add column if not exists last_notified_pick int;

create or replace function public.submit_draft_pick(
  p_expected_pick int,
  p_category_id text,
  p_selection text,
  p_is_custom boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '3s'
as $func$
declare
  v_session record;
  v_result jsonb;
  v_is_commissioner boolean := public.is_commissioner();
  v_caller_member_id text;
  v_caller_claim_method text;
  v_on_clock_member_id text;
  v_new_current_pick int;
  v_new_status text;
begin
  select * into v_session from public.draft_sessions where id = 1 for update;
  if v_session is null then
    raise exception 'no_live_draft';
  end if;
  if v_session.status = 'complete' then
    raise exception 'draft_already_complete';
  end if;
  if v_session.current_pick != p_expected_pick then
    raise exception 'stale_pick';
  end if;

  v_on_clock_member_id := v_session.snake_order -> p_expected_pick ->> 'memberId';
  if v_on_clock_member_id is null then
    raise exception 'draft_already_complete';
  end if;

  if not v_is_commissioner then
    select member_id, claim_method into v_caller_member_id, v_caller_claim_method
    from public.profiles where id = auth.uid();

    if v_caller_member_id is distinct from v_on_clock_member_id then
      raise exception 'not_your_turn';
    end if;
    if v_caller_claim_method is distinct from 'auto' then
      raise exception 'claim_not_verified';
    end if;
  end if;

  if not p_is_custom and exists (
    select 1 from jsonb_each_text(v_session.picks) where value = p_selection
  ) then
    raise exception 'selection_already_taken';
  end if;

  -- Codex-caught, real: without this, a client that (bug or otherwise)
  -- calls this RPC with a category this exact member already has on
  -- their board silently OVERWRITES that earlier pick in `picks` (the
  -- `||` merge below just replaces the existing key) while still
  -- appending a new pick_history entry and advancing current_pick — the
  -- member ends up missing one category and double-counted in another,
  -- with pick_history showing more entries than the member actually has
  -- distinct categories for. availCats (DraftTool.jsx) already filters
  -- this out of the UI, but that's advisory only, the same way the
  -- now-server-revalidated selection_already_taken check used to be.
  if v_session.picks ? (v_on_clock_member_id || '-' || p_category_id) then
    raise exception 'category_already_picked';
  end if;

  v_new_current_pick := v_session.current_pick + 1;
  v_new_status := case
    when v_new_current_pick >= jsonb_array_length(v_session.snake_order) then 'complete'
    else 'drafting'
  end;

  update public.draft_sessions set
    picks = v_session.picks || jsonb_build_object(v_on_clock_member_id || '-' || p_category_id, p_selection),
    pick_history = v_session.pick_history || jsonb_build_array(jsonb_build_object(
      'pick', p_expected_pick,
      'memberId', v_on_clock_member_id,
      'categoryId', p_category_id,
      'selection', p_selection,
      'isCustom', p_is_custom,
      'madeAt', now(),
      'byCommissioner', v_is_commissioner
    )),
    current_pick = v_new_current_pick,
    status = v_new_status,
    -- Keeps the clock running for the next person instead of stopping —
    -- same reasoning as the existing client-side patches (DraftTool.jsx).
    -- timer_started_at left null, not a client-style guess: the phase16
    -- trigger stamps it with the server's own now() once this write
    -- actually commits.
    timer_active = true, timer_started_at = null, timer_remaining = v_session.timer_duration
  where id = 1
  -- Into v_result (jsonb), NOT v_session (record) — a Codex-caught bug
  -- in an earlier version of this function did exactly that, and
  -- `returning <single jsonb expression> into a record variable` makes
  -- plpgsql treat the result set as one column named "to_jsonb" and
  -- wrap it INTO that record's one field, rather than spreading the
  -- row's own columns across the record. A subsequent `to_jsonb(v_session)`
  -- then double-wraps it as {"to_jsonb": {...the real row...}} instead of
  -- the flat row DraftTool.jsx expects — it would have broken on the
  -- very first live pick (effective.snakeOrder.length throwing again,
  -- the same crash phase15 fixed for a different reason). Assigning
  -- straight into a plain jsonb variable avoids the ambiguity entirely.
  returning to_jsonb(draft_sessions.*) into v_result;

  return v_result;
end;
$func$;

revoke all on function public.submit_draft_pick(int, text, text, boolean) from public;
grant execute on function public.submit_draft_pick(int, text, text, boolean) to authenticated;

-- Commissioner-only, same as the undo button always was — but now
-- routed through the same locked-row pattern instead of a plain client
-- UPDATE. Concurrent undos were never possible (only one role can call
-- this), but a plain UPDATE built from the commissioner's own possibly-
-- stale local state could now race a DIFFERENT problem: a member's own
-- pick landing between the commissioner's last render and their Undo
-- click. The version check below catches exactly that — it refuses to
-- undo "pick N" if the row has already moved past N for a reason the
-- commissioner's screen hadn't caught up to yet.
create or replace function public.undo_last_draft_pick(p_expected_pick int)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '3s'
as $func$
declare
  v_session record;
  v_result jsonb;
  v_last jsonb;
begin
  if not public.is_commissioner() then
    raise exception 'not_commissioner';
  end if;

  select * into v_session from public.draft_sessions where id = 1 for update;
  if v_session is null then
    raise exception 'no_live_draft';
  end if;
  if v_session.current_pick != p_expected_pick then
    raise exception 'stale_pick';
  end if;
  if jsonb_array_length(v_session.pick_history) = 0 then
    raise exception 'no_picks_to_undo';
  end if;

  v_last := v_session.pick_history -> (jsonb_array_length(v_session.pick_history) - 1);

  update public.draft_sessions set
    picks = v_session.picks - ((v_last ->> 'memberId') || '-' || (v_last ->> 'categoryId')),
    pick_history = v_session.pick_history - (jsonb_array_length(v_session.pick_history) - 1),
    current_pick = v_session.current_pick - 1,
    status = 'drafting',
    -- Codex-caught, real: without this, undoing a draft's FINAL pick
    -- reactivates a current_pick value that's still stamped in
    -- last_notified_pick from the original "you're up" push sent before
    -- that pick was ever made (completing the draft skips updating this
    -- column — see api/push.js's handleNotifyTurn — so it's left
    -- pointing at exactly the pick index undo reverts back to). The
    -- player ends up back on the clock but the dedup check in
    -- handleNotifyTurn treats it as already-notified and sends nothing.
    -- Clearing it on every undo (not just this one edge case) is the
    -- simpler, fully correct fix: an undo always means the person now on
    -- the clock deserves a fresh notification, never a stale dedup hit.
    last_notified_pick = null
  where id = 1
  -- Into v_result (jsonb) — see submit_draft_pick's own comment on this
  -- same line for why NOT the record variable.
  returning to_jsonb(draft_sessions.*) into v_result;

  return v_result;
end;
$func$;

revoke all on function public.undo_last_draft_pick(int) from public;
grant execute on function public.undo_last_draft_pick(int) to authenticated;
