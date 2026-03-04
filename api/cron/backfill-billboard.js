/**
* ONE-TIME Billboard Backfill Script
* 
* Fetches all available chart data from the mhollingshead/billboard-hot-100
* GitHub repo (covers ~March 2025 through Dec 2025), inserts into your
* billboard_weeks table, then recalculates Musician scores.
* 
* Run once, then DELETE this file.
* 
* Deploy as: api/cron/backfill-billboard.js
* Trigger manually: curl -H "Authorization: Bearer fantasylife2025" https://fantasy-life-black.vercel.app/api/cron/backfill-billboard
*/

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const FANTASY_YEAR_START = '2025-03-15';
const FANTASY_YEAR_END = '2026-03-14';
const GITHUB_BASE = 'https://raw.githubusercontent.com/mhollingshead/billboard-hot-100/main/date/';

function getChartDates() {
 var dates = [];
 var start = new Date(FANTASY_YEAR_START);
 var end = new Date(Math.min(Date.now(), new Date(FANTASY_YEAR_END).getTime()));
 var current = new Date(start);
 var dow = current.getDay();
 if (dow !== 6) current.setDate(current.getDate() + (6 - dow));
 while (current <= end) {
  dates.push(current.toISOString().split('T')[0]);
  current.setDate(current.getDate() + 7);
 }
 return dates;
}

function artistMatches(pickedArtist, billboardArtist) {
 var picked = pickedArtist.toLowerCase().trim();
 var billboard = billboardArtist.toLowerCase().trim();
 if (billboard === picked || billboard.includes(picked)) return true;
 var pn = picked.replace(/\$/g, 's'), bn = billboard.replace(/\$/g, 's');
 if (bn.includes(pn)) return true;
 var pnt = picked.replace(/^the\s+/, '');
 if (billboard.includes(pnt)) return true;
 var parts = billboard.split(/\s+(?:featuring|feat\.?|ft\.?|with|x|&|,)\s+/i);
 for (var p of parts) {
  if (p.trim() === picked || p.trim().includes(picked)) return true;
  if (p.trim().replace(/\$/g, 's').includes(pn)) return true;
 }
 return false;
}

module.exports = async function handler(req, res) {
 var authHeader = req.headers['authorization'];
 var cronSecret = process.env.CRON_SECRET;
 if (cronSecret && authHeader !== 'Bearer ' + cronSecret) {
  return res.status(401).json({ error: 'Unauthorized' });
 }
 if (!SUPABASE_SERVICE_KEY) {
  return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY' });
 }

 var supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
 console.log('Billboard Backfill — ONE TIME RUN\n');

 // 1. Find active season
 var { data: season } = await supabase
  .from('seasons')
  .select('year')
  .eq('status', 'active')
  .single();
 if (!season) return res.status(200).json({ message: 'No active season' });

 // 2. Get all chart dates we need
 var allDates = getChartDates();
 console.log('Total chart dates in Fantasy Year: ' + allDates.length);

 // 3. Check which dates are already cached
 var { data: existingRows } = await supabase
  .from('billboard_weeks')
  .select('chart_date');
 var cachedSet = new Set((existingRows || []).map(function(r) { return r.chart_date; }));
 var missingDates = allDates.filter(function(d) { return !cachedSet.has(d); });
 console.log('Already cached: ' + cachedSet.size + ' weeks');
 console.log('Missing: ' + missingDates.length + ' weeks');

 // 4. Fetch each missing date from GitHub repo
 var fetched = 0;
 var failed = [];

 for (var i = 0; i < missingDates.length; i++) {
  var dateStr = missingDates[i];
  process.stdout.write(' Fetching ' + dateStr + '... ');

  var entries = null;

  // Try the exact date first
  try {
   var url = GITHUB_BASE + dateStr + '.json';
   var resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
   if (resp.ok) {
    var data = await resp.json();
    if (data && data.data && data.data.length >= 10) {
     entries = data.data.map(function(e) {
      return { rank: e.this_week, title: e.song, artist: e.artist };
     });
    }
   }
  } catch (err) { /* ignore */ }

  // If exact date failed, try +/- 1 day (Billboard dates can be off by a day)
  if (!entries) {
   for (var offset = -1; offset <= 1; offset++) {
    if (offset === 0) continue;
    try {
     var altDate = new Date(dateStr);
     altDate.setDate(altDate.getDate() + offset);
     var altStr = altDate.toISOString().split('T')[0];
     var altResp = await fetch(GITHUB_BASE + altStr + '.json', { headers: { 'User-Agent': 'Mozilla/5.0' } });
     if (altResp.ok) {
      var altData = await altResp.json();
      if (altData && altData.data && altData.data.length >= 10) {
       entries = altData.data.map(function(e) {
        return { rank: e.this_week, title: e.song, artist: e.artist };
       });
       console.log('(found at ' + altStr + ')');
       break;
      }
     }
    } catch (err) { /* ignore */ }
   }
  }

  if (!entries) {
   console.log('NOT FOUND');
   failed.push(dateStr);
   continue;
  }

  // Insert into billboard_weeks
  var rows = entries.map(function(e) {
   return {
    chart_date: dateStr,
    rank: e.rank,
    title: e.title,
    artist: e.artist,
    is_number_one: e.rank === 1,
   };
  });

  var { error: insertErr } = await supabase
   .from('billboard_weeks')
   .upsert(rows, { onConflict: 'chart_date,rank' });

  if (insertErr) {
   console.log('INSERT ERROR: ' + insertErr.message);
   failed.push(dateStr);
  } else {
   fetched++;
   console.log('OK (' + entries.length + ' entries)');
  }

  // Small delay to be polite to GitHub
  await new Promise(function(r) { setTimeout(r, 200); });
 }

 console.log('\nBackfill complete: ' + fetched + ' weeks fetched, ' + failed.length + ' failed');
 if (failed.length > 0) {
  console.log('Failed dates (will be picked up by daily scraper): ' + failed.join(', '));
 }

 // 5. Now recalculate all Musician scores from the full cache
 console.log('\nRecalculating Musician scores...');

 var { data: picks } = await supabase
  .from('picks')
  .select('id, member_id, pick, bonus')
  .eq('season_year', season.year)
  .eq('category', 'Musician');

 if (!picks || picks.length === 0) {
  return res.status(200).json({ message: 'Backfill done but no Musician picks found', fetched: fetched, failed: failed });
 }

 var { data: allEntries } = await supabase
  .from('billboard_weeks')
  .select('chart_date, rank, title, artist, is_number_one')
  .gte('chart_date', FANTASY_YEAR_START)
  .lte('chart_date', FANTASY_YEAR_END)
  .order('chart_date');

 console.log('Total cached chart entries: ' + (allEntries || []).length);

 // Count chart weeks per artist
 var artistStats = {};
 for (var pick of picks) {
  var artistName = pick.pick;
  var songs = {};
  var totalWeeks = 0;
  for (var entry of (allEntries || [])) {
   if (artistMatches(artistName, entry.artist)) {
    var songKey = entry.title;
    if (!songs[songKey]) songs[songKey] = { title: entry.title, weeks: 0, numOneWeeks: 0 };
    songs[songKey].weeks++;
    totalWeeks++;
    if (entry.rank === 1) songs[songKey].numOneWeeks++;
   }
  }
  artistStats[pick.id] = {
   id: pick.id,
   member_id: pick.member_id,
   pick: pick.pick,
   bonus: pick.bonus,
   totalWeeks: totalWeeks,
   songs: Object.values(songs).sort(function(a, b) { return b.weeks - a.weeks; }),
  };
 }

 // Rank and update
 var ranked = Object.values(artistStats).sort(function(a, b) { return b.totalWeeks - a.totalWeeks; });
 var totalMembers = picks.length;
 var updated = 0;
 var rankings = [];

 for (var ri = 0; ri < ranked.length; ri++) {
  var r = ranked[ri];
  var newBase = totalMembers - ri;

  // Update picks table
  await supabase.from('picks').update({
   base: newBase,
   metric: r.totalWeeks,
   record: r.totalWeeks + ' chart wks',
   updated_at: new Date().toISOString(),
  }).eq('id', r.id);

  // Rebuild music_songs
  await supabase.from('music_songs').delete().eq('pick_id', r.id);
  if (r.songs.length > 0) {
   var songRows = r.songs.map(function(s) {
    return {
     pick_id: r.id,
     title: s.title,
     weeks: s.weeks,
     num_one_weeks: s.numOneWeeks,
     note: s.numOneWeeks > 0 ? s.numOneWeeks + ' week' + (s.numOneWeeks > 1 ? 's' : '') + ' at #1' : null,
    };
   });
   await supabase.from('music_songs').insert(songRows);
  }

  updated++;
  rankings.push({
   rank: ri + 1,
   member: r.member_id,
   artist: r.pick,
   totalWeeks: r.totalWeeks,
   songCount: r.songs.length,
   base: newBase,
   bonus: Number(r.bonus) || 0,
   total: newBase + (Number(r.bonus) || 0),
  });
 }

 var summary = {
  message: 'Backfill complete! ' + fetched + ' weeks fetched from GitHub, ' + updated + ' musicians rescored',
  failedDates: failed.length > 0 ? failed : undefined,
  failedNote: failed.length > 0 ? 'These dates will be picked up by your daily Billboard scraper' : undefined,
  chartWeeksNowCached: cachedSet.size + fetched,
  rankings: rankings,
 };

 console.log('\n' + summary.message);
 return res.status(200).json(summary);
};