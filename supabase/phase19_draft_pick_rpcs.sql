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
  returning to_jsonb(draft_sessions.*) into v_session;

  return to_jsonb(v_session);
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
    status = 'drafting'
  where id = 1
  returning to_jsonb(draft_sessions.*) into v_session;

  return to_jsonb(v_session);
end;
$func$;

revoke all on function public.undo_last_draft_pick(int) from public;
grant execute on function public.undo_last_draft_pick(int) to authenticated;
