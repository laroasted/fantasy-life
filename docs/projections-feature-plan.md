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
