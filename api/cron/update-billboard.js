/**
* Fantasy Life — Billboard Hot 100 Musician Tracker
* Respects commissioner locks from seasons.locks column.
* Bonus points are NEVER touched (locked from Grammy results).
*/

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const FANTASY_YEAR_START = '2025-03-15';
const FANTASY_YEAR_END = '2026-03-14';

function isFieldLocked(locks, category, ownerName, field) {
if (!locks) return false;
return !!locks[category + '|' + ownerName + '|' + field];
}

function getChartDates() {
var dates = [], start = new Date(FANTASY_YEAR_START), end = new Date(Math.min(Date.now(), new Date(FANTASY_YEAR_END).getTime()));
var current = new Date(start), dow = current.getDay();
if (dow !== 6) current.setDate(current.getDate() + (6 - dow));
while (current <= end) { dates.push(current.toISOString().split('T')[0]); current.setDate(current.getDate() + 7); }
return dates;
}

async function fetchBillboardChart(dateStr) {
try {
 var url = 'https://www.billboard.com/charts/hot-100/' + dateStr + '/';
 var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' } });
 if (!res.ok) { console.log(' Billboard returned ' + res.status + ' for ' + dateStr); return null; }
 var html = await res.text();
 return parseBillboardHTML(html);
} catch (err) { console.error(' Fetch error for ' + dateStr + ':', err.message); return null; }
}

function parseBillboardHTML(html) {
var entries = [], match;
var rowRegex = /id="title-of-a-story"[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<span[^>]*class="[^"]*c-label[^"]*"[^>]*>([\s\S]*?)<\/span>/g;
while ((match = rowRegex.exec(html)) !== null) {
 var title = match[1].replace(/<[^>]+>/g, '').trim(), artist = match[2].replace(/<[^>]+>/g, '').trim();
 if (title && artist && title !== 'Songwriter(s):' && title !== 'Producer(s):') entries.push({ rank: entries.length + 1, title: title, artist: artist });
}
if (entries.length === 0) {
 var altRegex = /<h3[^>]*class="[^"]*o-chart-results-list__item[^"]*"[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/g;
 while ((match = altRegex.exec(html)) !== null) {
 var t = match[1].replace(/<[^>]+>/g, '').trim(), a = match[2].replace(/<[^>]+>/g, '').trim();
 if (t && a && t.length > 0 && t.length < 200) entries.push({ rank: entries.length + 1, title: t, artist: a });
 }
}
if (entries.length < 10) {
 entries.length = 0;
 var chunks = html.split(/chart-results-list__item|data-detail-target/);
 for (var i = 1; i < chunks.length && entries.length < 100; i++) {
 var chunk = chunks[i];
 var tm = chunk.match(/<h3[^>]*>([\s\S]*?)<\/h3>/), am = chunk.match(/<span[^>]*class="[^"]*c-label[^"]*a-no-trucate[^"]*"[^>]*>([\s\S]*?)<\/span>/);
 if (tm && am) { var tt = tm[1].replace(/<[^>]+>/g, '').trim(), aa = am[1].replace(/<[^>]+>/g, '').trim(); if (tt && aa && tt.length < 200) entries.push({ rank: entries.length + 1, title: tt, artist: aa }); }
 }
}
return entries.length >= 10 ? entries : null;
}

function artistMatches(pickedArtist, billboardArtist) {
var picked = pickedArtist.toLowerCase().trim(), billboard = billboardArtist.toLowerCase().trim();
if (billboard === picked || billboard.includes(picked)) return true;
var pn = picked.replace(/\$/g, 's'), bn = billboard.replace(/\$/g, 's');
if (bn.includes(pn)) return true;
var pnt = picked.replace(/^the\s+/, '');
if (billboard.includes(pnt)) return true;
var parts = billboard.split(/\s+(?:featuring|feat\.?|ft\.?|with|x|&|,)\s+/i);
for (var p of parts) { if (p.trim() === picked || p.trim().includes(picked)) return true; if (p.trim().replace(/\$/g, 's').includes(pn)) return true; }
return false;
}

module.exports = async function handler(req, res) {
var authHeader = req.headers['authorization'], cronSecret = process.env.CRON_SECRET;
if (cronSecret && authHeader !== 'Bearer ' + cronSecret) return res.status(401).json({ error: 'Unauthorized' });
if (!SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });

var supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
console.log(' Fantasy Life — Billboard Hot 100 Update\n');

var { data: season } = await supabase.from('seasons').select('year, locks').eq('status', 'active').single();
if (!season) return res.status(200).json({ message: 'No active season found' });

var locks = season.locks || {};

var { data: membersArr } = await supabase.from('members').select('id, name');
var memberNameById = {};
(membersArr || []).forEach(function(m) { memberNameById[m.id] = m.name; });

var allChartDates = getChartDates();
console.log(' Chart dates in Fantasy Year: ' + allChartDates.length + ' weeks');

var { data: cachedDates } = await supabase.from('billboard_weeks').select('chart_date').order('chart_date').then(function(r) { var unique = [...new Set((r.data || []).map(function(d) { return d.chart_date; }))]; return { data: unique }; });
var cachedSet = new Set(cachedDates || []);
var missingDates = allChartDates.filter(function(d) { return !cachedSet.has(d); });

console.log(' Already cached: ' + cachedSet.size + ' weeks');
console.log(' Need to fetch: ' + missingDates.length + ' weeks');

var fetchedCount = 0, MAX_FETCHES_PER_RUN = 5;
for (var dateStr of missingDates) {
 if (fetchedCount >= MAX_FETCHES_PER_RUN) { console.log(' Hit fetch limit (' + MAX_FETCHES_PER_RUN + ')'); break; }
 console.log(' Fetching chart for ' + dateStr + '...');
 var entries = await fetchBillboardChart(dateStr);
 if (!entries) { console.log(' Failed to parse ' + dateStr); continue; }
 var rows = entries.map(function(e) { return { chart_date: dateStr, rank: e.rank, title: e.title, artist: e.artist, is_number_one: e.rank === 1 }; });
 var { error: insertErr } = await supabase.from('billboard_weeks').upsert(rows, { onConflict: 'chart_date,rank' });
 if (insertErr) console.error(' Insert error for ' + dateStr + ':', insertErr.message);
 else { fetchedCount++; console.log(' Cached ' + entries.length + ' entries for ' + dateStr); }
 if (fetchedCount < MAX_FETCHES_PER_RUN && missingDates.indexOf(dateStr) < missingDates.length - 1) await new Promise(function(r) { setTimeout(r, 2000); });
}

var { data: picks } = await supabase.from('picks').select('id, member_id, pick, bonus').eq('season_year', season.year).eq('category', 'Musician');
if (!picks || picks.length === 0) return res.status(200).json({ message: 'No Musician picks found' });

var { data: allEntries } = await supabase.from('billboard_weeks').select('chart_date, rank, title, artist, is_number_one').gte('chart_date', FANTASY_YEAR_START).lte('chart_date', FANTASY_YEAR_END).order('chart_date');
if (!allEntries || allEntries.length === 0) return res.status(200).json({ message: 'No chart data cached yet' });

console.log('\n Recounting from ' + allEntries.length + ' cached chart entries...');

var artistStats = {};
for (var pick of picks) {
 var artistName = pick.pick, songs = {}, totalWeeks = 0;
 for (var entry of allEntries) {
 if (artistMatches(artistName, entry.artist)) {
  var songKey = entry.title;
  if (!songs[songKey]) songs[songKey] = { title: entry.title, weeks: 0, numOneWeeks: 0 };
  songs[songKey].weeks++; totalWeeks++;
  if (entry.rank === 1) songs[songKey].numOneWeeks++;
 }
 }
 artistStats[pick.id] = { ...pick, totalWeeks: totalWeeks, songs: Object.values(songs).sort(function(a, b) { return b.weeks - a.weeks; }) };
}

var ranked = Object.values(artistStats).sort(function(a, b) { return b.totalWeeks - a.totalWeeks; });
var totalMembers = picks.length, updated = 0, rankings = [];

for (var i = 0; i < ranked.length; i++) {
 var r = ranked[i], newBase = totalMembers - i;
 var ownerName = memberNameById[r.member_id] || r.member_id;

 var baseLocked = isFieldLocked(locks, 'Musician', ownerName, 'base');
 var metricLocked = isFieldLocked(locks, 'Musician', ownerName, 'metric');

 var updateObj = { updated_at: new Date().toISOString() };
 if (!baseLocked) updateObj.base = newBase;
 if (!metricLocked) { updateObj.metric = r.totalWeeks; updateObj.record = r.totalWeeks + ' chart wks'; }

 var skipped = [];
 if (baseLocked) skipped.push('base');
 if (metricLocked) skipped.push('metric');
 if (skipped.length > 0) console.log(' ' + ownerName + ': skipped locked: ' + skipped.join(', '));

 var { error: pickErr } = await supabase.from('picks').update(updateObj).eq('id', r.id);
 if (pickErr) { console.error(' Failed to update pick ' + r.member_id + ':', pickErr.message); continue; }

 // Update music_songs (not locked — these are detail rows, lock check is on the pick level)
 await supabase.from('music_songs').delete().eq('pick_id', r.id);
 if (r.songs.length > 0) {
 var songRows = r.songs.map(function(s) { return { pick_id: r.id, title: s.title, weeks: s.weeks, num_one_weeks: s.numOneWeeks, note: s.numOneWeeks > 0 ? s.numOneWeeks + ' week' + (s.numOneWeeks > 1 ? 's' : '') + ' at #1' : null }; });
 var { error: songErr } = await supabase.from('music_songs').insert(songRows);
 if (songErr) console.error(' Failed to update songs for ' + r.member_id + ':', songErr.message);
 }

 updated++;
 rankings.push({ rank: i + 1, member: r.member_id, artist: r.pick, totalWeeks: r.totalWeeks, songCount: r.songs.length, base: baseLocked ? Number(r.base) || 0 : newBase, bonus: Number(r.bonus) || 0, total: (baseLocked ? Number(r.base) || 0 : newBase) + (Number(r.bonus) || 0), lockedFields: skipped.length > 0 ? skipped : undefined });
}

console.log('\n Billboard update complete — ' + updated + '/' + ranked.length + ' musicians updated');
return res.status(200).json({ message: 'Billboard update complete — ' + updated + '/' + ranked.length + ' musicians updated', season: season.year, timestamp: new Date().toISOString(), chartWeeksCached: cachedSet.size + fetchedCount, newWeeksFetched: fetchedCount, remainingToFetch: missingDates.length - fetchedCount, rankings: rankings });
};