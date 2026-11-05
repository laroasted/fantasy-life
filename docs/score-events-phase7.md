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
(NCAAF/NCAAB), `update-events.js` (Tennis/Golf/F1), `update-billboard.js`
(Musician), `update-entertainment.js` (Actor/Actress), `update-stocks.js`
(Stock), and `update-country.js` (Country) write to `score_events` as of
this pass — every cron this table was ever meant to cover now does.

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

### Extension: billboard + entertainment + stocks (follow-up pass)

All three needed real thought, not a direct copy of the diff block:

- **`update-billboard.js`** (Musician) didn't fetch `base` from `picks`
  at all before this pass — only `bonus` — since base was never needed
  for anything else in the file. Added it to the `select()`. While doing
  that, found and fixed a pre-existing display bug: the rankings output
  showed `bonus` in place of `base` whenever base was locked, because
  there was nothing else (`r.base` didn't exist) to show there.
- **`update-entertainment.js`** (Actor/Actress) writes `base` in a
  *second pass*, after every pick's metric is computed and all picks are
  ranked — not inline in the per-pick loop the way sports/college/events/
  billboard do it. The diff had to move to that second loop, comparing
  the pre-fetched `matchingPick.base`/`bonus` against the final ranked
  value, and explicitly skip diffing when the actual DB write failed
  (distinct from a locked base, which is a legitimate no-op).
- **`update-stocks.js`** (Stock) deliberately diffs `base` only, never
  `bonus`. `bonus` is unconditionally reset to `0` every run whenever
  base isn't locked — there's no real Stock bonus mechanism behind it —
  so diffing it would generate a misleading "bonus −X" `score_events` row
  (and a push) on every single run that just resets a leftover value,
  not a real change. Confirmed with the user before building this rather
  than guessing at the intent.

### Extension: country (final pass)

`update-country.js` was deliberately left out of the previous pass — it
needed real design, not a copy of the diff block, because it has two
separate update loops in one run: GDP (writes `base`/`metric`, gated by
one combined `'gdp'` lock key) and Olympics (writes `bonus`/`bonus_note`,
gated by a different `'olympics.rank'` key, and only runs during Olympic
windows). Both got their own diff, in place, against the field they
actually write:

- **GDP** diffs `r.base` (pre-fetched) against the rank-based `r.newBase`
  computed earlier in the same loop, skipped when the shared `gdp` lock
  blocks the write. Cause text reuses the existing `recordLabel`
  (`"7.2% GDP"`) plus the rank: `"Germany (7.2% GDP, #3)"`.
- **Olympics** diffs the pre-fetched `pick.bonus` against `bonusPts`,
  skipped when `olympics.rank` is locked or the upsert/update failed.
  Cause text reuses the same medal-rank string already built for the
  `country_olympics` row and `bonus_note` (`"#2 by total medals (15)"`),
  factored into one `medalNote` variable so there's a single source for
  all three places it was previously duplicated inline.

The real design question wasn't the diffing itself — it's that Country is
the only category where **both** loops can produce a nonzero
`score_events` row for the *same member in the same run* (a GDP rank
shift and an Olympic medal shift landing together during an Olympic
window). Every other category writes at most one event per member per
run, so `writeScoreEventsAndNotify()`'s existing per-member grouping
(which already calls `sendPushToMember()` once per member regardless of
how many events they have that run) was never actually exercised with
more than one same-category event — meaning the real risk wasn't a
*second push* (that was already prevented), it was `buildScoreDigest()`'s
multi-event title claiming `"${name}: 2 categories updated"` when it's
truly one category, two mechanisms. Fixed in `buildScoreDigest()`
(`api/_lib/push.js`) by counting *distinct* categories in the member's
batch: when they're all the same one, the title names that category
(`"${name}: Country updated"`) and the body joins each event's own
`cause` text instead of the generic `"${category} ±${delta}"` parts
(which would otherwise literally repeat "Country" twice). The
multi-category branch is untouched — every other cron still hits it
exactly as before, since for them distinct-category count always equals
event count.

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
  `update-college.js`, `update-events.js`, `update-billboard.js`,
  `update-entertainment.js`, `update-stocks.js`, and `update-country.js`,
  and the shared `writeScoreEventsAndNotify()`/`buildScoreDigest()`/
  `scoreboardUrl()` functions in `api/_lib/push.js`
- drop the `score_events` table in Supabase if you want it fully gone

No existing table, cron, or read path is modified.
