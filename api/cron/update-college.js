/**
* Fantasy Life — NCAAF & NCAAB AP Rankings Updater
* 
* Updates base points from AP Top 25 poll points.
* Each category has a hard freeze date after which scores lock.
* 
* - NCAAF: Active Aug 15 → Dec 9 (freezes before CFP)
* - NCAAB: Active Nov 1 → Mar 5 (freezes before March Madness)
* 
* Teams outside the AP Top 25 get 0 AP points.
* Bonus points are NEVER touched (locked from playoff results).
* 
* Deploy as: api/cron/update-college.js
* Schedule: daily at 5 AM UTC (midnight ET, after Monday poll releases)
*/

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ESPN AP poll endpoints
const COLLEGE_LEAGUES = {
 NCAAF: {
  url: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/rankings',
  // Active window: Aug 15 through Dec 9
  activeStart: { month: 8, day: 15 },
  freezeDate: { month: 12, day: 9 },
 },
 NCAAB: {
  url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/rankings',
  // Active window: Nov 1 through Mar 5
  activeStart: { month: 11, day: 1 },
  freezeDate: { month: 3, day: 5 },
 },
};

// Name aliases for matching picks to ESPN team names
const NAME_ALIASES = {
 'Ole Miss': 'Mississippi',
 'SMU': 'SMU Mustangs',
 'LSU': 'LSU Tigers',
 'UCLA': 'UCLA Bruins',
 'USC': 'USC Trojans',
 'BYU': 'BYU Cougars',
 'TCU': 'TCU Horned Frogs',
};

/**
* Check if today is within the active window for a league.
* Handles cross-year windows (e.g., NCAAB Nov→Mar spans New Year).
*/
function isActive(config) {
 const now = new Date();
 const month = now.getMonth() + 1; // 1-12
 const day = now.getDate();
 const today = month * 100 + day; // e.g., 305 for Mar 5, 1209 for Dec 9

 const start = config.activeStart.month * 100 + config.activeStart.day;
 const freeze = config.freezeDate.month * 100 + config.freezeDate.day;

 if (start <= freeze) {
  // Same year window (e.g., NCAAF: Aug 15 → Dec 9)
  return today >= start && today <= freeze;
 } else {
  // Cross-year window (e.g., NCAAB: Nov 1 → Mar 5)
  return today >= start || today <= freeze;
 }
}

/**
* Fetch AP Top 25 rankings from ESPN.
* Returns array of { teamName, displayName, apPoints, rank }
*/
async function fetchAPRankings(league, config) {
 try {
  const res = await fetch(config.url, {
   headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  if (!res.ok) {
   console.log(` ${league}: ESPN returned ${res.status}`);
   return null;
  }

  const data = await res.json();

  // Find the AP poll in the rankings array
  const rankings = data?.rankings || [];
  const apPoll = rankings.find(r =>
   r.name === 'AP Top 25' ||
   r.shortName === 'AP Top 25' ||
   r.type === 'ap' ||
   (r.name || '').toLowerCase().includes('ap')
  );

  if (!apPoll) {
   console.log(` ${league}: No AP poll found in ESPN response`);
   // Try first ranking if AP not explicitly named
   if (rankings.length > 0 && rankings[0].ranks) {
    return parseRanks(rankings[0].ranks);
   }
   return null;
  }

  return parseRanks(apPoll.ranks || []);
 } catch (err) {
  console.error(` ${league}: Fetch error — ${err.message}`);
  return null;
 }
}

/**
* Parse ESPN ranks array into our format
*/
function parseRanks(ranks) {
 const teams = [];

 for (const entry of ranks) {
  const team = entry?.team;
  if (!team) continue;

  teams.push({
   rank: entry.current || entry.rank || 0,
   teamName: team.name || team.shortDisplayName || '',     // "Crimson Tide"
   displayName: team.displayName || team.name || '',      // "Alabama Crimson Tide"
   location: team.location || team.nickname || '',       // "Alabama"
   abbreviation: team.abbreviation || '',           // "ALA"
   apPoints: entry.points || 0,                // AP poll points (e.g., 1234)
  });
 }

 return teams;
}

/**
* Match a Fantasy Life pick name to an ESPN team.
*/
function matchTeam(pickName, espnTeams) {
 const pick = pickName.trim();
 const alias = NAME_ALIASES[pick];
 const searchTerms = alias ? [alias, pick] : [pick];

 for (const term of searchTerms) {
  const lower = term.toLowerCase();

  // Exact location match (most common for college: "Alabama", "Ohio State")
  const locationMatch = espnTeams.find(t =>
   t.location.toLowerCase() === lower
  );
  if (locationMatch) return locationMatch;

  // displayName contains pick
  const contains = espnTeams.find(t =>
   t.displayName.toLowerCase().includes(lower) ||
   t.teamName.toLowerCase().includes(lower)
  );
  if (contains) return contains;

  // Abbreviation match
  const abbr = espnTeams.find(t =>
   t.abbreviation.toLowerCase() === lower
  );
  if (abbr) return abbr;
 }

 // Not in top 25 — return null (0 AP points)
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

 console.log(' Fantasy Life — Updating College AP Rankings...\n');

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

 for (const [league, config] of Object.entries(COLLEGE_LEAGUES)) {
  console.log(`Processing ${league}...`);

  // Check freeze date
  if (!isActive(config)) {
   const freezeStr = `${config.freezeDate.month}/${config.freezeDate.day}`;
   console.log(` ${league}: Frozen (past ${freezeStr} freeze date) — scores locked`);
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
   console.log(` ${league}: No picks found for season ${seasonYear}, skipping`);
   results[league] = { status: 'skipped', reason: 'no picks' };
   continue;
  }

  // 2. Fetch AP rankings from ESPN
  const espnTeams = await fetchAPRankings(league, config);

  if (!espnTeams) {
   console.log(` ${league}: No ESPN data — preserving existing scores`);
   results[league] = { status: 'skipped', reason: 'no ESPN data' };
   continue;
  }

  console.log(` ${league}: Found ${espnTeams.length} ranked teams`);

  // 3. Match picks to AP rankings
  const matched = [];

  for (const pick of picks) {
   const espnTeam = matchTeam(pick.pick, espnTeams);
   matched.push({
    ...pick,
    espnTeam: espnTeam ? espnTeam.displayName : null,
    apRank: espnTeam ? espnTeam.rank : 'Unranked',
    apPoints: espnTeam ? espnTeam.apPoints : 0,
   });
  }

  // 4. Rank by AP points (highest = rank 1 = most base points)
  matched.sort((a, b) => b.apPoints - a.apPoints);

  const totalMembers = picks.length;

  // 5. Update Supabase — base points only
  let updated = 0;
  const rankings = [];

  for (let i = 0; i < matched.length; i++) {
   const m = matched[i];
   const newBase = totalMembers - i;

   const { error: updateErr } = await supabase
    .from('picks')
    .update({
     base: newBase,
     metric: m.apPoints,
     record: m.apPoints > 0 ? `${m.apPoints} AP pts (${m.apRank})` : 'Unranked',
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
    espnMatch: m.espnTeam || 'Unranked',
    apRank: m.apRank,
    apPoints: m.apPoints,
    base: newBase,
    bonus: Number(m.bonus) || 0,
    total: newBase + (Number(m.bonus) || 0),
   });
  }

  console.log(` ${league}: Updated ${updated}/${matched.length} picks`);
  results[league] = { status: 'updated', updated, total: picks.length, rankings };
 }

 const summary = {
  message: 'College AP rankings update complete',
  season: seasonYear,
  timestamp: new Date().toISOString(),
  results,
 };

 console.log('\n Done!');
 return res.status(200).json(summary);
};