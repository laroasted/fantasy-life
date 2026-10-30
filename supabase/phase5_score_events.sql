-- Phase 5: score change events (sidebar activity feed)
--
-- Feeds the Scoreboard sidebar's Activity card. Unlike score_history (one
-- row per member per category per DAY, a full snapshot), this is an
-- append-only log of individual nonzero score changes with a "cause" —
-- e.g. which ESPN team/record produced the delta — so the feed can read
-- as "Jordan +3.5 NFL — Chiefs (11-2)" instead of a bare number.
--
-- Written only by api/cron/update-sports.js for now (NFL/NBA/NHL/MLB/MLS —
-- the one cron where the old base, new base, and matched team/record are
-- all already in memory at write time). The other update-*.js crons
-- (college, country, entertainment, events, billboard, stocks) do not
-- write here yet; that's a deliberate follow-up, not an oversight — each
-- has a different "cause" shape and should be added one at a time.

create table if not exists public.score_events (
  id bigint generated always as identity primary key,
  season_year integer not null references public.seasons (year) on delete cascade,
  member_id text not null references public.members (id) on delete cascade,
  category text not null,
  delta numeric not null,
  cause text,
  source text not null,
  occurred_at timestamptz not null default now()
);

create index if not exists score_events_lookup
  on public.score_events (season_year, occurred_at desc);

alter table public.score_events enable row level security;

drop policy if exists "public can read score_events" on public.score_events;
create policy "public can read score_events"
on public.score_events
for select
to anon, authenticated
using (true);

-- No insert/update policy for anon/authenticated: update-sports.js writes
-- with the service role key, which bypasses RLS entirely.
