/**
 * Fantasy Life — Daily Stock Price Updater
 *
 * Vercel Cron Job: runs daily at 9pm ET (after market close)
 * Fetches current prices from Yahoo Finance, recalculates % change,
 * re-ranks all members, and updates Supabase.
 *
 * Fully dynamic — pulls picks and open prices from Supabase,
 * so it works for any season without code changes.
 *
 * Deploy as: api/cron/update-stocks.js
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

/**
 * Fetch current price from Yahoo Finance
 */
async function fetchPrice(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    if (!res.ok) {
      console.error(`Yahoo Finance HTTP ${res.status} for ${ticker}`);
      return null;
    }

    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) {
      console.error(`No meta data for ${ticker}`);
      return null;
    }

    return meta.regularMarketPrice || meta.previousClose || null;
  } catch (err) {
    console.error(`Failed to fetch ${ticker}:`, err.message);
    return null;
  }
}

module.exports = async function handler(req, res) {
  // Auth check
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  console.log('📈 Fetching stock prices...\n');

  // 1. Find the active season
  const { data: season } = await supabase
    .from('seasons')
    .select('year')
    .eq('status', 'active')
    .single();

  if (!season) {
    return res.status(200).json({ message: 'No active season found, skipping' });
  }

  const seasonYear = season.year;

  // 2. Get all Stock picks + their open prices from Supabase
  const { data: picks, error: pickErr } = await supabase
    .from('picks')
    .select('id, member_id, pick')
    .eq('season_year', seasonYear)
    .eq('category', 'Stock');

  if (pickErr || !picks || picks.length === 0) {
    return res.status(200).json({ message: 'No Stock picks found, skipping' });
  }

  // Get open prices from stock_prices table
  const pickIds = picks.map(p => p.id);
  const { data: stockRows } = await supabase
    .from('stock_prices')
    .select('pick_id, open_price')
    .in('pick_id', pickIds);

  const openPriceByPickId = {};
  (stockRows || []).forEach(s => {
    openPriceByPickId[s.pick_id] = Number(s.open_price);
  });

  // 3. Fetch current prices for all tickers
  const results = [];

  for (const pick of picks) {
    const ticker = pick.pick;
    const openPrice = openPriceByPickId[pick.id];

    if (!openPrice) {
      console.warn(`  ${ticker}: No open price in DB — skipping`);
      continue;
    }

    const closePrice = await fetchPrice(ticker);

    if (closePrice === null) {
      console.warn(`  ${ticker}: Failed to fetch price — preserving existing score`);
      continue;
    }

    const pctChange = ((closePrice - openPrice) / openPrice) * 100;
    results.push({
      ...pick,
      openPrice,
      closePrice,
      pctChange,
    });

    console.log(`  ${ticker}: $${openPrice.toFixed(2)} → $${closePrice.toFixed(2)} (${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(2)}%)`);
  }

  if (results.length === 0) {
    return res.status(200).json({ message: 'No prices fetched successfully, existing scores preserved' });
  }

  // 4. Rank by % change (highest = rank 1 = most base points)
  results.sort((a, b) => b.pctChange - a.pctChange);

  const totalMembers = picks.length;

  // 5. Update Supabase
  let updated = 0;
  const rankings = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const basePoints = totalMembers - i;

    // Update picks table
    const { error: pickUpdateErr } = await supabase
      .from('picks')
      .update({
        base: basePoints,
        bonus: 0,
        metric: Math.round(r.pctChange * 100) / 100,
        updated_at: new Date().toISOString(),
      })
      .eq('id', r.id);

    if (pickUpdateErr) {
      console.error(`  Failed to update pick ${r.member_id}:`, pickUpdateErr.message);
      continue;
    }

    // Update stock_prices table
    const { error: stockUpdateErr } = await supabase
      .from('stock_prices')
      .update({ close_price: r.closePrice })
      .eq('pick_id', r.id);

    if (stockUpdateErr) {
      console.error(`  Failed to update stock_prices ${r.member_id}:`, stockUpdateErr.message);
      continue;
    }

    updated++;
    rankings.push({
      rank: i + 1,
      member: r.member_id,
      ticker: r.pick,
      openPrice: r.openPrice.toFixed(2),
      closePrice: r.closePrice.toFixed(2),
      pctChange: r.pctChange.toFixed(2) + '%',
      basePoints,
    });
  }

  const summary = {
    message: `Updated ${updated}/${results.length} stock scores`,
    season: seasonYear,
    timestamp: new Date().toISOString(),
    rankings,
  };

  console.log(`\n✅ ${summary.message}`);
  return res.status(200).json(summary);
};