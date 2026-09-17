/**
 * Fantasy Life — Daily Score History Snapshot
 *
 * Runs once a day, after the sports/college/events crons, and writes one
 * score_history row per member per category for the active season. This
 * is what powers the Trends tab's standings-over-time chart.
 *
 * Read-only with respect to `picks` — this job never mutates scores, it
 * only records what they were at snapshot time. Safe to re-run: rows are
 * upserted on (season_year, snapshot_date, member_id, category), so a
 * duplicate run for the same day just overwrites that day's snapshot.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

module.exports = async function handler(req, res) {
  var authHeader = req.headers['authorization'], cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== 'Bearer ' + cronSecret) return res.status(401).json({ error: 'Unauthorized' });
  if (!SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });

  var supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log('📸 Snapshotting scores...\n');

  var { data: season } = await supabase.from('seasons').select('year').eq('status', 'active').single();
  if (!season) return res.status(200).json({ message: 'No active season found, skipping' });

  var seasonYear = season.year;
  var snapshotDate = new Date().toISOString().slice(0, 10); // UTC yyyy-mm-dd

  var { data: picks, error: pickErr } = await supabase
    .from('picks')
    .select('member_id, category, base, bonus, total')
    .eq('season_year', seasonYear);

  if (pickErr) return res.status(500).json({ error: 'Failed to fetch picks: ' + pickErr.message });
  if (!picks || picks.length === 0) return res.status(200).json({ message: 'No picks found for season ' + seasonYear + ', skipping' });

  var rows = picks.map(function (p) {
    return {
      season_year: seasonYear,
      snapshot_date: snapshotDate,
      member_id: p.member_id,
      category: p.category,
      base: Number(p.base) || 0,
      bonus: Number(p.bonus) || 0,
      total: Number(p.total) || 0,
    };
  });

  var { error: upsertErr } = await supabase
    .from('score_history')
    .upsert(rows, { onConflict: 'season_year,snapshot_date,member_id,category' });

  if (upsertErr) return res.status(500).json({ error: 'Failed to write score_history: ' + upsertErr.message });

  console.log('✅ Snapshotted ' + rows.length + ' rows for ' + seasonYear + ' on ' + snapshotDate);
  return res.status(200).json({
    message: 'Snapshotted ' + rows.length + ' rows',
    season: seasonYear,
    date: snapshotDate,
  });
};
