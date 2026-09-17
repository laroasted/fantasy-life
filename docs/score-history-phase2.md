# Score history phase 2

Adds a daily score-history snapshot so standings can be charted over time
(the Trends tab) instead of only ever showing a live snapshot.

## What changed

- New `score_history` table: one row per member per category per day.
- New cron `api/cron/snapshot-scores`, scheduled daily at 8am UTC (after the
  sports/college/events crons finish updating the day's scores).
- New "Trends" tab in the app, reading from `score_history`.

## How to configure

### 1. Apply the SQL migration in Supabase

Vercel's build only runs `npm run build` — it does not execute SQL files in
this repo, so `supabase/phase2_score_history.sql` must be applied manually,
the same way `supabase/phase1_commissioner_auth.sql` was applied for
commissioner auth.

Run `supabase/phase2_score_history.sql` in the Supabase SQL editor **before**
the `snapshot-scores` cron's first scheduled run. Until you do, the cron
will fail (table doesn't exist) and the Trends tab will just show its
"not enough history yet" empty state — nothing breaks, it just has nothing
to show.

### 2. No new environment variables

`snapshot-scores` reuses the same `SUPABASE_SERVICE_KEY` / `CRON_SECRET`
env vars the other cron jobs already use. Nothing else to configure.

## Verifying it worked

- Check the `snapshot-scores` cron's logs in the Vercel dashboard after its
  first scheduled run (8am UTC) — it should report how many rows it wrote.
- Or trigger it manually: `POST /api/cron/snapshot-scores` with the
  `Authorization: Bearer <CRON_SECRET>` header if `CRON_SECRET` is set.
- After 2+ days of successful snapshots, the Trends tab will start
  rendering a chart instead of its empty state.

## Rollback

This phase is additive and isolated:

- remove the "Trends" tab from `src/App.jsx`
- remove the `snapshot-scores` entry from `vercel.json`
- drop the `score_history` table in Supabase if you want it fully gone

No existing table, cron, or read path is modified.
