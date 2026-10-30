-- Phase 5: season-end projections
--
-- Feeds the Scoreboard "Projected Final" toggle. A new cron job
-- (api/cron/update-projections.js) runs a Monte Carlo simulation per
-- category and upserts one row per pick per run into `projections`.
-- `projection_runs` is an observability log, one row per category per
-- cron invocation — mirrors the shape of the data_refresh_triggered
-- analytics event so a failed/degraded category is easy to spot without
-- digging through Vercel logs.
--
-- Read-only with respect to `picks`/`seasons` — this job never mutates a
-- real score, only stores a projected one alongside it. See
-- docs/projections-feature-plan.md for the full per-category methodology
-- and confidence-tier writeup.

create table if not exists public.projections (
  id bigint generated always as identity primary key,
  pick_id bigint not null references public.picks (id) on delete cascade,
  season_year integer not null references public.seasons (year) on delete cascade,
  category text not null,

  -- Mean across the Monte Carlo simulations for this run.
  projected_metric numeric,
  projected_base numeric not null default 0,
  projected_bonus_ev numeric not null default 0,
  projected_total numeric not null default 0,

  -- Spread of projected_total across simulations — the "how locked in is
  -- this" band. p50 is the median, not necessarily equal to the mean
  -- above (projected_total is the mean; p50 is reported alongside it so
  -- the UI can show skew, e.g. a long tail from a single big bonus).
  p10 numeric,
  p50 numeric,
  p90 numeric,

  -- How this row was computed. See docs/projections-feature-plan.md for
  -- what each value means per category.
  method text not null,                -- 'monte_carlo' | 'static' | 'trend_only' | 'unavailable'
  confidence text not null,            -- 'high' | 'medium' | 'low' | 'deterministic' | 'not_a_projection' | 'unavailable'
  source_detail text,                  -- free text: which odds market/endpoint, or why it fell back
  simulations integer not null default 0,

  computed_at timestamptz not null default now(),

  unique (season_year, pick_id)
);

create index if not exists projections_lookup
  on public.projections (season_year, category);

alter table public.projections enable row level security;

drop policy if exists "public can read projections" on public.projections;
create policy "public can read projections"
on public.projections
for select
to anon, authenticated
using (true);

-- No insert/update policy for anon/authenticated: the projections cron
-- writes with the service role key, which bypasses RLS entirely — same
-- pattern as every other cron job's write path in this repo.

create table if not exists public.projection_runs (
  id bigint generated always as identity primary key,
  season_year integer not null references public.seasons (year) on delete cascade,
  category text not null,
  status text not null,                -- 'ok' | 'degraded' | 'skipped' | 'error'
  detail jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists projection_runs_lookup
  on public.projection_runs (season_year, started_at desc);

alter table public.projection_runs enable row level security;

drop policy if exists "public can read projection_runs" on public.projection_runs;
create policy "public can read projection_runs"
on public.projection_runs
for select
to anon, authenticated
using (true);
