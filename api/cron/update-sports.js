/**
* Fantasy Life — Daily Sports Standings Updater
* 
* Updates base points for NFL, NBA, NHL, MLB, MLS from ESPN standings.
* Bonus points are NEVER touched (locked from previous season playoffs).
* 
* - Pulls picks from Supabase (not hardcoded) — works for any season
* - Skips leagues in offseason gracefully
* - If any fetch fails, existing data is preserved
* 
* Deploy as: api/cron/update-sports.js
* Schedule: daily at 6 AM UTC (1 AM ET)
*/

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ESPN API endpoints for standings
// activeMonths: months (1-12) when the regular season is active and scores should update.
// Outside these months, the league is frozen and the cron skips it.
const ESPN_LEAGUES = {
 NFL: {
  url: 'https://site.api.espn.com/apis/v2/sports/football/nfl/standings',
  metric: 'winPercent',
  metricType: 'winpct',
  recordType: 'W-L',
  activeMonths: [9, 10, 11, 12, 1],    // Sep–Jan (regular season)
 },
 NBA: {
  url: 'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings',
  metric: 'winPercent',
  metricType: 'winpct',
  recordType: 'W-L',
  activeMonths: [10, 11, 12, 1, 2, 3, 4], // Oct–Apr
 },
 NHL: {
  url: 'https://site.api.espn.com/apis/v2/sports/hockey/nhl/standings',
  metric: 'points',
  metricType: 'points',
  recordType: 'pts',
  activeMonths: [10, 11, 12, 1, 2, 3, 4], // Oct–Apr
 },
 MLB: {
  url: 'https://site.api.espn.com/apis/v2/sports/baseball/mlb/standings',
  metric: 'winPercent',
  metricType: 'winpct',
  recordType: 'W-L',
  activeMonths: [4, 5, 6, 7, 8, 9],    // Apr–Sep
 },
 MLS: {
  url: 'https://site.api.espn.com/apis/v2/sports/soccer/usa.1/standings',
  metric: 'points',
  metricType: 'points',
  recordType: 'pts',
  activeMonths: [3, 4, 5, 6, 7, 8, 9, 10], // Mar–Oct
 },
};

// Special name mappings for picks that don't fuzzy-match ESPN names
const NAME_ALIASES = {
 // NBA
 'T-Wolves': 'Timberwolves',
 'Wolves': 'Timberwolves',
 // NFL
 '49ers': 'San Francisco',
 // NHL
 // MLS
 'Red Bull': 'Red Bulls',
 'Atlanta': 'Atlanta United',
 'Columbus Crew': 'Columbus',
 'Vancouver': 'Whitecaps',
 'Philadelphia Union': 'Union',
 'San Diego FC': 'San Diego',
};

/**
* Fetch standings from ESPN for a given league.
* Returns array of { teamName, displayName, abbreviation, record, metric }
* Returns null if league is in offseason or fetch fails.
*/
async function fetchESPNStandings(league, config) {
 try {
  const res = await fetch(config.url, {
   headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  if (!res.ok) {
   console.log(` ${league}: ESPN returned ${res.status} — likely offseason, skipping`);
   return null;
  }

  const data = await res.json();

  // ESPN standings structure: children[] → standings → entries[]
  // Each entry has a team object and stats array
  const teams = [];

  // Handle different ESPN response formats
  const children = data?.children || [];
  if (children.length === 0) {
   // Some endpoints return a flat standings object
   const entries = data?.standings?.entries || [];
   if (entries.length === 0) {
    console.log(` ${league}: No standings data found — likely offseason`);
    return null;
   }
   for (const entry of entries) {
    const team = parseStandingsEntry(entry, config);
    if (team) teams.push(team);
   }
  } else {
   // Grouped by conference/division
   for (const group of children) {
    const entries = group?.standings?.entries || [];
    for (const entry of entries) {
     const team = parseStandingsEntry(entry, config);
     if (team) teams.push(team);
    }
    // Some have nested children (divisions within conferences)
    const subChildren = group?.children || [];
    for (const sub of subChildren) {
     const subEntries = sub?.standings?.entries || [];
     for (const entry of subEntries) {
      const team = parseStandingsEntry(entry, config);
      if (team) teams.push(team);
     }
    }
   }
  }

  if (teams.length === 0) {
   console.log(` ${league}: Parsed 0 teams — data format may have changed`);
   return null;
  }

  console.log(` ${league}: Found ${teams.length} teams`);
  return teams;
 } catch (err) {
  console.error(` ${league}: Fetch error — ${err.message}`);
  return null;
 }
}

/**
* Parse a single ESPN standings entry into our format
*/
function parseStandingsEntry(entry, config) {
 try {
  const team = entry?.team;
  if (!team) return null;

  const stats = entry?.stats || [];
  let metric = 0;
  let record = '';

  if (config.metricType === 'winpct') {
   // Find win percentage stat
   const wpStat = stats.find(s => s.name === 'winPercent' || s.abbreviation === 'PCT');
   metric = wpStat ? parseFloat(wpStat.value || wpStat.displayValue) : 0;

   // Find overall record
   const overallStat = stats.find(s => s.name === 'overall' || s.type === 'total');
   record = overallStat?.displayValue || '';
   if (!record) {
    const wins = stats.find(s => s.name === 'wins')?.value || 0;
    const losses = stats.find(s => s.name === 'losses')?.value || 0;
    record = `${wins}-${losses}`;
   }
  } else if (config.metricType === 'points') {
   // Find points stat (NHL/MLS standings points)
   const ptsStat = stats.find(s =>
    s.name === 'points' || s.abbreviation === 'PTS' || s.abbreviation === 'Pts'
   );
   metric = ptsStat ? parseFloat(ptsStat.value || ptsStat.displayValue) : 0;
   record = `${Math.round(metric)} pts`;
  }

  return {
   teamName: team.name || '',      // "Hawks", "Celtics"
   displayName: team.displayName || '', // "Atlanta Hawks", "Boston Celtics"
   abbreviation: team.abbreviation || '',// "ATL", "BOS"
   location: team.location || '',    // "Atlanta", "Boston"
   record,
   metric,
  };
 } catch (err) {
  return null;
 }
}

/**
* Match a Fantasy Life pick name to an ESPN team.
* Uses fuzzy matching: checks if ESPN team name/displayName contains the pick.
*/
function matchTeam(pickName, espnTeams) {
 const pick = pickName.trim();

 // Check aliases first
 const alias = NAME_ALIASES[pick];
 const searchTerms = alias ? [alias, pick] : [pick];

 for (const term of searchTerms) {
  const lower = term.toLowerCase();

  // Exact match on short name
  const exact = espnTeams.find(t =>
   t.teamName.toLowerCase() === lower
  );
  if (exact) return exact;

  // displayName contains pick
  const contains = espnTeams.find(t =>
   t.displayName.toLowerCase().includes(lower) ||
   t.teamName.toLowerCase().includes(lower) ||
   t.location.toLowerCase() === lower
  );
  if (contains) return contains;

  // Abbreviation match (e.g., "LAFC")
  const abbr = espnTeams.find(t =>
   t.abbreviation.toLowerCase() === lower
  );
  if (abbr) return abbr;
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

 console.log(' Fantasy Life — Updating Sports Standings...\n');

 // Find the active season
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
 const currentMonth = new Date().getMonth() + 1; // 1-12

 for (const [league, config] of Object.entries(ESPN_LEAGUES)) {
  console.log(`Processing ${league}...`);

  // Check if this league's regular season is currently active
  if (config.activeMonths && !config.activeMonths.includes(currentMonth)) {
   console.log(` ${league}: Offseason (month ${currentMonth} not in active window) — scores frozen`);
   results[league] = { status: 'frozen', reason: `Offseason — active months: ${config.activeMonths.join(',')}` };
   continue;
  }

  // 1. Get picks for this league from Supabase
  const { data: picks, error: pickErr } = await supabase
   .from('picks')
   .select('id, member_id, pick, base, bonus')
   .eq('season_year', seasonYear)
   .eq('category', league);

  if (pickErr || !picks || picks.length === 0) {
   console.log(` ${league}: No picks found for season ${seasonYear}, skipping`);
   results[league] = { status: 'skipped', reason: 'no picks' };
   continue;
  }

  // 2. Fetch standings from ESPN
  const espnTeams = await fetchESPNStandings(league, config);

  if (!espnTeams) {
   console.log(` ${league}: No ESPN data — preserving existing scores`);
   results[league] = { status: 'skipped', reason: 'no ESPN data (offseason?)' };
   continue;
  }

  // 3. Match picks to ESPN teams and get metrics
  const matched = [];
  const unmatched = [];

  for (const pick of picks) {
   const espnTeam = matchTeam(pick.pick, espnTeams);
   if (espnTeam) {
    matched.push({
     ...pick,
     espnTeam: espnTeam.displayName,
     record: espnTeam.record,
     metric: espnTeam.metric,
    });
   } else {
    unmatched.push(pick.pick);
    console.warn(`  Could not match "${pick.pick}" to any ESPN team`);
   }
  }

  if (matched.length === 0) {
   console.log(` ${league}: No picks matched ESPN teams — preserving existing scores`);
   results[league] = { status: 'skipped', reason: 'no matches', unmatched };
   continue;
  }

  // 4. Rank by metric (highest = rank 1 = most base points)
  matched.sort((a, b) => b.metric - a.metric);

  const totalMembers = picks.length; // usually 11

  // 5. Update Supabase — base points only, NEVER touch bonus
  let updated = 0;
  const rankings = [];

  for (let i = 0; i < matched.length; i++) {
   const m = matched[i];
   const newBase = totalMembers - i; // 11 for #1, 10 for #2, etc.

   const { error: updateErr } = await supabase
    .from('picks')
    .update({
     base: newBase,
     // bonus is NOT in this update — it stays untouched
     metric: Math.round(m.metric * 1000) / 1000,
     record: m.record,
     updated_at: new Date().toISOString(),
    })
    .eq('id', m.id);

   if (updateErr) {
    console.error(` Failed to update ${m.member_id} (${m.pick}):`, updateErr.message);
    continue;
   }

   updated++;
   rankings.push({
    rank: i + 1,
    member: m.member_id,
    pick: m.pick,
    espnMatch: m.espnTeam,
    record: m.record,
    metric: m.metric,
    base: newBase,
    bonus: Number(m.bonus) || 0,
    total: newBase + (Number(m.bonus) || 0),
   });
  }

  console.log(` ${league}: Updated ${updated}/${matched.length} picks`);
  results[league] = {
   status: 'updated',
   updated,
   total: picks.length,
   unmatched: unmatched.length > 0 ? unmatched : undefined,
   rankings,
  };
 }

 const summary = {
  message: 'Sports standings update complete',
  season: seasonYear,
  timestamp: new Date().toISOString(),
  results,
 };

 console.log('\n Done!');
 return res.status(200).json(summary);
};