/**
 * Fantasy Life — Daily Stock Price Updater
 * Respects commissioner locks from seasons.locks column.
 *
 * Tiebreaker: stocks with the same % change split/average the base points
 * they collectively occupy.
 * e.g. 2-way tie for ranks 1–2 out of 12 = (12+11)/2 = 11.5 each
 */
 
const { createClient } = require('@supabase/supabase-js');
 
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
 
async function fetchPrice(ticker) {
  try {
    // Yahoo Finance uses dashes not dots for class shares (e.g. BRK.B must be BRK-B)
    var yahooTicker = ticker.replace(/\./g, '-');
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + yahooTicker + '?interval=1d&range=1d';
    var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) { console.error('Yahoo Finance HTTP ' + res.status + ' for ' + ticker); return null; }
    var data = await res.json();
    var meta = data?.chart?.result?.[0]?.meta;
    if (!meta) { console.error('No meta data for ' + ticker); return null; }
    return meta.regularMarketPrice || meta.previousClose || null;
  } catch (err) { console.error('Failed to fetch ' + ticker + ':', err.message); return null; }
}
 
module.exports = async function handler(req, res) {
  var authHeader = req.headers['authorization'], cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== 'Bearer ' + cronSecret) return res.status(401).json({ error: 'Unauthorized' });
  if (!SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });
 
  var supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log('📈 Fetching stock prices...\n');
 
  var { data: season } = await supabase.from('seasons').select('year, locks').eq('status', 'active').single();
  if (!season) return res.status(200).json({ message: 'No active season found, skipping' });
 
  var seasonYear = season.year, locks = season.locks || {};
 
  var { data: membersArr } = await supabase.from('members').select('id, name');
  var memberNameById = {};
  (membersArr || []).forEach(function(m) { memberNameById[m.id] = m.name; });
 
  var { data: picks, error: pickErr } = await supabase.from('picks').select('id, member_id, pick').eq('season_year', seasonYear).eq('category', 'Stock');
  if (pickErr || !picks || picks.length === 0) return res.status(200).json({ message: 'No Stock picks found, skipping' });
 
  var pickIds = picks.map(function(p) { return p.id; });
  var { data: stockRows } = await supabase.from('stock_prices').select('pick_id, open_price').in('pick_id', pickIds);
  var openPriceByPickId = {};
  (stockRows || []).forEach(function(s) { openPriceByPickId[s.pick_id] = Number(s.open_price); });
 
  var priceResults = [];
 
  for (var pick of picks) {
    var ticker = pick.pick;
    var openPrice = openPriceByPickId[pick.id];
    if (openPrice == null || openPrice === 0) { console.warn('  ' + ticker + ': No open price or open price is 0 — skipping (check stock_prices table)'); continue; }
    var closePrice = await fetchPrice(ticker);
    if (closePrice === null) { console.warn('  ' + ticker + ': Failed to fetch — preserving existing'); continue; }
    var pctChange = ((closePrice - openPrice) / openPrice) * 100;
    priceResults.push({ ...pick, openPrice: openPrice, closePrice: closePrice, pctChange: pctChange });
    console.log('  ' + ticker + ': $' + openPrice.toFixed(2) + ' → $' + closePrice.toFixed(2) + ' (' + (pctChange >= 0 ? '+' : '') + pctChange.toFixed(2) + '%)');
  }
 
  if (priceResults.length === 0) return res.status(200).json({ message: 'No prices fetched, existing scores preserved' });
 
  // Sort descending by pctChange, then apply tiebreaker
  priceResults.sort(function(a, b) { return b.pctChange - a.pctChange; });
  priceResults = assignBasePointsWithTiebreaker(priceResults, picks.length);
 
  var updated = 0, rankings = [];
 
  for (var r of priceResults) {
    var ownerName = memberNameById[r.member_id] || r.member_id;
    var baseLocked = isFieldLocked(locks, 'Stock', ownerName, 'base');
    var metricLocked = isFieldLocked(locks, 'Stock', ownerName, 'metric');
 
    var pickUpdate = { updated_at: new Date().toISOString() };
    if (!baseLocked) { pickUpdate.base = r.newBase; pickUpdate.bonus = 0; }
    if (!metricLocked) pickUpdate.metric = Math.round(r.pctChange * 100) / 100;
 
    var skipped = [];
    if (baseLocked) skipped.push('base');
    if (metricLocked) skipped.push('metric');
    if (skipped.length > 0) console.log('  ' + ownerName + ': skipped locked: ' + skipped.join(', '));
 
    var { error: pickUpdateErr } = await supabase.from('picks').update(pickUpdate).eq('id', r.id);
    if (pickUpdateErr) { console.error('  Failed to update pick ' + r.member_id + ':', pickUpdateErr.message); continue; }
 
    var { error: stockUpdateErr } = await supabase.from('stock_prices').update({ close_price: r.closePrice }).eq('pick_id', r.id);
    if (stockUpdateErr) { console.error('  Failed to update stock_prices ' + r.member_id + ':', stockUpdateErr.message); continue; }
 
    updated++;
    rankings.push({ rank: r.rank, member: r.member_id, ticker: r.pick, openPrice: r.openPrice.toFixed(2), closePrice: r.closePrice.toFixed(2), pctChange: r.pctChange.toFixed(2) + '%', basePoints: baseLocked ? 'locked' : r.newBase, lockedFields: skipped.length > 0 ? skipped : undefined });
  }
 
  console.log('\n✅ Updated ' + updated + '/' + priceResults.length + ' stock scores');
  return res.status(200).json({ message: 'Updated ' + updated + '/' + priceResults.length + ' stock scores', season: seasonYear, timestamp: new Date().toISOString(), rankings: rankings });
};
