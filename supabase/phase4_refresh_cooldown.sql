-- Phase 4: cooldown for the public "Refresh" button
--
-- api/refresh-all.js is intentionally open to any visitor (no auth gate —
-- see that file's header comment), but with no throttling a repeat-clicking
-- visitor or a bot could trigger the full cron run (external API calls +
-- Supabase writes) far more often than useful. last_full_refresh_at tracks
-- when that run last actually happened, so refresh-all.js can skip
-- re-running the crons if one completed too recently.

alter table public.seasons
  add column if not exists last_full_refresh_at timestamptz;

-- No RLS/RPC needed here: refresh-all.js reads and writes this column with
-- the service-role key (same as every cron job already does), never from
-- the browser, so it's not exposed to anon/authenticated at all.
