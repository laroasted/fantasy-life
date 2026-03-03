/**
* Fantasy Life — Daily Sports Standings Updater
*
* Updates base points for NFL, NBA, NHL, MLB, MLS from ESPN standings.
* Bonus points are NEVER touched (locked from previous season playoffs).
* Respects commissioner locks from the seasons.locks column.
*/

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ESPN_LEAGUES = {
 NFL: {
  url: 'https://site.api.espn.com/apis/v2/sports/football/nfl/standings',
  metric: 'winPercent', metricType: 'winpct', recordType: 'W-L',
  activeMonths: [9, 10, 11, 12, 1],
 },
 NBA: {
  url: 'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings',
  metric: 'winPercent', metricType: 'winpct', recordType: 'W-L',
  activeMonths: [10, 11, 12, 1, 2, 3, 4],
 },
 NHL: {
  url: 'https://site.api.espn.com/apis/v2/sports/hockey/nhl/standings',
  metric: 'points', metricType: 'points', recordType: 'pts',
  activeMonths: [10, 11, 12, 1, 2, 3, 4],
 },
 MLB: {
  url: 'https://site.api.espn.com/apis/v2/sports/baseball/mlb/standings',
  metric: 'winPercent', metricType: 'winpct', recordType: 'W-L',
  activeMonths: [4, 5, 6, 7, 8, 9],
 },
 MLS: {
  url: 'https://site.api.espn.com/apis/v2/sports/soccer/usa.1/standings',
  metric: 'points', metricType: 'points', recordType: 'pts',
  activeMonths: [4, 5, 6, 7, 8, 9, 10],
 },
};

const NAME_ALIASES = {
 'T-Wolves': 'Timberwolves', 'Wolves': 'Timberwolves',
 '49ers': 'San Francisco', 'Red Bull': 'Red Bulls',
 'Atlanta': 'Atlanta United', 'Columbus Crew': 'Columbus',
 'Vancouver': 'Whitecaps', 'Philadelphia Union': 'Union',
 'San Diego FC': 'San Diego',
};

// ── Lock helper ──
function isFieldLocked(locks, category, ownerName, field) {
 if (!locks) return false;
 return !!locks[category + '|' + ownerName + '|' + field];
}

async function fetchESPNStandings(league, config) {
 try {
  const res = await fetch(config.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) { console.log(` ${league}: ESPN returned ${res.status}`); return null; }
  const data = await res.json();
  const teams = [];
  const children = data?.children || [];
  if (children.length === 0) {
   const entries = data?.standings?.entries || [];
   if (entries.length === 0) { console.log(` ${league}: No standings data`); return null; }
   for (const entry of entries) { const t = parseEntry(entry, config); if (t) teams.push(t); }
  } else {
   for (const group of children) {
    for (const entry of (group?.standings?.entries || [])) { const t = parseEntry(entry, config); if (t) teams.push(t); }
    for (const sub of (group?.children || [])) {
     for (const entry of (sub?.standings?.entries || [])) { const t = parseEntry(entry, config); if (t) teams.push(t); }
    }
   }
  }
  if (teams.length === 0) { console.log(` ${league}: Parsed 0 teams`); return null; }
  console.log(` ${league}: Found ${teams.length} teams`);
  return teams;
 } catch (err) { console.error(` ${league}: Fetch error — ${err.message}`); return null; }
}

function parseEntry(entry, config) {
 try {
  const team = entry?.team; if (!team) return null;
  const stats = entry?.stats || [];
  let metric = 0, record = '';
  if (config.metricType === 'winpct') {
   const wp = stats.find(s => s.name === 'winPercent' || s.abbreviation === 'PCT');
   metric = wp ? parseFloat(wp.value || wp.displayValue) : 0;
   const ov = stats.find(s => s.name === 'overall' || s.type === 'total');
   record = ov?.displayValue || '';
   if (!record) { const w = stats.find(s => s.name === 'wins')?.value || 0; const l = stats.find(s => s.name === 'losses')?.value || 0; record = w + '-' + l; }
  } else if (config.metricType === 'points') {
   const pt = stats.find(s => s.name === 'points' || s.abbreviation === 'PTS' || s.abbreviation === 'Pts');
   metric = pt ? parseFloat(pt.value || pt.displayValue) : 0;
   record = Math.round(metric) + ' pts';
  }
  return { teamName: team.name || '', displayName: team.displayName || '', abbreviation: team.abbreviation || '', location: team.location || '', record, metric };
 } catch (err) { return null; }
}

function matchTeam(pickName, espnTeams) {
 const pick = pickName.trim();
 const alias = NAME_ALIASES[pick];
 const terms = alias ? [alias, pick] : [pick];
 for (const term of terms) {
  const lower = term.toLowerCase();
  const exact = espnTeams.find(t => t.teamName.toLowerCase() === lower);
  if (exact) return exact;
  const contains = espnTeams.find(t => t.displayName.toLowerCase().includes(lower) || t.teamName.toLowerCase().includes(lower) || t.location.toLowerCase() === lower);
  if (contains) return contains;
  const abbr = espnTeams.find(t => t.abbreviation.toLowerCase() === lower);
  if (abbr) return abbr;
 }
 return null;
}

module.exports = async function handler(req, res) {
 const authHeader = req.headers['authorization'];
 const cronSecret = process.env.CRON_SECRET;
 if (cronSecret && authHeader !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'Unauthorized' });
 if (!SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });

 const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
 console.log(' Fantasy Life — Updating Sports Standings...\n');

 // Find active season + locks
 const { data: season } = await supabase.from('seasons').select('year, locks').eq('status', 'active').single();
 if (!season) return res.status(200).json({ message: 'No active season found, skipping' });

 const seasonYear = season.year;
 const locks = season.locks || {};

 // Fetch member names for lock lookups
 const { data: members } = await supabase.from('members').select('id, name');
 const memberNameById = {};
 (members || []).forEach(m => { memberNameById[m.id] = m.name; });

 const results = {};
 const currentMonth = new Date().getMonth() + 1;

 for (const [league, config] of Object.entries(ESPN_LEAGUES)) {
  console.log(`Processing ${league}...`);

  if (config.activeMonths && !config.activeMonths.includes(currentMonth)) {
   console.log(` ${league}: Offseason — scores frozen`);
   results[league] = { status: 'frozen', reason: 'Offseason' };
   continue;
  }

  const { data: picks, error: pickErr } = await supabase.from('picks').select('id, member_id, pick, base, bonus').eq('season_year', seasonYear).eq('category', league);
  if (pickErr || !picks || picks.length === 0) { results[league] = { status: 'skipped', reason: 'no picks' }; continue; }

  const espnTeams = await fetchESPNStandings(league, config);
  if (!espnTeams) { results[league] = { status: 'skipped', reason: 'no ESPN data' }; continue; }

  const matched = [], unmatched = [];
  for (const pick of picks) {
   const espnTeam = matchTeam(pick.pick, espnTeams);
   if (espnTeam) matched.push({ ...pick, espnTeam: espnTeam.displayName, record: espnTeam.record, metric: espnTeam.metric });
   else { unmatched.push(pick.pick); console.warn(`  Could not match "${pick.pick}"`); }
  }
  if (matched.length === 0) { results[league] = { status: 'skipped', reason: 'no matches', unmatched }; continue; }

  matched.sort((a, b) => b.metric - a.metric);
  const totalMembers = picks.length;
  let updated = 0;
  const rankings = [];

  for (let i = 0; i < matched.length; i++) {
   const m = matched[i];
   const newBase = totalMembers - i;
   const ownerName = memberNameById[m.member_id] || m.member_id;

   // ── Check locks before updating ──
   const baseLocked = isFieldLocked(locks, league, ownerName, 'base');
   const metricLocked = isFieldLocked(locks, league, ownerName, 'metric');
   const recordLocked = isFieldLocked(locks, league, ownerName, 'record');

   const updateObj = { updated_at: new Date().toISOString() };
   if (!baseLocked) updateObj.base = newBase;
   if (!metricLocked) updateObj.metric = Math.round(m.metric * 1000) / 1000;
   if (!recordLocked) updateObj.record = m.record;

   const skippedFields = [];
   if (baseLocked) skippedFields.push('base');
   if (metricLocked) skippedFields.push('metric');
   if (recordLocked) skippedFields.push('record');
   if (skippedFields.length > 0) console.log(`  ${ownerName}: skipped locked fields: ${skippedFields.join(', ')}`);

   const { error: updateErr } = await supabase.from('picks').update(updateObj).eq('id', m.id);
   if (updateErr) { console.error(` Failed to update ${m.member_id}:`, updateErr.message); continue; }

   updated++;
   rankings.push({ rank: i + 1, member: m.member_id, pick: m.pick, espnMatch: m.espnTeam, record: m.record, metric: m.metric, base: baseLocked ? m.base : newBase, bonus: Number(m.bonus) || 0, total: (baseLocked ? m.base : newBase) + (Number(m.bonus) || 0), lockedFields: skippedFields.length > 0 ? skippedFields : undefined });
  }

  console.log(` ${league}: Updated ${updated}/${matched.length} picks`);
  results[league] = { status: 'updated', updated, total: picks.length, unmatched: unmatched.length > 0 ? unmatched : undefined, rankings };
 }

 console.log('\n Done!');
 return res.status(200).json({ message: 'Sports standings update complete', season: seasonYear, timestamp: new Date().toISOString(), results });
};