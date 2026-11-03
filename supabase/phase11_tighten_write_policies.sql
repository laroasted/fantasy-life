-- Phase 11: Close an open write-access gap found while shipping member
-- accounts (phase10).
--
-- Discovery (verified against this project's live pg_policies, not
-- assumed): every "Service write" policy in this database is actually
-- `to public using (true) with check (true)` for ALL commands — despite
-- the name, "public" is the Postgres role that means *everyone*,
-- including the anon key your frontend bundle ships to every visitor.
-- There has never been a database-level check that only the commissioner
-- can write to `seasons`/`members`/`picks` — the app's buttons being
-- disabled for non-commissioners was the only thing stopping a browser
-- console from writing to these tables directly. Independent of
-- everything else in this file, this also explains why DraftTool.jsx's
-- browser-side (anon-key) finalize writes to seasons/members/picks have
-- been working with zero RLS friction.
--
-- Two different fixes, because the tables fall into two different
-- categories:
--
-- 1. seasons / members / picks — DO have a legitimate authenticated
--    browser write path (commissioner-only UI actions: draft finalize,
--    season locks, paywalls). These get a real replacement policy below,
--    gated on a new is_commissioner() check.
--
-- 2. billboard_weeks / country_olympics / event_majors / film_entries /
--    music_grammys / music_songs / sport_rounds / stock_prices — per
--    AGENTS.md, every one of these is written only by cron jobs using the
--    Supabase service role key, which bypasses RLS entirely regardless of
--    policy content (service_role has BYPASSRLS). There is no browser
--    write path to any of these documented anywhere in this app. So the
--    fix is just to drop the bogus public-write policy — nothing needs to
--    replace it, because the only real writer was never subject to RLS in
--    the first place. (Moderate-high confidence, not certainty, that
--    none of these eight have a write path I haven't seen — if dropping
--    one of these breaks something, recreating `"Service write" ... to
--    public using (true) with check (true)` on just that table reverts
--    it instantly.)
--
-- score_events / score_history / projections / projection_runs /
-- calendar_events / push_subscriptions / profiles are untouched — they
-- never had a "Service write" policy to begin with (checked against the
-- same pg_policies query), so they were already correctly locked to
-- service_role-only writes.

-- ── is_commissioner(): mirrors getCommissionerRole()'s own OR logic ──
-- (configured email allow-list OR profiles.role), so tightening this
-- doesn't require the commissioner to have a profiles row already —
-- today they don't (see phase10's header comment), and this avoids
-- needing any sign-in-time sync step to keep that working.
--
-- commissioner_emails is a tiny reference table, not exposed to
-- PostgREST reads (RLS enabled, zero policies) — only this
-- security-definer function can see its contents, same shielding
-- pattern as claim_member_identity/unlock_paywall use for their own
-- privileged writes.
create table if not exists public.commissioner_emails (
  email text primary key
);

alter table public.commissioner_emails enable row level security;

create or replace function public.is_commissioner()
returns boolean
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
begin
  if v_uid is null then
    return false;
  end if;

  select lower(email) into v_email from auth.users where id = v_uid;

  if v_email is not null and exists (
    select 1 from public.commissioner_emails where email = v_email
  ) then
    return true;
  end if;

  return exists (
    select 1 from public.profiles
    where id = v_uid and role in ('commissioner', 'admin')
  );
end;
$$;

revoke all on function public.is_commissioner() from public;
grant execute on function public.is_commissioner() to authenticated;

-- ACTION REQUIRED: seed this with the exact same address(es) as your
-- Vercel REACT_APP_COMMISSIONER_EMAILS env var (comma-separated there,
-- one row each here), lowercased. This file intentionally does not
-- guess or hardcode your email — run this yourself with the real
-- value(s):
--
-- insert into public.commissioner_emails (email) values
--   ('you@example.com')
-- on conflict (email) do nothing;

-- ── 1. seasons / members / picks — replace the open policy with a real one ──
drop policy if exists "Service write" on public.seasons;
create policy "commissioners can write seasons"
on public.seasons
for all
to authenticated
using (public.is_commissioner())
with check (public.is_commissioner());

drop policy if exists "Service write" on public.members;
create policy "commissioners can write members"
on public.members
for all
to authenticated
using (public.is_commissioner())
with check (public.is_commissioner());

drop policy if exists "Service write" on public.picks;
create policy "commissioners can write picks"
on public.picks
for all
to authenticated
using (public.is_commissioner())
with check (public.is_commissioner());

-- ── 2. cron-only reference/cache tables — just remove the open policy ──
drop policy if exists "Service write" on public.billboard_weeks;
drop policy if exists "Service write" on public.country_olympics;
drop policy if exists "Service write" on public.event_majors;
drop policy if exists "Service write" on public.film_entries;
drop policy if exists "Service write" on public.music_grammys;
drop policy if exists "Service write" on public.music_songs;
drop policy if exists "Service write" on public.sport_rounds;
drop policy if exists "Service write" on public.stock_prices;
