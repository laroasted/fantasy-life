-- Phase 10: Member accounts
--
-- Groundwork for "everyone has their own account": lets a regular league
-- member sign in with the same Google OAuth flow the commissioner already
-- uses (phase1_commissioner_auth.sql) and link that Supabase Auth identity
-- to one of the existing static member ids (adam, dhruv, marsh, ... — see
-- src/constants/members.js and the `members` table rows DraftTool.jsx
-- upserts on finalize). This is additive only: anonymous visitors and the
-- existing commissioner flow are untouched.
--
-- Deliberately NOT built in this pass: gating who is allowed to claim
-- which identity. signInWithGoogle() has no allow-list (see storage.js's
-- comment on that), so today any Google account that reaches this app's
-- URL could claim any unclaimed member_id. Acceptable for now — claiming
-- an identity only unlocks push targeting (phase B), nothing privileged —
-- but revisit before Phase C (live draft) ever lets member_id gate who's
-- allowed to make a pick. A cheap future fix: have the commissioner seed
-- profiles rows (or a one-time claim token per member) instead of open
-- self-claim.

alter table public.profiles
  add column if not exists member_id text references public.members (id) on delete set null;

-- Backstop against two simultaneous claims racing past the RPC's own
-- existence check below. Multiple NULLs are allowed under a unique index,
-- so unclaimed profiles (every profile today) are unaffected.
create unique index if not exists profiles_member_id_key
  on public.profiles (member_id)
  where member_id is not null;

-- Self-service claim, mirroring the unlock_paywall security-definer RPC
-- (phase3_paywalls.sql) — a tightly scoped function is how an otherwise
-- untrusted browser is allowed to write the one thing it's allowed to
-- write, instead of a raw RLS UPDATE policy on profiles (which would also
-- have to defend the `role` column from being self-escalated).
--
-- Upserts the caller's own profiles row so a brand-new member doesn't
-- need a commissioner to manually seed one first (unlike the commissioner
-- bootstrap note at the bottom of phase1_commissioner_auth.sql) — on
-- conflict it only ever touches member_id, never role, so it can't
-- downgrade or escalate an existing profile.
create or replace function public.claim_member_identity(p_member_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
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

  insert into public.profiles (id, email, role, member_id)
  values (v_uid, v_email, 'member', p_member_id)
  on conflict (id) do update
    set member_id = excluded.member_id;
end;
$$;

revoke all on function public.claim_member_identity(text) from public;
grant execute on function public.claim_member_identity(text) to authenticated;
