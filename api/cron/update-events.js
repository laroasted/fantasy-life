/**
 * Fantasy Life — Tennis, Golf, F1 Rankings Updater
 *
 * Updates base points from world rankings / season standings.
 * Each category has a freeze date after which scores lock.
 *
 * - Tennis: ATP ranking points (higher = better). Freezes Jan 31 (post AO).
 * - Golf: OWGR ranking position (lower = better). Freezes Aug 31 (post TOUR Champ).
 * - F1: Season driver points (higher = better). Freezes Dec 15 (season end).
 *
 * Bonus points are NEVER touched.
 *
 * Deploy as: api/cron/update-events.js
 * Schedule: daily at 4 AM UTC (11 PM ET)
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const EVENT_LEAGUES = {
  Tennis: {
    url: 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/rankings',
    metricType: 'points',       // ATP ranking points — higher = better
    sortDirection: 'desc',      // highest points = rank 1
    activeStart: { month: 2, day: 1 },   // Feb 1
    freezeDate: { month: 1, day: 31 },   // Jan 31 (cross-year: active Feb→Jan)
  },
  Golf: {
    url: 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/rankings',
    metricType: 'position',     // OWGR position — lower = better
    sortDirection: 'asc',       // lowest position = rank 1
    activeStart: { month: 1, day: 1 },
    freezeDate: { month: 8, day: 31 },   // Aug 31 (post TOUR Championship)
  },
  F1: {
    url: 'https://site.api.espn.com/apis/site/v2/sports/racing/f1/standings',
    metricType: 'points',       // season driver points — higher = better
    sortDirection: 'desc',
    activeStart: { month: 3, day: 1 },
    freezeDate: { month: 12, day: 15 },  // Dec 15 (season end)
  },
};

// Name aliases for matching
const NAME_ALIASES = {
  'Ludvig Åberg': 'Aberg',
  'Ludvig Aberg': 'Aberg',
};

/**
 * Check if today is within the active window
 */
function isActive(config) {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const today = month * 100 + day;

  const start = config.activeStart.month * 100 + config.activeStart.day;
  const freeze = config.freezeDate.month * 100 + config.freezeDate.day;

  if (start <= freeze) {
    return today >= start && today <= freeze;
  } else {
    // Cross-year window (Tennis: Feb→Jan)
    return today >= start || today <= freeze;
  }
}

/**
 * Fetch Tennis ATP rankings from ESPN
 * Returns array of { name, points }
 */
async function fetchTennisRankings() {
  try {
    const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/tennis/atp/rankings', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    const data = await res.json();

    const rankings = data?.rankings || [];
    // Find the main singles ranking
    const singlesRanking = rankings.find(r =>
      (r.name || '').toLowerCase().includes('singles') ||
      (r.name || '').toLowerCase().includes('atp') ||
      rankings.length === 1
    ) || rankings[0];

    if (!singlesRanking?.ranks) return null;

    return singlesRanking.ranks.map(entry => ({
      name: entry.athlete?.displayName || entry.athlete?.name || '',
      shortName: entry.athlete?.shortName || '',
      points: entry.points || entry.stat || 0,
      rank: entry.current || entry.rank || 0,
    }));
  } catch (err) {
    console.error('  Tennis fetch error:', err.message);
    return null;
  }
}

/**
 * Fetch Golf OWGR rankings from ESPN
 * Returns array of { name, position }
 */
async function fetchGolfRankings() {
  try {
    // Try the rankings endpoint first
    let res = await fetch('https://site.api.espn.com/apis/site/v2/sports/golf/pga/rankings', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    if (!res.ok) {
      // Fallback: try scraping the ESPN golf rankings page structure
      res = await fetch('https://site.web.api.espn.com/apis/site/v2/sports/golf/pga/rankings', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
    }

    if (!res.ok) return null;
    const data = await res.json();

    const rankings = data?.rankings || [];
    const mainRanking = rankings[0];
    if (!mainRanking?.ranks) return null;

    return mainRanking.ranks.map(entry => ({
      name: entry.athlete?.displayName || entry.athlete?.name || '',
      shortName: entry.athlete?.shortName || '',
      position: entry.current || entry.rank || 999,
    }));
  } catch (err) {
    console.error('  Golf fetch error:', err.message);
    return null;
  }
}

/**
 * Fetch F1 driver standings from ESPN
 * Returns array of { name, points }
 */
async function fetchF1Standings() {
  try {
    const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/racing/f1/standings', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    const data = await res.json();

    // F1 standings structure: children[] → standings → entries[]
    const drivers = [];
    const children = data?.children || [];

    for (const group of children) {
      const entries = group?.standings?.entries || [];
      for (const entry of entries) {
        const athlete = entry?.athlete || entry?.team;
        if (!athlete) continue;

        const stats = entry?.stats || [];
        const ptsStat = stats.find(s =>
          s.name === 'points' || s.abbreviation === 'PTS'
        );

        drivers.push({
          name: athlete.displayName || athlete.name || '',
          shortName: athlete.shortName || '',
          points: ptsStat ? parseFloat(ptsStat.value || ptsStat.displayValue) : 0,
        });
      }
    }

    // Also try flat standings format
    if (drivers.length === 0) {
      const entries = data?.standings?.entries || [];
      for (const entry of entries) {
        const athlete = entry?.athlete || entry?.team;
        if (!athlete) continue;
        const stats = entry?.stats || [];
        const ptsStat = stats.find(s =>
          s.name === 'points' || s.abbreviation === 'PTS'
        );
        drivers.push({
          name: athlete.displayName || athlete.name || '',
          shortName: athlete.shortName || '',
          points: ptsStat ? parseFloat(ptsStat.value || ptsStat.displayValue) : 0,
        });
      }
    }

    return drivers.length > 0 ? drivers : null;
  } catch (err) {
    console.error('  F1 fetch error:', err.message);
    return null;
  }
}

/**
 * Match a pick name to an ESPN athlete name
 */
function matchAthlete(pickName, espnAthletes) {
  const pick = pickName.trim();
  const alias = NAME_ALIASES[pick];
  const searchTerms = alias ? [alias, pick] : [pick];

  for (const term of searchTerms) {
    const lower = term.toLowerCase();

    // Exact match
    const exact = espnAthletes.find(a =>
      a.name.toLowerCase() === lower
    );
    if (exact) return exact;

    // Last name match (most common for athletes)
    const lastName = lower.split(' ').pop();
    const lastNameMatch = espnAthletes.find(a => {
      const aLast = a.name.toLowerCase().split(' ').pop();
      return aLast === lastName;
    });
    if (lastNameMatch) return lastNameMatch;

    // Contains match
    const contains = espnAthletes.find(a =>
      a.name.toLowerCase().includes(lower) || lower.includes(a.name.toLowerCase())
    );
    if (contains) return contains;
  }

  return null;
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

  console.log('🎾⛳🏎️ Fantasy Life — Updating Event Rankings...\n');

  // Find active season
  const { data: season } = await supabase
    .from('seasons')
    .select('year')
    .eq('status', 'active')
    .single();

  if (!season) {
    return res.status(200).json({ message: 'No active season found, skipping' });
  }

  const seasonYear = season.year;
  const results = {};

  for (const [league, config] of Object.entries(EVENT_LEAGUES)) {
    console.log(`Processing ${league}...`);

    // Check freeze date
    if (!isActive(config)) {
      const freezeStr = `${config.freezeDate.month}/${config.freezeDate.day}`;
      console.log(`  ${league}: Frozen (past ${freezeStr}) — scores locked`);
      results[league] = { status: 'frozen', reason: `Past freeze date (${freezeStr})` };
      continue;
    }

    // 1. Get picks from Supabase
    const { data: picks, error: pickErr } = await supabase
      .from('picks')
      .select('id, member_id, pick, base, bonus')
      .eq('season_year', seasonYear)
      .eq('category', league);

    if (pickErr || !picks || picks.length === 0) {
      console.log(`  ${league}: No picks found, skipping`);
      results[league] = { status: 'skipped', reason: 'no picks' };
      continue;
    }

    // 2. Fetch rankings from ESPN
    let espnData = null;
    if (league === 'Tennis') espnData = await fetchTennisRankings();
    else if (league === 'Golf') espnData = await fetchGolfRankings();
    else if (league === 'F1') espnData = await fetchF1Standings();

    if (!espnData || espnData.length === 0) {
      console.log(`  ${league}: No ESPN data — preserving existing scores`);
      results[league] = { status: 'skipped', reason: 'no ESPN data' };
      continue;
    }

    console.log(`  ${league}: Found ${espnData.length} athletes/drivers`);

    // 3. Match picks to ESPN data
    const matched = [];

    for (const pick of picks) {
      const athlete = matchAthlete(pick.pick, espnData);

      let metric = 0;
      let record = 'Not found';

      if (athlete) {
        if (league === 'Golf') {
          metric = athlete.position || 999;
          record = `#${metric}`;
        } else {
          metric = athlete.points || 0;
          record = league === 'Tennis'
            ? `${metric.toLocaleString()} pts`
            : `${metric} pts`;
        }
      }

      matched.push({
        ...pick,
        espnName: athlete ? athlete.name : null,
        metric,
        record,
      });
    }

    // 4. Sort: Golf by position ascending (lower = better), others by points descending
    if (config.sortDirection === 'asc') {
      matched.sort((a, b) => a.metric - b.metric);
    } else {
      matched.sort((a, b) => b.metric - a.metric);
    }

    const totalMembers = picks.length;

    // 5. Update Supabase — base only
    let updated = 0;
    const rankings = [];

    for (let i = 0; i < matched.length; i++) {
      const m = matched[i];
      const newBase = totalMembers - i;

      const { error: updateErr } = await supabase
        .from('picks')
        .update({
          base: newBase,
          metric: m.metric,
          record: m.record,
          updated_at: new Date().toISOString(),
        })
        .eq('id', m.id);

      if (updateErr) {
        console.error(`  Failed to update ${m.member_id} (${m.pick}):`, updateErr.message);
        continue;
      }

      updated++;
      rankings.push({
        rank: i + 1,
        member: m.member_id,
        pick: m.pick,
        espnMatch: m.espnName || 'Not found',
        metric: m.metric,
        record: m.record,
        base: newBase,
        bonus: Number(m.bonus) || 0,
        total: newBase + (Number(m.bonus) || 0),
      });
    }

    console.log(`  ${league}: Updated ${updated}/${matched.length} picks`);
    results[league] = { status: 'updated', updated, total: picks.length, rankings };
  }

  const summary = {
    message: 'Event rankings update complete',
    season: seasonYear,
    timestamp: new Date().toISOString(),
    results,
  };

  console.log('\n✅ Done!');
  return res.status(200).json(summary);
};