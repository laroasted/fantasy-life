# Score events phase 7

Adds a sidebar "Activity" feed to the Scoreboard tab — a short list of
recent individual score changes with a reason attached ("Jordan +3.5 NFL —
Chiefs (11-2)"), distinct from the Trends tab's daily standings snapshot.

Numbered 7, not 5: this was developed in parallel with the Projections
feature, which merged to main first and took phase5/phase6
(`supabase/phase5_projections.sql`, `supabase/phase6_projection_notes.sql`).
The migration below was actually applied to Supabase under its original
`phase5_score_events.sql` filename before the collision was caught —
only the file's name changed, not the table or any column, so nothing
already run against Supabase needs to be redone.

## What changed

- New `score_events` table: append-only, one row per nonzero score change,
  with a `cause` string and `source` (which cron wrote it).
- `api/cron/update-sports.js` now diffs each pick's old base/bonus against
  its newly computed total and, if nonzero, logs a row — reusing data
  (matched ESPN team name, record) it already holds in memory for that
  pick, so this is a few extra lines per pick, not a new fetch.
- New `src/components/ActivityFeed.jsx`, mounted in `Scoreboard.jsx`'s
  sidebar below Category Leaders. Clicking an entry filters the scoreboard
  to that category, the same way clicking a Category Leaders row does
  (fires `EVENTS.CATEGORY_FILTER_CHANGED` with `surface: "scoreboard"`).
- Paywalled members: the entry still appears (member name, category,
  cause), but the delta number is blurred via the same `PAYWALL_BLUR_STYLE`
  the rest of Scoreboard.jsx uses, matching how Category Leaders handles a
  paywalled leader. This was a deliberate choice, not an oversight — a
  bare "event happened" with no number doesn't undercut the paywall the
  way a visible delta would.

## Scope: sports only, deliberately

Only `update-sports.js` (NFL/NBA/NHL/MLB/MLS) writes to `score_events` so
far. The other `update-*.js` crons (college, country, entertainment,
events, billboard, stocks) do not yet — each has a different shape of
"cause" data (stock price vs. chart position vs. odds), so wiring them up
is future work, one cron at a time, not a blocker for shipping this.

## How to configure

### 1. Apply the SQL migration in Supabase

Same process as `phase2_score_history.sql`: Vercel's build only runs
`npm run build`, it does not execute SQL files in this repo, so
`supabase/phase7_score_events.sql` must be run manually in the Supabase
SQL editor **before** `update-sports`'s next scheduled run (6am UTC) —
or already has been, if you applied it under its original
`phase5_score_events.sql` name; the table it creates is identical.
Until it's applied, `update-sports` will log a "Failed to write
score_events" line and otherwise run exactly as before — picks still
update normally, nothing breaks, the Activity card just shows its empty
state.

### 2. No new environment variables

Reuses the same `SUPABASE_SERVICE_KEY` / `SUPABASE_URL` env vars
`update-sports.js` already has.

## Verifying it worked

- Check `update-sports`'s cron logs in the Vercel dashboard after its next
  scheduled run — it should report `Wrote N score_events rows` (N can be
  0 on a day nothing moved).
- Or trigger it manually: `POST /api/cron/update-sports` with the
  `Authorization: Bearer <CRON_SECRET>` header if `CRON_SECRET` is set.
- The Scoreboard sidebar's Activity card should show entries after the
  first successful run with at least one nonzero delta.

## Rollback

Additive and isolated:

- remove `<ActivityFeed .../>` from `src/components/Scoreboard.jsx`
- revert the `scoreEvents` diffing block in `api/cron/update-sports.js`
- drop the `score_events` table in Supabase if you want it fully gone

No existing table, cron, or read path is modified.
