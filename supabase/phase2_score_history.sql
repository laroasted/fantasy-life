-- Phase 2: daily score history snapshots
--
-- Feeds the Trends tab (src/components/Trends.jsx). A new cron job
-- (api/cron/snapshot-scores.js) inserts one row per member per category
-- per day for the active season. Overall totals are summed client-side
-- from the per-category rows rather than stored separately.

create table if not exists public.score_history (
  id bigint generated always as identity primary key,
  season_year integer not null references public.seasons (year) on delete cascade,
  snapshot_date date not null,
  member_id text not null references public.members (id) on delete cascade,
  category text not null,
  base numeric not null default 0,
  bonus numeric not null default 0,
  total numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (season_year, snapshot_date, member_id, category)
);

create index if not exists score_history_lookup
  on public.score_history (season_year, snapshot_date);

alter table public.score_history enable row level security;

drop policy if exists "public can read score_history" on public.score_history;
create policy "public can read score_history"
on public.score_history
for select
to anon, authenticated
using (true);

-- No insert/update policy for anon/authenticated: the snapshot cron writes
-- with the service role key, which bypasses RLS entirely.
