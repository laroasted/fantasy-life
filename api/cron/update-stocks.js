/**
 * Fantasy Life — Daily Stock Price Updater
 * Respects commissioner locks from seasons.locks column.
 *
 * Tiebreaker: stocks with the same % change split/average the base points
 * they collectively occupy.
 * e.g. 2-way tie for ranks 1–2 out of 12 = (12+11)/2 = 11.5 each
 *
 * Stock splits: pctChange is (closePrice - openPrice) / openPrice, where
 * openPrice is a snapshot taken once, at draft time, and never otherwise
 * touched. A forward N-for-1 split divides the live trading price by N
 * with zero real change to anyone's position — SNDK's 8-for-1 split
 * (effective 2026-11-20) turned a flat stock into an apparent ~-87.5% move
 * because openPrice was still carrying the pre-split price. fetchPrice()
 * below also asks Yahoo for any splits between openPrice's capture date
 * and today and rebases openPrice by the cumulative factor — the same
 * thing a brokerage does to your cost basis after a split — so this is a
 * one-time fix for SNDK and an evergreen one for every future split on
 * any ticker. See phase23_stock_split_adjustments.sql for the column this
 * uses to avoid re-applying a split it already folded in.
 */
 
const { createClient } = require('@supabase/supabase-js');
const { writeScoreEventsAndNotify } = require('../_lib/push');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
 
/**
 * Assigns base points with split/average tiebreaker logic.
 * Input array must already be sorted descending by pctChange before calling.
 *
 * Example — 2-way tie for 1st out of 12:
 *   (12+11) / 2 = 11.5 each
 */
function assignBasePointsWithTiebreaker(results, totalMembers) {
  var n = results.length;
  var i = 0;
  while (i < n) {
    var j = i;
    while (j < n && results[j].pctChange === results[i].pctChange) j++;
    var pointSum = 0;
    for (var p = i; p < j; p++) pointSum += (totalMembers - p);
    var avgPoints = Math.round((pointSum / (j - i)) * 100) / 100;
    for (var p = i; p < j; p++) {
      results[p].newBase = avgPoints;
      results[p].rank = i + 1;
    }
    i = j;
  }
  return results;
}
 
function isFieldLocked(locks, category, ownerName, field) {
  return locks ? !!locks[category + '|' + ownerName + '|' + field] : false;
}
 
/**
 * Fetches the current price, plus any stock splits between `sinceUnix`
 * (unix seconds — either the last split this pick already folded into its
 * open price, or its draft date if it's never had one) and now.
 *
 * Yahoo's chart API returns splits as `events.splits`, keyed by the
 * split's own unix timestamp, e.g. SNDK's 8-for-1:
 *   { "1795185000": { date: 1795185000, numerator: 8, denominator: 1 } }
 * A forward N-for-1 split has numerator=N, denominator=1 (reverse splits
 * are the same shape the other way round); the price-rebasing factor is
 * always denominator/numerator. Confirmed against SNDK's real numbers:
 * $776.22 pre-split * (1/8) = $97.03, its actual first post-split price.
 */
async function fetchPrice(ticker, sinceUnix) {
  try {
    // Yahoo Finance uses dashes not dots for class shares (e.g. BRK.B must be BRK-B)
    var yahooTicker = ticker.replace(/\./g, '-');
    var period1 = sinceUnix || (Math.floor(Date.now() / 1000) - 400 * 86400);
    var period2 = Math.floor(Date.now() / 1000) + 86400; // pad a day for clock skew
    // interval=1mo, not 1d: split events are metadata independent of bar
    // granularity (confirmed against Yahoo's real response), and this
    // window only ever grows over a season — daily bars would mean
    // fetching and parsing an ever-larger full-season OHLC history just
    // to check for splits, for every stock pick, on every single run.
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + yahooTicker
      + '?period1=' + period1 + '&period2=' + period2 + '&interval=1mo&events=split';
    var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) { console.error('Yahoo Finance HTTP ' + res.status + ' for ' + ticker); return null; }
    var data = await res.json();
    var result = data?.chart?.result?.[0];
    var meta = result?.meta;
    if (!meta) { console.error('No meta data for ' + ticker); return null; }
    var price = meta.regularMarketPrice || meta.previousClose || null;
    if (price === null) return null;
    var splitsByTimestamp = (result.events && result.events.splits) || {};
    var splits = Object.values(splitsByTimestamp).filter(function(s) { return !sinceUnix || s.date > sinceUnix; });
    return { price: price, splits: splits };
  } catch (err) { console.error('Failed to fetch ' + ticker + ':', err.message); return null; }
}
 
module.exports = async function handler(req, res) {
  var authHeader = req.headers['authorization'], cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== 'Bearer ' + cronSecret) return res.status(401).json({ error: 'Unauthorized' });
  if (!SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });
 
  var supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log('📈 Fetching stock prices...\n');
 
  var { data: season } = await supabase.from('seasons').select('year, locks, draft_date').eq('status', 'active').single();
  if (!season) return res.status(200).json({ message: 'No active season found, skipping' });

  var seasonYear = season.year, locks = season.locks || {};
  // Falls back to fetchPrice()'s own 400-day lookback if a season somehow
  // has no draft_date — never expected, but splits are rare enough that a
  // slightly-too-wide window of "did this split since draft" costs nothing.
  var draftDateUnix = season.draft_date ? Math.floor(new Date(season.draft_date).getTime() / 1000) : null;
 
  var { data: membersArr } = await supabase.from('members').select('id, name');
  var memberNameById = {};
  (membersArr || []).forEach(function(m) { memberNameById[m.id] = m.name; });
 
  var { data: picks, error: pickErr } = await supabase.from('picks').select('id, member_id, pick, base').eq('season_year', seasonYear).eq('category', 'Stock');
  if (pickErr || !picks || picks.length === 0) return res.status(200).json({ message: 'No Stock picks found, skipping' });
 
  var pickIds = picks.map(function(p) { return p.id; });
  var { data: stockRows } = await supabase.from('stock_prices').select('pick_id, open_price, split_adjusted_through, pre_split_open_price').in('pick_id', pickIds);
  var openPriceByPickId = {}, splitAdjustedThroughByPickId = {}, preSplitOpenPriceByPickId = {};
  (stockRows || []).forEach(function(s) {
    openPriceByPickId[s.pick_id] = Number(s.open_price);
    splitAdjustedThroughByPickId[s.pick_id] = s.split_adjusted_through;
    preSplitOpenPriceByPickId[s.pick_id] = s.pre_split_open_price == null ? null : Number(s.pre_split_open_price);
  });

  var priceResults = [];

  for (var pick of picks) {
    var ticker = pick.pick;
    var openPrice = openPriceByPickId[pick.id];
    if (openPrice == null || openPrice === 0) { console.warn('  ' + ticker + ': No open price or open price is 0 — skipping (check stock_prices table)'); continue; }
    // Where to start looking for splits: right after the last one this
    // pick already folded in, or its draft date if it's never had one.
    var splitCheckSince = splitAdjustedThroughByPickId[pick.id] || draftDateUnix;
    var fetched = await fetchPrice(ticker, splitCheckSince);
    if (fetched === null) { console.warn('  ' + ticker + ': Failed to fetch — preserving existing'); continue; }
    var closePrice = fetched.price;

    // Rebase openPrice for every split since the last check, oldest first,
    // and remember the latest one applied so a future run (Yahoo keeps
    // returning the same historical split forever) doesn't apply it again.
    var splitAdjustedThrough = splitAdjustedThroughByPickId[pick.id] || null;
    var preSplitOpenPrice = preSplitOpenPriceByPickId[pick.id];
    var splitNotes = [];
    fetched.splits.sort(function(a, b) { return a.date - b.date; }).forEach(function(s) {
      // Only the very first split this pick ever sees needs to record the
      // true original price — once set, never overwrite it again.
      if (preSplitOpenPrice == null) preSplitOpenPrice = openPrice;
      openPrice = openPrice * (s.denominator / s.numerator);
      splitAdjustedThrough = s.date;
      splitNotes.push(s.numerator + '-for-' + s.denominator + ' on ' + new Date(s.date * 1000).toISOString().slice(0, 10));
    });
    if (splitNotes.length > 0) console.log('  ' + ticker + ': split-adjusted open price for ' + splitNotes.join(', ') + ' → $' + openPrice.toFixed(2));

    var pctChange = ((closePrice - openPrice) / openPrice) * 100;
    priceResults.push({ ...pick, openPrice: openPrice, closePrice: closePrice, pctChange: pctChange, splitAdjustedThrough: splitAdjustedThrough, preSplitOpenPrice: preSplitOpenPrice == null ? null : preSplitOpenPrice });
    console.log('  ' + ticker + ': $' + openPrice.toFixed(2) + ' → $' + closePrice.toFixed(2) + ' (' + (pctChange >= 0 ? '+' : '') + pctChange.toFixed(2) + '%)');
  }
 
  if (priceResults.length === 0) return res.status(200).json({ message: 'No prices fetched, existing scores preserved' });
 
  // Sort descending by pctChange, then apply tiebreaker
  priceResults.sort(function(a, b) { return b.pctChange - a.pctChange; });
  priceResults = assignBasePointsWithTiebreaker(priceResults, picks.length);
 
  var updated = 0, rankings = [];
  // Collected across every stock pick, then batch-written once at the end
  // via writeScoreEventsAndNotify (api/_lib/push.js) — same pattern
  // update-sports.js established first. Deliberately diffs `base` ONLY,
  // never bonus: pickUpdate.bonus is unconditionally forced to 0 below
  // whenever base isn't locked (there's no real Stock bonus mechanism
  // behind it), so diffing it would generate a "bonus -X" score_events
  // row — and a push — on every run that just resets a leftover value,
  // not a real change. Confirmed with the user before building this.
  var scoreEvents = [];

  for (var r of priceResults) {
    var ownerName = memberNameById[r.member_id] || r.member_id;
    var baseLocked = isFieldLocked(locks, 'Stock', ownerName, 'base');
    var metricLocked = isFieldLocked(locks, 'Stock', ownerName, 'metric');
    // SeasonSettings.jsx's Stock editor also lets the commissioner lock
    // 'openPrice'/'closePrice' directly (its own detail-row fields,
    // distinct from base/metric above) — honor those the same way, so a
    // manual correction here can't be silently overwritten by this cron.
    var openPriceLocked = isFieldLocked(locks, 'Stock', ownerName, 'openPrice');
    var closePriceLocked = isFieldLocked(locks, 'Stock', ownerName, 'closePrice');

    var pickUpdate = { updated_at: new Date().toISOString() };
    if (!baseLocked) { pickUpdate.base = r.newBase; pickUpdate.bonus = 0; }
    if (!metricLocked) pickUpdate.metric = Math.round(r.pctChange * 100) / 100;

    var skipped = [];
    if (baseLocked) skipped.push('base');
    if (metricLocked) skipped.push('metric');
    if (openPriceLocked) skipped.push('openPrice');
    if (closePriceLocked) skipped.push('closePrice');
    if (skipped.length > 0) console.log('  ' + ownerName + ': skipped locked: ' + skipped.join(', '));
 
    // Optimistic concurrency on `base` (the only field this diffs into a
    // score event — see the scoreEvents comment above) — same reasoning
    // and same fix as update-sports.js's equivalent comment: without
    // conditioning this UPDATE on the pre-update value just read
    // (r.base), two near-simultaneous invocations of this cron (the
    // scheduled run and a visitor's manual Refresh via
    // api/refresh-all.js, or a retried Vercel cron trigger) both compute
    // the same new base from the same fetched price and both push their
    // own score_events row for the same real change. Whichever commits
    // first changes `base` away from what this invocation read, so a
    // second invocation's conditional UPDATE matches zero rows.
    var pickUpdateQuery = supabase.from('picks').update(pickUpdate).eq('id', r.id);
    if (!baseLocked) pickUpdateQuery = pickUpdateQuery.eq('base', r.base);
    var { data: updatedPickRows, error: pickUpdateErr } = await pickUpdateQuery.select('id');
    if (pickUpdateErr) { console.error('  Failed to update pick ' + r.member_id + ':', pickUpdateErr.message); continue; }
    if (!updatedPickRows || updatedPickRows.length === 0) {
      console.log('  ' + r.member_id + ': base changed under us (a concurrent run already applied this) — skipping duplicate score event');
      continue;
    }

    var stockUpdate = {};
    if (!closePriceLocked) stockUpdate.close_price = r.closePrice;
    if (!openPriceLocked) {
      stockUpdate.open_price = r.openPrice;
      stockUpdate.split_adjusted_through = r.splitAdjustedThrough;
      // Record the true pre-split price once, the first time a split is
      // ever applied, so rebasing open_price for comparison against
      // closePrice doesn't permanently erase what was actually drafted.
      if (r.preSplitOpenPrice !== null) stockUpdate.pre_split_open_price = r.preSplitOpenPrice;
    }
    var { error: stockUpdateErr } = await supabase.from('stock_prices').update(stockUpdate).eq('pick_id', r.id);
    if (stockUpdateErr) { console.error('  Failed to update stock_prices ' + r.member_id + ':', stockUpdateErr.message); continue; }

    updated++;

    // base-only diff against the pre-update row (r.base) — see the
    // scoreEvents comment above for why bonus is deliberately excluded.
    // A locked base means pickUpdate.base was never set, so newBaseVal
    // === r.base and delta is naturally 0, no special case needed to
    // skip locked no-ops.
    var newBaseVal = baseLocked ? (Number(r.base) || 0) : (Number(r.newBase) || 0);
    var delta = Math.round((newBaseVal - (Number(r.base) || 0)) * 10) / 10;
    if (delta !== 0) {
      scoreEvents.push({
        season_year: seasonYear,
        member_id: r.member_id,
        category: 'Stock',
        delta: delta,
        cause: r.pick + ' ' + (r.pctChange >= 0 ? '+' : '') + r.pctChange.toFixed(2) + '% ($' + r.openPrice.toFixed(2) + ' → $' + r.closePrice.toFixed(2) + ')',
        source: 'update-stocks',
      });
    }

    rankings.push({ rank: r.rank, member: r.member_id, ticker: r.pick, openPrice: r.openPrice.toFixed(2), closePrice: r.closePrice.toFixed(2), pctChange: r.pctChange.toFixed(2) + '%', basePoints: baseLocked ? 'locked' : r.newBase, lockedFields: skipped.length > 0 ? skipped : undefined });
  }

  await writeScoreEventsAndNotify(supabase, scoreEvents, memberNameById);

  console.log('\n✅ Updated ' + updated + '/' + priceResults.length + ' stock scores');
  return res.status(200).json({ message: 'Updated ' + updated + '/' + priceResults.length + ' stock scores', season: seasonYear, timestamp: new Date().toISOString(), rankings: rankings });
};
