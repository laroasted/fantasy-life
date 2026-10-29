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
async function findPolymarketProbability(titleKeyword, outcomeKeyword) {
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

  const needle = outcomeKeyword.toLowerCase();
  let marketsScanned = 0;
  for (const ev of events) {
    const markets = ev.markets || [];
    for (const m of markets) {
      marketsScanned++;
      const question = (m.question || m.groupItemTitle || m.title || '').toLowerCase();
      if (!question.includes(needle)) continue;
      try {
        const outcomes = JSON.parse(m.outcomes || '[]');
        const prices = JSON.parse(m.outcomePrices || '[]');
        const yesIdx = outcomes.findIndex((o) => String(o).toLowerCase() === 'yes');
        const price = yesIdx >= 0 ? parseFloat(prices[yesIdx]) : parseFloat(prices[0]);
        if (!isNaN(price)) return { prob: clamp(price, 0, 1), reason: 'matched' };
      } catch (e) { /* malformed market payload — skip, don't guess */ }
    }
  }
  return { prob: null, reason: events.length + '_events_' + marketsScanned + '_markets_none_matched_outcome(' + outcomeKeyword + ')' };
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
        });
      });

      if (bonusConfig) {
        // Match on the PICKED TEAM/ATHLETE/ARTIST's name, never the
        // league member's — a championship market's outcome text says
        // "Kansas City Chiefs", never "LaRosa". Keyed by ownerName in the
        // result map only because attachBonusSampler looks it up that way
        // (one pick per owner per category).
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
            const found = await findChampionshipProbability(bonusConfig.titleKeyword, m.pickName, bonusConfig.kalshiSeriesGuess);
            bonusProbByOwner[m.ownerName] = found.prob;
            if (found.prob === null && !bonusDiagnostic) bonusDiagnostic = found.reason;
          } catch (e) { bonusProbByOwner[m.ownerName] = null; if (!bonusDiagnostic) bonusDiagnostic = 'exception:' + e.message; }
          await delay(150);
        }
        models = attachBonusSampler(models, bonusProbByOwner, bonusConfig.bonusPointsIfWin);
        // See attachBonusSampler's own comment — this is a real, named
        // limitation, not an implementation detail to bury.
        models = models.map((m) => Object.assign({}, m, {
          sourceNote: m.sourceNote + '|bonus_ev_models_title_win_only|odds_lookup:' + (bonusDiagnostic || 'matched'),
        }));
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
          sourceDetail: model.sourceNote, simulations: N_SIMS,
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

  async function runStatic(category, method, confidence) {
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
      method, confidence, sourceDetail: method === 'trend_only' ? 'stock_price_not_modeled_see_design_doc' : 'gdp_forecast_is_already_static',
      simulations: 0,
    }));
    const written = await upsertProjections(supabase, seasonYear, category, rows);
    results[category] = { status: 'ok', written, total: picks.length };
    await logRun(supabase, seasonYear, category, 'ok', { written }, startedAt);
  }

  // ── Win%-based sports ──
  for (const league of ['NFL', 'NBA', 'MLB']) {
    await runCategory(league, 'desc',
      (picks) => buildWinPctModel(picks, league, seasonYear, locks, ownerNameById, pastDeadline),
      bonusConfigFor(league));
  }
  // ── Points-based sports ──
  for (const league of ['NHL', 'MLS']) {
    await runCategory(league, 'desc', (picks) => buildPointsRateModel(picks, league, ownerNameById), bonusConfigFor(league));
  }
  // ── College (AP poll, not the same accumulation shape as pro sports) ──
  await runCategory('NCAAF', 'desc', (picks) => buildCollegeRankingModel(picks, 'NCAAF', ownerNameById),
    { titleKeyword: 'College Football Playoff', kalshiSeriesGuess: null, bonusPointsIfWin: 10 });
  await runCategory('NCAAB', 'desc', (picks) => buildCollegeRankingModel(picks, 'NCAAB', ownerNameById),
    { titleKeyword: 'NCAA Tournament', kalshiSeriesGuess: null, bonusPointsIfWin: 10 });
  // ── Individual-ranking sports ──
  await runCategory('Tennis', 'desc', (picks) => buildRankingPointsModel(picks, 'Tennis', ownerNameById),
    remainingEventsThisMonth('Tennis') > 0
      ? { titleKeyword: 'Grand Slam', kalshiSeriesGuess: null, bonusPointsIfWin: 5 }
      : null);
  await runCategory('Golf', 'asc', (picks) => buildRankingPointsModel(picks, 'Golf', ownerNameById), null);
  // F1's real bonus rule (CATEGORY_BONUS_RULES.F1 in
  // src/constants/categories.js) is per-podium across 4 SPECIFIC featured
  // races (AUS/MIA/ATX/LV), accumulating up to 12 — NOT a single
  // season-championship bonus. A generic "who wins the F1 championship"
  // market (which is what a bonusConfig here would search for) models
  // the wrong event entirely. Most of those 4 races are already run by
  // this point in the season, so the already-banked bonus (held flat by
  // the default in runCategory) is close to final anyway. Not attempting
  // a Las-Vegas-GP-podium-specific odds search — that needs a narrower,
  // unverified market match this build can't confirm — so F1 gets no
  // bonusConfig, same as Golf.
  await runCategory('F1', 'desc', (picks) => buildRankingPointsModel(picks, 'F1', ownerNameById), null);
  // ── Entertainment ──
  await runCategory('Actor', 'desc', (picks) => buildFilmModel(picks, fyEnd, ownerNameById, pastDeadline, avgRtByPickId),
    { titleKeyword: 'Academy Awards', kalshiSeriesGuess: null, bonusPointsIfWin: 10 });
  await runCategory('Actress', 'desc', (picks) => buildFilmModel(picks, fyEnd, ownerNameById, pastDeadline, avgRtByPickId),
    { titleKeyword: 'Academy Awards', kalshiSeriesGuess: null, bonusPointsIfWin: 10 });
  // ── Musician ──
  await runCategory('Musician', 'desc', (picks) => buildMusicianModel(picks, fyStart, fyEnd, ownerNameById),
    { titleKeyword: 'Grammy', kalshiSeriesGuess: null, bonusPointsIfWin: 7 });
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

function bonusConfigFor(league) {
  const CHAMPIONSHIP_TITLE = { NFL: 'Super Bowl', NBA: 'NBA Finals', MLB: 'World Series', NHL: 'Stanley Cup', MLS: 'MLS Cup' };
  const BONUS_IF_WIN = { NFL: 10, NBA: 10, MLB: 10, NHL: 10, MLS: 10 };
  const title = CHAMPIONSHIP_TITLE[league];
  if (!title) return null;
  return { titleKeyword: title, kalshiSeriesGuess: null, bonusPointsIfWin: BONUS_IF_WIN[league] };
}

// Exported for local unit testing of the pure math core (see
// scripts/test-projections-math.js) — not used by the Vercel handler.
module.exports.__testing = { rankToPoints, simulateCategory, percentile, sampleNormal, sampleBinomial, gaussian };
