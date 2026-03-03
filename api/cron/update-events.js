/**
* Fantasy Life — Tennis, Golf, F1 Rankings Updater
* Respects commissioner locks from seasons.locks column.
*/

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const EVENT_LEAGUES = {
 Tennis: { metricType: 'points', sortDirection: 'desc', activeStart: { month: 2, day: 1 }, freezeDate: { month: 1, day: 31 } },
 Golf: { metricType: 'position', sortDirection: 'asc', activeStart: { month: 1, day: 1 }, freezeDate: { month: 8, day: 31 } },
 F1: { metricType: 'points', sortDirection: 'desc', activeStart: { month: 3, day: 15 }, freezeDate: { month: 12, day: 15 } },
};
const NAME_ALIASES = { 'Ludvig Åberg': 'Aberg', 'Ludvig Aberg': 'Aberg' };

function isFieldLocked(locks, category, ownerName, field) { return locks ? !!locks[category + '|' + ownerName + '|' + field] : false; }

function isActive(config) {
 var now = new Date(), month = now.getMonth() + 1, day = now.getDate(), today = month * 100 + day;
 var start = config.activeStart.month * 100 + config.activeStart.day, freeze = config.freezeDate.month * 100 + config.freezeDate.day;
 return start <= freeze ? (today >= start && today <= freeze) : (today >= start || today <= freeze);
}

async function fetchTennisRankings() {
 try { var res = await fetch('https://site.api.espn.com/apis/site/v2/sports/tennis/atp/rankings', { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (!res.ok) return null; var data = await res.json(); var rankings = data?.rankings || []; var sr = rankings.find(function(r) { return (r.name || '').toLowerCase().includes('singles') || (r.name || '').toLowerCase().includes('atp') || rankings.length === 1; }) || rankings[0]; if (!sr?.ranks) return null; return sr.ranks.map(function(e) { return { name: e.athlete?.displayName || e.athlete?.name || '', shortName: e.athlete?.shortName || '', points: e.points || e.stat || 0, rank: e.current || e.rank || 0 }; }); } catch (err) { console.error(' Tennis fetch error:', err.message); return null; }
}

async function fetchGolfRankings() {
 try { var res = await fetch('https://www.espn.com/golf/rankings', { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (!res.ok) return null; var html = await res.text(); var golfers = [], regex = /golf\/player\/_\/id\/\d+\/([^"]+)"[^>]*>([^<]+)/g, match, rank = 1; while ((match = regex.exec(html)) !== null) { var name = match[2].trim(); if (name && !golfers.find(function(g) { return g.name === name; })) { golfers.push({ name: name, position: rank, shortName: '' }); rank++; } } return golfers.length > 0 ? golfers : null; } catch (err) { console.error(' Golf fetch error:', err.message); return null; }
}

async function fetchF1Standings() {
 try { var res = await fetch('https://site.api.espn.com/apis/site/v2/sports/racing/f1/standings', { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (!res.ok) return null; var data = await res.json(); var drivers = []; for (var group of (data?.children || [])) { for (var entry of (group?.standings?.entries || [])) { var ath = entry?.athlete || entry?.team; if (!ath) continue; var stats = entry?.stats || []; var pt = stats.find(function(s) { return s.name === 'points' || s.abbreviation === 'PTS'; }); drivers.push({ name: ath.displayName || ath.name || '', shortName: ath.shortName || '', points: pt ? parseFloat(pt.value || pt.displayValue) : 0 }); } } if (drivers.length === 0) { for (var entry2 of (data?.standings?.entries || [])) { var ath2 = entry2?.athlete || entry2?.team; if (!ath2) continue; var stats2 = entry2?.stats || []; var pt2 = stats2.find(function(s) { return s.name === 'points' || s.abbreviation === 'PTS'; }); drivers.push({ name: ath2.displayName || ath2.name || '', shortName: ath2.shortName || '', points: pt2 ? parseFloat(pt2.value || pt2.displayValue) : 0 }); } } return drivers.length > 0 ? drivers : null; } catch (err) { console.error(' F1 fetch error:', err.message); return null; }
}

function matchAthlete(pickName, espnAthletes) {
 var pick = pickName.trim(), alias = NAME_ALIASES[pick], terms = alias ? [alias, pick] : [pick];
 for (var term of terms) { var lower = term.toLowerCase(); var exact = espnAthletes.find(function(a) { return a.name.toLowerCase() === lower; }); if (exact) return exact; var lastName = lower.split(' ').pop(); var lnm = espnAthletes.find(function(a) { return a.name.toLowerCase().split(' ').pop() === lastName; }); if (lnm) return lnm; var con = espnAthletes.find(function(a) { return a.name.toLowerCase().includes(lower) || lower.includes(a.name.toLowerCase()); }); if (con) return con; }
 return null;
}

module.exports = async function handler(req, res) {
 var authHeader = req.headers['authorization'], cronSecret = process.env.CRON_SECRET;
 if (cronSecret && authHeader !== 'Bearer ' + cronSecret) return res.status(401).json({ error: 'Unauthorized' });
 if (!SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });

 var supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
 console.log(' Fantasy Life — Updating Event Rankings...\n');

 var { data: season } = await supabase.from('seasons').select('year, locks').eq('status', 'active').single();
 if (!season) return res.status(200).json({ message: 'No active season found, skipping' });

 var seasonYear = season.year, locks = season.locks || {};
 var { data: membersArr } = await supabase.from('members').select('id, name');
 var memberNameById = {};
 (membersArr || []).forEach(function(m) { memberNameById[m.id] = m.name; });

 var results = {};

 for (var [league, config] of Object.entries(EVENT_LEAGUES)) {
  console.log('Processing ' + league + '...');
  if (!isActive(config)) { results[league] = { status: 'frozen', reason: 'Past freeze date' }; continue; }

  var { data: picks, error: pickErr } = await supabase.from('picks').select('id, member_id, pick, base, bonus').eq('season_year', seasonYear).eq('category', league);
  if (pickErr || !picks || picks.length === 0) { results[league] = { status: 'skipped', reason: 'no picks' }; continue; }

  var espnData = null;
  if (league === 'Tennis') espnData = await fetchTennisRankings();
  else if (league === 'Golf') espnData = await fetchGolfRankings();
  else if (league === 'F1') espnData = await fetchF1Standings();
  if (!espnData || espnData.length === 0) { results[league] = { status: 'skipped', reason: 'no ESPN data' }; continue; }

  console.log(' ' + league + ': Found ' + espnData.length + ' athletes/drivers');
  var matched = [];
  for (var pick of picks) {
   var athlete = matchAthlete(pick.pick, espnData);
   var metric = 0, record = 'Not found';
   if (athlete) { if (league === 'Golf') { metric = athlete.position || 999; record = '#' + metric; } else { metric = athlete.points || 0; record = metric.toLocaleString() + ' pts'; } }
   matched.push({ ...pick, espnName: athlete ? athlete.name : null, metric: metric, record: record });
  }

  var totalMetric = matched.reduce(function(sum, m) { return sum + m.metric; }, 0);
  if (totalMetric === 0) { results[league] = { status: 'skipped', reason: 'all metrics zero' }; continue; }

  if (config.sortDirection === 'asc') matched.sort(function(a, b) { return a.metric - b.metric; });
  else matched.sort(function(a, b) { return b.metric - a.metric; });

  var totalMembers = picks.length, updated = 0, rankings = [];

  for (var i = 0; i < matched.length; i++) {
   var m = matched[i], newBase = totalMembers - i;
   var ownerName = memberNameById[m.member_id] || m.member_id;

   var baseLocked = isFieldLocked(locks, league, ownerName, 'base');
   var metricLocked = isFieldLocked(locks, league, ownerName, 'metric');
   var recordLocked = isFieldLocked(locks, league, ownerName, 'record');

   var updateObj = { updated_at: new Date().toISOString() };
   if (!baseLocked) updateObj.base = newBase;
   if (!metricLocked) updateObj.metric = m.metric;
   if (!recordLocked) updateObj.record = m.record;

   var skipped = [];
   if (baseLocked) skipped.push('base');
   if (metricLocked) skipped.push('metric');
   if (recordLocked) skipped.push('record');
   if (skipped.length > 0) console.log('  ' + ownerName + ': skipped locked: ' + skipped.join(', '));

   var { error: updateErr } = await supabase.from('picks').update(updateObj).eq('id', m.id);
   if (updateErr) { console.error(' Failed to update ' + m.member_id + ':', updateErr.message); continue; }
   updated++;
   rankings.push({ rank: i + 1, member: m.member_id, pick: m.pick, espnMatch: m.espnName || 'Not found', metric: m.metric, record: m.record, base: baseLocked ? m.base : newBase, bonus: Number(m.bonus) || 0, total: (baseLocked ? m.base : newBase) + (Number(m.bonus) || 0), lockedFields: skipped.length > 0 ? skipped : undefined });
  }

  console.log(' ' + league + ': Updated ' + updated + '/' + matched.length + ' picks');
  results[league] = { status: 'updated', updated: updated, total: picks.length, rankings: rankings };
 }

 console.log('\n Done!');
 return res.status(200).json({ message: 'Event rankings update complete', season: seasonYear, timestamp: new Date().toISOString(), results: results });
};