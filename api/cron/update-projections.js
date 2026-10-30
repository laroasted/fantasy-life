/**
 * Fantasy Life — Season-End Projections
 *
 * Runs after the category crons (update-sports, update-events,
 * update-entertainment, update-billboard, update-country). Read-only with
 * respect to `picks` — never mutates a real score, only writes a
 * projected one into `projections`, same read-only relationship
 * snapshot-scores.js has with `picks`.
 *
 * WHY THIS ISN'T ADDITIVE FANTASY-FOOTBALL SCORING:
 * Every category here scores by RELATIVE RANK among the 12 picks
 * (totalMembers - position, ties averaged — see assignBasePointsWithTies
 * in update-sports.js and its siblings). So this file doesn't project
 * "expected points" per pick independently — it projects the underlying
 * METRIC for every pick in a category, re-ranks the projected metrics
 * against each other, and re-derives base points from that rank using the
 * exact same tie-averaging rule the real scoring crons use. Bonus points
 * are modeled separately as expected value from a win probability, since
 * they're one-time binary outcomes (win the Super Bowl, win a major), not
 * a continuous trend.
 *
 * METHOD: Monte Carlo (N_SIMS runs per category). See
 * docs/projections-feature-plan.md for the full per-category methodology,
 * confidence tiers, and — importantly — what could NOT be verified live
 * against real APIs from the build sandbox this was written in (ESPN's
 * power-index endpoint and both Kalshi's and Polymarket's public APIs are
 * documented as free/no-auth by their own current docs, but this file's
 * parsing has not been exercised against a live response; expect the same
 * kind of iterate-after-deploy fixing visible in update-sports.js's,
 * update-events.js's, and update-billboard.js's own changelogs).
 *
 * DEGRADATION RULE: if an external odds/power-index source can't be
 * reached or doesn't parse, this file NEVER invents a probability or
 * trend — it falls back to the simplest defensible model (current value
 * held flat, or a documented extrapolation) and records why in
 * `source_detail` + `confidence`. A locked field (commissioner already
 * entered the real outcome) is used as-is, never simulated over.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';

const N_SIMS = 2000;

// api/refresh-all.js calls this handler in-process after seven other data
// jobs — the whole chain shares one Vercel function's maxDuration. Every
// external call in this file (odds lookups, TMDB upcoming-release
// discovery) checks this budget first and skips straight to the
// no-data fallback once it's spent, rather than risking a timeout that
// kills the function mid-write for every remaining category.
const RUN_BUDGET_MS = 40000;

// ── Approximate regular-season game counts, for parsing "W-L" records
// into games-played / games-remaining. Approximate by design — this
// drives a Monte Carlo *variance* estimate, not a scoreboard number. ──
const SEASON_LENGTH = { NFL: 17, NBA: 82, MLB: 162, NHL: 82, MLS: 34 };

// Mirrors update-sports.js's ESPN_LEAGUES[...].activeMonths exactly — the
// real base-scoring cron freezes these months already (e.g. MLB goes
// frozen in October: the World Series is over and there's no regular
// season left to simulate). Projections has to agree with it instead of
// Monte-Carlo-projecting movement that cron would never actually write.
// Duplicated here rather than imported because these two files share no
// module today and this is a small, stable table — same tradeoff already
// made for isFieldLocked.
const SPORTS_ACTIVE_MONTHS = {
  NFL: [9, 10, 11, 12, 1],
  NBA: [10, 11, 12, 1, 2],
  NHL: [10, 11, 12, 1, 2],
  MLB: [4, 5, 6, 7, 8, 9],
  MLS: [4, 5, 6, 7, 8, 9, 10],
};
function isSportBaseActive(league, now) {
  const month = (now || new Date()).getMonth() + 1;
  return SPORTS_ACTIVE_MONTHS[league].includes(month);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════
// PURE MATH CORE — no network, no Supabase. Kept pure and exported-shape
// so it can be unit-tested with a seeded RNG independent of live data.
// ═══════════════════════════════════════════════════════════════════════

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

/**
 * NFL/NBA/MLB/NHL/MLS picks are stored with a leading abbreviation prefix
 * — "KC Chiefs", "LAL Lakers", "TB Lightning" (see update-sports.js's own
 * stripPickPrefix(), same regex, same reason: ESPN's team names don't
 * carry it). A betting market's question text says "Kansas City Chiefs",
 * which does NOT contain "kc chiefs" as a substring — so passing the raw
 * pick string into the odds-market match was a real bug, not just a
 * reachability question: it could never have matched regardless of
 * whether Kalshi/Polymarket actually carry these markets. Caught by
 * re-reading this file against update-sports.js's own documented data
 * format, not from a live response.
 */
function stripPickPrefix(pickName) {
  return (pickName || '').trim().replace(/^[A-Z]{2,4}\s+/, '');
}
function round2(x) { return x === null || x === undefined ? null : Math.round(x * 100) / 100; }

// Box-Muller — one standard-normal draw per call.
function gaussian(rng) {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
function sampleNormal(rng, mean, sd) { return mean + gaussian(rng) * Math.max(sd, 0); }

// Simulate `n` independent Bernoulli(p) trials, return count of successes.
function sampleBinomial(rng, n, p) {
  let successes = 0;
  for (let i = 0; i < Math.max(0, Math.round(n)); i++) if (rng() < p) successes++;
  return successes;
}

function percentile(sortedAsc, p) {
  if (!sortedAsc || sortedAsc.length === 0) return null;
  const idx = p * (sortedAsc.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

/**
 * The exact same tie-averaging rank→points rule used by every
 * update-*.js scoring cron (assignBasePointsWithTies / …Tiebreaker),
 * generalized to take pre-computed {key, metric} entries.
 * direction: 'desc' (higher metric = better, e.g. win%, points) or
 *            'asc'  (lower metric = better, e.g. golf world ranking).
 */
function rankToPoints(entries, totalMembers, direction) {
  const sorted = entries.slice().sort((a, b) => (direction === 'asc' ? a.metric - b.metric : b.metric - a.metric));
  const n = sorted.length;
  const out = {};
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && sorted[j].metric === sorted[i].metric) j++;
    let posSum = 0;
    for (let p = i; p < j; p++) posSum += (totalMembers - p);
    const avg = posSum / (j - i);
    for (let p = i; p < j; p++) out[sorted[p].key] = avg;
    i = j;
  }
  return out;
}

/**
 * Runs N Monte Carlo simulations for one category and returns per-pick
 * aggregates. `picks` each need: { id, currentMetric, lockedBase,
 * lockedBonus, lockedMetric, actualBase, actualBonus, deltaSampler(rng),
 * bonusSampler(rng) }.
 */
function simulateCategory(picks, totalMembers, direction, nSims, rng) {
  const totalsById = {}, baseSumById = {}, bonusSumById = {};
  picks.forEach((p) => { totalsById[p.id] = []; baseSumById[p.id] = 0; bonusSumById[p.id] = 0; });

  for (let s = 0; s < nSims; s++) {
    const entries = picks.map((p) => ({
      key: p.id,
      metric: p.lockedMetric ? p.currentMetric : p.currentMetric + p.deltaSampler(rng),
    }));
    const pointsByKey = rankToPoints(entries, totalMembers, direction);

    picks.forEach((p) => {
      const baseSim = p.lockedBase ? p.actualBase : pointsByKey[p.id];
      const bonusSim = p.lockedBonus ? p.actualBonus : p.bonusSampler(rng);
      const totalSim = baseSim + bonusSim;
      totalsById[p.id].push(totalSim);
      baseSumById[p.id] += baseSim;
      bonusSumById[p.id] += bonusSim;
    });
  }

  return picks.map((p) => {
    const arr = totalsById[p.id].slice().sort((a, b) => a - b);
    return {
      id: p.id,
      projectedBase: round2(baseSumById[p.id] / nSims),
      projectedBonusEv: round2(bonusSumById[p.id] / nSims),
      projectedTotal: round2(arr.reduce((a, b) => a + b, 0) / nSims),
      p10: round2(percentile(arr, 0.10)),
      p50: round2(percentile(arr, 0.50)),
      p90: round2(percentile(arr, 0.90)),
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════
// FREE ODDS SOURCES — best-effort, never throws, never fabricates.
// Polymarket's Gamma API is used as primary (its own docs show exactly
// this title-keyword search pattern: gamma-api.polymarket.com/events
// ?active=true&closed=false&title=<text>). Kalshi is attempted as a
// secondary source using only its documented-public /series and /markets
// endpoints — its sports-series tickers were NOT verified live from this
// build, so treat any Kalshi hit here as a bonus, not a guarantee.
// ═══════════════════════════════════════════════════════════════════════

async function fetchJsonWithTimeout(url, ms) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

/**
 * Same as fetchJsonWithTimeout but keeps the failure detail instead of
 * collapsing everything to null — used only where that detail matters
 * (the odds-market lookups below), not threaded through the other
 * callers of fetchJsonWithTimeout to keep this change's blast radius
 * small.
 */
async function fetchJsonDiagnostic(url, ms) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { Accept: 'application/json' } });
    if (!res.ok) return { ok: false, status: res.status, json: null };
    const json = await res.json().catch(() => null);
    return { ok: json !== null, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, json: null, error: err.message };
  }
}

/**
 * Finds a Polymarket event by title keyword, then returns the YES price
 * (0-1 probability) of whichever outcome's text contains `outcomeKeyword`.
 * Returns { prob: null, reason } instead of a bare null on failure — a
 * live test showed bonus EV staying flat across every sports pick even
 * after fixing the team-name prefix bug, and "no match" alone wasn't
 * enough to tell whether that's because Kalshi/Polymarket don't have
 * these markets, the title search found nothing, the request itself
 * failed, or a market was found but no outcome text matched. The reason
 * string answers that on the next live run instead of guessing again.
 *
 * A diagnosed run showed the title search for "Super Bowl" genuinely
 * finding 10 real events totaling 46 real markets — the query mechanics
 * work — but NONE of them mentioned the team being searched for. Tried
 * adding order=volume&ascending=false to surface the real championship
 * market, which DID produce matches for NFL/NBA — but a wider check
 * exposed why: MLB ("World Series"), MLS ("MLS Cup"), and NCAAB ("NCAA
 * Tournament") — three unrelated searches — all came back with the
 * EXACT same event/market count. order/ascending aren't documented for
 * this endpoint, and evidently break the title filter entirely once
 * added, silently falling back to an unfiltered top-N-by-volume list.
 * NFL/NBA only "matched" because their markets are popular enough to be
 * in that unfiltered list anyway, not because per-category search
 * actually worked — the right answer for the wrong reason. Reverted;
 * kept the wider limit (an independent, lower-risk change) without the
 * sort params.
 *
 * ROOT CAUSE, finally confirmed: /events?title= was never a real filter
 * on this endpoint at all — all three outcomes above (plain "no match",
 * "matched by accident", "identical counts across searches") were
 * symptoms of the same thing. The actual fix is below: Polymarket's real
 * full-text search endpoint, verified live (see this function's own
 * comment).
 */
/**
 * Generates alternate search terms for betting-market matching. Every
 * entry here is verified live via the same Alexandria technique used to
 * fix the search endpoint itself — not guessed:
 *   - College markets abbreviate "State" to "St." — the real Ohio State
 *     market literally says "Will Ohio St. Make the 2027 College
 *     Football Playoff National Championship Game?", not "Ohio State".
 *     A general pattern, not a one-off — should also cover Michigan
 *     State, Florida State, Penn State, etc.
 *   - LAFC's real market says "Will Los Angeles FC win the 2026 MLS
 *     Cup?" — our pick storage uses the club's brand initialism, the
 *     market spells it out.
 *   - UConn's real market says "Will UConn be a number 1 seed..." — not
 *     "Connecticut" at all, a distinct mismatch from the State/St.
 *     pattern (not an abbreviation of "Connecticut", a different name
 *     entirely).
 *   - NYCFC's real market says "Will New York City FC win the 2026 MLS
 *     Cup?" — same brand-initialism pattern as LAFC. (Other MLS brand
 *     abbreviations in this league's picks — e.g. "Red Bull", "Sounders",
 *     "Atlanta", "Vancouver" — are already substrings of their real
 *     market text, so they match via the plain includes() check below
 *     with no alias needed; only initialisms that DON'T appear inside
 *     the spelled-out name, like LAFC/NYCFC, require one.)
 * Not a comprehensive team-alias table — these are the four mismatches
 * actually found and confirmed so far, not a guess at others that might
 * exist. A no-op for any name that doesn't match one of these patterns.
 */
const VERIFIED_NAME_ALIASES = { 'LAFC': 'Los Angeles FC', 'NYCFC': 'New York City FC', 'Connecticut': 'UConn' };
function nameVariants(name) {
  const variants = [name];
  if (/\bState\b/i.test(name)) variants.push(name.replace(/\bState\b/i, 'St.'));
  if (VERIFIED_NAME_ALIASES[name]) variants.push(VERIFIED_NAME_ALIASES[name]);
  return variants;
}

async function findPolymarketProbability(titleKeyword, outcomeKeywords) {
  const candidates = Array.isArray(outcomeKeywords) ? outcomeKeywords : [outcomeKeywords];
  // VERIFIED live via Firecrawl's Alexandria integration (which has its
  // own network path, unlike this file's deploy target) — NOT the
  // /events?title= filter used before, which three separate live runs
  // proved doesn't actually filter anything. This is Polymarket's real
  // full-text search: querying "Super Bowl Champion" correctly found the
  // current season's actual market even though it's literally titled
  // "Pro Football: 2027 Champion" (Polymarket avoids the NFL's
  // trademarked term) — sharing zero words with the query. Confirmed
  // field names too: question/groupItemTitle/outcomes/outcomePrices on
  // each event's markets[] are exactly what this file already parses
  // below. events_status=active is Polymarket's own upstream filter
  // (confirmed via the capability's documented parameter list); the
  // active/closed check below is kept as a client-side safety net in
  // case that upstream param doesn't behave as named.
  const url = 'https://gamma-api.polymarket.com/public-search?events_status=active&limit_per_type=10&q=' + encodeURIComponent(titleKeyword);
  const res = await fetchJsonDiagnostic(url, 8000);
  if (res.error) return { prob: null, reason: 'fetch_error:' + res.error };
  if (!res.ok) return { prob: null, reason: 'http_' + res.status };
  const data = res.json;
  const allEvents = Array.isArray(data) ? data : (data && data.events) || [];
  const events = allEvents.filter((ev) => ev.active !== false && ev.closed !== true);
  if (!events || events.length === 0) return { prob: null, reason: 'no_active_events_matched_query(' + titleKeyword + ')' };

  const needles = candidates.map((k) => (k || '').toLowerCase()).filter(Boolean);
  let marketsScanned = 0;
  for (const ev of events) {
    const markets = ev.markets || [];
    for (const m of markets) {
      marketsScanned++;
      const question = (m.question || m.groupItemTitle || m.title || '').toLowerCase();
      if (!needles.some((n) => question.includes(n))) continue;
      try {
        const outcomes = JSON.parse(m.outcomes || '[]');
        const prices = JSON.parse(m.outcomePrices || '[]');
        const yesIdx = outcomes.findIndex((o) => String(o).toLowerCase() === 'yes');
        const price = yesIdx >= 0 ? parseFloat(prices[yesIdx]) : parseFloat(prices[0]);
        if (!isNaN(price)) return { prob: clamp(price, 0, 1), reason: 'matched' };
      } catch (e) { /* malformed market payload — skip, don't guess */ }
    }
  }
  return { prob: null, reason: events.length + '_events_' + marketsScanned + '_markets_none_matched_outcome(' + candidates.join('|') + ')' };
}

/**
 * Secondary/best-effort Kalshi lookup. Uses only the officially-documented
 * public endpoints (no API key). The series ticker guess is NOT verified
 * live — this is intentionally best-effort and silently returns null on
 * any shape mismatch rather than throwing. Not currently given a real
 * series ticker anywhere this file calls findChampionshipProbability
 * (kalshiSeriesGuess is always null), so this path is dead code until
 * someone has a verified ticker to pass in — kept because the function
 * itself is sound, just unfed.
 */
async function findKalshiProbability(seriesTickerGuess, outcomeKeyword) {
  const url = 'https://external-api.kalshi.com/trade-api/v2/markets?series_ticker=' + encodeURIComponent(seriesTickerGuess) + '&status=open&limit=100';
  const data = await fetchJsonWithTimeout(url, 8000);
  const markets = data && data.markets;
  if (!Array.isArray(markets) || markets.length === 0) return null;

  const needle = outcomeKeyword.toLowerCase();
  const match = markets.find((m) => (m.title || m.yes_sub_title || '').toLowerCase().includes(needle));
  if (!match) return null;
  const yesBid = typeof match.yes_bid_dollars === 'number' ? match.yes_bid_dollars : (match.yes_bid || 0) / 100;
  return isNaN(yesBid) ? null : clamp(yesBid, 0, 1);
}

/** Tries Polymarket then Kalshi; returns { prob, source, reason }. reason is only meaningful when prob is null. */
async function findChampionshipProbability(titleKeyword, outcomeKeyword, kalshiSeriesGuess) {
  const poly = await findPolymarketProbability(titleKeyword, outcomeKeyword);
  if (poly.prob !== null) return { prob: poly.prob, source: 'polymarket:' + titleKeyword, reason: null };
  if (kalshiSeriesGuess) {
    const kalshi = await findKalshiProbability(kalshiSeriesGuess, outcomeKeyword);
    if (kalshi !== null) return { prob: kalshi, source: 'kalshi:' + kalshiSeriesGuess, reason: null };
  }
  return { prob: null, source: null, reason: 'polymarket:' + poly.reason };
}

// ═══════════════════════════════════════════════════════════════════════
// ESPN power-index (best-effort; see docs/projections-feature-plan.md —
// not reachable from the build sandbox, so untested against a live
// response). Falls back cleanly to null on any failure.
// ═══════════════════════════════════════════════════════════════════════

const ESPN_SPORT_PATH = {
  NFL: 'football/nfl', NBA: 'basketball/nba', MLB: 'baseball/mlb',
  NHL: 'hockey/nhl', MLS: 'soccer/usa.1',
};

async function fetchEspnPowerIndex(league, year) {
  const path = ESPN_SPORT_PATH[league];
  if (!path) return null;
  const url = `https://sports.core.api.espn.com/v2/sports/${path}/seasons/${year}/types/2/powerindex?limit=100`;
  const data = await fetchJsonWithTimeout(url, 8000);
  const items = data && (data.items || data.athletes || data.teams);
  if (!Array.isArray(items) || items.length === 0) return null;
  // Shape intentionally not hard-coded further than "an array of items" —
  // real field names (projected win%, team ref) need confirming against a
  // live response before this is trusted as more than "source reachable".
  return items;
}

// ═══════════════════════════════════════════════════════════════════════
// PER-CATEGORY MODEL BUILDERS
// Each returns an array of per-pick simulation inputs for simulateCategory().
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parses games-played out of a record string. MLS records from
 * update-sports.js are "W-D-L · X pts" (three dash-separated numbers,
 * draws in the middle) when stats are available — a naive two-number
 * match would read the draw count as losses and undercount games
 * played. NFL/NBA/MLB are plain "W-L". NHL has no dash at all ("82
 * pts") and correctly falls through to null (caller's generic fallback).
 */
function parseRecordToGamesPlayed(record, league) {
  const str = record || '';
  const three = /(\d+)\s*-\s*(\d+)\s*-\s*(\d+)/.exec(str);
  const two = three ? null : /(\d+)\s*-\s*(\d+)/.exec(str);
  if (!three && !two) return null;

  let wins, losses, played;
  if (three) {
    wins = parseInt(three[1], 10);
    const draws = parseInt(three[2], 10);
    losses = parseInt(three[3], 10);
    played = wins + draws + losses;
  } else {
    wins = parseInt(two[1], 10);
    losses = parseInt(two[2], 10);
    played = wins + losses;
  }

  const total = SEASON_LENGTH[league];
  if (!total || played > total) return null;
  return { wins, losses, played, remaining: total - played };
}

/**
 * NFL/NBA/MLB — metric is win%. NHL/MLS — metric handled by points below.
 *
 * The ESPN power-index fetch below is reachability-only right now: its
 * response shape was never verified live (see file header), so its
 * values are NOT wired into deltaSampler — the model always runs the
 * binomial-on-current-win% calculation. The fetch is kept so
 * source_detail can record whether ESPN responded, as a signal for
 * whoever wires the real values in next, but sourceNote below
 * deliberately does NOT claim ESPN's numbers influenced this pick's
 * projection, because they don't yet.
 */
async function buildWinPctModel(picks, league, seasonYear, locks, ownerNameById, pastDeadline) {
  let espnItems = null;
  if (!pastDeadline || !pastDeadline()) {
    try { espnItems = await fetchEspnPowerIndex(league, seasonYear); } catch (e) { espnItems = null; }
  }
  const sourceNote = 'binomial_on_current_winpct' +
    (espnItems ? '(espn_power_index reachable but not yet wired into the model — reachability signal only)' : '(espn unreachable)');

  return picks.map((pick) => {
    const ownerName = ownerNameById[pick.member_id] || pick.member_id;
    const games = parseRecordToGamesPlayed(pick.record, league);
    const currentWinPct = Number(pick.metric) || 0;

    let deltaSampler;
    if (games && games.remaining > 0) {
      // Binomial model: remaining games are Bernoulli trials at the
      // current win rate, lightly shrunk toward .500 the fewer games
      // played so far (small-sample noise shouldn't fully carry forward).
      const shrinkWeight = clamp(games.played / (SEASON_LENGTH[league] * 0.3), 0, 1);
      const rateForRemaining = currentWinPct * shrinkWeight + 0.5 * (1 - shrinkWeight);
      const total = SEASON_LENGTH[league];
      deltaSampler = (rng) => {
        const winsRemaining = sampleBinomial(rng, games.remaining, rateForRemaining);
        const finalWinPct = (games.wins + winsRemaining) / total;
        return finalWinPct - currentWinPct;
      };
    } else {
      // No parseable record (frozen/offseason/unmatched) — hold flat with
      // a small generic volatility band rather than a confident model.
      deltaSampler = (rng) => sampleNormal(rng, 0, currentWinPct * 0.08);
    }

    return {
      id: pick.id,
      ownerName,
      pickName: stripPickPrefix(pick.pick), // the TEAM, not the member — this is what an odds market's outcome text matches against
      currentMetric: currentWinPct,
      actualBase: Number(pick.base) || 0, actualBonus: Number(pick.bonus) || 0,
      deltaSampler,
      bonusSampler: () => 0, // filled in by attachBonusSampler()
      sourceNote,
    };
  });
}

/**
 * NHL's record is always "N pts" (see update-sports.js — no dash, so
 * parseRecordToGamesPlayed always returns null for it). Rather than
 * falling through to a content-free fallback for the entire season,
 * approximate games-played from the calendar date against the NHL's
 * actual ~Oct 1 – Apr 15 regular-season window. Approximate by design,
 * same honesty bar as EVENTS_REMAINING_BY_MONTH below — this drives
 * Monte Carlo variance, not a displayed fact.
 */
function estimateNhlGamesPlayed(now) {
  const year = now.getFullYear();
  let start = new Date(year, 9, 1); // Oct 1
  if (now < start) start = new Date(year - 1, 9, 1);
  const end = new Date(start); end.setMonth(end.getMonth() + 7); // ~Apr 1, 7 months later
  const total = SEASON_LENGTH.NHL;
  const seasonMs = end - start;
  const elapsedMs = clamp(now - start, 0, seasonMs);
  const played = Math.round((elapsedMs / seasonMs) * total);
  return { played, remaining: total - played };
}

/** NHL/MLS — metric is cumulative points, not win%. Simpler linear-rate model. */
function buildPointsRateModel(picks, league, ownerNameById) {
  return picks.map((pick) => {
    const ownerName = ownerNameById[pick.member_id] || pick.member_id;
    const currentPoints = Number(pick.metric) || 0;
    let games = parseRecordToGamesPlayed(pick.record, league);
    let sourceNote = 'points_per_game_rate(parsed_record)';
    if (!games && league === 'NHL') {
      games = estimateNhlGamesPlayed(new Date());
      sourceNote = 'points_per_game_rate(date_estimated_games_played,approximate)';
    }

    let deltaSampler;
    if (games && games.remaining > 0 && games.played > 0) {
      const ptsPerGame = currentPoints / games.played;
      const meanDelta = ptsPerGame * games.remaining;
      // Points only accumulate (never decrease), so the sampled delta is
      // clamped non-negative — same convention as the win%-sports model.
      deltaSampler = (rng) => Math.max(0, sampleNormal(rng, meanDelta, meanDelta * 0.35));
    } else {
      deltaSampler = (rng) => Math.max(0, sampleNormal(rng, 0, Math.max(currentPoints * 0.1, 2)));
      sourceNote = 'fallback:generic_small_variance(no_games_data)';
    }

    return {
      id: pick.id, ownerName, pickName: stripPickPrefix(pick.pick), currentMetric: currentPoints,
      deltaSampler, bonusSampler: () => 0,
      sourceNote,
    };
  });
}

/** Tennis/F1 — ranking points, cumulative, project forward at the picked
 * athlete's own rate. Golf — world ranking POSITION, no majors left this
 * year per the league's own calendar, so held static (see design doc). */
const EVENTS_REMAINING_BY_MONTH = {
  // Rough, documented-approximate remaining-majors/races count by current
  // month — this drives simulation variance, not a displayed fact.
  Tennis: { 1: 3, 2: 3, 3: 2, 4: 2, 5: 2, 6: 1, 7: 1, 8: 1, 9: 0, 10: 0, 11: 0, 12: 0 },
  F1: { 1: 24, 2: 24, 3: 22, 4: 20, 5: 18, 6: 15, 7: 13, 8: 11, 9: 8, 10: 6, 11: 3, 12: 0 },
};

/**
 * Shared by buildRankingPointsModel (base projection) AND the handler's
 * category registration below (deciding whether to even attempt a
 * bonus-odds lookup). Tennis previously searched for a "remaining major"
 * bonus market unconditionally, even in months with zero majors left —
 * same class of bug as F1's mismatched bonus config, caught in the same
 * live-testing pass. No remaining events means no bonus-earning
 * opportunity left to model, not just a smaller one.
 */
function remainingEventsThisMonth(category) {
  const month = new Date().getMonth() + 1;
  return (EVENTS_REMAINING_BY_MONTH[category] || {})[month] ?? 0;
}

function buildRankingPointsModel(picks, category, ownerNameById) {
  const eventsRemaining = remainingEventsThisMonth(category);

  return picks.map((pick) => {
    const ownerName = ownerNameById[pick.member_id] || pick.member_id;
    const currentPoints = Number(pick.metric) || 0;

    if (category === 'Golf' || eventsRemaining === 0) {
      return {
        id: pick.id, ownerName, pickName: pick.pick, currentMetric: currentPoints,
        deltaSampler: () => 0, bonusSampler: () => 0,
        sourceNote: 'static:no_majors_remaining_this_year',
      };
    }

    // Approximate "events elapsed" from current points vs. a generic
    // per-event scale, just to get a per-event rate — not exact.
    const assumedEventsElapsed = category === 'F1' ? Math.max(1, 24 - eventsRemaining) : Math.max(1, 4 - eventsRemaining);
    const ratePerEvent = currentPoints / assumedEventsElapsed;
    const meanDelta = ratePerEvent * eventsRemaining;
    return {
      id: pick.id, ownerName, pickName: pick.pick, currentMetric: currentPoints,
      deltaSampler: (rng) => Math.max(0, sampleNormal(rng, meanDelta, meanDelta * 0.5 + 1)),
      bonusSampler: () => 0,
      sourceNote: 'fallback:points_per_event_rate,eventsRemaining=' + eventsRemaining,
    };
  });
}

/**
 * NCAAF/NCAAB — base metric is AP poll points (update-college.js), which
 * is a weekly voter-sentiment score, NOT a per-game accumulated stat —
 * it can go up OR down week to week, unlike win% or cumulative points.
 * So this gets a symmetric variance band around the current value
 * rather than the monotonic accumulation models above, and holds flat
 * (zero variance) once the regular-season AP poll freezes for the year
 * (see update-college.js's own freezeDate per league), since there's no
 * more poll movement left to simulate before bowls/tournament bonus
 * outcomes take over.
 */
const COLLEGE_FREEZE = { NCAAF: { month: 12, day: 9 }, NCAAB: { month: 3, day: 5 } };
function isPastCollegeFreeze(league, now) {
  const freeze = COLLEGE_FREEZE[league];
  const todayNum = (now.getMonth() + 1) * 100 + now.getDate();
  const freezeNum = freeze.month * 100 + freeze.day;
  // NCAAB's poll season spans the new year (Nov–Mar); only the Jan–Mar
  // stretch can be "past" its freeze date. NCAAF's poll season is
  // within one calendar year, so a plain numeric compare works, but
  // also treat the off-season months (Jan–Jul) as frozen since there's
  // no active poll to simulate movement in.
  if (league === 'NCAAB') return now.getMonth() + 1 <= 3 && todayNum >= freezeNum;
  return todayNum >= freezeNum || now.getMonth() + 1 < 8;
}

function buildCollegeRankingModel(picks, league, ownerNameById) {
  const frozen = isPastCollegeFreeze(league, new Date());
  return picks.map((pick) => {
    const ownerName = ownerNameById[pick.member_id] || pick.member_id;
    const currentPoints = Number(pick.metric) || 0;
    const deltaSampler = frozen
      ? () => 0
      : (rng) => Math.max(-currentPoints, sampleNormal(rng, 0, Math.max(currentPoints * 0.12, 3)));
    return {
      id: pick.id, ownerName, pickName: pick.pick, currentMetric: currentPoints,
      deltaSampler, bonusSampler: () => 0,
      sourceNote: frozen
        ? 'static:ap_poll_frozen_past_regular_season'
        : 'fallback:ap_poll_symmetric_variance(no_real_forecast_source)',
    };
  });
}

/** Actor/Actress — TMDB upcoming-release discovery. Explicitly low
 * confidence: there is no real forecast API for unreleased box office. */
async function fetchFilmBudget(tmdbId) {
  try {
    const data = await fetchJsonWithTimeout(`${TMDB_BASE}/movie/${tmdbId}?api_key=${TMDB_API_KEY}`, 8000);
    return data && typeof data.budget === 'number' ? data.budget : 0;
  } catch (e) { return 0; }
}

async function fetchUpcomingFilms(personName, fyEnd, pastDeadline) {
  if (!TMDB_API_KEY) return [];
  try {
    const searchUrl = `${TMDB_BASE}/search/person?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(personName)}`;
    const searchData = await fetchJsonWithTimeout(searchUrl, 8000);
    const person = searchData && searchData.results && searchData.results[0];
    if (!person) return [];
    await delay(150);
    const creditsUrl = `${TMDB_BASE}/person/${person.id}/movie_credits?api_key=${TMDB_API_KEY}`;
    const credits = await fetchJsonWithTimeout(creditsUrl, 8000);
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = (credits && credits.cast || []).filter((f) => f.release_date && f.release_date > today && f.release_date <= fyEnd);

    // Fetch each upcoming film's disclosed TMDB budget (0 if a studio
    // hasn't registered one yet) to anchor the box-office guess on real
    // data instead of one flat number for every film. Capped at 5 titles
    // and gated on the shared time budget so one actor with a long
    // upcoming slate can't eat the whole run.
    const withBudget = [];
    for (const f of upcoming.slice(0, 5)) {
      if (pastDeadline && pastDeadline()) { withBudget.push(Object.assign({}, f, { budget: 0 })); continue; }
      const budget = await fetchFilmBudget(f.id);
      await delay(150);
      withBudget.push(Object.assign({}, f, { budget }));
    }
    return withBudget;
  } catch (e) { return []; }
}

async function buildFilmModel(picks, fyEnd, ownerNameById, pastDeadline, avgRtByPickId) {
  return Promise.all(picks.map(async (pick) => {
    const ownerName = ownerNameById[pick.member_id] || pick.member_id;
    const currentScore = Number(pick.metric) || 0; // totalScore (sum of BO x RT already banked)
    let upcoming = [];
    if (!pastDeadline || !pastDeadline()) {
      try { upcoming = await fetchUpcomingFilms(pick.pick, fyEnd, pastDeadline); await delay(200); } catch (e) { upcoming = []; }
    }

    // Real data when we have it: this actor's own average RT from films
    // ALREADY scored this season (film_entries, fetched once in the
    // handler) — a flat industry-wide guess only when they have none yet.
    const ownRtAvg = avgRtByPickId && avgRtByPickId[pick.id];
    const rtMean = typeof ownRtAvg === 'number' ? ownRtAvg : 55;

    if (upcoming.length === 0) {
      return {
        id: pick.id, ownerName, pickName: pick.pick, currentMetric: currentScore,
        deltaSampler: () => 0, bonusSampler: () => 0,
        sourceNote: (pastDeadline && pastDeadline()) ? 'skipped:time_budget_exceeded' : 'none:no_known_upcoming_release_in_window',
        confidence: 'low',
      };
    }

    // Still explicitly low-confidence — no real pre-release box-office
    // forecast exists publicly, and this isn't pretending otherwise. But
    // anchored on real signals where they exist rather than one flat
    // guess for every actor and every film: box office centers on the
    // film's own disclosed TMDB budget (median guess ~2.2x budget, a
    // common rough industry rule of thumb for a wide theatrical release —
    // still a guess, just a less arbitrary one) when a studio has
    // registered it, falling back to a flat $40M median otherwise; RT
    // centers on the actor's own track record this season, falling back
    // to a generic 55 only if they have no scored films yet.
    const films = upcoming;
    return {
      id: pick.id, ownerName, pickName: pick.pick, currentMetric: currentScore,
      deltaSampler: (rng) => {
        let total = 0;
        for (const f of films) {
          const budgetMillions = (f.budget || 0) / 1e6;
          const anchorMedianBO = budgetMillions > 0 ? clamp(budgetMillions * 2.2, 5, 400) : 40;
          const boMillions = Math.max(0, Math.exp(sampleNormal(rng, Math.log(anchorMedianBO), 0.9)));
          const rt = clamp(sampleNormal(rng, rtMean, 18), 0, 100);
          total += boMillions * rt / 100;
        }
        return total;
      },
      bonusSampler: () => 0,
      sourceNote: 'tmdb_upcoming(' + films.length + ' titles' +
        (films.some((f) => f.budget > 0) ? ',budget_anchored' : ',no_budget_disclosed_yet') + ')' +
        (typeof ownRtAvg === 'number' ? ',rt_anchored_on_own_history(' + Math.round(ownRtAvg) + '%)' : ',rt_flat_guess(no_own_history_yet)'),
      confidence: 'low',
    };
  }));
}

/** Musician — decay-rate extrapolation of the artist's OWN already-cached
 * chart history. This is the one category backed by real collected data
 * rather than a third-party forecast. */
function buildMusicianModel(picks, fyStart, fyEnd, ownerNameById) {
  const today = new Date();
  const daysElapsed = Math.max(1, Math.round((today - new Date(fyStart)) / 86400000));
  const daysTotal = Math.max(daysElapsed + 1, Math.round((new Date(fyEnd) - new Date(fyStart)) / 86400000));
  const weeksElapsed = Math.max(1, daysElapsed / 7);
  const weeksRemaining = Math.max(0, (daysTotal - daysElapsed) / 7);

  return picks.map((pick) => {
    const ownerName = ownerNameById[pick.member_id] || pick.member_id;
    const currentWeeks = Number(pick.metric) || 0; // totalWeeks (chart appearances + #1 bonus)
    const weeklyRate = currentWeeks / weeksElapsed; // real, derived from own cached history
    const meanDelta = weeklyRate * weeksRemaining;
    return {
      id: pick.id, ownerName, pickName: pick.pick, currentMetric: currentWeeks,
      deltaSampler: (rng) => Math.max(0, sampleNormal(rng, meanDelta, meanDelta * 0.6 + 0.5)),
      bonusSampler: () => 0,
      sourceNote: 'own_billboard_history_decay_rate,weeksRemaining=' + weeksRemaining.toFixed(1),
    };
  });
}

/**
 * KNOWN SIMPLIFICATION, not an oversight: this models the REMAINING
 * bonus upside as a single binary event (go on to win the title, or
 * don't) against ONE market's probability, added on top of whatever
 * bonus is already banked (see the bonusSampler default set in
 * runCategory — never zero, always at least m.actualBonus). It does NOT
 * model the EV of advancing through yet-unresolved partial tiers between
 * now and the end (see CATEGORY_BONUS_RULES in
 * src/constants/categories.js — a conference-championship loss, a
 * divisional loss, etc. each pay out their own smaller tier). A fuller
 * model would need either a separate odds-market lookup per round (more
 * unverified-shape surface area per the caveats at the top of this file)
 * or a structured points-per-round table to interpolate from title odds
 * alone — both are future work, not done here. Flagging this in
 * projection_runs.detail / source_detail rather than letting it look
 * more complete than it is.
 */
function attachBonusSampler(models, bonusProbByOwner, bonusPointsIfWin) {
  return models.map((m) => {
    const prob = bonusProbByOwner[m.ownerName];
    if (prob === null || prob === undefined) return m; // leave the actualBonus-flat default in place
    const alreadyBanked = m.actualBonus;
    const upside = Math.max(0, bonusPointsIfWin - alreadyBanked);
    return Object.assign({}, m, { bonusSampler: (rng) => alreadyBanked + (rng() < prob ? upside : 0) });
  });
}

// ═══════════════════════════════════════════════════════════════════════
// BRACKET-RANKED BONUS — replaces the single-market EV model above for
// any category whose real bonus rule (CATEGORY_BONUS_RULES in
// src/constants/categories.js) is a single-elimination bracket: ONE
// eventual champion, ONE runner-up, then smaller tiers going out earlier
// (e.g. NFL's "10:Win SB | 7:Lose SB | 5:Lose Conf Champ | 3:Lose Div |
// 2:Lose WC"). attachBonusSampler's fractional-EV approach (every pick's
// own win% × bonusPointsIfWin) under-projects the real favorite (their
// true win probability is well under 100%) and over-projects the rest of
// the field (everyone gets a sliver of credit for a prize only one of
// them can actually win). Ranking the field by live win probability and
// slotting it into the real bracket tiers is a much closer match to what
// will actually happen — per direct user instruction after reviewing
// live projection output.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Looks up ONE betting-market event (by title keyword) and returns a win
 * probability per PICK, in a single search call shared across the whole
 * category — not one search per pick like findChampionshipProbability.
 * Every pick's probability has to come from the same market snapshot to
 * be comparable against each other, which rank-based tier assignment
 * needs (and as a side effect, this also cuts the network calls for a
 * 12-pick category from 12 down to 1).
 */
async function findMarketProbabilitiesForPicks(titleKeyword, picksWithNameVariants, eventFilter) {
  const url = 'https://gamma-api.polymarket.com/public-search?events_status=active&limit_per_type=10&q=' + encodeURIComponent(titleKeyword);
  const res = await fetchJsonDiagnostic(url, 8000);
  if (res.error) return { probs: {}, reason: 'fetch_error:' + res.error };
  if (!res.ok) return { probs: {}, reason: 'http_' + res.status };
  const data = res.json;
  const allEvents = Array.isArray(data) ? data : (data && data.events) || [];
  // eventFilter is an extra client-side narrowing beyond active/closed —
  // needed because Polymarket's search is loose enough that e.g. "Best
  // Actor Winner" also returns the separate "Best Supporting Actor
  // Winner" event (confirmed live), the same class of cross-match
  // already found and fixed for F1's practice-lap vs podium markets.
  const events = allEvents.filter((ev) => ev.active !== false && ev.closed !== true && (!eventFilter || eventFilter(ev)));
  if (!events || events.length === 0) return { probs: {}, reason: 'no_active_events_matched_query(' + titleKeyword + ')' };

  let marketsScanned = 0;
  const probs = {};
  for (const entry of picksWithNameVariants) {
    const needles = entry.nameVariants.map((v) => (v || '').toLowerCase()).filter(Boolean);
    let matchedPrice = null;
    for (const ev of events) {
      if (matchedPrice !== null) break;
      for (const m of (ev.markets || [])) {
        marketsScanned++;
        const question = (m.question || m.groupItemTitle || m.title || '').toLowerCase();
        if (!needles.some((n) => question.includes(n))) continue;
        try {
          const outcomes = JSON.parse(m.outcomes || '[]');
          const prices = JSON.parse(m.outcomePrices || '[]');
          const yesIdx = outcomes.findIndex((o) => String(o).toLowerCase() === 'yes');
          const price = yesIdx >= 0 ? parseFloat(prices[yesIdx]) : parseFloat(prices[0]);
          if (!isNaN(price)) { matchedPrice = clamp(price, 0, 1); break; }
        } catch (e) { /* malformed market payload — skip, don't guess */ }
      }
    }
    probs[entry.id] = matchedPrice;
  }
  const anyMatched = Object.keys(probs).some((id) => probs[id] !== null);
  if (!anyMatched) {
    return { probs, reason: events.length + '_events_' + marketsScanned + '_markets_none_matched_any_pick' };
  }

  // A brand-new market can list every outcome at the same flat default
  // price before any real trading volume comes in (confirmed live: a
  // Las Vegas GP market 3 weeks out had the IDENTICAL 0.495/0.505 for
  // all 23 drivers — zero differentiation). Ranking off that isn't
  // reading the market, it's reading whatever order the picks happened
  // to come out of the database in (a tie leaves a stable sort
  // untouched) — not a real signal, so treat it the same as no match
  // rather than silently manufacturing a ranking from coincidence.
  const matchedValues = Object.keys(probs).map((id) => probs[id]).filter((p) => typeof p === 'number');
  const distinctValues = new Set(matchedValues.map((p) => Math.round(p * 1000)));
  if (matchedValues.length > 1 && distinctValues.size === 1) {
    return { probs: {}, reason: 'flat_untraded_market(all_matched_at_' + matchedValues[0] + ')' };
  }

  return { probs, reason: null };
}

/**
 * Assigns bonus by RANK among a single-elimination bracket. The most
 * likely pick (by live win probability) is slotted into tierValues[0]
 * (champion), the next most likely into tierValues[1] (runner-up), and
 * so on; anything ranked past the end of tierValues gets 0. Never
 * projects BELOW what a pick has already banked — max() keeps a pick's
 * real earned points even if it now ranks outside the modeled tiers
 * (e.g. already mathematically eliminated).
 *
 * tierLabels, when given, is a parallel array to tierValues (same rank
 * index) — a human-readable explanation of that tier ("Projected to win
 * the Super Bowl") stored on m.bonusNote, surfaced on the Scoreboard
 * next to the projected total. Only set when the computed tier is what
 * actually determined the projection (tier > the already-banked floor)
 * — a pick whose real actualBonus already exceeds every modeled tier
 * keeps whatever note (if any) it already had, since the tier ladder
 * isn't what's driving their number.
 */
function rankIntoTierBonus(models, probs, tierValues, tierLabels) {
  const contenders = models
    .filter((m) => typeof probs[m.id] === 'number')
    .slice()
    .sort((a, b) => probs[b.id] - probs[a.id]);
  const tierByPickId = {};
  const labelByPickId = {};
  contenders.forEach((m, idx) => {
    tierByPickId[m.id] = tierValues[idx] !== undefined ? tierValues[idx] : 0;
    if (tierLabels && tierLabels[idx]) labelByPickId[m.id] = tierLabels[idx];
  });
  return models.map((m) => {
    const tier = tierByPickId[m.id] !== undefined ? tierByPickId[m.id] : 0;
    const projected = Math.max(m.actualBonus, tier);
    const note = (tier > m.actualBonus && labelByPickId[m.id]) ? labelByPickId[m.id] : m.bonusNote;
    return Object.assign({}, m, { bonusSampler: () => projected, bonusNote: note });
  });
}

/**
 * Same rank-into-tiers idea as rankIntoTierBonus, but ADDS the tier to
 * whatever's already banked instead of taking the max — for a bonus rule
 * that pays out independently more than once (F1's per-featured-race
 * placement bonus, an artist winning more than one Grammy category),
 * not a single bracket with one eventual winner.
 *
 * Reads the running total from m.bonusSampler() rather than the static
 * m.actualBonus — this function is meant to be called repeatedly in a
 * loop (once per race/category), and m.actualBonus never changes after
 * the first call, so chaining off it would silently DISCARD every
 * addition but the last whenever more than one market matches in the
 * same run. bonusSampler() always reflects whatever the previous call
 * in the chain (or the actualBonus-flat default, on the first call)
 * last set it to.
 *
 * tierLabels (parallel to tierValues, same rank index) accumulates onto
 * m.bonusNote across calls — comma-joined, since this function models a
 * bonus that can be earned more than once in the same run (a driver on
 * the podium in two different featured races, an artist winning two
 * Grammy categories), unlike rankIntoTierBonus's single note.
 */
function addTierBonus(models, probs, tierValues, tierLabels) {
  const contenders = models
    .filter((m) => typeof probs[m.id] === 'number')
    .slice()
    .sort((a, b) => probs[b.id] - probs[a.id]);
  const tierByPickId = {};
  const labelByPickId = {};
  contenders.forEach((m, idx) => {
    tierByPickId[m.id] = tierValues[idx] !== undefined ? tierValues[idx] : 0;
    if (tierLabels && tierLabels[idx]) labelByPickId[m.id] = tierLabels[idx];
  });
  return models.map((m) => {
    const addition = tierByPickId[m.id] !== undefined ? tierByPickId[m.id] : 0;
    const projected = m.bonusSampler() + addition;
    let note = m.bonusNote;
    if (addition > 0 && labelByPickId[m.id]) note = note ? (note + ', ' + labelByPickId[m.id]) : labelByPickId[m.id];
    return Object.assign({}, m, { bonusSampler: () => projected, bonusNote: note });
  });
}

/** Same accumulation idea as addTierBonus, but only the single most
 * likely pick in this market gets credit (no 2nd/3rd place tier) — for
 * an award category that has exactly one winner and no partial-credit
 * placement, like a Grammy category. */
function addSingleWinnerTier(models, probs, tier, label) {
  return addTierBonus(models, probs, [tier], label ? [label] : undefined);
}

/**
 * Combines a WIN-market ranking (only the single most likely pick gets
 * winTier) with a NOMINATION-market ranking (the top nomineeCount most
 * likely picks each get nomTier) into one pass. Takes the max across
 * actualBonus/winTier/nomTier per pick — not additive, since winning
 * implies having been nominated (CATEGORY_BONUS_RULES' win tier already
 * supersedes its own category's nomination tier), and a pick can't earn
 * a nomination-without-a-win AND a win in the same category at once.
 */
function combinedAwardTierBonus(models, winProbs, winTier, winLabel, nomProbs, nomTier, nomLabel, nomineeCount) {
  const winContenders = models.filter((m) => typeof winProbs[m.id] === 'number').slice().sort((a, b) => winProbs[b.id] - winProbs[a.id]);
  const winnerPickId = winContenders.length > 0 ? winContenders[0].id : null;

  const nomContenders = models.filter((m) => typeof nomProbs[m.id] === 'number').slice().sort((a, b) => nomProbs[b.id] - nomProbs[a.id]);
  const nominatedIds = new Set(nomContenders.slice(0, nomineeCount).map((m) => m.id));

  return models.map((m) => {
    const winValue = m.id === winnerPickId ? winTier : 0;
    const nomValue = nominatedIds.has(m.id) ? nomTier : 0;
    const projected = Math.max(m.actualBonus, winValue, nomValue);
    let note = m.bonusNote;
    if (winValue > m.actualBonus && winValue >= nomValue) note = winLabel;
    else if (nomValue > m.actualBonus) note = nomLabel;
    return Object.assign({}, m, { bonusSampler: () => projected, bonusNote: note });
  });
}

/**
 * Oscars (CATEGORY_BONUS_RULES.Actor/Actress): looks up the real "Best
 * X Winner" and "Best X Nominations" markets (awardLabel is "Best
 * Actor" or "Best Actress"), explicitly excluding the Supporting
 * category's own markets — verified live that a loose search for e.g.
 * "Best Actor Winner" also returns "Best Supporting Actor Winner", the
 * same class of cross-match already found and fixed for F1's
 * practice-lap vs podium markets. Only the LEAD track is modeled — a
 * pick who ends up nominated in Supporting instead (a different pair of
 * tiers in CATEGORY_BONUS_RULES) isn't covered; not verified live, not
 * guessed at blind. Oscar's Best Actor/Actress field is always exactly
 * 5 nominees, hence nomineeCount=5.
 */
async function applyOscarBonus(models, pastDeadline, awardLabel) {
  const excludeSupporting = (ev) => !/supporting/i.test(ev.title || '');
  let winProbs = {}, winReason = 'skipped:time_budget_exceeded';
  if (!pastDeadline()) {
    const picksWithVariants = models.map((m) => ({ id: m.id, nameVariants: [m.pickName] }));
    try {
      const lookup = await findMarketProbabilitiesForPicks(awardLabel + ' Winner', picksWithVariants, excludeSupporting);
      winProbs = lookup.probs; winReason = lookup.reason || 'matched';
    } catch (e) { winReason = 'exception:' + e.message; }
    await delay(150);
  }

  let nomProbs = {}, nomReason = 'skipped:time_budget_exceeded';
  if (!pastDeadline()) {
    const picksWithVariants2 = models.map((m) => ({ id: m.id, nameVariants: [m.pickName] }));
    try {
      const lookup = await findMarketProbabilitiesForPicks(awardLabel + ' Nominations', picksWithVariants2, excludeSupporting);
      nomProbs = lookup.probs; nomReason = lookup.reason || 'matched';
    } catch (e) { nomReason = 'exception:' + e.message; }
  }

  const updated = combinedAwardTierBonus(
    models,
    winProbs, 10, 'Projected to win ' + awardLabel,
    nomProbs, 3, 'Projected ' + awardLabel + ' nominee',
    5
  );
  return { models: updated, sourceNoteSuffix: 'oscar_bonus(win:' + winReason + '|nom:' + nomReason + ')' };
}

/**
 * Grammys (CATEGORY_BONUS_RULES.Musician): tries each real Grammy
 * category market Polymarket actually lists — confirmed live via
 * Alexandria (Album/Song/Record of the Year, Best Rap Album, Best New
 * Artist; no Pop/Rock-album or nomination-only markets were found to
 * exist right now, so those tiers of CATEGORY_BONUS_RULES.Musician
 * aren't modeled — not guessed at blind). The "big three" (Album/Song/
 * Record of the Year) pay the 7-tier; Best Rap Album/Best New Artist
 * pay the 3-tier, matching "Best Song/Album Win" vs "Pop/Rock/Rap/New
 * Artist Win". Only the single most-likely winner in EACH market gets
 * that market's tier, added on top of whatever's already banked — an
 * artist can genuinely win more than one Grammy category in the same
 * ceremony, unlike a sports bracket's single champion.
 */
const GRAMMY_MARKETS = [
  { title: 'Album of the Year Winner', tier: 7 },
  { title: 'Song of the Year Winner', tier: 7 },
  { title: 'Record of the Year Winner', tier: 7 },
  { title: 'Best Rap Album Winner', tier: 3 },
  { title: 'Best New Artist Winner', tier: 3 },
];

async function applyGrammyBonus(models, pastDeadline) {
  let current = models;
  const reasonParts = [];
  for (const market of GRAMMY_MARKETS) {
    if (pastDeadline()) { reasonParts.push(market.title + ':skipped:time_budget_exceeded'); break; }
    const picksWithVariants = current.map((m) => ({ id: m.id, nameVariants: [m.pickName] }));
    let lookup;
    try { lookup = await findMarketProbabilitiesForPicks(market.title, picksWithVariants); }
    catch (e) { lookup = { probs: {}, reason: 'exception:' + e.message }; }
    current = addSingleWinnerTier(current, lookup.probs, market.tier, 'Projected to win ' + market.title.replace(/ Winner$/, ''));
    reasonParts.push(market.title + ':' + (lookup.reason || 'matched'));
    await delay(150);
  }
  return { models: current, sourceNoteSuffix: 'grammy_bonus(' + reasonParts.join('|') + ')' };
}

/**
 * F1's real bonus rule (CATEGORY_BONUS_RULES.F1) pays out per-podium
 * finish across 4 SPECIFIC featured races (Australian, Miami, United
 * States, Las Vegas GPs) — 3/2/1 points for 1st/2nd/3rd in THAT race —
 * not a single season-championship market. A generic "wins the F1
 * championship" search (the previous attempt) modeled the wrong event
 * entirely and was removed rather than fixed in place; this models the
 * real rule instead.
 *
 * Tries each featured race's own market in calendar order. A race that's
 * already run won't have an active market anymore (Polymarket
 * resolves/closes it), so this naturally skips to whichever race(s) are
 * still open without needing to hardcode exact 2026 race dates — the
 * market's own active/closed state IS the "has this race happened yet"
 * signal. Whichever race(s) come back with live odds get their podium
 * tier ADDED on top of whatever's already banked from earlier races in
 * the season (see addTierBonus) — never replacing it, since this bonus
 * accumulates independently race by race, unlike the bracket sports.
 */
const F1_FEATURED_RACES = [
  { key: 'AUS', title: 'Australian Grand Prix', tierValues: [3, 2, 1] },
  { key: 'MIA', title: 'Miami Grand Prix', tierValues: [3, 2, 1] },
  { key: 'ATX', title: 'United States Grand Prix', tierValues: [3, 2, 1] },
  { key: 'LV', title: 'Las Vegas Grand Prix', tierValues: [3, 2, 1] },
];

async function applyF1FeaturedRaceBonus(models, pastDeadline) {
  let current = models;
  let anyOpenRace = false;
  let lastNote = 'no_featured_race_markets_open';
  for (const race of F1_FEATURED_RACES) {
    if (pastDeadline()) { lastNote = 'skipped:time_budget_exceeded'; break; }
    const picksWithVariants = current.map((m) => ({ id: m.id, nameVariants: [m.pickName] }));
    let lookup;
    try { lookup = await findMarketProbabilitiesForPicks(race.title, picksWithVariants); }
    catch (e) { lookup = { probs: {}, reason: 'exception:' + e.message }; }
    const matchedAny = Object.keys(lookup.probs).some((id) => lookup.probs[id] !== null);
    if (matchedAny) {
      const tierLabels = ['Projected 1st at the ' + race.title, 'Projected 2nd at the ' + race.title, 'Projected 3rd at the ' + race.title];
      current = addTierBonus(current, lookup.probs, race.tierValues, tierLabels);
      anyOpenRace = true;
      lastNote = race.key + ':matched';
    } else {
      lastNote = race.key + ':' + (lookup.reason || 'no_match');
    }
    await delay(150);
  }
  return {
    models: current,
    sourceNoteSuffix: 'f1_featured_race_bonus(' + (anyOpenRace ? lastNote : 'no_race_open,last=' + lastNote) + ')',
  };
}

// ═══════════════════════════════════════════════════════════════════════
// SUPABASE I/O
// ═══════════════════════════════════════════════════════════════════════

function isFieldLocked(locks, category, ownerName, field) {
  return !!(locks && locks[category + '|' + ownerName + '|' + field]);
}

async function upsertProjections(supabase, seasonYear, category, rows) {
  if (rows.length === 0) return 0;
  const payload = rows.map((r) => ({
    pick_id: r.id,
    season_year: seasonYear,
    category,
    projected_metric: r.projectedMetric ?? null,
    projected_base: r.projectedBase,
    projected_bonus_ev: r.projectedBonusEv,
    projected_total: r.projectedTotal,
    p10: r.p10, p50: r.p50, p90: r.p90,
    method: r.method, confidence: r.confidence,
    source_detail: r.sourceDetail || null,
    note: r.note || null,
    simulations: r.simulations || 0,
    computed_at: new Date().toISOString(),
  }));
  const { error } = await supabase.from('projections').upsert(payload, { onConflict: 'season_year,pick_id' });
  if (error) { console.error('  projections upsert error:', error.message); return 0; }
  return payload.length;
}

async function logRun(supabase, seasonYear, category, status, detail, startedAt) {
  await supabase.from('projection_runs').insert({
    season_year: seasonYear, category, status, detail: detail || {},
    started_at: startedAt, finished_at: new Date().toISOString(),
  });
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════

module.exports = async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== 'Bearer ' + cronSecret) return res.status(401).json({ error: 'Unauthorized' });
  if (!SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log('Fantasy Life — Computing Season Projections...\n');

  const { data: season } = await supabase.from('seasons').select('year, locks, fy_start, fy_end').eq('status', 'active').single();
  if (!season) return res.status(200).json({ message: 'No active season found, skipping' });

  const seasonYear = season.year;
  const locks = season.locks || {};
  const fyStart = season.fy_start || `${seasonYear}-01-01`;
  const fyEnd = season.fy_end || `${seasonYear}-12-31`;

  const { data: membersArr } = await supabase.from('members').select('id, name');
  const ownerNameById = {};
  (membersArr || []).forEach((m) => { ownerNameById[m.id] = m.name; });

  const { data: allPicks, error: picksErr } = await supabase
    .from('picks').select('id, member_id, category, pick, base, bonus, total, metric, record')
    .eq('season_year', seasonYear);
  if (picksErr || !allPicks || allPicks.length === 0) {
    return res.status(200).json({ message: 'No picks found for season ' + seasonYear });
  }

  const picksByCategory = {};
  allPicks.forEach((p) => { (picksByCategory[p.category] = picksByCategory[p.category] || []).push(p); });

  // Real, already-collected data for Actor/Actress: each pick's own
  // already-scored films this season, specifically their RT scores — the
  // one genuine signal available for what an UNRELEASED film from the
  // same actor might score, since there's no public pre-release RT
  // forecast anywhere. Used to replace a flat guess with the actor's own
  // track record. See buildFilmModel.
  const filmPickIds = (picksByCategory['Actor'] || []).concat(picksByCategory['Actress'] || []).map((p) => p.id);
  const avgRtByPickId = {};
  if (filmPickIds.length > 0) {
    const { data: filmEntries } = await supabase
      .from('film_entries').select('pick_id, rotten_tom').in('pick_id', filmPickIds);
    const rtByPick = {};
    (filmEntries || []).forEach((f) => {
      const rt = Number(f.rotten_tom) || 0;
      if (rt <= 0) return; // 0 means "not yet scored/found", same convention update-entertainment.js uses — not a real RT of zero
      (rtByPick[f.pick_id] = rtByPick[f.pick_id] || []).push(rt);
    });
    Object.keys(rtByPick).forEach((pickId) => {
      const arr = rtByPick[pickId];
      avgRtByPickId[pickId] = arr.reduce((a, b) => a + b, 0) / arr.length;
    });
  }

  const results = {};
  const runStartedAt = Date.now();
  const pastDeadline = () => (Date.now() - runStartedAt) > RUN_BUDGET_MS;

  function withLocks(models, category) {
    return models.map((m) => Object.assign({}, m, {
      lockedBase: m.lockedBase ?? isFieldLocked(locks, category, m.ownerName, 'base'),
      lockedBonus: m.lockedBonus ?? isFieldLocked(locks, category, m.ownerName, 'bonus'),
      lockedMetric: m.lockedMetric ?? isFieldLocked(locks, category, m.ownerName, 'metric'),
      actualBase: m.actualBase ?? 0,
      actualBonus: m.actualBonus ?? 0,
    }));
  }

  async function runCategory(category, direction, buildModels, bonusConfig) {
    const startedAt = new Date().toISOString();
    const picks = picksByCategory[category] || [];
    if (picks.length === 0) { results[category] = { status: 'skipped', reason: 'no picks' }; await logRun(supabase, seasonYear, category, 'skipped', { reason: 'no picks' }, startedAt); return; }

    try {
      let models = await buildModels(picks);
      models = withLocks(models, category).map((m, idx) => {
        const actualBase = Number(picks[idx].base) || 0;
        const actualBonus = Number(picks[idx].bonus) || 0;
        return Object.assign({}, m, {
          actualBase, actualBonus,
          // Builders never implement a meaningful bonusSampler of their
          // own (they all set a `() => 0` placeholder) — this is the
          // real default, applied here because actualBonus isn't known
          // yet inside the builder functions. Holding bonus flat at
          // whatever's already recorded is correct for "nothing left to
          // model" (Golf, a settled Oscar/Grammy) AND for "partial
          // progress already banked, no further odds match found" —
          // it's never okay to default to zero and erase real points a
          // pick has already earned. Only replaced below when a live
          // odds match for the remaining top prize is found.
          bonusSampler: () => actualBonus,
          // Plain-English explanation of the projected bonus, surfaced on
          // the Scoreboard (projections.note) — set by whichever bonus
          // path below actually determines this pick's number; null when
          // nothing does (no bonus mechanism modeled for this category,
          // or no live match found).
          bonusNote: m.bonusNote || null,
        });
      });

      if (bonusConfig) {
        if (bonusConfig.kind === 'tierLadder') {
          // Match on the PICKED TEAM/ATHLETE's name, never the league
          // member's — a championship market's outcome text says "Kansas
          // City Chiefs", never "LaRosa".
          const picksWithVariants = models.map((m) => ({ id: m.id, nameVariants: nameVariants(m.pickName) }));
          let lookup = { probs: {}, reason: 'skipped:time_budget_exceeded' };
          if (!pastDeadline()) {
            try { lookup = await findMarketProbabilitiesForPicks(bonusConfig.titleKeyword, picksWithVariants); }
            catch (e) { lookup = { probs: {}, reason: 'exception:' + e.message }; }
          }
          models = bonusConfig.mode === 'add'
            ? addTierBonus(models, lookup.probs, bonusConfig.tierValues, bonusConfig.tierLabels)
            : rankIntoTierBonus(models, lookup.probs, bonusConfig.tierValues, bonusConfig.tierLabels);
          models = models.map((m) => Object.assign({}, m, {
            sourceNote: m.sourceNote + '|bonus_tier_ladder(' + bonusConfig.tierValues.join('/') + ')|odds_lookup:' + (lookup.reason || 'matched'),
          }));
        } else if (bonusConfig.kind === 'custom') {
          const applied = await bonusConfig.apply(models, pastDeadline);
          models = applied.models.map((m) => Object.assign({}, m, {
            sourceNote: m.sourceNote + '|' + (applied.sourceNoteSuffix || 'custom_bonus'),
          }));
        } else {
          // Legacy single-market EV path — still used for categories this
          // pass didn't rework (NCAAF/NCAAB's non-bracket-shaped bowl/CFP
          // tiers, Actor/Actress/Musician awards): every pick's own win
          // probability × bonusPointsIfWin, added on top of the banked
          // floor. See docs/projections-feature-plan.md for why the
          // bracket sports moved off this model and these haven't, yet.
          const bonusProbByOwner = {};
          // Captures the FIRST failure reason seen in this category as a
          // category-wide diagnostic (titleKeyword is the same for every
          // pick here, so the root cause — no events found, events found
          // but no outcome matched, a fetch error — is almost always the
          // same across all of them too). Tells the next live run exactly
          // where the lookup is failing instead of just "no match".
          let bonusDiagnostic = null;
          for (const m of models) {
            if (pastDeadline()) { bonusProbByOwner[m.ownerName] = null; if (!bonusDiagnostic) bonusDiagnostic = 'skipped:time_budget_exceeded'; continue; }
            try {
              const found = await findChampionshipProbability(bonusConfig.titleKeyword, nameVariants(m.pickName), bonusConfig.kalshiSeriesGuess);
              bonusProbByOwner[m.ownerName] = found.prob;
              if (found.prob === null && !bonusDiagnostic) bonusDiagnostic = found.reason;
            } catch (e) { bonusProbByOwner[m.ownerName] = null; if (!bonusDiagnostic) bonusDiagnostic = 'exception:' + e.message; }
            await delay(150);
          }
          models = attachBonusSampler(models, bonusProbByOwner, bonusConfig.bonusPointsIfWin);
          models = models.map((m) => {
            const prob = bonusProbByOwner[m.ownerName];
            const note = (typeof prob === 'number' && prob > 0.01)
              ? Math.round(prob * 100) + '% projected to win ' + bonusConfig.titleKeyword
              : m.bonusNote;
            return Object.assign({}, m, {
              sourceNote: m.sourceNote + '|bonus_ev_models_title_win_only|odds_lookup:' + (bonusDiagnostic || 'matched'),
              bonusNote: note,
            });
          });
        }
      }

      // picks.length, NOT the league-wide member count — matches the exact
      // convention every real scoring cron uses (assignBasePointsWithTies
      // scales off how many picks exist IN THIS CATEGORY, which is
      // normally == total members but isn't guaranteed to be).
      const simResults = simulateCategory(models, picks.length, direction, N_SIMS, Math.random);
      const anyLowConfidence = models.some((m) => m.confidence === 'low');
      const rows = simResults.map((r) => {
        const model = models.find((m) => m.id === r.id);
        return Object.assign({}, r, {
          projectedMetric: round2(model.currentMetric), // the metric itself isn't simulated forward as a single number; base/total are
          method: 'monte_carlo', confidence: model.confidence || (anyLowConfidence ? 'low' : 'medium'),
          sourceDetail: model.sourceNote, note: model.bonusNote || null, simulations: N_SIMS,
        });
      });

      const written = await upsertProjections(supabase, seasonYear, category, rows);
      results[category] = { status: 'ok', written, total: picks.length };
      await logRun(supabase, seasonYear, category, 'ok', { written, total: picks.length }, startedAt);
    } catch (err) {
      console.error('  ' + category + ' projection failed:', err.message);
      results[category] = { status: 'error', error: err.message };
      await logRun(supabase, seasonYear, category, 'error', { error: err.message }, startedAt);
    }
  }

  async function runStatic(category, method, confidence, sourceDetail, note) {
    const startedAt = new Date().toISOString();
    const picks = picksByCategory[category] || [];
    if (picks.length === 0) { results[category] = { status: 'skipped', reason: 'no picks' }; await logRun(supabase, seasonYear, category, 'skipped', {}, startedAt); return; }
    const rows = picks.map((p) => ({
      id: p.id,
      projectedMetric: Number(p.metric) || null,
      projectedBase: Number(p.base) || 0,
      projectedBonusEv: Number(p.bonus) || 0,
      projectedTotal: Number(p.total) || 0,
      p10: null, p50: null, p90: null,
      method, confidence,
      sourceDetail: sourceDetail || (method === 'trend_only' ? 'stock_price_not_modeled_see_design_doc' : 'gdp_forecast_is_already_static'),
      note: note || null,
      simulations: 0,
    }));
    const written = await upsertProjections(supabase, seasonYear, category, rows);
    results[category] = { status: 'ok', written, total: picks.length };
    await logRun(supabase, seasonYear, category, 'ok', { written }, startedAt);
  }

  // ── Win%-based sports ──
  for (const league of ['NFL', 'NBA', 'MLB']) {
    if (!isSportBaseActive(league)) {
      // Real base-scoring cron (update-sports.js) is frozen this month —
      // the regular season (and for MLB, the postseason right behind it)
      // is over, nothing left to simulate. Hold the real actual values
      // flat rather than keep Monte-Carlo-projecting movement that cron
      // would never actually write.
      await runStatic(league, 'static', 'deterministic', league.toLowerCase() + '_season_over_frozen', 'Season complete — locked');
      continue;
    }
    const bonusConfig = bonusConfigFor(league);
    await runCategory(league, 'desc', async (picks) => {
      const models = await buildWinPctModel(picks, league, seasonYear, locks, ownerNameById, pastDeadline);
      // NBA: bonusConfigFor returns null here because the bonus-deciding
      // event already happened (see bonusConfigFor's own comment) — note
      // that explicitly in source_detail, and give the Scoreboard a
      // plain-English note too (reverse-matched against the real
      // actualBonus value, since it's already decided rather than
      // projected — picks[idx].bonus is available here, m.actualBonus
      // isn't set yet at this point in the pipeline).
      return bonusConfig ? models : models.map((m, idx) => {
        const actualBonus = Number(picks[idx].bonus) || 0;
        const tierIdx = [10, 7, 5, 3, 2].indexOf(actualBonus);
        const lockedNote = tierIdx >= 0 ? (SPORT_TIER_LABELS_LOCKED[league] || [])[tierIdx] : null;
        return Object.assign({}, m, {
          sourceNote: m.sourceNote + '|bonus_locked:prior_season_already_decided',
          bonusNote: lockedNote,
        });
      });
    }, bonusConfig);
  }
  // ── Points-based sports ──
  for (const league of ['NHL', 'MLS']) {
    if (!isSportBaseActive(league)) {
      await runStatic(league, 'static', 'deterministic', league.toLowerCase() + '_season_over_frozen', 'Season complete — locked');
      continue;
    }
    const bonusConfig = bonusConfigFor(league);
    await runCategory(league, 'desc', async (picks) => {
      const models = await buildPointsRateModel(picks, league, ownerNameById);
      return bonusConfig ? models : models.map((m, idx) => {
        const actualBonus = Number(picks[idx].bonus) || 0;
        const tierIdx = [10, 7, 5, 3, 2].indexOf(actualBonus);
        const lockedNote = tierIdx >= 0 ? (SPORT_TIER_LABELS_LOCKED[league] || [])[tierIdx] : null;
        return Object.assign({}, m, {
          sourceNote: m.sourceNote + '|bonus_locked:prior_season_already_decided',
          bonusNote: lockedNote,
        });
      });
    }, bonusConfig);
  }
  // ── College (AP poll, not the same accumulation shape as pro sports) ──
  // Still on the legacy single-market EV bonus model (kind unset) — the
  // real NCAAF/NCAAB bonus rule forks into separate named bowl games
  // rather than one clean single-elimination bracket (see
  // CATEGORY_BONUS_RULES.NCAAF/NCAAB), so it doesn't map onto
  // rankIntoTierBonus the same direct way the pro sports' brackets do.
  // Left as future work, not reworked this pass.
  await runCategory('NCAAF', 'desc', (picks) => buildCollegeRankingModel(picks, 'NCAAF', ownerNameById),
    { titleKeyword: 'College Football Playoff', kalshiSeriesGuess: null, bonusPointsIfWin: 10 });
  await runCategory('NCAAB', 'desc', (picks) => buildCollegeRankingModel(picks, 'NCAAB', ownerNameById),
    { titleKeyword: 'NCAA Tournament', kalshiSeriesGuess: null, bonusPointsIfWin: 10 });
  // ── Individual-ranking sports ──
  // Tennis's bonus event is specifically the Australian Open — not "any
  // remaining Grand Slam this calendar year" (CATEGORY_METRICS.Tennis is
  // literally "Post Australian Open World Ranking Pts"; the category's
  // own freeze date in update-events.js is Jan 31, right after the AO
  // wraps). The old remainingEventsThisMonth('Tennis') gate read the
  // calendar-year-majors-remaining table instead, which goes to 0 every
  // September–December even though the AO — this category's actual
  // target event — hasn't happened yet and is still fully live to model.
  // Bracket-ranked the same as the pro sports' championships, using this
  // category's own real bonus ladder (CATEGORY_BONUS_RULES.Tennis).
  await runCategory('Tennis', 'desc', (picks) => buildRankingPointsModel(picks, 'Tennis', ownerNameById),
    { kind: 'tierLadder', titleKeyword: 'Australian Open', tierValues: [5, 3, 2],
      tierLabels: ['Projected to win the Australian Open', 'Projected to lose the Australian Open Final', 'Projected to lose in the Australian Open Semifinal'],
      mode: 'replace' });
  await runCategory('Golf', 'asc', (picks) => buildRankingPointsModel(picks, 'Golf', ownerNameById), null);
  // F1's real bonus rule (CATEGORY_BONUS_RULES.F1) is per-podium across 4
  // SPECIFIC featured races (AUS/MIA/ATX/LV) — modeled properly now via
  // applyF1FeaturedRaceBonus, which tries each race's own market and adds
  // whichever one(s) are still live on top of the already-banked total.
  await runCategory('F1', 'desc', (picks) => buildRankingPointsModel(picks, 'F1', ownerNameById),
    { kind: 'custom', apply: (models, pastDeadlineFn) => applyF1FeaturedRaceBonus(models, pastDeadlineFn) });
  // ── Entertainment ──
  // Oscars 2027 Best Actor/Actress Winner + Nominations markets are
  // real and live (confirmed via Alexandria before writing this, same
  // as every other odds integration in this file) — replaces the old
  // generic "Academy Awards" EV search, which was too broad to
  // distinguish Best Actor from Best Supporting Actor and didn't model
  // nominations at all.
  await runCategory('Actor', 'desc', (picks) => buildFilmModel(picks, fyEnd, ownerNameById, pastDeadline, avgRtByPickId),
    { kind: 'custom', apply: (models, pastDeadlineFn) => applyOscarBonus(models, pastDeadlineFn, 'Best Actor') });
  await runCategory('Actress', 'desc', (picks) => buildFilmModel(picks, fyEnd, ownerNameById, pastDeadline, avgRtByPickId),
    { kind: 'custom', apply: (models, pastDeadlineFn) => applyOscarBonus(models, pastDeadlineFn, 'Best Actress') });
  // ── Musician ──
  await runCategory('Musician', 'desc', (picks) => buildMusicianModel(picks, fyStart, fyEnd, ownerNameById),
    { kind: 'custom', apply: (models, pastDeadlineFn) => applyGrammyBonus(models, pastDeadlineFn) });
  // ── Deterministic / explicitly-not-a-forecast categories ──
  await runStatic('Country', 'static', 'deterministic');
  await runStatic('Stock', 'trend_only', 'not_a_projection');

  console.log('\nDone!');
  return res.status(200).json({
    message: 'Projections computed',
    season: seasonYear,
    timestamp: new Date().toISOString(),
    simulationsPerCategory: N_SIMS,
    results,
  });
};

// Human-readable version of each league's real bracket ladder
// (CATEGORY_BONUS_RULES in src/constants/categories.js), parallel to
// TIER_VALUES = [10, 7, 5, 3, 2] by rank index — surfaced on the
// Scoreboard as projections.note, not just the internal source_detail
// diagnostic string.
const SPORT_TIER_LABELS = {
  NFL: ['Projected to win the Super Bowl', 'Projected to lose the Super Bowl', 'Projected to lose the Conference Championship', 'Projected to lose in the Divisional Round', 'Projected to lose in the Wild Card Round'],
  MLB: ['Projected to win the World Series', 'Projected to lose the World Series', 'Projected to lose the LCS', 'Projected to lose the LDS', 'Projected to lose the Wild Card round'],
  NBA: ['Projected to win the NBA Finals', 'Projected to lose the NBA Finals', 'Projected to lose the Conference Finals', 'Projected to lose in Round 2', 'Projected to lose in Round 1'],
  NHL: ['Projected to win the Stanley Cup', 'Projected to lose the Stanley Cup Final', 'Projected to lose the Conference Finals', 'Projected to lose in Round 2', 'Projected to lose in Round 1'],
  MLS: ['Projected to win the MLS Cup', 'Projected to lose the MLS Cup Final', 'Projected to lose the Conference Final', 'Projected to lose in the Semifinal', 'Projected to lose in Round 1'],
};

// Same ladder, past tense — for NBA/NHL's bonus-locked case, where the
// real outcome (from the PRECEDING season) is already known rather than
// projected. Reverse-matched against a pick's actualBonus value in the
// handler below (isSportBaseActive(league) branch).
const SPORT_TIER_LABELS_LOCKED = {
  NBA: ['Won the NBA Finals (already decided)', 'Lost the NBA Finals (already decided)', 'Lost the Conference Finals (already decided)', 'Lost in Round 2 (already decided)', 'Lost in Round 1 (already decided)'],
  NHL: ['Won the Stanley Cup (already decided)', 'Lost the Stanley Cup Final (already decided)', 'Lost the Conference Finals (already decided)', 'Lost in Round 2 (already decided)', 'Lost in Round 1 (already decided)'],
};

function bonusConfigFor(league) {
  // Each of these is a single-elimination bracket (CATEGORY_BONUS_RULES in
  // src/constants/categories.js): ONE champion (10), ONE runner-up (7),
  // then 5/3/2 going out earlier. Ranked into those tiers by live
  // championship odds (rankIntoTierBonus) rather than each pick's own
  // fractional win probability — see that function's own comment for why.
  const TIER_VALUES = [10, 7, 5, 3, 2];
  const CHAMPIONSHIP_TITLE = { NFL: 'Super Bowl', NBA: 'NBA Finals', MLB: 'World Series', NHL: 'Stanley Cup', MLS: 'MLS Cup' };
  // NBA/NHL: the bonus THIS pick can still earn isn't from a bracket
  // that's still being played out. Per update-sports.js's own FIX 4
  // comment, base scoring for NBA/NHL runs the NEW season (their
  // Oct–Feb activeMonths) while bonus comes from the PRECEDING season's
  // playoffs — always fully over by the time that new-season window
  // opens. Modeling fresh odds for a different, not-yet-run future
  // bracket and adding it on top of an already-settled bonus would be
  // actively wrong, not just redundant, so there's no odds lookup at all
  // while that window is open: the real recorded actual_bonus (whatever
  // the commissioner already has in the picks table) is the final
  // answer, same as a commissioner-locked field.
  if ((league === 'NBA' || league === 'NHL') && isSportBaseActive(league)) return null;
  const title = CHAMPIONSHIP_TITLE[league];
  if (!title) return null;
  return { kind: 'tierLadder', titleKeyword: title, tierValues: TIER_VALUES, tierLabels: SPORT_TIER_LABELS[league], mode: 'replace' };
}

// Exported for local unit testing of the pure math core (see
// scripts/test-projections-math.js) — not used by the Vercel handler.
module.exports.__testing = { rankToPoints, simulateCategory, percentile, sampleNormal, sampleBinomial, gaussian };
