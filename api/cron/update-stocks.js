/**
* Fantasy Life — Daily Stock Price Updater
* Respects commissioner locks from seasons.locks column.
*/

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function isFieldLocked(locks, category, ownerName, field) {
  return locks ? !!locks[category + '|' + ownerName + '|' + field] : false;
}

async function fetchPrice(ticker) {
  try {
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + ticker + '?interval=1d&range=1d';
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

  var results = [];

  for (var pick of picks) {
    var ticker = pick.pick;
    var openPrice = openPriceByPickId[pick.id];
    if (!openPrice) { console.warn('  ' + ticker + ': No open price — skipping'); continue; }
    var closePrice = await fetchPrice(ticker);
    if (closePrice === null) { console.warn('  ' + ticker + ': Failed to fetch — preserving existing'); continue; }
    var pctChange = ((closePrice - openPrice) / openPrice) * 100;
    results.push({ ...pick, openPrice: openPrice, closePrice: closePrice, pctChange: pctChange });
    console.log('  ' + ticker + ': $' + openPrice.toFixed(2) + ' → $' + closePrice.toFixed(2) + ' (' + (pctChange >= 0 ? '+' : '') + pctChange.toFixed(2) + '%)');
  }

  if (results.length === 0) return res.status(200).json({ message: 'No prices fetched, existing scores preserved' });

  results.sort(function(a, b) { return b.pctChange - a.pctChange; });
  var totalMembers = picks.length, updated = 0, rankings = [];

  for (var i = 0; i < results.length; i++) {
    var r = results[i], basePoints = totalMembers - i;
    var ownerName = memberNameById[r.member_id] || r.member_id;

    var baseLocked = isFieldLocked(locks, 'Stock', ownerName, 'base');
    var metricLocked = isFieldLocked(locks, 'Stock', ownerName, 'metric');

    var pickUpdate = { updated_at: new Date().toISOString() };
    if (!baseLocked) { pickUpdate.base = basePoints; pickUpdate.bonus = 0; }
    if (!metricLocked) pickUpdate.metric = Math.round(r.pctChange * 100) / 100;

    var skipped = [];
    if (baseLocked) skipped.push('base');
    if (metricLocked) skipped.push('metric');
    if (skipped.length > 0) console.log('  ' + ownerName + ': skipped locked: ' + skipped.join(', '));

    var { error: pickUpdateErr } = await supabase.from('picks').update(pickUpdate).eq('id', r.id);
    if (pickUpdateErr) { console.error('  Failed to update pick ' + r.member_id + ':', pickUpdateErr.message); continue; }

    // Stock prices table — update close price (not lockable, it's raw market data)
    var { error: stockUpdateErr } = await supabase.from('stock_prices').update({ close_price: r.closePrice }).eq('pick_id', r.id);
    if (stockUpdateErr) { console.error('  Failed to update stock_prices ' + r.member_id + ':', stockUpdateErr.message); continue; }

    updated++;
    rankings.push({ rank: i + 1, member: r.member_id, ticker: r.pick, openPrice: r.openPrice.toFixed(2), closePrice: r.closePrice.toFixed(2), pctChange: r.pctChange.toFixed(2) + '%', basePoints: baseLocked ? 'locked' : basePoints, lockedFields: skipped.length > 0 ? skipped : undefined });
  }

  console.log('\n✅ Updated ' + updated + '/' + results.length + ' stock scores');
  return res.status(200).json({ message: 'Updated ' + updated + '/' + results.length + ' stock scores', season: seasonYear, timestamp: new Date().toISOString(), rankings: rankings });
};