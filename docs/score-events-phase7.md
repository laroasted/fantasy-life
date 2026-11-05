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

## Scope: being extended one cron at a time

`update-sports.js` (NFL/NBA/NHL/MLB/MLS), `update-college.js`
(NCAAF/NCAAB), and `update-events.js` (Tennis/Golf/F1) write to
`score_events` as of this pass. The remaining `update-*.js` crons
(country, entertainment, billboard, stocks) do not yet — each has a
different shape of "cause" data (stock price vs. chart position vs.
odds) and, for a few of them, doesn't even fetch the pre-update
base/bonus value yet (needed to compute a diff at all) — so wiring each
one up is still future work, one cron at a time, not a blocker for
shipping any of this.

### Extension: college + events (same session, follow-up pass)

Both crons were already structurally identical to `update-sports.js`'s
own diff pattern — same per-member loop, same pre-fetched `base`/`bonus`,
same `isFieldLocked` scheme — so extending them was close to a direct
copy of the diff block, not new design. The one thing worth doing
first: `buildScoreDigest()`/`scoreboardUrl()` were originally written
*inline inside* `update-sports.js`, the only caller at the time. Copying
~80 lines of that into two more files (and inevitably more crons after)
would mean the same digest-formatting bug fixed in one place silently
staying broken in the others. Extracted both, plus the "insert
score_events, send broad + per-member pushes" orchestration itself, into
one new shared function — `writeScoreEventsAndNotify(supabase,
scoreEvents, memberNameById)` in `api/_lib/push.js` — that every
score_events-writing cron now calls instead of reimplementing that
block. `update-sports.js` was refactored to call it too, so there's
exactly one copy of this logic, not one that happens to be first and two
copies that happen to match it today.

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
- revert the `scoreEvents` diffing block in `api/cron/update-sports.js`,
  `update-college.js`, and `update-events.js`, and the shared
  `writeScoreEventsAndNotify()`/`buildScoreDigest()`/`scoreboardUrl()`
  functions in `api/_lib/push.js`
- drop the `score_events` table in Supabase if you want it fully gone

No existing table, cron, or read path is modified.
