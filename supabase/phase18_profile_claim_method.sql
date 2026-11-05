-- Phase 18: Persist how a member identity was claimed.
--
-- Groundwork for self-service draft picking (docs/live-draft-phase2.md's
-- "What's still step 2"). phase10's own migration comment flagged this in
-- advance: "revisit before Phase C (live draft) ever lets member_id gate
-- who's allowed to make a pick." The open self-claim gap it's talking
-- about is mostly closed by phase13's email map — but "mostly" is the
-- problem. The manual fallback picker (claim_member_identity, phase10)
-- is still open self-claim for any email that isn't in the map (a guest,
-- a changed email, someone added later). That's an acceptable risk for
-- tracking/push targeting, which is all it's gated today — it stops
-- being acceptable the moment a claimed member_id can submit a live
-- draft pick on someone's behalf.
--
-- Today this distinction (auto vs. manual) exists ONLY as a property on
-- the member_claimed Mixpanel event (AGENTS.md) — it's reported once at
-- claim time and never written to the database. There is nothing in
-- `profiles` a server-side RPC could check. This adds that column and
-- has both claim paths set it.
alter table public.profiles
  add column if not exists claim_method text check (claim_method in ('auto', 'manual'));

-- ── claim_member_identity (phase10, manual fallback) — now stamps 'manual' ──
create or replace function public.claim_member_identity(p_member_id text)
returns void
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_uid uuid := auth.uid();
  v_email text;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not exists (select 1 from public.members where id = p_member_id) then
    raise exception 'Unknown member_id: %', p_member_id;
  end if;

  if exists (
    select 1 from public.profiles
    where member_id = p_member_id and id <> v_uid
  ) then
    raise exception 'That member has already been claimed';
  end if;

  select email into v_email from auth.users where id = v_uid;

  insert into public.profiles (id, email, role, member_id, claim_method)
  values (v_uid, v_email, 'member', p_member_id, 'manual')
  on conflict (id) do update
    set member_id = excluded.member_id, claim_method = 'manual';
end;
$func$;

revoke all on function public.claim_member_identity(text) from public;
grant execute on function public.claim_member_identity(text) to authenticated;

-- ── auto_claim_member_identity (phase13, email-mapped) — now stamps 'auto' ──
--
-- Also retroactively backfills claim_method for anyone claimed BEFORE
-- this column existed: the function used to return early the instant
-- member_id was already set, with no reason to look at the email map
-- again. Now, on every sign-in, if claim_method is still null AND this
-- profile's existing member_id matches exactly what the email map says
-- it should be, it backfills 'auto' — safe, because it only ever
-- confirms a claim that was already correct by the map's own standard,
-- never changes which member_id is claimed. A profile whose claimed
-- member_id DOESN'T match the map (or isn't in the map at all) is left
-- alone, i.e. stays null/manual, which is the conservative, correct
-- outcome for an identity this file can't vouch for. No blind bulk-SQL
-- backfill guess needed — every real league member signs in again
-- naturally on draft day, which is all this needs to self-correct.
create or replace function public.auto_claim_member_identity()
returns text
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_mapped_member_id text;
  v_current_member_id text;
  v_current_claim_method text;
begin
  if v_uid is null then
    return null;
  end if;

  select lower(email) into v_email from auth.users where id = v_uid;
  if v_email is null then
    return null;
  end if;

  select member_id, claim_method into v_current_member_id, v_current_claim_method
  from public.profiles where id = v_uid;

  select member_id into v_mapped_member_id from public.email_member_map where email = v_email;

  if v_current_member_id is not null then
    if v_current_claim_method is null and v_mapped_member_id = v_current_member_id then
      update public.profiles set claim_method = 'auto' where id = v_uid;
    end if;
    return v_current_member_id;
  end if;

  if v_mapped_member_id is null then
    return null;
  end if;

  if exists (
    select 1 from public.profiles
    where member_id = v_mapped_member_id and id <> v_uid
  ) then
    return null;
  end if;

  insert into public.profiles (id, email, role, member_id, claim_method)
  values (v_uid, v_email, 'member', v_mapped_member_id, 'auto')
  on conflict (id) do update
    set member_id = excluded.member_id, claim_method = 'auto';

  return v_mapped_member_id;
end;
$func$;

revoke all on function public.auto_claim_member_identity() from public;
grant execute on function public.auto_claim_member_identity() to authenticated;
