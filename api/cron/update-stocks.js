/**
* Fantasy Life — Daily Stock Price Updater
* 
* Vercel Cron Job: runs daily at 9pm ET (after market close)
* Fetches current prices from Yahoo Finance, recalculates % change,
* re-ranks all 11 members, and updates Supabase.
* 
* Deploy as: api/cron/update-stocks.js
*/

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const SEASON_YEAR = 2025;

// Open prices locked on 3/14/25 — these never change
const OPEN_PRICES = {
 ORCL: 149.27,
 SE: 127.43,
 AMZN: 197.76,
 NVDA: 121.67,
 LB: 72.57,
 XOM: 111.90,
 TSLA: 239.98,
 META: 600.31,
 HIMS: 33.14,
 PATH: 10.88,
 SBDS: 9.42,
};

const TICKERS = Object.keys(OPEN_PRICES);

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

  // regularMarketPrice is the most current price
  return meta.regularMarketPrice || meta.previousClose || null;
 } catch (err) {
  console.error(`Failed to fetch ${ticker}:`, err.message);
  return null;
 }
}

module.exports = async function handler(req, res) {
 // Verify this is a cron call or authorized request
 const authHeader = req.headers['authorization'];
 const cronSecret = process.env.CRON_SECRET;
 if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
  return res.status(401).json({ error: 'Unauthorized' });
 }

 if (!SUPABASE_SERVICE_KEY) {
  return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });
 }

 const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

 console.log(' Fetching stock prices...');

 // 1. Fetch all current prices
 const prices = {};
 for (const ticker of TICKERS) {
  const price = await fetchPrice(ticker);
  if (price !== null) {
   prices[ticker] = price;
   console.log(` ${ticker}: $${price.toFixed(2)}`);
  } else {
   console.warn(` ${ticker}: FAILED — will skip`);
  }
 }

 if (Object.keys(prices).length === 0) {
  return res.status(500).json({ error: 'No prices fetched' });
 }

 // 2. Get all Stock picks for this season
 const { data: picks, error: pickErr } = await supabase
  .from('picks')
  .select('id, member_id, pick')
  .eq('season_year', SEASON_YEAR)
  .eq('category', 'Stock');

 if (pickErr || !picks) {
  return res.status(500).json({ error: 'Failed to fetch picks', detail: pickErr?.message });
 }

 // 3. Calculate % change for each pick
 const results = picks.map((p) => {
  const ticker = p.pick; // "ORCL", "TSLA", etc.
  const openPrice = OPEN_PRICES[ticker];
  const closePrice = prices[ticker];

  if (!openPrice || !closePrice) {
   return { ...p, pctChange: null, closePrice: null };
  }

  const pctChange = ((closePrice - openPrice) / openPrice) * 100;
  return { ...p, pctChange, closePrice, openPrice };
 });

 // 4. Filter out any that failed, then rank by % change (highest = rank 1)
 const valid = results.filter((r) => r.pctChange !== null);
 valid.sort((a, b) => b.pctChange - a.pctChange);

 const totalMembers = 11; // always 11 for base point calculation

 // 5. Update Supabase — picks table + stock_prices table
 let updated = 0;
 for (let i = 0; i < valid.length; i++) {
  const r = valid[i];
  const basePoints = totalMembers - i; // 11 for #1, 10 for #2, etc.

  // Update picks table (base, bonus=0, metric=pctChange)
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
   console.error(`Failed to update pick ${r.member_id}:`, pickUpdateErr.message);
   continue;
  }

  // Update stock_prices table (close_price, note)
  const { error: stockUpdateErr } = await supabase
   .from('stock_prices')
   .update({
    close_price: r.closePrice,
   })
   .eq('pick_id', r.id);

  if (stockUpdateErr) {
   console.error(`Failed to update stock_prices ${r.member_id}:`, stockUpdateErr.message);
   continue;
  }

  updated++;
  console.log(` #${i + 1} ${r.member_id} (${r.pick}): ${r.pctChange >= 0 ? '+' : ''}${r.pctChange.toFixed(2)}% → ${basePoints} pts`);
 }

 const summary = {
  message: `Updated ${updated}/${valid.length} stock scores`,
  timestamp: new Date().toISOString(),
  rankings: valid.map((r, i) => ({
   rank: i + 1,
   member: r.member_id,
   ticker: r.pick,
   closePrice: r.closePrice?.toFixed(2),
   pctChange: r.pctChange?.toFixed(2) + '%',
   basePoints: totalMembers - i,
  })),
 };

 console.log(`\n ${summary.message}`);
 return res.status(200).json(summary);
};