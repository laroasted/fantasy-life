# Automated bonus scoring (F1, sports playoffs, majors)

Added 2026-11. Context: before this, every bonus number in `categories.js`'s
`CATEGORY_BONUS_RULES` was commissioner-only manual entry via Settings →
Scores & Bonus (a plain number input + free-text note per member per
category — see `SeasonSettings.jsx`). This automates three of those bonus
types from the same data vendors already trusted for base scoring. It does
**not** change how bonus is entered — it just means the automated crons now
also write to `picks.bonus`/`picks.bonus_note`, the same columns the manual
UI writes, respecting the same per-field locks.

## What's automated now

| Bonus | Where | Data source |
| --- | --- | --- |
| F1 featured-GP podiums (AUS/MIA/ATX/LV) | `api/cron/update-events.js` | Jolpica (`api.jolpi.ca`, Ergast-successor) |
| Tennis majors (win/final/SF) | `api/cron/update-events.js` | ESPN tennis scoreboard |
| Golf majors (win/runner-up/top 10) | `api/cron/update-events.js` | ESPN golf scoreboard + leaderboard |
| NFL/MLB/NBA/NHL/MLS playoff bracket round | `api/cron/update-sports.js` | ESPN team postseason schedule |
| Country Olympic medal rank | `api/cron/update-country.js` | ESPN Olympics medal table (pre-existing, unchanged) |

Still manual (deliberately, see the original brainstorm): Oscar/Grammy
win/nomination bonus, NCAAF/NCAAB bowl and tournament bonus, and the
"Most Pro Bowl / Most All-Star selections" sub-tier on NFL/MLB/NBA. The
NCAAF/NCAAB bowl bonus was already flagged as not worth automating in
`docs/projections-feature-plan.md` (named bowl games, not one bracket); the
All-Star sub-tier needs per-player roster data, a different shape of API
call than anything else here, for a bonus that only fires once a year.

## Evergreen by design — no hardcoded dates

Every one of these matches by **name** (a race name, a tournament name, a
playoff round's own label) or by **live API state** (does a postseason
bracket currently exist), never by assuming a sport's schedule falls on the
same week/month every year:

- **F1** (`FEATURED_GPS` in `update-events.js`): matches by `raceName`
  substring ("Australian Grand Prix", "Miami Grand Prix", "United States
  Grand Prix", "Las Vegas Grand Prix") against Jolpica's season race list,
  not by which round number or calendar week they land on.
- **Tennis/Golf majors** (`MAJOR_NAMES`): scans the whole current calendar
  year's ESPN scoreboard for an event whose name contains one of the 4
  major names per sport, rather than assuming e.g. "Wimbledon is always
  late June."
- **Sports playoff bracket** (`PLAYOFF_ROUNDS` in `update-sports.js`):
  classifies a completed postseason game by the round NAME ESPN attaches
  to it ("Wild Card", "Conference Championship", "Super Bowl", ...), not by
  week number or date. The gate for "should we even check" is "does ESPN's
  `seasontype=3` scoreboard return anything right now" — not a hardcoded
  month window — and deliberately omits ESPN's `season` query param
  entirely (see the comment on `fetchPostseasonExists`): this app's own
  `seasonYear` is already known (see `update-sports.js` FIX 4) to not line
  up with every sport's native season-year labeling, so guessing an offset
  risked silently querying the wrong year forever. Letting ESPN resolve
  "current" itself sidesteps that whole class of bug.

None of the three needs a yearly code edit when a race, a major, or a
playoff start date shifts.

## Confidence levels (read this before trusting a live run blindly)

This was built without live access to `site.api.espn.com` / `api.jolpi.ca`
from the build sandbox (network policy blocked both) — the API shapes below
rest on public documentation and this repo's own existing, already-proven
calls, not a verified live response for every endpoint added here.

- **High** — F1 featured-GP bonus. Jolpica's `/races.json` and
  `/{round}/results.json` shapes are long-documented, stable, and this repo
  already depends on the same family of Jolpica endpoint for base F1
  scoring.
- **High-moderate** — Golf majors. A single flat tournament leaderboard
  call per major; the one soft spot is the exact field ESPN uses for a
  golfer's finishing position (`fetchGolfMajorBonus` tries two candidate
  paths and regex-extracts a number from whichever resolves).
- **Moderate** — NFL/MLB/NBA/NHL/MLS playoff bracket. `seasontype=3` and
  the postseason-schedule-by-team endpoint shape are well-established ESPN
  API patterns; what's NOT verified live is exactly which field carries a
  round's display name for every sport, so `fetchTeamPostseasonGames`
  concatenates several candidate fields (event name/shortName, `week.text`,
  competition `notes[].headline`) and classifies against the combined text.
  NBA's "second round"/"semifinals" wording and whether MLS's postseason is
  queryable the same `seasontype=3` way as the other four are the two
  specific soft spots to check first.
- **Lowest** — Tennis majors. Unlike golf's one-leaderboard-per-tournament
  shape, ESPN's tennis scoreboard is one event per MATCH, so Final/SF exits
  are classified from free-text match labels the same way the sports
  bracket is — and that label shape is the least-verified piece in this
  whole change.

**On the first live run after this ships**, check the cron's logs/response
for each of the above, specifically:
1. Does `bonusDetected`/`rankings[].bonusDetected` (F1/Tennis/Golf) or
   `rankings[].bonusDetected` (sports) show up for a pick you know should
   have one by now?
2. Any `Could not classify playoff round from text: "..."` or similar
   warning — that's the raw text ESPN returned that didn't match a known
   keyword; it tells you exactly what to add to `PLAYOFF_ROUNDS`/
   `MAJOR_NAMES`'s keyword lists if a real result was missed.

## Safety: never overwrites a lock, never guesses

Every bonus write in this change follows the exact pattern the pre-existing
Olympics bonus in `update-country.js` already established:

- If `isFieldLocked(locks, category, owner, 'bonus')` is true, the bonus is
  never touched — a commissioner's manual correction always wins.
- If a pick's result can't be confidently classified (no matching round/
  major keyword found in whatever text the API returned, or the athlete
  name can't be resolved via the existing `matchAthlete`/`matchTeam`
  fuzzy-matching), nothing is written for that pick — whatever's currently
  in `bonus` (blank, or a manual entry) stays exactly as-is. It only ever
  writes a number it actually resolved from real data.
- Like base scoring elsewhere in this app, bonus is **recomputed fresh
  every run**, not incremented — so a team currently alive mid-playoffs
  shows the tier for the furthest round it has already survived, and that
  number updates automatically (and self-heals from a transient bad run)
  as it advances or gets eliminated, with no separate "did we already
  count this GP/round" bookkeeping needed.
