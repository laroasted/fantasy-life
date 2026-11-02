-- Phase 8: Realtime for the live scoreboard
--
-- Turns on Postgres logical replication for the two tables the frontend
-- needs to hear about without a manual Refresh click: `picks` (the actual
-- scores Scoreboard renders — a sport's `base`/`bonus`/`total` columns get
-- UPDATEd by api/cron/update-*.js on their own daily cron schedules, see
-- vercel.json) and `score_events` (the append-only activity-feed log,
-- INSERTed by api/cron/update-sports.js — see phase7_score_events.sql).
--
-- `score_history` and `calendar_events` are deliberately left out: both
-- only change once a day via snapshot-scores.js / are edited rarely by the
-- commissioner, and Trends/Calendar already re-fetch on every tab visit —
-- not worth a second always-open socket subscription for that cadence.
--
-- This is additive to existing RLS: Realtime still enforces each table's
-- row-level security policies per subscriber, so this doesn't widen who
-- can read what — it only lets rows already readable by anon under the
-- existing "public can read picks" (phase1_commissioner_auth.sql) and
-- "public can read score_events" (phase7_score_events.sql) policies push
-- to subscribers instead of waiting to be pulled.

alter publication supabase_realtime add table public.picks;
alter publication supabase_realtime add table public.score_events;
