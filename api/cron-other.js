const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TMDB_KEY = process.env.TMDB_API_KEY;
const MEMBERS = ["Adam","Dhruv","Marsh","Jordan","Alan","Evan","LaRosa","Jack","Mike","Danny","Auzy"];

// ── Paste the fetch functions from backend-scripts.js here ──
// fetchTennisRankings()
// fetchGolfRankings()
// fetchMusicianCredits()
// fetchActorScores() + fetchActressScores()
// fetchGDPGrowth()
// fetchStockPerformance()
// applyRotiScoring()

// ── Then the handler writes results to Supabase ──
module.exports = async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const log = [];
  const categories = [
    { name: "Tennis", fn: fetchTennisRankings },
    { name: "Golf", fn: fetchGolfRankings },
    { name: "Musician", fn: fetchMusicianCredits },
    { name: "Actor", fn: fetchActorScores },
    { name: "Actress", fn: fetchActressScores },
    { name: "Country", fn: fetchGDPGrowth },
    { name: "Stock", fn: fetchStockPerformance },
  ];

  for (const { name, fn } of categories) {
    try {
      const result = applyRotiScoring(await fn());
      if (!result?.data) { log.push({ cat: name, status: "no data" }); continue; }

      const rows = result.data.map(r => ({
        category: name, member: r.member, pick: r.pick,
        baseline: r.baseline, bonus: 0,
        metric: r.metric || "", raw_value: r.value || 0,
        record: "", source: result.source || name,
        updated_at: new Date().toISOString()
      }));

      const { error } = await supabase.from('scores').upsert(rows, { onConflict: 'category,member' });
      log.push({ cat: name, status: error ? "error" : "ok", count: rows.length, error: error?.message });
    } catch (e) {
      log.push({ cat: name, status: "error", error: e.message });
    }
  }

  return res.status(200).json({ message: "Other cron complete", log, timestamp: new Date().toISOString() });
};