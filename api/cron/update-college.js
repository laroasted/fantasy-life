/**
* Fantasy Life — NCAAF & NCAAB AP Rankings Updater
* Respects commissioner locks from seasons.locks column.
*/

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const COLLEGE_LEAGUES = {
NCAAF: {
 url: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/rankings',
 activeStart: { month: 8, day: 15 }, freezeDate: { month: 12, day: 9 },
},
NCAAB: {
 url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/rankings',
 activeStart: { month: 11, day: 1 }, freezeDate: { month: 3, day: 5 },
},
};

const NAME_ALIASES = { 'Ole Miss': 'Mississippi', 'SMU': 'SMU Mustangs', 'LSU': 'LSU Tigers', 'UCLA': 'UCLA Bruins', 'USC': 'USC Trojans', 'BYU': 'BYU Cougars', 'TCU': 'TCU Horned Frogs' };

function isFieldLocked(locks, category, ownerName, field) {
if (!locks) return false;
return !!locks[category + '|' + ownerName + '|' + field];
}

function isActive(config) {
var now = new Date(), month = now.getMonth() + 1, day = now.getDate(), today = month * 100 + day;
var start = config.activeStart.month * 100 + config.activeStart.day, freeze = config.freezeDate.month * 100 + config.freezeDate.day;
return start <= freeze ? (today >= start && today <= freeze) : (today >= start || today <= freeze);
}

async function fetchAPRankings(league, config) {
try {
 var res = await fetch(config.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
 if (!res.ok) { console.log(` ${league}: ESPN returned ${res.status}`); return null; }
 var data = await res.json();
 var rankings = data?.rankings || [];
 var apPoll = rankings.find(r => r.name === 'AP Top 25' || r.shortName === 'AP Top 25' || r.type === 'ap' || (r.name || '').toLowerCase().includes('ap'));
 if (!apPoll) { if (rankings.length > 0 && rankings[0].ranks) return parseRanks(rankings[0].ranks); return null; }
 return parseRanks(apPoll.ranks || []);
} catch (err) { console.error(` ${league}: Fetch error — ${err.message}`); return null; }
}

function parseRanks(ranks) {
return ranks.filter(e => e?.team).map(e => ({
 rank: e.current || e.rank || 0, teamName: e.team.name || e.team.shortDisplayName || '',
 displayName: e.team.displayName || e.team.name || '', location: e.team.location || e.team.nickname || '',
 abbreviation: e.team.abbreviation || '', apPoints: e.points || 0,
}));
}

function matchTeam(pickName, espnTeams) {
var pick = pickName.trim(), alias = NAME_ALIASES[pick], terms = alias ? [alias, pick] : [pick];
for (var term of terms) {
 var lower = term.toLowerCase();
 var loc = espnTeams.find(t => t.location.toLowerCase() === lower); if (loc) return loc;
 var con = espnTeams.find(t => t.displayName.toLowerCase().includes(lower) || t.teamName.toLowerCase().includes(lower)); if (con) return con;
 var abbr = espnTeams.find(t => t.abbreviation.toLowerCase() === lower); if (abbr) return abbr;
}
return null;
}

module.exports = async function handler(req, res) {
var authHeader = req.headers['authorization'], cronSecret = process.env.CRON_SECRET;
if (cronSecret && authHeader !== 'Bearer ' + cronSecret) return res.status(401).json({ error: 'Unauthorized' });
if (!SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });

var supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
console.log(' Fantasy Life — Updating College AP Rankings...\n');

var { data: season } = await supabase.from('seasons').select('year, locks').eq('status', 'active').single();
if (!season) return res.status(200).json({ message: 'No active season found, skipping' });

var seasonYear = season.year, locks = season.locks || {};

var { data: members } = await supabase.from('members').select('id, name');
var memberNameById = {};
(members || []).forEach(function(m) { memberNameById[m.id] = m.name; });

var results = {};

for (var [league, config] of Object.entries(COLLEGE_LEAGUES)) {
 console.log('Processing ' + league + '...');

 if (!isActive(config)) {
 var freezeStr = config.freezeDate.month + '/' + config.freezeDate.day;
 console.log(' ' + league + ': Frozen (past ' + freezeStr + ')');
 results[league] = { status: 'frozen', reason: 'Past freeze date (' + freezeStr + ')' };
 continue;
 }

 var { data: picks, error: pickErr } = await supabase.from('picks').select('id, member_id, pick, base, bonus').eq('season_year', seasonYear).eq('category', league);
 if (pickErr || !picks || picks.length === 0) { results[league] = { status: 'skipped', reason: 'no picks' }; continue; }

 var espnTeams = await fetchAPRankings(league, config);
 if (!espnTeams) { results[league] = { status: 'skipped', reason: 'no ESPN data' }; continue; }

 console.log(' ' + league + ': Found ' + espnTeams.length + ' ranked teams');

 var matched = [];
 for (var pick of picks) {
 var espnTeam = matchTeam(pick.pick, espnTeams);
 matched.push({ ...pick, espnTeam: espnTeam ? espnTeam.displayName : null, apRank: espnTeam ? espnTeam.rank : 'Unranked', apPoints: espnTeam ? espnTeam.apPoints : 0 });
 }

 matched.sort(function(a, b) { return b.apPoints - a.apPoints; });
 var totalMembers = picks.length, updated = 0, rankings = [];

 for (var i = 0; i < matched.length; i++) {
 var m = matched[i], newBase = totalMembers - i;
 var ownerName = memberNameById[m.member_id] || m.member_id;

 var baseLocked = isFieldLocked(locks, league, ownerName, 'base');
 var metricLocked = isFieldLocked(locks, league, ownerName, 'metric');
 var recordLocked = isFieldLocked(locks, league, ownerName, 'record');

 var updateObj = { updated_at: new Date().toISOString() };
 if (!baseLocked) updateObj.base = newBase;
 if (!metricLocked) updateObj.metric = m.apPoints;
 if (!recordLocked) updateObj.record = m.apPoints > 0 ? m.apPoints + ' AP pts (' + m.apRank + ')' : 'Unranked';

 var skipped = [];
 if (baseLocked) skipped.push('base');
 if (metricLocked) skipped.push('metric');
 if (recordLocked) skipped.push('record');
 if (skipped.length > 0) console.log(' ' + ownerName + ': skipped locked: ' + skipped.join(', '));

 var { error: updateErr } = await supabase.from('picks').update(updateObj).eq('id', m.id);
 if (updateErr) { console.error(' Failed to update ' + m.member_id + ':', updateErr.message); continue; }

 updated++;
 rankings.push({ rank: i + 1, member: m.member_id, pick: m.pick, espnMatch: m.espnTeam || 'Unranked', apRank: m.apRank, apPoints: m.apPoints, base: baseLocked ? m.base : newBase, bonus: Number(m.bonus) || 0, total: (baseLocked ? m.base : newBase) + (Number(m.bonus) || 0), lockedFields: skipped.length > 0 ? skipped : undefined });
 }

 console.log(' ' + league + ': Updated ' + updated + '/' + matched.length + ' picks');
 results[league] = { status: 'updated', updated: updated, total: picks.length, rankings: rankings };
}

console.log('\n Done!');
return res.status(200).json({ message: 'College AP rankings update complete', season: seasonYear, timestamp: new Date().toISOString(), results: results });
};