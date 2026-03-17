/**
 * Fantasy Life — Tennis, Golf, F1 Rankings Updater
 * Respects commissioner locks from seasons.locks column.
 *
 * Tiebreaker: players with the same metric split/average the base points
 * they collectively occupy.
 * e.g. 2-way tie for ranks 1–2 out of 12 = (12+11)/2 = 11.5 each
 *
 * CHANGELOG (2026-03-17):
 *   - F1: Added Jolpica API (Ergast successor) as PRIMARY data source
 *   - F1: ESPN kept as fallback (currently returning empty for 2026)
 *   - F1: Added season year parameter to Jolpica request
 */
 
const { createClient } = require('@supabase/supabase-js');
 
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
 
const EVENT_LEAGUES = {
  Tennis: { metricType: 'points', sortDirection: 'desc', activeStart: { month: 2, day: 1 }, freezeDate: { month: 1, day: 31 } },
  Golf:   { metricType: 'position', sortDirection: 'asc',  activeStart: { month: 1, day: 1 }, freezeDate: { month: 8, day: 31 } },
  F1:     { metricType: 'points', sortDirection: 'desc', activeStart: { month: 3, day: 1 }, freezeDate: { month: 12, day: 15 } },
};
 
const NAME_ALIASES = { 'Ludvig Åberg': 'Aberg', 'Ludvig Aberg': 'Aberg' };
 
/**
 * Assigns base points with split/average tiebreaker logic.
 */
function assignBasePointsWithTiebreaker(matched, totalMembers) {
  var n = matched.length;
  var i = 0;
  while (i < n) {
    var j = i;
    while (j < n && matched[j].metric === matched[i].metric) j++;
    var pointSum = 0;
    for (var p = i; p < j; p++) pointSum += (totalMembers - p);
    var avgPoints = Math.round((pointSum / (j - i)) * 100) / 100;
    for (var p = i; p < j; p++) {
      matched[p].newBase = avgPoints;
      matched[p].rank = i + 1;
    }
    i = j;
  }
  return matched;
}
 
function isFieldLocked(locks, category, ownerName, field) { return locks ? !!locks[category + '|' + ownerName + '|' + field] : false; }
 
function isActive(config) {
  var now = new Date(), month = now.getMonth() + 1, day = now.getDate(), today = month * 100 + day;
  var start = config.activeStart.month * 100 + config.activeStart.day, freeze = config.freezeDate.month * 100 + config.freezeDate.day;
  return start <= freeze ? (today >= start && today <= freeze) : (today >= start || today <= freeze);
}
 
async function fetchTennisRankings() {
  try {
    var res = await fetch('https://site.api.espn.com/apis/site/v2/sports/tennis/atp/rankings', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    var data = await res.json();
    var rankings = data?.rankings || [];
    var sr = rankings.find(function(r) { return (r.name || '').toLowerCase().includes('singles') || (r.name || '').toLowerCase().includes('atp') || rankings.length === 1; }) || rankings[0];
    if (!sr?.ranks) return null;
    return sr.ranks.map(function(e) { return { name: e.athlete?.displayName || e.athlete?.name || '', shortName: e.athlete?.shortName || '', points: e.points || e.stat || 0, rank: e.current || e.rank || 0 }; });
  } catch (err) { console.error(' Tennis fetch error:', err.message); return null; }
}
 
async function fetchGolfRankings() {
  try {
    var res = await fetch('https://www.espn.com/golf/rankings', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    var html = await res.text();
    var golfers = [], regex = /golf\/player\/_\/id\/\d+\/([^"]+)"[^>]*>([^<]+)/g, match, rank = 1;
    while ((match = regex.exec(html)) !== null) {
      var name = match[2].trim();
      if (name && !golfers.find(function(g) { return g.name === name; })) { golfers.push({ name: name, position: rank, shortName: '' }); rank++; }
    }
    return golfers.length > 0 ? golfers : null;
  } catch (err) { console.error(' Golf fetch error:', err.message); return null; }
}
 
// ═══════════════════════════════════════════════════════════
// F1 STANDINGS — ESPN HTML scrape (primary) + Jolpica (fallback)
// ═══════════════════════════════════════════════════════════
 
/**
 * PRIMARY: ESPN Racing standings page (server-rendered HTML)
 * URL: https://www.espn.com/racing/standings/_/series/f1/year/{season}
 * This is the OLD racing section — it renders standings as HTML table,
 * unlike espn.com/f1/standings which uses client-side JS.
 * Same pattern used by fetchGolfRankings() in this cron.
 */
async function fetchF1FromESPNHtml(seasonYear) {
  try {
    var url = 'https://www.espn.com/racing/standings/_/series/f1/year/' + seasonYear;
    console.log('  F1: Trying ESPN HTML scrape → ' + url);
    var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) {
      console.log('  F1: ESPN HTML returned HTTP ' + res.status);
      return null;
    }
    var html = await res.text();
 
    // Parse driver rows from the standings table
    // Each row has: racing/driver/_/id/{id}/{slug}  and then the driver name + points
    var drivers = [];
    var regex = /racing\/driver\/_\/id\/\d+\/[^"]*"[^>]*>([^<]+)<[\s\S]*?<td[^>]*>([\d.]+)<\/td>/g;
    var match;
    while ((match = regex.exec(html)) !== null) {
      var name = match[1].trim();
      var points = parseFloat(match[2]) || 0;
      if (name && !drivers.find(function(d) { return d.name === name; })) {
        drivers.push({ name: name, shortName: '', points: points });
      }
    }
 
    // Fallback regex if the table structure is slightly different
    if (drivers.length === 0) {
      // Try a simpler approach: find all driver links followed by point values
      var simpleRegex = /racing\/driver\/_\/id\/\d+\/[^"]+">([^<]+)/g;
      var pointRegex = /<td[^>]*class="[^"]*"[^>]*>(\d+)<\/td>/g;
      var names = [], pts = [];
      while ((match = simpleRegex.exec(html)) !== null) names.push(match[1].trim());
      while ((match = pointRegex.exec(html)) !== null) pts.push(parseFloat(match[1]) || 0);
      // The first set of numbers after driver names should be points
      for (var i = 0; i < names.length && i < pts.length; i++) {
        drivers.push({ name: names[i], shortName: '', points: pts[i] });
      }
    }
 
    if (drivers.length > 0) {
      console.log('  F1: ESPN HTML returned ' + drivers.length + ' drivers');
    } else {
      console.log('  F1: ESPN HTML — could not parse driver data');
    }
    return drivers.length > 0 ? drivers : null;
  } catch (err) {
    console.error('  F1: ESPN HTML fetch error:', err.message);
    return null;
  }
}
 
/**
 * FALLBACK 1: Jolpica API (Ergast successor)
 * Endpoint: https://api.jolpi.ca/ergast/f1/{season}/driverStandings.json
 * Updates on Mondays after each race weekend.
 * Rate limit: 200 requests/hour (unauthenticated)
 */
async function fetchF1FromJolpica(seasonYear) {
  try {
    var url = 'https://api.jolpi.ca/ergast/f1/' + seasonYear + '/driverStandings.json';
    console.log('  F1: Trying Jolpica API → ' + url);
    var res = await fetch(url, {
      headers: { 'User-Agent': 'FantasyLifeHub/1.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      console.log('  F1: Jolpica returned HTTP ' + res.status);
      return null;
    }
    var data = await res.json();
 
    var standingsTable = data?.MRData?.StandingsTable;
    var standingsLists = standingsTable?.StandingsLists;
    if (!standingsLists || standingsLists.length === 0) {
      console.log('  F1: Jolpica returned empty StandingsLists');
      return null;
    }
 
    var driverStandings = standingsLists[0]?.DriverStandings;
    if (!driverStandings || driverStandings.length === 0) {
      console.log('  F1: Jolpica returned empty DriverStandings');
      return null;
    }
 
    var drivers = driverStandings.map(function(entry) {
      var driver = entry.Driver || {};
      var firstName = driver.givenName || '';
      var lastName = driver.familyName || '';
      var fullName = (firstName + ' ' + lastName).trim();
      var points = parseFloat(entry.points) || 0;
      return { name: fullName, shortName: (driver.code || '').toUpperCase(), points: points };
    });
 
    console.log('  F1: Jolpica returned ' + drivers.length + ' drivers');
    return drivers.length > 0 ? drivers : null;
  } catch (err) {
    console.error('  F1: Jolpica fetch error:', err.message);
    return null;
  }
}
 
/**
 * FALLBACK 2: ESPN hidden JSON API
 * Known issue: Returns empty/zero data for 2026 F1 season.
 * Kept as last resort in case it starts working again.
 */
async function fetchF1FromESPNApi() {
  try {
    console.log('  F1: Trying ESPN JSON API fallback...');
    var res = await fetch('https://site.api.espn.com/apis/site/v2/sports/racing/f1/standings', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    var data = await res.json();
    var drivers = [];
 
    for (var group of (data?.children || [])) {
      for (var entry of (group?.standings?.entries || [])) {
        var ath = entry?.athlete || entry?.team; if (!ath) continue;
        var stats = entry?.stats || [];
        var pt = stats.find(function(s) { return s.name === 'points' || s.abbreviation === 'PTS'; });
        drivers.push({ name: ath.displayName || ath.name || '', shortName: ath.shortName || '', points: pt ? parseFloat(pt.value || pt.displayValue) : 0 });
      }
    }
    if (drivers.length === 0) {
      for (var entry2 of (data?.standings?.entries || [])) {
        var ath2 = entry2?.athlete || entry2?.team; if (!ath2) continue;
        var stats2 = entry2?.stats || [];
        var pt2 = stats2.find(function(s) { return s.name === 'points' || s.abbreviation === 'PTS'; });
        drivers.push({ name: ath2.displayName || ath2.name || '', shortName: ath2.shortName || '', points: pt2 ? parseFloat(pt2.value || pt2.displayValue) : 0 });
      }
    }
 
    console.log('  F1: ESPN API returned ' + drivers.length + ' drivers');
    return drivers.length > 0 ? drivers : null;
  } catch (err) {
    console.error('  F1: ESPN API fetch error:', err.message);
    return null;
  }
}
 
/**
 * Combined F1 fetch — tries 3 sources in order:
 *   1. ESPN HTML scrape (most reliable for 2026)
 *   2. Jolpica API (Ergast successor)
 *   3. ESPN JSON API (currently broken for F1 2026)
 * Also validates total points > 0 to avoid resetting with stale data.
 */
async function fetchF1Standings(seasonYear) {
  var drivers = await fetchF1FromESPNHtml(seasonYear);
 
  if (!drivers) {
    drivers = await fetchF1FromJolpica(seasonYear);
  }
 
  if (!drivers) {
    drivers = await fetchF1FromESPNApi();
  }
 
  if (!drivers || drivers.length === 0) {
    console.log('  F1: All 3 sources failed — no data available');
    return null;
  }
 
  // Safety check: don't return all-zero standings mid-season
  var totalPoints = drivers.reduce(function(sum, d) { return sum + d.points; }, 0);
  if (totalPoints === 0) {
    console.log('  F1: All drivers have 0 points — likely stale data, skipping');
    return null;
  }
 
  return drivers;
}
 
function matchAthlete(pickName, espnAthletes) {
  var pick = pickName.trim(), alias = NAME_ALIASES[pick], terms = alias ? [alias, pick] : [pick];
  for (var term of terms) {
    var lower = term.toLowerCase();
    var exact = espnAthletes.find(function(a) { return a.name.toLowerCase() === lower; }); if (exact) return exact;
    var lastName = lower.split(' ').pop();
    var lnm = espnAthletes.find(function(a) { return a.name.toLowerCase().split(' ').pop() === lastName; }); if (lnm) return lnm;
    var con = espnAthletes.find(function(a) { return a.name.toLowerCase().includes(lower) || lower.includes(a.name.toLowerCase()); }); if (con) return con;
  }
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
    else if (league === 'F1') espnData = await fetchF1Standings(seasonYear);
    if (!espnData || espnData.length === 0) { results[league] = { status: 'skipped', reason: 'no data from any source' }; continue; }
 
    console.log(' ' + league + ': Found ' + espnData.length + ' athletes/drivers');
 
    var matched = [];
    for (var pick of picks) {
      var athlete = matchAthlete(pick.pick, espnData);
      var metric = 0, record = 'Not found';
      if (athlete) {
        if (league === 'Golf') { metric = athlete.position || 999; record = '#' + metric; }
        else { metric = athlete.points || 0; record = metric.toLocaleString() + ' pts'; }
      }
      matched.push({ ...pick, espnName: athlete ? athlete.name : null, metric: metric, record: record });
    }
 
    var totalMetric = matched.reduce(function(sum, m) { return sum + m.metric; }, 0);
    if (totalMetric === 0) { results[league] = { status: 'skipped', reason: 'all metrics zero' }; continue; }
 
    if (config.sortDirection === 'asc') matched.sort(function(a, b) { return a.metric - b.metric; });
    else matched.sort(function(a, b) { return b.metric - a.metric; });
 
    matched = assignBasePointsWithTiebreaker(matched, picks.length);
 
    var updated = 0, rankings = [];
 
    for (var m of matched) {
      var ownerName = memberNameById[m.member_id] || m.member_id;
      var baseLocked = isFieldLocked(locks, league, ownerName, 'base');
      var metricLocked = isFieldLocked(locks, league, ownerName, 'metric');
      var recordLocked = isFieldLocked(locks, league, ownerName, 'record');
 
      var updateObj = { updated_at: new Date().toISOString() };
      if (!baseLocked) updateObj.base = m.newBase;
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
      rankings.push({ rank: m.rank, member: m.member_id, pick: m.pick, espnMatch: m.espnName || 'Not found', metric: m.metric, record: m.record, base: baseLocked ? m.base : m.newBase, bonus: Number(m.bonus) || 0, total: (baseLocked ? m.base : m.newBase) + (Number(m.bonus) || 0), lockedFields: skipped.length > 0 ? skipped : undefined });
    }
 
    console.log(' ' + league + ': Updated ' + updated + '/' + matched.length + ' picks');
    results[league] = { status: 'updated', updated: updated, total: picks.length, rankings: rankings };
  }
 
  console.log('\n Done!');
  return res.status(200).json({ message: 'Event rankings update complete', season: seasonYear, timestamp: new Date().toISOString(), results: results });
};
