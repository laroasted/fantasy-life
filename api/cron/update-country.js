/**
* Fantasy Life — Country GDP + Olympics Updater
* Respects commissioner locks from seasons.locks column.
*/

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const COUNTRY_CODES = { 'Norway': 'NOR', 'South Sudan': 'SSD', 'Germany': 'DEU', 'United States': 'USA', 'Russia': 'RUS', 'India': 'IND', 'Libya': 'LBY', 'Ethiopia': 'ETH', 'Guyana': 'GUY', 'Canada': 'CAN', 'Philippines': 'PHL', 'US': 'USA', 'USA': 'USA', 'U.S.': 'USA' };
const COUNTRY_NOC = { 'Norway': 'NOR', 'South Sudan': 'SSD', 'Germany': 'GER', 'United States': 'USA', 'Russia': 'RUS', 'India': 'IND', 'Libya': 'LBY', 'Ethiopia': 'ETH', 'Guyana': 'GUY', 'Canada': 'CAN', 'Philippines': 'PHI' };
const OLYMPIC_BONUS = { 1: 10, 2: 7, 3: 5, 4: 3, 5: 2 };

function isFieldLocked(locks, category, ownerName, field) { return locks ? !!locks[category + '|' + ownerName + '|' + field] : false; }

function getCountryISO(pickName) { if (COUNTRY_CODES[pickName]) return COUNTRY_CODES[pickName]; var lower = pickName.toLowerCase(); for (var [name, code] of Object.entries(COUNTRY_CODES)) { if (name.toLowerCase() === lower) return code; } return null; }

function matchOlympicMedals(pickName, medalData) { var noc = COUNTRY_NOC[pickName]; return noc ? (medalData.find(function(m) { return m.noc === noc; }) || null) : null; }

async function fetchGDPData(countryCodes) {
try { var isoList = countryCodes.join(';'); var currentYear = new Date().getFullYear(); var dateRange = (currentYear - 3) + ':' + currentYear; var url = 'https://api.worldbank.org/v2/country/' + isoList + '/indicator/NY.GDP.MKTP.KD.ZG?format=json&date=' + dateRange + '&per_page=200'; var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (!res.ok) return null; var data = await res.json(); var records = data[1]; if (!records || records.length === 0) return null; var gdpByCountry = {}; for (var record of records) { if (record.value === null) continue; var iso3 = record.countryiso3code || record.country?.id; var year = parseInt(record.date); var value = parseFloat(record.value); if (!gdpByCountry[iso3] || year > gdpByCountry[iso3].year) gdpByCountry[iso3] = { countryName: record.country?.value || iso3, year: year, gdpGrowth: Math.round(value * 10) / 10 }; } return gdpByCountry; } catch (err) { console.error(' GDP fetch error:', err.message); return null; }
}

async function fetchOlympicMedals() {
try { var res = await fetch('https://www.espn.com/olympics/winter/2026/medals', { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (!res.ok) return null; var html = await res.text(); var medals = []; var pattern = /([A-Z]{3})[^0-9]*(\d+)[^0-9]+(\d+)[^0-9]+(\d+)[^0-9]+(\d+)/g; var match; while ((match = pattern.exec(html)) !== null) { var noc = match[1]; if (['THE', 'FOR', 'AND', 'ALL', 'TOP'].includes(noc)) continue; medals.push({ noc: noc, gold: parseInt(match[2]), silver: parseInt(match[3]), bronze: parseInt(match[4]), total: parseInt(match[5]) }); } if (medals.length > 0) medals.sort(function(a, b) { return b.total - a.total || b.gold - a.gold; }); return medals.length > 0 ? medals : null; } catch (err) { console.error(' Olympics fetch error:', err.message); return null; }
}

module.exports = async function handler(req, res) {
var authHeader = req.headers['authorization'], cronSecret = process.env.CRON_SECRET;
if (cronSecret && authHeader !== 'Bearer ' + cronSecret) return res.status(401).json({ error: 'Unauthorized' });
if (!SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });

var supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
console.log(' Fantasy Life — Country GDP + Olympics Update\n');

var { data: season } = await supabase.from('seasons').select('year, locks').eq('status', 'active').single();
if (!season) return res.status(200).json({ message: 'No active season found' });

var locks = season.locks || {};
var { data: membersArr } = await supabase.from('members').select('id, name');
var memberNameById = {};
(membersArr || []).forEach(function(m) { memberNameById[m.id] = m.name; });

var { data: picks } = await supabase.from('picks').select('id, member_id, pick, base, bonus').eq('season_year', season.year).eq('category', 'Country');
if (!picks || picks.length === 0) return res.status(200).json({ message: 'No Country picks found' });

var results = { gdp: null, olympics: null };

// ── GDP UPDATE ──
console.log(' Fetching GDP data from World Bank...');
var isoCodes = picks.map(function(p) { return getCountryISO(p.pick); }).filter(Boolean);
var uniqueISO = [...new Set(isoCodes)];
var gdpData = await fetchGDPData(uniqueISO);

if (gdpData) {
 var gdpResults = picks.map(function(p) { var iso = getCountryISO(p.pick); var gdp = iso && gdpData[iso] ? gdpData[iso].gdpGrowth : null; return { ...p, gdpGrowth: gdp, iso: iso }; });
 var withData = gdpResults.filter(function(r) { return r.gdpGrowth !== null; });
 if (withData.length > 0) {
 gdpResults.sort(function(a, b) { return (b.gdpGrowth || -999) - (a.gdpGrowth || -999); });
 var totalMembers = picks.length, updated = 0, rankings = [];
 for (var i = 0; i < gdpResults.length; i++) {
  var r = gdpResults[i], newBase = totalMembers - i;
  var ownerName = memberNameById[r.member_id] || r.member_id;

  if (r.gdpGrowth !== null) {
  var baseLocked = isFieldLocked(locks, 'Country', ownerName, 'base');
  var metricLocked = isFieldLocked(locks, 'Country', ownerName, 'metric');

  var updateObj = { updated_at: new Date().toISOString() };
  if (!baseLocked) updateObj.base = newBase;
  if (!metricLocked) { updateObj.metric = r.gdpGrowth; updateObj.record = r.gdpGrowth + '% GDP'; }

  var skipped = [];
  if (baseLocked) skipped.push('base');
  if (metricLocked) skipped.push('metric');
  if (skipped.length > 0) console.log(' ' + ownerName + ': skipped locked: ' + skipped.join(', '));

  var { error } = await supabase.from('picks').update(updateObj).eq('id', r.id);
  if (!error) updated++;
  }
  rankings.push({ rank: i + 1, member: r.member_id, country: r.pick, gdpGrowth: r.gdpGrowth !== null ? r.gdpGrowth + '%' : 'No data', base: newBase });
 }
 console.log(' GDP: Updated ' + updated + '/' + picks.length + ' countries');
 results.gdp = { status: 'updated', updated: updated, rankings: rankings };
 } else { results.gdp = { status: 'skipped', reason: 'no data for picked countries' }; }
} else { results.gdp = { status: 'skipped', reason: 'World Bank API error' }; }

// ── OLYMPICS UPDATE ──
var now = new Date(), year = now.getFullYear(), month = now.getMonth() + 1;
var isWinterOlympicYear = (year - 2026) % 4 === 0;
var isSummerOlympicYear = (year - 2028) % 4 === 0;
var isOlympicWindow = (isWinterOlympicYear && (month === 2 || month === 3)) || (isSummerOlympicYear && (month === 7 || month === 8));

if (isOlympicWindow) {
 console.log('\n Checking Olympic medal counts...');
 var medalData = await fetchOlympicMedals();
 if (medalData) {
 var olympicsUpdated = 0, medalRankings = [];
 for (var pick of picks) {
  var ownerName2 = memberNameById[pick.member_id] || pick.member_id;
  var medals = matchOlympicMedals(pick.pick, medalData);
  if (medals) {
  var rankIdx = medalData.findIndex(function(m) { return m.noc === COUNTRY_NOC[pick.pick]; });
  var medalRank = rankIdx >= 0 ? rankIdx + 1 : null;
  var bonusPts = OLYMPIC_BONUS[medalRank] || 0;

  // Check lock on bonus before updating
  var bonusLocked = isFieldLocked(locks, 'Country', ownerName2, 'bonus');

  var { error: olyErr } = await supabase.from('country_olympics').upsert({ pick_id: pick.id, medal_rank: medalRank, gold: medals.gold, silver: medals.silver, bronze: medals.bronze, pts: bonusPts, note: medalRank && medalRank <= 5 ? '#' + medalRank + ' by total medals (' + medals.total + ')' : medals.total > 0 ? medals.total + ' medals, outside top 5' : 'No medals' }, { onConflict: 'pick_id' });

  if (!olyErr && !bonusLocked) {
   await supabase.from('picks').update({ bonus: bonusPts, bonus_note: bonusPts > 0 ? '#' + medalRank + ' by total medals (' + medals.total + ')' : '', updated_at: new Date().toISOString() }).eq('id', pick.id);
   olympicsUpdated++;
  } else if (bonusLocked) {
   console.log(' ' + ownerName2 + ': bonus is locked, skipping');
   olympicsUpdated++;
  }

  medalRankings.push({ member: pick.member_id, country: pick.pick, gold: medals.gold, silver: medals.silver, bronze: medals.bronze, total: medals.total, medalRank: medalRank, bonusPts: bonusPts });
  } else {
  medalRankings.push({ member: pick.member_id, country: pick.pick, gold: 0, silver: 0, bronze: 0, total: 0, medalRank: null, bonusPts: 0 });
  }
 }
 console.log(' Olympics: Updated ' + olympicsUpdated + '/' + picks.length + ' countries');
 results.olympics = { status: 'updated', updated: olympicsUpdated, rankings: medalRankings };
 } else { results.olympics = { status: 'skipped', reason: 'no medal data found' }; }
} else { results.olympics = { status: 'skipped', reason: 'not Olympic season' }; }

console.log('\n Done!');
return res.status(200).json({ message: 'Country update complete', season: season.year, timestamp: new Date().toISOString(), results: results });
};