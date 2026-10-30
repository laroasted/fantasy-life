# Projections — design & category-by-category automation plan

## Why this is harder than fantasy football

Every other fantasy app (ESPN, Yahoo, Sleeper) scores additively: your
players' points don't depend on what anyone else owns. **This league
doesn't.** Every category in `CATEGORY_ORDER` scores by *relative rank*:
`base = totalMembers - position`, with ties averaged
(`assignBasePointsWithTiebreaker` / `assignBasePointsWithTies`, duplicated
across every `api/cron/update-*.js` file). A pick's points depend on where
its underlying metric (win%, ranking points, chart weeks, BO×RT, GDP
growth) lands *relative to the other 11 picks in that category*, not on an
absolute scale.

That means a projection can't just sum "expected points" per member like a
football app does. The engine has to:

1. Project the underlying **metric** for every pick in a category (not the
   points).
2. **Re-rank** the projected metrics against each other.
3. Re-derive base points from that projected rank, using the exact same
   tie-averaging rule the real scoring crons use.
4. Add projected **bonus** separately — bonus events (win the Super Bowl,
   win a major, win an Oscar) are one-time binary outcomes, not a
   continuous metric, so they're modeled as expected value from a win
   probability, not from a trend line.

Locked fields are a fixed point, not a variable: once the commissioner
locks a `base`/`bonus`/`metric` field because the real outcome happened
(see `isFieldLocked` in `src/utils/helpers.js`), the projection must use
that locked value as-is, not simulate over it. Projecting something that
already happened is a bug, not a feature.

## Method: Monte Carlo, not a single point estimate

Per user decision, the engine runs **N=2,000 simulations per category**
per cron run. Each simulation draws a random "rest of season" outcome for
every pick (per the category-specific model below), computes that
simulation's rank-based base points + sampled bonus, and totals it. Across
all simulations we keep:

- `projected_base`, `projected_bonus_ev`, `projected_total` — the mean
- `p10` / `p50` / `p90` of `projected_total` — the spread, for a range band
  in the UI (this is the "surprises happen" part — a tight band means the
  outcome is close to locked in, a wide band means anything could happen)

This is intentionally more work than a deterministic estimate, because a
single number would misrepresent exactly the dynamic that makes this fun
(golf's done, basketball/hockey base points just started, a dozen majors
and awards shows are still live).

## Confidence tiers (per category) — what's real vs. what's a guess

| Category | Metric projection | Bonus EV source | Confidence |
|---|---|---|---|
| NFL/NBA/MLB/NHL/MLS | ESPN power index / BPI (`sports.core.api.espn.com/.../powerindex`) if reachable, else regression-to-mean extrapolation of current win% with binomial variance over games remaining | Kalshi/Polymarket championship market, found by **keyword search** (`"Super Bowl"`, `"NBA Finals"`, etc.) against `gamma-api.polymarket.com/events` and `external-api.kalshi.com/trade-api/v2/markets` — never a hardcoded ticker, since tickers change every season | **Medium** — ESPN's power-index endpoint and both markets are documented as public/free but were not live-reachable from this build sandbox (network policy blocks `sports.core.api.espn.com` and `gamma-api.polymarket.com` here); the parsing will very likely need the same kind of iteration the existing `update-sports.js`/`update-events.js`/`update-billboard.js` changelogs show once it runs on Vercel against real traffic |
| Tennis/Golf/F1 | Linear extrapolation of the picked athlete's own points-per-event rate × events remaining (ranking points are already a live cumulative metric, so this is closer to "continue the trend" than a true forecast) | Tennis: Kalshi/Polymarket keyword search for the remaining major. Golf/F1: **no bonusConfig** — Golf has no majors left this year; F1's real bonus rule is per-podium across 4 specific featured races (AUS/MIA/ATX/LV), not a season-championship market, so a generic "F1 champion" search would model the wrong event (caught live — see "Caught via live testing" below) | **Medium** for Tennis; Golf/F1 bonus is just the already-banked value held flat, deliberately not simulated further |
| Actor/Actress | TMDB upcoming-release discovery (reusing the existing `TMDB_API_KEY`) for titles releasing inside the remaining Fantasy Year window; box office is a wide log-normal band **anchored on the film's own disclosed TMDB budget** when a studio has registered one (median guess ≈ 2.2× budget — a rough industry rule of thumb, still a guess) and falls back to a flat $40M median otherwise; RT is centered on the actor's **own already-scored films this season** (`film_entries`, real data) rather than a flat number, falling back to a generic 55 only when they have no scored films yet | Polymarket "Academy Awards" market search, only ever populated close to the ceremony | **Low** — explicitly labeled as such in the stored record (`confidence: "low"`). Still a genuine guess, not a forecast — real signals (budget, own RT history) narrow and center the guess where available, they don't turn it into one. Don't let the UI present it with the same visual confidence as the sports numbers. |
| Musician | Decay-curve regression fit to the artist's **own already-cached** `billboard_weeks`/`music_songs` history (this is the one category where we already have months of real, collected data — no new external dependency) | Polymarket "Grammy" market search | **Medium-high for base** (real historical data), **low for bonus** (depends entirely on whether a Grammy market exists yet) |
| Country | None needed — `gdp_forecasts` is already a static twice-yearly commissioner-entered number (`update-country.js`), so the "projection" is just the current value with zero variance | Olympics bonus = 0 unless the season window contains an Olympics | **Deterministic** (correctly reflects that this number doesn't move intra-season) |
| Stock | **Explicitly not modeled as a projection.** Stored as `method: "trend_only"`, `confidence: "not_a_projection"` — an annualized extrapolation of the realized return so far, shown in the UI as a plain trend arrow, never a Monte Carlo band | n/a (category has no bonus) | **N/A by design** — I'm not building a fake-confident model for individual stock price movement. A trend line is fine; presenting it with the same visual weight as the sports simulations would be dishonest. If you want this changed, that's a product call, but I'd push back on it. |

## Schema (`supabase/phase5_projections.sql`)

- `projections` — one row per `pick_id` per cron run: `projected_metric`,
  `projected_base`, `projected_bonus_ev`, `projected_total`, `p10`, `p50`,
  `p90`, `method`, `confidence`, `source_detail` (free text — which odds
  market/endpoint it used, or why it fell back), `computed_at`.
- `projection_runs` — one row per cron invocation per category, for
  observability: `status`, `detail` (jsonb), mirroring the existing
  `data_refresh_triggered` analytics event's shape.

Both are append/upsert-only from the service-role cron, RLS-readable by
anon/authenticated — same pattern as `score_history` in
`phase2_score_history.sql`.

## Orchestrator: `api/cron/update-projections.js`

Runs after the category crons (reads their output), never writes to
`picks` — read-only with respect to real scores, exactly like
`snapshot-scores.js`. On any fetch failure for a given pick/category, it
degrades to `confidence: "unavailable"` and stores the *current* actual
value as the projection rather than guessing — it never fabricates a
number it couldn't source, the same rule the rest of this codebase
already follows (`validateAndCleanEntries` in `update-billboard.js`
rejecting a whole batch rather than writing garbage).

## UI

v1 ships as a **toggle on the existing Scoreboard "Overall" view**
(current vs. projected-final), per your call that it's the more common
fantasy-sports pattern and the lower-lift option. A dedicated "Projections"
tab with full per-category breakdowns (closer to how ESPN/Sleeper show
projected-vs-live side by side) is the natural fast-follow — same data,
just a second surface — and is **not built in this pass**; flagging that
explicitly rather than quietly dropping it.

## New Mixpanel events

- `projections_toggled` — `{ surface, is_enabled, season_year }`

Added to `src/utils/analytics.js`'s `EVENTS` object and this repo's
`AGENTS.md` event reference table per the existing "Adding a new event"
procedure.

## Known limitations / what I could not verify from this build

- Could not live-test ESPN's power-index endpoint, Kalshi's public API, or
  Polymarket's Gamma API from this sandbox — its network policy denied
  `sports.core.api.espn.com` and `gamma-api.polymarket.com` (confirmed via
  `$HTTPS_PROXY/__agentproxy/status`, which logged `connect_rejected`/403
  for both). Their existence and no-auth read access is confirmed from
  each provider's own current documentation, not from a live response I
  captured. The production Vercel functions have normal outbound network
  access (the existing crons already hit ESPN, TMDB, OMDB, Billboard,
  Jolpica successfully), so this should work there, but expect the same
  kind of iterate-after-deploy fixing visible in this repo's own cron
  changelogs.
- Actor/Actress box office and Musician unannounced-release risk are
  genuine guesses with wide uncertainty bands, not real forecasts — labeled
  `confidence: "low"` deliberately so the UI can (and should) visually
  de-emphasize them relative to the sports numbers.
- Stock is intentionally excluded from Monte Carlo projection. See table
  above.
- **Bonus EV models a single binary event** (win the title, or don't)
  against one odds market's probability. The real bonus schedule
  (`CATEGORY_BONUS_RULES`) pays out smaller tiers for a conference
  championship loss, a divisional loss, etc. — those smaller tiers
  usually add up to more total bonus points league-wide than the single
  championship does. This systematically understates projected bonus EV
  for every pick except the eventual champion/favorite. Flagged in
  `source_detail` as `bonus_ev_models_title_win_only` rather than left
  implicit. Fixing it properly needs either a per-round odds lookup (more
  unverified-shape surface area) or a structured points-per-round table
  to interpolate from title odds alone — future work.

## Caught in self-review before first deploy

A few bugs were caught and fixed by re-reading this file adversarially
before the first live run, worth recording so they don't quietly get
reintroduced:

- The championship-odds lookup was searching a betting market's outcome
  text for the **league member's name** (e.g. "LaRosa") instead of the
  **picked team's name** (e.g. "Kansas City Chiefs"). No market will ever
  mention a member's name, so this would have silently zeroed out every
  sport's bonus EV regardless of whether Kalshi/Polymarket were reachable
  — a correctness bug, not a reachability one. Fixed by threading
  `pickName` through every model builder and matching on that instead.
- The Monte Carlo rank→points conversion used the league-wide member
  count instead of `picks.length` for that specific category. Normally
  identical (everyone drafts every category), but it's the wrong
  semantic — the real scoring crons scale off how many picks actually
  exist in that category, not the roster size. Fixed to match.
- MLS records are `"W-D-L · X pts"` (three numbers) once ESPN's stats are
  available, but the games-played parser only looked for two
  dash-separated numbers, so it read the draw count as losses and
  undercounted games played. Fixed to handle both shapes.

## Caught via live testing against the real deploy

- **Bonus defaulted to zero, erasing already-earned points.** Every model
  builder set `bonusSampler: () => 0` as a placeholder meant to be filled
  in by the odds-lookup logic. When no odds match was found (which, per
  the first live run, is the common case — ESPN's power-index is
  unreachable from Vercel too, and Kalshi/Polymarket aren't confirmed
  matching yet either), that placeholder stayed at flat zero, discarding
  whatever bonus a pick had *already legitimately earned* — a playoff
  round already won, a major already won for an already-finished category
  like Golf, an Oscar/Grammy already decided. The user caught this
  immediately in the real projected numbers ("doesn't account for the
  bonus points that have already happened"). Fixed: the real default is
  now "hold already-recorded bonus flat," applied centrally in
  `runCategory` once `actualBonus` is known, never zero. When an odds
  match for the remaining title *is* found, it now adds the probability-
  weighted upside on top of that banked floor instead of replacing it
  outright.
- **F1's bonus config modeled the wrong event.** The user spotted a pick
  projecting 19.97 total — above what looked like a sane ceiling (12 base
  + 3 bonus = 15). Turned out the ceiling assumption was wrong, not the
  math: F1's real bonus rule (`CATEGORY_BONUS_RULES.F1`) pays per-podium
  across 4 specific featured races (AUS/MIA/ATX/LV), up to 12, not a
  single season-championship tier. The `bonusConfig` for F1 was searching
  "who wins the F1 championship" and capping upside at 3 — a plausible-
  looking config that modeled a completely different event than the
  league's actual rule. The already-banked bonus (8, in the flagged pick)
  was real and correctly held flat by the fix above; the mismatched
  "upside" layer on top of it just happened to clamp to 0 in that
  specific case, which is what made it look coincidentally sane. Fixed by
  removing F1's bonusConfig entirely (same treatment as Golf) rather than
  guessing at a correctly-scoped replacement market this build can't
  verify. Lesson: a plausible-sounding odds-market keyword isn't the same
  as checking the actual scoring rule it's supposed to represent.

## Second iteration — found by re-reading, not by another live run

User asked for the odds-matching to actually start working, not just stay
documented as unverified. Before touching anything live again, re-read
this file adversarially against what the rest of the repo already
documents, and found a real bug that fully explains why the first live
run's bonus-EV numbers never showed any probabilistic variance:

- **Team names were never de-prefixed before the odds-market search.**
  `update-sports.js` stores NFL/NBA/MLB/NHL/MLS picks as `"KC Chiefs"`,
  `"LAL Lakers"` — an abbreviation prefix plus name, specifically because
  ESPN's own team names don't carry it (that file has its own
  `stripPickPrefix()` for exactly this). This file was passing that raw,
  prefixed string straight into the betting-market match as the search
  term. `"kansas city chiefs"` does not contain `"kc chiefs"` as a
  substring — so the match could never have succeeded, regardless of
  whether Kalshi/Polymarket actually carry a Super Bowl market (they
  almost certainly do; these are high-volume, commonly-listed markets).
  This was a real logic bug provable from this repo's own documented data
  format, not a live-reachability question. Fixed by adding the same
  `stripPickPrefix()` pattern here and applying it to the two builders
  that need it (`buildWinPctModel`, `buildPointsRateModel`) — NCAAF/NCAAB
  and the individual-athlete/artist categories don't store a prefix, so
  they were never affected.
- **Artistic categories were upgraded from flat guesses to real-data-
  anchored guesses.** Actor/Actress box office now anchors its median on
  each upcoming film's own disclosed TMDB `budget` (when a studio has
  registered one) instead of a flat $40M for every film; RT now centers
  on the actor's own already-scored films this season (`film_entries`,
  fetched once per run) instead of a flat industry-wide 55 — the gap
  between what an earlier comment here claimed ("RT centered on the
  actor's own average") and what the code actually did, caught by
  re-reading the two against each other. Still genuinely low-confidence
  — narrowing a guess with real signals isn't the same as having a real
  forecast — but no longer ignoring data already sitting in the database.
- Musician's Grammy bonus and Country's GDP/Olympics bonus were checked
  too: both already correctly inherit from the "hold already-recorded
  bonus flat" fix, since whatever a commissioner has entered for either
  already flows through `pick.bonus`/`pick.metric`. No separate fix
  needed there.

## Third iteration — the prefix fix alone wasn't enough

A live run after the prefix fix still showed every sports bonus EV as a
flat whole number (MLB/NBA/NCAAB all checked) — the tell that none of
them carry any probability-weighted contribution, since `alreadyBanked +
probability × upside` is essentially never a round number. The prefix
bug was real and worth fixing, but something else is still blocking the
Polymarket match, and there was no way to tell *what* from this build —
could be no event found for the title search, an event found but no
market's question text matching the team name, an HTTP error, or a
genuinely malformed response.

Rather than guess again, `findPolymarketProbability` now returns a
specific failure reason instead of a bare null
(`no_events_matched_title(...)`, `N_events_M_markets_none_matched_outcome(...)`,
`http_NNN`, `fetch_error:...`), and the orchestrator records the first
one seen per category into `source_detail` as `odds_lookup:<reason>`.
The next live run will say exactly where this is breaking instead of
just confirming — again — that it is.

## Fourth iteration — the diagnostic paid off immediately

The instrumented run reported `odds_lookup:polymarket:
10_events_46_markets_none_matched_outcome(Broncos)` for NFL — a real
diagnosis, not a guess: the title search genuinely finds 10 real events
totaling 46 real markets (the query mechanics work end to end), but none
of them mention the team at all. 46 markets spread across 10 events is
too thin for the real ~32-team Super Bowl Champion market to be among
them — that alone would hold ~32 sub-markets. Most likely those 10 are a
grab-bag of anything with "Super Bowl" in the title (MVP odds, halftime
show, prop bets), and the real championship market either sorts outside
an unordered top-10 window or isn't literally titled with the search
phrase.

Changed the events query to sort by volume descending and widened the
window from 10 to 25 (the real championship market, being one of the
most heavily-traded contracts on the platform, should sort near the top
by volume if this assumption holds), and added `m.title` as a third
fallback field for a sub-market's question text in case the real field
name differs from the two already tried. Both changes are reasoned from
the diagnostic, not blind guesses, but still unverified against a live
response — this build still can't reach Polymarket directly. If the
next run's `marketsScanned` count jumps well past 46, the sort/window
fix helped even if the outcome still doesn't match, which would point at
the field-name guess as the next thing to check.

## Fifth iteration — the sort fix was right for the wrong reason

That run DID produce matches — NFL showed `odds_lookup:matched` with
plausible fractional bonus EV (0.3, 0.11, 1.14 — roughly 3%/1%/11%
championship-win probabilities). Looked like a clean win. A broader
check across MLB/MLS/NCAAB caught the real problem before calling it
done: all three — searching for "World Series", "MLS Cup", and "NCAA
Tournament" respectively, three *unrelated* terms — came back with the
exact same `25_events_1082_markets`. That's not survivable as a
coincidence; it means `order=volume&ascending=false` (undocumented for
Polymarket's `/events` endpoint specifically) silently breaks the
`title` filter entirely once added, falling back to an unfiltered
top-25-by-volume list across all of Polymarket. NFL and NBA only
"matched" because their championship markets are popular enough to
appear in that unfiltered list regardless — the right-looking answer for
the wrong reason, which would have shipped as a confirmed fix without
the second check.

Reverted `order`/`ascending`, kept the wider `limit=25` alone (an
independent change, not implicated by the identical-count evidence).
Re-verifying NFL/NBA still match through genuine per-category filtering
now, not through an unfiltered list they happened to be popular enough
to land in. Also worth remembering when reading the next result: MLB's
real World Series may already be over or concluding around this point in
the season, so a legitimate `no_events_matched_title` for MLB specifically
could mean "the active market genuinely doesn't exist anymore," not
"still broken" — season-end timing, not a bug, needs to be checked
before assuming either way.

## Sixth iteration — root cause confirmed live, not guessed

A follow-up check (removing order/ascending, keeping limit=25) found
MLB, NBA, and NFL *still* returning the identical event/market count
across three unrelated searches. That ruled out order/ascending as the
cause and pointed at something more fundamental: `/events?title=` was
likely never a real filter on this endpoint at all.

This build still can't reach Polymarket directly, but it has a separate
tool (Firecrawl's Alexandria integration) with its own network path that
can execute Polymarket's catalogued capabilities live. Used its
`search/query` capability directly — genuinely live, not a guess — and
it immediately surfaced the real problem and the real fix in one call:
querying `"Super Bowl Champion"` correctly found the current season's
actual championship market, titled **"Pro Football: 2027 Champion"**
(Polymarket avoids the NFL's trademarked "Super Bowl" name) — sharing
zero words with the query. `/events?title=` was doing literal substring
matching against event titles (if it was filtering at all); the real
search is full-text/semantic. That's the actual root cause of all three
earlier symptoms (no match, accidental match, identical counts) at once.

The same live call also confirmed, with real data, the exact field
names this file was already parsing: `question`, `groupItemTitle`,
`outcomes`, `outcomePrices` (JSON-encoded string arrays) on each event's
`markets[]` — e.g. `{"question": "Will the Arizona Cardinals win the
2027 NFL league championship?", "outcomes": "[\"Yes\", \"No\"]",
"outcomePrices": "[\"0.0015\", \"0.9985\"]"}`. The parsing logic was
never the problem — only event discovery was.

Fixed by switching to Polymarket's real search endpoint
(`gamma-api.polymarket.com/public-search`, with `q`, `limit_per_type`,
and `events_status=active` — params confirmed via the capability's own
documented contract, not guessed) in place of the broken `/events?title=`
filter. Kept a client-side `active !== false && closed !== true` filter
as a safety net in case the upstream `events_status` param doesn't
behave exactly as named. The question/outcome parsing code is unchanged
— it didn't need to be, now that it's confirmed correct against real
data.

This endpoint, these exact parameter names, and these field names are
now genuinely verified against a live response — not an educated guess
dressed up as one, unlike everything before this point in the file's
history. Still worth a live run to confirm it end to end, since the
*deployed* code path (plain `fetch()` from Vercel) hasn't itself been
exercised — only the equivalent call through Alexandria's own
infrastructure has.

## Seventh iteration — confirmed live, then closed the remaining gaps the same way

A live run confirmed the fix: NFL, NBA, MLB, and NHL all came back
`odds_lookup:matched` with sane, differentiated fractional bonus EV —
MLB's values clustering higher than NFL/NBA's makes sense too, since the
real World Series is likely underway right now, so most MLB picks
already have real banked bonus from earlier playoff rounds, unlike
NFL/NBA whose playoffs are still months off.

NCAAF, NCAAB, and MLS still weren't matching. Rather than guess at why,
used the same verified Alexandria technique again on each:

- NCAAF searched for "Ohio State" against 267 real markets, no match.
  Live check: the real market says **"Ohio St."** — AP-poll-style
  abbreviation, not the full word. A general pattern, not a one-off —
  should also fix Michigan State, Florida State, Penn State, etc.
- MLS searched for "LAFC" against a thin 31-market result, no match.
  Live check: the real market says **"Los Angeles FC"** — our pick
  storage uses the club's brand initialism, the market spells it out.
- NCAAB searched for "Connecticut", no match. Live check: the real
  market says **"UConn"** — not an abbreviation of "Connecticut" at
  all, a distinct name entirely.

Added a `nameVariants()` helper generating alternate search terms —
the general State→St. substitution, plus the two specific verified
aliases (LAFC, Connecticut/UConn) — tried alongside the original name
for every category (a harmless no-op for names that don't match any
pattern, e.g. "Chiefs"). This is explicitly NOT a comprehensive
team-alias table; it's the three mismatches actually found and
confirmed, not a guess at others that might exist. More will surface
the same way if/when they do — this technique (search live via
Alexandria for the exact pick name, read back the real question text)
is now the established way to resolve a stuck "none_matched_outcome"
diagnostic rather than guessing blind.

## Eighth iteration — one more MLS alias, same pattern as LAFC

A live run after the seventh-iteration fix confirmed NCAAF and NCAAB
now matching (Ohio St. and UConn aliases both worked). MLS still
failed, but on a different team: `1_events_31_markets_none_matched_
outcome(NYCFC)` — LAFC's own alias didn't help a different club's
initialism.

Same technique: queried Polymarket live via Alexandria for "MLS Cup"
and read the real market list (31 markets, one per club). The real
market says **"New York City FC"** — same brand-initialism pattern as
LAFC, a second MLS club whose pick is stored as a bare initialism that
doesn't appear as a substring of its spelled-out market name.

Also checked, while the full 31-market MLS list was in hand, whether
any *other* MLS picks in this league have the same problem — the
matching is a plain lowercase substring check, so a pick only needs an
alias when the pick string literally cannot be found inside the real
market question. Every other MLS pick seen so far (Inter Miami, LA
Galaxy, Red Bull → "New York Red Bulls", Sounders → "Seattle Sounders
FC", Atlanta → "Atlanta United FC", Columbus Crew, Philadelphia Union,
San Diego FC, Vancouver → "Vancouver Whitecaps FC") is already a
substring of its real market name, so none of those need an alias —
only bare initialisms like LAFC/NYCFC do. Added `'NYCFC': 'New York
City FC'` to `VERIFIED_NAME_ALIASES`. Still not a comprehensive
alias table — just the fourth confirmed mismatch. The same
read-the-diagnostic-then-verify-live loop applies to any future one.

## Ninth iteration — bonus went from "fractional EV" to "ranked into the
real bracket", and base now mirrors the real crons' own freeze windows

All 7 sports categories' odds matching confirmed working. User then
reviewed the actual projected numbers against what they know about each
category's real-world state and found a different, bigger class of
problem — not an odds-matching bug, a methodology gap:

1. **MLB was still projecting movement after the season was completely
   over.** BAL Orioles' base showed 5 (current) projecting to 9.14 — but
   the World Series had already concluded. Root cause: this file never
   checked whether a sport's real season was even still active before
   Monte-Carlo-simulating it. update-sports.js already freezes MLB's
   `activeMonths` to `[4,5,6,7,8,9]` (no October) for exactly this
   reason — base is final for the year — but update-projections.js had
   no equivalent check at all, so it kept projecting movement the real
   cron would never actually write.

2. **NBA/NHL bonus was still being probability-weighted after the real
   outcome was already known.** User's example: SA Spurs lost the NBA
   Finals (a fact, not a forecast) and should show bonus = 7 exactly, not
   7.65. Root cause, confirmed by re-reading update-sports.js's own FIX 4
   comment: NBA/NHL's `base` tracks the NEW season (their `activeMonths`
   = Oct–Feb) while `bonus` comes from the PRECEDING season's playoffs,
   which are always fully decided by the time that new-season window
   opens — "Bonus points are NEVER touched" by that cron at all; it's
   pure commissioner entry. So querying live odds for a fresh, unrelated
   future bracket and layering probability-weighted upside on top of an
   already-final number was actively wrong, not just redundant.

3. **The fractional-EV bonus model itself was the wrong shape for a
   single-elimination bracket.** Every pick's own win probability × the
   top prize understates the real favorite (their true win% is well
   under 100%) and spreads false credit across the whole field (everyone
   gets a sliver of a prize only one of them can actually win). User's
   own words: "take the most likely to win it all and slate them in to
   win all the Championship points (10) and the second most likely to be
   the Lose Finals bonus (7 points) and so on" — i.e. RANK the field by
   live win probability and slot it into the league's real bracket tiers
   (`CATEGORY_BONUS_RULES` in `src/constants/categories.js`: NFL/MLB/
   NBA/NHL/MLS all share the same 10/7/5/3/2 ladder — champion / lose
   finals / lose conf champ / lose round 2 / lose round 1).

4. **F1 had NO bonus model at all** (explicitly set to `bonusConfig:
   null` back in the seventh iteration, because a generic "wins the F1
   championship" search was the wrong event). But F1's real bonus rule
   (`CATEGORY_BONUS_RULES.F1`) is concrete and modelable: 3/2/1 points
   for 1st/2nd/3rd place in each of 4 SPECIFIC featured races (AUS, MIA,
   ATX/US, LV). User's example: Kimi Antonelli's 8 banked points (2nd
   AUS + 1st MIA + 1st US GP = 2+3+3) are correct and already reflect 3
   of those 4 races — but the 4th (Las Vegas) hasn't happened yet and
   he's a live favorite for it, and the projection showed zero credit
   for that.

5. **Tennis's bonus lookup was gated by the wrong calendar logic.**
   `remainingEventsThisMonth('Tennis')` read a generic "Grand Slams left
   this calendar year" table that goes to 0 every September–December —
   but this league's Tennis category has ONE specific target event, the
   Australian Open (`CATEGORY_METRICS.Tennis` is literally "Post
   Australian Open World Ranking Pts"; the category's own freeze date in
   update-events.js is Jan 31, right after the AO wraps). So the AO was
   always the real target, hadn't happened yet, and the gate was
   wrongly suppressing the lookup for it. User's example: Sinner
   (favorite) and Alcaraz (2nd favorite) should show 5 and 3 respectively
   ahead of the January AO; both showed 0.

### Fixes

- **`isSportBaseActive(league)`** — a direct duplicate of
  update-sports.js's own `ESPN_LEAGUES[...].activeMonths` table. When a
  sport's base is out of season, the category is routed through
  `runStatic` entirely (same deterministic path already used for
  Country/Stock) instead of `runCategory`'s Monte Carlo — base AND bonus
  both hold flat at the real actual values, full stop. This is what
  fixes MLB.
- **`bonusConfigFor(league)`** returns `null` for NBA/NHL specifically
  while `isSportBaseActive(league)` is true (their new-season base
  window) — no odds lookup attempted at all, bonus stays locked to
  whatever's already recorded. `source_detail` gets an explicit
  `bonus_locked:prior_season_already_decided` note rather than silently
  doing nothing.
- **`rankIntoTierBonus(models, probs, tierValues)`** — the new core
  bracket model. One search (`findMarketProbabilitiesForPicks`, see
  below) gets every pick's live win probability from the SAME market
  snapshot (not probability in isolation — rank only means something
  when everyone's compared against each other), ranks descending, and
  slots rank 1 into `tierValues[0]`, rank 2 into `tierValues[1]`, etc.
  Still respects the existing floor (`Math.max(actualBonus, tier)`) — a
  pick already eliminated with real banked points never gets projected
  below them just because they now rank outside the modeled tiers.
  Replaces `attachBonusSampler`'s fractional-EV approach for NFL/MLB (when
  in season)/NBA (off-season)/NHL (off-season)/MLS/Tennis.
  NCAAF/NCAAB/Actor/Actress/Musician are explicitly NOT moved to this
  model yet — their real bonus rules fork into separate named
  tiers/awards rather than one clean elimination bracket, so they stay on
  the old EV path (`bonusConfig.kind` left unset on their configs) as
  documented future work, not an oversight.
- **`findMarketProbabilitiesForPicks(titleKeyword, picksWithNameVariants)`**
  — does ONE search call per category instead of one per pick (the old
  `findChampionshipProbability` loop), returning a probability per pick
  id from the same event snapshot. Needed for ranking to be meaningful,
  and as a side effect cuts network calls for a 12-pick category from 12
  down to 1.
- **`addTierBonus(models, probs, tierValues)`** — same rank-into-tiers
  idea as `rankIntoTierBonus`, but ADDS the tier instead of taking the
  max, for a bonus that pays out independently more than once (F1's
  per-race podium bonus) rather than a single bracket with one eventual
  winner.
- **`applyF1FeaturedRaceBonus` / `F1_FEATURED_RACES`** — tries each of
  the 4 named races' own market in order. A race that's already run
  won't have an active Polymarket event anymore (resolved/closed), so
  this naturally finds only the race(s) still open without hardcoding
  exact 2026 race dates — the market's own active/closed state IS the
  "has this race happened yet" signal. Whichever race comes back live
  gets its podium tier added on top of the already-banked total.
- **Tennis's bonus config** switched from the old EV shape gated by
  `remainingEventsThisMonth` to `{ kind: 'tierLadder', titleKeyword:
  'Australian Open', tierValues: [5, 3, 2], mode: 'replace' }`, always
  attempted (no gate) — matches this category's real single-target-event
  design instead of a generic any-slam-this-year table.

### Known follow-up, not done this pass

- Tennis's BASE model (not bonus) still uses the old
  `remainingEventsThisMonth`-gated rate projection, which likely
  understates ranking-point growth September–December (ATP ranking
  points accumulate from non-major tournaments too, not just majors) —
  flagged but out of scope for this round, which was about bonus.
- NCAAF/NCAAB/Actor/Actress/Musician bonus still use the single-market
  fractional-EV model. NCAAF/NCAAB's real bonus rule forks into distinct
  named bowl games rather than one elimination bracket; Actor/Actress/
  Musician are award-nomination shaped, not a ranked field at all in the
  same sense. Both need their own dedicated design, not a drop-in reuse
  of `rankIntoTierBonus`.
- `findMarketProbabilitiesForPicks` (and `applyF1FeaturedRaceBonus`'s
  per-race searches) still don't normalize diacritics the way
  update-events.js's `normalizeStr` does for ESPN name matching — a
  driver/player name with an accent (not an issue for any example seen
  live so far) could fail to match a betting market's plain-ASCII
  question text. Same class of gap as the existing team-name-alias
  table: fix if/when a live diagnostic actually shows it, not guessed at
  in advance.

## Tenth iteration — two more live findings: one real data gap, one real
bug (caught by the user's own domain knowledge, not from a stack trace)

Live run after the ninth-iteration fix confirmed MLB/NBA/NHL all
correct (frozen flat for MLB, bonus locked for NBA/NHL with clean
whole-number values pulled straight from `picks.bonus`, base still
projecting). Two more things stood out:

**Tennis: confirmed no bug, a genuine data-availability gap.** Every
Tennis row came back `odds_lookup:no_active_events_matched_query
(Australian Open)`. Checked directly against Polymarket (two separate
searches, "Australian Open" and "Australian Open winner") rather than
assuming the code was at fault: the only "Australian Open"-tagged
events that exist right now are two stale, already-`closed: true`
match-level bets from the January 2026 tournament — there is no live
outright-winner futures market yet for the January 2027 edition, three
months out. The code's own client-side `active && !closed` filter
correctly excludes the stale ones, which is exactly why nothing
survived. This should resolve on its own once Polymarket actually lists
that market (typically closer to the event) — nothing to fix in this
file.

**F1: a real bug, and a more interesting one than a bad keyword match.**
User expected Kimi Antonelli — 8 points already banked, 2nd at AUS + 1st
at MIA + 1st at the US GP — to be the betting favorite for the
remaining Las Vegas GP and show meaningful added bonus. The live run
instead ranked Leclerc > Piastri > Antonelli (+3/+2/+1). Verified
directly against Polymarket's real Las Vegas GP markets rather than
trusting the ranking: the "Driver Podium Finish" and "Practice 3
Fastest Lap" events (both matched by the broad "Las Vegas Grand Prix"
title search) have the IDENTICAL price, `0.495` / `0.505`, for all 23
drivers — zero differentiation whatsoever, meaning the market has no
real trading volume yet (it's 3 weeks before the race). `rankIntoTierBonus`
and `addTierBonus` sort by probability, and JS's sort is stable — when
every value ties, the sort doesn't reorder anything, so the "ranking"
was silently just the database's own pick-insertion order, not a real
market read. Leclerc/Piastri/Antonelli landing on top was coincidence,
not a signal.

Fixed in `findMarketProbabilitiesForPicks` (shared by every tier-ladder
and F1 lookup, not just this one race): if every pick that matched a
market comes back with the exact same price, that's treated as "no real
signal" — same as no match at all — instead of letting a tie-order
artifact get reported as a ranking. `source_detail` now reports
`flat_untraded_market(all_matched_at_X)` for this case, distinct from
`none_matched_outcome`, so a future live run can tell "the market
exists but isn't priced yet" apart from "the market doesn't exist" or
"the name didn't match." This should also self-resolve as the Las Vegas
GP gets closer and real volume comes in — same open question as Tennis,
different mechanism (a market that exists but isn't priced yet, vs. one
that doesn't exist yet).

Both of these are documented as confirmed live findings, not guesses —
checked directly against Polymarket's real data via Alexandria before
concluding anything, per this file's established methodology.

## Eleventh iteration — Actor/Actress/Musician get real odds, and a
latent accumulation bug in addTierBonus is fixed before it could bite

Verified live (via Alexandria, same technique as every other odds
integration) that real, well-differentiated Polymarket markets exist
for all three remaining categories, contrary to the previous build's
assumption that only sports/Tennis had usable data:

- **Oscars 2027**: separate "Best Actor Winner", "Best Actor
  Nominations", "Best Actress Winner", "Best Actress Nominations"
  events (plus their own Supporting-category equivalents) all exist and
  are well-priced — e.g. Julianne Moore showed 74.5% to win / 96.85% to
  be nominated for Best Actress, nothing like the flat/tied F1 case.
- **Grammys 2027**: Album/Song/Record of the Year, Best Rap Album, and
  Best New Artist Winner markets all exist and are well-priced (e.g.
  Olivia Rodrigo 43% favorite for Album of the Year, Ella Langley 57.5%
  for Best New Artist). No Pop/Rock-album or nomination-only markets
  were found to exist right now — not modeled, rather than guessed at.

**A real cross-match risk, caught before it shipped, not from a live
test.** A loose search for "Best Actor Winner" also matches "Best
Supporting Actor Winner" (confirmed live) — the exact same class of bug
already found in the tenth iteration for F1's practice-lap vs podium
markets. Fixed by adding an optional `eventFilter` parameter to
`findMarketProbabilitiesForPicks` and excluding any event whose title
contains "Supporting" for the Oscar lookups.

**A real, structural bug in `addTierBonus`, also caught before it
shipped.** The function computed each pick's projected bonus as
`m.actualBonus + addition` — but `actualBonus` is a static field set
once at the start of `runCategory` and never updated afterward. F1's
`applyF1FeaturedRaceBonus` calls `addTierBonus` in a loop, once per
featured race; if more than one race's market had been open at the same
time, every call after the first would have silently DISCARDED the
earlier race's addition (overwriting `bonusSampler` from `actualBonus +
this_race_only`, not `running_total + this_race`). This never surfaced
in live testing because only one F1 race (Las Vegas) has ever been open
in a test run — but Grammy's 5-separate-market loop (`applyGrammyBonus`)
was certain to exercise exactly this path, since an artist can
realistically top more than one category's market in the same run.
Fixed by reading the running total from `m.bonusSampler()` (which
reflects whatever the previous call in the chain last set it to, or the
actualBonus-flat default on the first call) instead of the static
field. `rankIntoTierBonus` (used once per category, never chained) and
`combinedAwardTierBonus` (computes both its inputs in one pass, no
chaining) didn't need the same fix.

### New functions

- **`combinedAwardTierBonus`** — merges a WIN-market ranking (single
  most-likely pick gets the win tier) with a NOMINATION-market ranking
  (top `nomineeCount` most-likely picks each get the nomination tier)
  via `Math.max(actualBonus, winTier, nomTier)` — not additive, since a
  pick can't simultaneously be "nominated without winning" and "won" in
  the same category.
- **`applyOscarBonus(models, pastDeadline, awardLabel)`** — the Actor/
  Actress custom bonus applier, parameterized by `awardLabel` ("Best
  Actor" / "Best Actress") so one function serves both categories.
- **`addSingleWinnerTier`** — `addTierBonus` with a single-entry tier
  array; only the market's single most-likely pick gets credit, no 2nd/
  3rd place partial credit (Grammy categories don't have a runner-up
  tier, unlike Oscar nominations or a sports bracket).
- **`applyGrammyBonus`** — loops `GRAMMY_MARKETS`, adding each market's
  tier to whichever pick is that market's most-likely winner.

### Known follow-up, not done this pass

- Actor/Actress Supporting-category cross-nomination (CATEGORY_BONUS_
  RULES' 7/2 tiers) isn't modeled — only the Lead track. Rare enough in
  practice, and not verified live, to be worth guessing at.
- Musician's nomination-without-win tier (1 point) isn't modeled — no
  live nomination-only Grammy market was found to exist. Same honesty
  bar as everywhere else in this file: not guessed at blind.
- Actor/Actress/Musician picks haven't been live-tested against this
  league's actual stored names yet (unlike the sports team-name-alias
  cycle, which went through several real mismatches before settling).
  Expect the same kind of iterate-after-deploy name-matching fixes if a
  live run's `source_detail` shows `none_matched_any_pick` for a
  particular actor/artist whose stored name doesn't exactly match how
  Polymarket spells it.
