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
| Tennis/Golf/F1 | Linear extrapolation of the picked athlete's own points-per-event rate × events remaining (ranking points are already a live cumulative metric, so this is closer to "continue the trend" than a true forecast) | Same Kalshi/Polymarket keyword search, for the specific remaining major/race | **Medium** — same reachability caveat as above |
| Actor/Actress | TMDB upcoming-release discovery (reusing the existing `TMDB_API_KEY`) for titles releasing inside the remaining Fantasy Year window; box office modeled as a wide log-normal band with **no real forecast confidence** (there is no clean public API for pre-release BO forecasts); RT modeled as the actor's own historical mean | Polymarket "Academy Awards" market search, only ever populated close to the ceremony | **Low** — explicitly labeled as such in the stored record (`confidence: "low"`). This is a genuine guess dressed up as a wide band, not a forecast. Don't let the UI present it with the same visual confidence as the sports numbers. |
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
