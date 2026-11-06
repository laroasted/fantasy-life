# Automated bonus scoring (F1, sports playoffs, majors, Oscars, Grammys, college bowls/tournament)

Added 2026-11. Context: before this, every bonus number in `categories.js`'s
`CATEGORY_BONUS_RULES` was commissioner-only manual entry via Settings →
Scores & Bonus (a plain number input + free-text note per member per
category — see `SeasonSettings.jsx`). This automates those bonus types from
real-world sources instead. It does **not** change how bonus is entered —
it just means the automated crons now also write to
`picks.bonus`/`picks.bonus_note`, the same columns the manual UI writes,
respecting the same per-field locks.

## What's automated now

| Bonus | Where | Data source |
| --- | --- | --- |
| F1 featured-GP podiums (AUS/MIA/ATX/LV) | `api/cron/update-events.js` | Jolpica (`api.jolpi.ca`, Ergast-successor) |
| Tennis majors (win/final/SF) | `api/cron/update-events.js` | ESPN tennis scoreboard |
| Golf majors (win/runner-up/top 10) | `api/cron/update-events.js` | ESPN golf scoreboard + leaderboard |
| NFL/MLB/NBA/NHL/MLS playoff bracket round | `api/cron/update-sports.js` | ESPN team postseason schedule |
| Oscar win/nomination (incl. Supporting) | `api/cron/update-entertainment.js` | English Wikipedia (ceremony article wikitext) |
| Grammy win/nomination (incl. Pop/Rock/Rap/New Artist) | `api/cron/update-billboard.js` | English Wikipedia (ceremony article wikitext) |
| Country Olympic medal rank | `api/cron/update-country.js` | ESPN Olympics medal table (pre-existing, unchanged) |
| NCAAB NCAA Tournament round (Round of 32 → Championship) | `api/cron/update-college.js` | ESPN team postseason schedule |
| NCAAF CFP round (First Round/Quarterfinal/Semifinal/Championship) + non-playoff bowl win | `api/cron/update-college.js` | ESPN team postseason schedule |

Still manual (deliberately): the "Most Pro Bowl / Most All-Star selections"
sub-tier on NFL/MLB/NBA. It needs per-player roster/selection data, a
different shape of API call than anything else here, for a bonus that's
worth only 1 point and fires once a year.

NCAAF/NCAAB bowl and tournament bonus were flagged as not worth automating
in an earlier pass (`docs/projections-feature-plan.md`, written against the
old pre-2024 two-bowl NCAAF system, where "BCS Bowl" really did mean an
arbitrary named list) — that reasoning doesn't hold in the 12-team CFP era.
The current `CATEGORY_BONUS_RULES.NCAAF` is now
`"10:Win Natl Champ | 7:Lose Natl Champ | 5:Lose Semi | 3:Lose QF | 2:Lose
1st Rd | 1:Win Other Bowl"` — every CFP round follows the exact same
furthest-round-reached pattern as NCAAB and the five sports in
`update-sports.js` (one tier per round regardless of whether that specific
game was won or lost; only the championship distinguishes a win from a
loss), with "Lose 1st Rd" explicitly scored this time (evergreen to a
future 16-team CFP expansion too, since this classifies by round NAME, not
bracket size). Only the "1:Win Other Bowl" tier (a team that missed the CFP
bracket entirely) is a flat game result rather than bracket depth, and
that's still gettable from the same per-team postseason schedule call. See
"NCAAF/NCAAB bowl & tournament bonus" below for the full design.

## Oscar/Grammy: Wikipedia, not Wikidata — and not `update-projections.js`

`update-projections.js` already had `applyOscarBonus`/`applyGrammyBonus`,
but those stay exactly what they are: a **pre-outcome probability estimate**
from Kalshi/Polymarket odds, feeding the Scoreboard's "Current / Projected
Final" toggle, and that cron remains explicitly read-only with respect to
`picks` — this change doesn't touch it, the `projections` table, or that
toggle at all. What's new here is the **post-outcome settlement** of the
real thing, a fully separate pipeline living in the base-scoring crons for
those categories (`update-entertainment.js` for Actor/Actress,
`update-billboard.js` for Musician) — same split already established
between "what might happen" (projections) and "what did happen" (real
`picks.bonus`) for F1/sports/majors above.

The source is the ceremony's own Wikipedia article's **wikitext**, fetched
live via `action=parse` on `en.wikipedia.org`'s API — deliberately not
Wikidata's structured "award received" statements, which lag real-time
editing of the article's own prose/tables by hours to days; Wikipedia's
winners table gets edited live during the broadcast. Evergreen lookup:
- **Grammy** (`resolveGrammyWikitext`): tries `"{year} Grammy Awards"` —
  this show's articles are titled by calendar year directly.
- **Oscar** (`resolveOscarWikitext`): tries `"{year} Academy Awards"`,
  relying on Wikipedia's own redirect to the real ordinal-numbered article
  (e.g. "98th Academy Awards") — since the Oscars aren't titled by year.

Both try the current year, then the prior year, and "has this ceremony
actually happened" is answered by whether a winner can be parsed out of the
page — live content state, not a hardcoded date — so this self-corrects
across the New Year boundary before a given year's ceremony has aired.

**Full bonus-rule coverage, not just what a market happened to list:** the
projections' market-based version explicitly skips Best Supporting
Actor/Actress (no Polymarket market found) and Best Pop/Rock Album (same
reason), even though both are real tiers in `CATEGORY_BONUS_RULES`. This
version isn't constrained by what a prediction market lists — Wikipedia has
every category's section regardless — so `OSCAR_CATEGORIES`/
`GRAMMY_CATEGORIES` cover the complete rule: both Leading and Supporting for
Oscars, and Album/Record/Song of the Year plus Pop/Rock/Rap/New Artist (all
at CATEGORY_BONUS_RULES's tier 3) plus the nomination-without-win tier for
Grammys.

**Parsing approach (live-verified 2026-11 against the 97th Academy Awards
and 2025 Grammy Awards articles' real wikitext — see the Confidence
section below for what changed and why):** categories on these pages are
NOT `==heading==` sections — a first version of this assumed they were,
and Codex's review on PR #55 caught that it silently never matched
anything. Each category is actually a
`{{Award category|color|[[Real Name|Display Name]]}}` template marker
inside a wikitable; `extractCategoryBlock()` finds that marker by keyword
and reads until the next one (or a table-row break, or a real heading).
Within that block, `extractWinnerAndNominees()` takes the first **bold**
(`'''...'''`) bulleted line as the winner and every other bulleted line as
a nominee candidate — bullet depth varies by category shape (Oscar acting
categories: one winner `*` + four nominee `**` lines; Grammy's "General
Field" categories: one `*` per nominee, each with its own producer/
engineer-credit `**` sub-line; Grammy's genre categories: one winner `*`
with every other nominee as a `**` beneath it), so nothing here assumes a
fixed depth. A song/album/film title or a producer's name landing in a
candidate list is harmless noise: `namesMatch()`/`artistMatches()` just
won't match it to the real person/artist being checked. One wrinkle
worth knowing: a winner's own credit sub-line (e.g. Grammy Song of the
Year's winner line is just the song title in quotes — the actual
songwriter/performer is named only on the `**` line beneath it) gets
merged into that winner's own candidate list rather than treated as a
separate nominee, specifically so that name isn't lost.
A person/artist's result is **summed across every distinct category**
they match — not a max, despite `CATEGORY_BONUS_RULES.Actor`/`Actress`/
`Musician`'s single-line phrasing initially reading like "whichever of
these applies." Caught by Codex's review on PR #55, which traced it to
this league's own historical record (`src/data/musician.js`): Bad
Bunny's real `bonus: 9` breaks down as `bonusNote: "AOTY win, ROTY nom,
SOTY nom"` = 7 (Album of the Year win) + 1 (Record of the Year nom) + 1
(Song of the Year nom); Kendrick Lamar's `bonus: 15` = 7 + 3 + 3 + 1 + 1
across 5 categories. Multi-category nominations are the norm, not the
exception, for the Grammys' "General Field" (every General Field nominee
is also cross-nominated in a genre category) and plausible, if rarer,
for Oscar dual Lead/Supporting nominations too — same rule applied to
both for consistency. Within a single category a win always replaces a
nomination, never double-counted, since a category's own winner is
excluded from its own nominee-candidate list.

## NCAAF/NCAAB bowl & tournament bonus

Lives in `api/cron/update-college.js`, rewritten file-local rather than
imported from `update-sports.js` — this repo's existing convention of one
copy of the playoff-bracket pattern per cron file, same as Oscar/Grammy's
file-local wikitext parser duplicated between `update-entertainment.js` and
`update-billboard.js`.

**NCAAB and NCAAF now share one resolver** (`computeBracketTier`, called
by both `computeNCAABTier` and `computeNCAAFTier`) — both brackets follow
the exact same furthest-round-reached semantics as the five sports in
`update-sports.js`: every round's tier is the same whether the team won or
lost that specific game, except the Championship, the only round where a
win and a loss differ (10 vs. 7). This wasn't true of an earlier version
of this change: the NCAAF bonus rule was initially read as giving the CFP
Quarterfinal its own win-vs-loss split (3 vs. 2), which turned out to be
based on the *old* pre-2024 two-bowl NCAAF rule text. The commissioner
corrected it once the 12-team CFP changed the real rule to
`"10:Win Natl Champ | 7:Lose Natl Champ | 5:Lose Semi | 3:Lose QF | 2:Lose
1st Rd | 1:Win Other Bowl"` — uniform depth-based tiers like NCAAB, with
the CFP's First Round now explicitly worth 2 (not 0, as a prior draft of
this rule and this code both had it) and no Quarterfinal win/loss split at
all. `CATEGORY_BONUS_RULES.NCAAF` in `categories.js` was updated to match,
and this should hold evergreen through a future 16-team CFP expansion too,
since classification is by round NAME, not by bracket size.

**NCAAF alone adds one fallback** `computeBracketTier` doesn't have: a team
whose last completed postseason game doesn't classify as a CFP round at all
missed the playoff bracket and played a plain non-playoff bowl game instead
— win → the "1:Win Other Bowl" tier, using the bowl's own name (ESPN's note
headline, e.g. "Pop-Tarts Bowl") as the label; loss → an explicit 0, not
left untouched. This fallback only fires when the game's text positively
does NOT contain "College Football Playoff" at all — a CFP game whose
round-name wording these keywords simply don't recognize returns null
(can't confidently classify) instead of guessing Other Bowl, a real bug
Codex's review on this PR caught in an earlier version that used
"didn't match any known CFP keyword" as the signal, which included both
cases.

**Round-name text, live-verified via Firecrawl** against the real,
completed 2025-26 CFP (Jan 2026) and 2025-26 NCAA Tournament (Mar–Apr
2026) ESPN scoreboard responses — not assumed from documentation:

- NCAAF: `"College Football Playoff First Round Game"` /
  `"College Football Playoff Quarterfinal at the <Bowl Name>"` /
  `"College Football Playoff Semifinal at the <Bowl Name>"` /
  `"College Football Playoff National Championship Presented by <Sponsor>"`
  — a non-playoff bowl's note is just its own sponsored name (e.g.
  `"Bucked Up LA Bowl"`), with no "College Football Playoff" prefix at all,
  which is exactly the signal `computeNCAAFTier` uses to fall through to
  the Other-Bowl branch.
- NCAAB: `"NCAA Men's Basketball Championship - <Region> - 1st Round"` /
  `"... - 2nd Round"` / `"... - Sweet 16"` / `"... - Elite 8"` /
  `"... - Final Four"` / `"... - National Championship"` (no region suffix
  on the last two).

**Team IDs come from a separate full-roster fetch (`fetchESPNTeams`), not
the AP rankings endpoint.** The AP Top 25 only lists ranked teams, and an
unranked team can still win (or lose) a bowl game — base scoring and bonus
resolution are deliberately decoupled: if the AP poll has no data yet
(preseason), base is skipped but bonus resolution still runs against the
full team list.

**Bonus resolution is gated per pick, not per day.** An earlier version
gated the whole per-team lookup on a single `fetchPostseasonExists` call to
ESPN's day-scoped `seasontype=3` scoreboard ("does today's slate have any
games") before spending the per-pick API calls. Codex's review on this PR
caught that this was fragile: both sports' scoreboard endpoint rejects a
`dates=YYYYMMDD-YYYYMMDD` range query (confirmed live — both return 400),
and NCAAB's scoreboard is day-granular (confirmed live; NCAAF's single-date
test happened to return a wide multi-week window, but that can't be relied
on when `dates` is omitted) — so a single gap day between rounds, routine
in both brackets, could make that gate report "no bracket" and skip an
already-decided result for a run or more. The gate was removed; bonus
resolution now runs every day for every pick, via `fetchTeamPostseasonGames`
directly, which only ever returns that team's own completed games and has
no day-granularity to miss. (The FCS-playoff-games/NIT-CBI concurrent-
bracket concern this gate used to filter with `groups=80`/`groups=100` is
moot now — a picked team is always an FBS or Division-I team, so matching
it to its own ESPN team ID and reading its own schedule never pulls in an
FCS or NIT game in the first place.)

Like `update-sports.js`'s playoff bonus, the old date-based freeze
(`isActive()`/`freezeDate` — Dec 9 for NCAAF, Mar 5 for NCAAB) only gates
the base/metric/record writes now, not the whole league — bowl season and
the NCAA Tournament both run for weeks past those dates, which exist for
AP-ranking freshness, not bonus eligibility.

No auto-lock was added for NCAAF/NCAAB in this pass — out of scope; bonus
stays commissioner-unlockable same as before until/unless that's asked for
separately.

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

- **NCAAF/NCAAB bowl & tournament bonus** (`update-college.js`): same
  round-NAME classification as the pro-sports bracket, resolved per pick
  from that team's own postseason schedule (never empty outside a real
  bracket) rather than any day-scoped or calendar-window check.

None of these needs a yearly code edit when a race, a major, a playoff
start date, or a bowl/CFP sponsor name shifts.

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
- **High** — Oscar and Grammy bonus. Upgraded from "moderate" after Codex's
  review on PR #55 caught that the first version's heading-based category
  matching never matched anything on either real page (there are no
  `==heading==` sections per category at all), which sent this through an
  actual live-data fetch (via Firecrawl, since `en.wikipedia.org` is
  blocked from this sandbox's own network) against the real 97th Academy
  Awards and 2025 Grammy Awards articles to find the true
  `{{Award category|...}}`-marker structure described above and confirm
  the rewrite resolves every one of the 11 tracked categories to the
  actual, correct real-world winner (Adrien Brody, Mikey Madison, Kieran
  Culkin, Zoe Saldaña, Beyoncé, Kendrick Lamar ×2, Sabrina Carpenter, The
  Rolling Stones, Doechii, Chappell Roan). `extractWinnerAndNominees()`
  only ever returns a winner when it finds one clean bold match; anything
  messier (a tie, a future markup change, a category this wasn't tested
  against) falls through to "could not resolve," logged and skipped,
  never guessed.
- **High** — NCAAF/NCAAB bowl & tournament bonus. Unlike the five
  pro-sports leagues above (built without live API access and resting on
  documentation), every NCAAF and NCAAB round-name string this classifies
  against was pulled live via Firecrawl from ESPN's actual completed
  2025-26 CFP and 2025-26 NCAA Tournament scoreboard responses and tested
  directly against the shared `computeBracketTier` resolver (via
  `computeNCAAFTier`/`computeNCAABTier`) with real win/loss cases for every
  round (including the now-uniform First Round, and a non-playoff bowl
  appearance both won and lost) — every case produced the exact point
  value the corrected `CATEGORY_BONUS_RULES.NCAAF` specifies.
  `fetchESPNTeams`'s team-list endpoint shape (`{id, name, displayName,
  abbreviation, location}` per team) was also confirmed live for both
  sports. Not exercised live: `matchTeam()` run end-to-end against this
  specific 700+/300+-team list for one of this league's real 12 picks —
  the matching logic itself is unchanged from the AP-rankings path already
  proven in production.

**On the first live run after this ships**, check the cron's logs/response
for each of the above, specifically:
1. Does `bonusDetected`/`rankings[].bonusDetected` (F1/Tennis/Golf) or
   `rankings[].bonusDetected` (sports) show up for a pick you know should
   have one by now?
2. Any `Could not classify playoff round from text: "..."` or similar
   warning — that's the raw text ESPN returned that didn't match a known
   keyword; it tells you exactly what to add to `PLAYOFF_ROUNDS`/
   `NCAAF_ROUNDS`/`NCAAB_ROUNDS`/`MAJOR_NAMES`'s keyword lists if a real
   result was missed. For NCAAF specifically, a real CFP result (First
   Round through Championship) should never fall through to the
   "Other Bowl" branch — `computeNCAAFTier` only does that when the text
   has no "College Football Playoff" prefix at all, so that branch firing
   for a team you know made the CFP means ESPN's wording changed in some
   way that broke even that prefix check, not just a round-keyword miss.
3. Any `Oscar: could not resolve winner for "..."` / `Grammy: could not
   resolve winner for "..."` warning, or a `"{year} ... has no resolvable
   winners yet"` log line right after a ceremony you know already aired —
   that means the heading-keyword match or the bold-text parse missed, and
   is the first place to look.

## Auto-lock (NFL/MLB/MLS/NBA/NHL)

Added right after the above. Once a league's season is decided, the cron
locks the relevant fields itself instead of waiting on the commissioner —
same `locks` mechanism and shape `SeasonSettings.jsx`'s manual lock button
already uses (`{at, by}`), just written by the cron with `by: 'auto'`.

Per `AUTO_LOCK_RULES` in `update-sports.js`:

| League | Locks `base` + `bonus` on | Locks `bonus` only on | Locks `base` only on |
| --- | --- | --- | --- |
| NFL / MLB / MLS | championship game complete | — | — |
| NBA / NHL | — | championship game complete | regular season ending |

NBA/NHL's `base` deliberately locks on a *different, earlier* trigger
(regular season end, detected the same way the bonus gate detects it — a
postseason bracket existing at all) than their `bonus` (the Finals/Cup),
because their `base` scoring is already for the *following* season by
design (see FIX 4 in that file) — it needs to stay unlocked and live right
through that next season, not get locked at the same moment their bonus
does.

**Fires once per league+field per season, not every run.** A separate
`seasons.auto_lock_fired` column (added in
`supabase/phase20_auto_lock_tracking.sql`) tracks whether a given
league+field has already auto-locked this season, independent of the
`locks` column's own content. This exists specifically so a commissioner
who manually unlocks something afterward to fix a mistake doesn't get
immediately fought by the next cron run re-locking it — and it's a
separate column rather than a marker key inside `locks` itself because
`SeasonSettings.jsx`'s Locks tab counts and lists every raw key in that
object (`"Locks (" + Object.keys(locks).length + ")"`), so a bookkeeping
marker stuffed in there would show up to the commissioner as a phantom
lock.

Locking only ever happens **after** that same run's own base/bonus writes
for the league — a just-decided championship's correct final value gets
written first, then locked, never the other way around (locking first
would make that same run skip writing the value the lock exists to
protect).

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
