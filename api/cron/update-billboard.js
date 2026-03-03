/**
* Fantasy Life — Billboard Hot 100 Musician Tracker
* 
* Caches each week's Hot 100 chart in billboard_weeks table.
* On every run, fetches only new weeks, then does a full YTD recount
* from the cache — total chart weeks + #1 weeks per song per artist.
* 
* Scoring: rank all 11 members by total chart weeks (highest = 11 base pts).
* Also updates music_songs detail table with per-song breakdowns.
* Bonus points are NEVER touched (locked from Grammy results).
* 
* Deploy as: api/cron/update-billboard.js
* Schedule: weekly on Wednesdays at 3 AM UTC (Tues 10 PM ET, after chart drops)
*/

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Fantasy Year boundaries
const FANTASY_YEAR_START = '2025-03-15';
// We'll stop processing at the season end
const FANTASY_YEAR_END = '2026-03-14';

/**
* Get all valid chart dates (Saturdays) from Fantasy Year start to today
*/
function getChartDates() {
 const dates = [];
 const start = new Date(FANTASY_YEAR_START);
 const end = new Date(Math.min(Date.now(), new Date(FANTASY_YEAR_END).getTime()));

 // Billboard charts are dated Saturdays. Find first Saturday >= start
 let current = new Date(start);
 const dayOfWeek = current.getDay();
 if (dayOfWeek !== 6) {
  // Advance to next Saturday
  current.setDate(current.getDate() + (6 - dayOfWeek));
 }

 while (current <= end) {
  dates.push(current.toISOString().split('T')[0]); // "YYYY-MM-DD"
  current.setDate(current.getDate() + 7); // Next Saturday
 }

 return dates;
}

/**
* Fetch and parse Billboard Hot 100 chart for a given date.
* Returns array of { rank, title, artist } or null on failure.
*/
async function fetchBillboardChart(dateStr) {
 try {
  const url = `https://www.billboard.com/charts/hot-100/${dateStr}/`;
  const res = await fetch(url, {
   headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
   },
  });

  if (!res.ok) {
   console.log(`  Billboard returned ${res.status} for ${dateStr}`);
   return null;
  }

  const html = await res.text();
  return parseBillboardHTML(html);
 } catch (err) {
  console.error(`  Fetch error for ${dateStr}:`, err.message);
  return null;
 }
}

/**
* Parse Billboard Hot 100 HTML into structured data.
* Billboard uses <h3> for song titles and <span> for artist names
* within chart row containers.
*/
function parseBillboardHTML(html) {
 const entries = [];

 // Billboard chart entries are in containers with data-detail-target
 // Pattern: find song title in <h3 ...> and artist in <span ...> near each other
 // The #1 song uses a different class than 2-100

 // Strategy: find all <h3> tags with specific chart classes, then grab nearby <span> for artist
 // Billboard uses: <h3 ...class="...c-title...">TITLE</h3> and <span ...class="...c-label...">ARTIST</span>

 // More reliable: look for the chart list items with rank, title, artist pattern
 // Try multiple parsing strategies

 // Strategy 1: Look for title/artist pairs in chart row markup
 const rowRegex = /id="title-of-a-story"[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<span[^>]*class="[^"]*c-label[^"]*"[^>]*>([\s\S]*?)<\/span>/g;
 let match;

 while ((match = rowRegex.exec(html)) !== null) {
  const title = match[1].replace(/<[^>]+>/g, '').trim();
  const artist = match[2].replace(/<[^>]+>/g, '').trim();
  if (title && artist && title !== 'Songwriter(s):' && title !== 'Producer(s):') {
   entries.push({ rank: entries.length + 1, title, artist });
  }
 }

 // Strategy 2: If strategy 1 found nothing, try a broader approach
 if (entries.length === 0) {
  // Look for <h3> with chart item classes followed by artist spans
  const altRegex = /<h3[^>]*class="[^"]*o-chart-results-list__item[^"]*"[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/g;
  while ((match = altRegex.exec(html)) !== null) {
   const title = match[1].replace(/<[^>]+>/g, '').trim();
   const artist = match[2].replace(/<[^>]+>/g, '').trim();
   if (title && artist && title.length > 0 && title.length < 200) {
    entries.push({ rank: entries.length + 1, title, artist });
   }
  }
 }

 // Strategy 3: Most aggressive — find all h3/span pairs that look like songs
 if (entries.length < 10) {
  entries.length = 0;
  // Billboard wraps each chart entry; look for the title pattern
  const chunks = html.split(/chart-results-list__item|data-detail-target/);
  for (let i = 1; i < chunks.length && entries.length < 100; i++) {
   const chunk = chunks[i];
   const titleMatch = chunk.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
   const artistMatch = chunk.match(/<span[^>]*class="[^"]*c-label[^"]*a-no-trucate[^"]*"[^>]*>([\s\S]*?)<\/span>/);
   if (titleMatch && artistMatch) {
    const title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
    const artist = artistMatch[1].replace(/<[^>]+>/g, '').trim();
    if (title && artist && title.length < 200) {
     entries.push({ rank: entries.length + 1, title, artist });
    }
   }
  }
 }

 return entries.length >= 10 ? entries : null; // Expect at least 10 entries for valid chart
}

/**
* Check if a picked artist appears in a Billboard artist credit string.
* Handles "Featuring", "&", "With", "x", "," collaborations.
* e.g., "Kendrick Lamar Featuring SZA" should match "Kendrick Lamar"
* e.g., "Bruno Mars & Lady Gaga" should match both "Bruno Mars" and "Lady Gaga"
*/
function artistMatches(pickedArtist, billboardArtist) {
 const picked = pickedArtist.toLowerCase().trim();
 const billboard = billboardArtist.toLowerCase().trim();

 // Direct match
 if (billboard === picked) return true;

 // Billboard contains picked name
 if (billboard.includes(picked)) return true;

 // Handle "A$AP Rocky" → "A$AP" or "ASAP"
 const pickedNorm = picked.replace(/\$/g, 's');
 const billboardNorm = billboard.replace(/\$/g, 's');
 if (billboardNorm.includes(pickedNorm)) return true;

 // Handle "The Weeknd" → "Weeknd"
 const pickedNoThe = picked.replace(/^the\s+/, '');
 if (billboard.includes(pickedNoThe)) return true;

 // Split billboard credit by common separators and check each part
 const parts = billboard.split(/\s+(?:featuring|feat\.?|ft\.?|with|x|&|,)\s+/i);
 for (const part of parts) {
  if (part.trim() === picked || part.trim().includes(picked)) return true;
  if (part.trim().replace(/\$/g, 's').includes(pickedNorm)) return true;
 }

 return false;
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

 console.log(' Fantasy Life — Billboard Hot 100 Update\n');

 // 1. Find active season
 const { data: season } = await supabase
  .from('seasons')
  .select('year')
  .eq('status', 'active')
  .single();

 if (!season) {
  return res.status(200).json({ message: 'No active season found' });
 }

 // 2. Get all chart dates for the Fantasy Year
 const allChartDates = getChartDates();
 console.log(` Chart dates in Fantasy Year: ${allChartDates.length} weeks`);

 // 3. Check which dates we already have cached
 const { data: cachedDates } = await supabase
  .from('billboard_weeks')
  .select('chart_date')
  .order('chart_date')
  .then(r => {
   const unique = [...new Set((r.data || []).map(d => d.chart_date))];
   return { data: unique };
  });

 const cachedSet = new Set(cachedDates || []);
 const missingDates = allChartDates.filter(d => !cachedSet.has(d));

 console.log(` Already cached: ${cachedSet.size} weeks`);
 console.log(` Need to fetch: ${missingDates.length} weeks`);

 // 4. Fetch and cache missing weeks (with rate limiting)
 let fetchedCount = 0;
 const MAX_FETCHES_PER_RUN = 5; // Limit to avoid timeout

 for (const dateStr of missingDates) {
  if (fetchedCount >= MAX_FETCHES_PER_RUN) {
   console.log(` Hit fetch limit (${MAX_FETCHES_PER_RUN}), will get remaining next run`);
   break;
  }

  console.log(` Fetching chart for ${dateStr}...`);
  const entries = await fetchBillboardChart(dateStr);

  if (!entries) {
   console.log(`  Failed to parse chart for ${dateStr}, skipping`);
   continue;
  }

  // Store in billboard_weeks
  const rows = entries.map(e => ({
   chart_date: dateStr,
   rank: e.rank,
   title: e.title,
   artist: e.artist,
   is_number_one: e.rank === 1,
  }));

  const { error: insertErr } = await supabase
   .from('billboard_weeks')
   .upsert(rows, { onConflict: 'chart_date,rank' });

  if (insertErr) {
   console.error(`  Insert error for ${dateStr}:`, insertErr.message);
  } else {
   fetchedCount++;
   console.log(`  Cached ${entries.length} entries for ${dateStr}`);
  }

  // Rate limit: wait 2 seconds between fetches
  if (fetchedCount < MAX_FETCHES_PER_RUN && missingDates.indexOf(dateStr) < missingDates.length - 1) {
   await new Promise(r => setTimeout(r, 2000));
  }
 }

 // 5. Get Musician picks from Supabase
 const { data: picks } = await supabase
  .from('picks')
  .select('id, member_id, pick, bonus')
  .eq('season_year', season.year)
  .eq('category', 'Musician');

 if (!picks || picks.length === 0) {
  return res.status(200).json({ message: 'No Musician picks found' });
 }

 // 6. Full recount from cache — load ALL cached chart entries
 const { data: allEntries } = await supabase
  .from('billboard_weeks')
  .select('chart_date, rank, title, artist, is_number_one')
  .gte('chart_date', FANTASY_YEAR_START)
  .lte('chart_date', FANTASY_YEAR_END)
  .order('chart_date');

 if (!allEntries || allEntries.length === 0) {
  console.log(' No cached chart data yet — run again after charts are fetched');
  return res.status(200).json({ message: 'No chart data cached yet, will fetch on next runs' });
 }

 console.log(`\n Recounting from ${allEntries.length} cached chart entries...`);

 // 7. For each picked artist, count chart weeks and #1 weeks per song
 const artistStats = {};

 for (const pick of picks) {
  const artistName = pick.pick;
  const songs = {}; // { songTitle: { weeks: N, numOneWeeks: N } }
  let totalWeeks = 0;

  for (const entry of allEntries) {
   if (artistMatches(artistName, entry.artist)) {
    const songKey = entry.title;
    if (!songs[songKey]) {
     songs[songKey] = { title: entry.title, weeks: 0, numOneWeeks: 0 };
    }
    songs[songKey].weeks++;
    totalWeeks++;
    if (entry.rank === 1) {
     songs[songKey].numOneWeeks++;
    }
   }
  }

  artistStats[pick.id] = {
   ...pick,
   totalWeeks,
   songs: Object.values(songs).sort((a, b) => b.weeks - a.weeks),
  };
 }

 // 8. Rank by total chart weeks (highest = rank 1)
 const ranked = Object.values(artistStats).sort((a, b) => b.totalWeeks - a.totalWeeks);
 const totalMembers = picks.length;

 // 9. Update Supabase — picks + music_songs
 let updated = 0;
 const rankings = [];

 for (let i = 0; i < ranked.length; i++) {
  const r = ranked[i];
  const newBase = totalMembers - i;

  // Update picks table — base only, never touch bonus
  const { error: pickErr } = await supabase
   .from('picks')
   .update({
    base: newBase,
    metric: r.totalWeeks,
    record: `${r.totalWeeks} chart wks`,
    updated_at: new Date().toISOString(),
   })
   .eq('id', r.id);

  if (pickErr) {
   console.error(` Failed to update pick ${r.member_id}:`, pickErr.message);
   continue;
  }

  // Update music_songs — delete existing and re-insert from recount
  await supabase.from('music_songs').delete().eq('pick_id', r.id);

  if (r.songs.length > 0) {
   const songRows = r.songs.map(s => ({
    pick_id: r.id,
    title: s.title,
    weeks: s.weeks,
    num_one_weeks: s.numOneWeeks,
    note: s.numOneWeeks > 0 ? `${s.numOneWeeks} week${s.numOneWeeks > 1 ? 's' : ''} at #1` : null,
   }));

   const { error: songErr } = await supabase
    .from('music_songs')
    .insert(songRows);

   if (songErr) {
    console.error(` Failed to update songs for ${r.member_id}:`, songErr.message);
   }
  }

  updated++;
  rankings.push({
   rank: i + 1,
   member: r.member_id,
   artist: r.pick,
   totalWeeks: r.totalWeeks,
   songCount: r.songs.length,
   topSongs: r.songs.slice(0, 3).map(s =>
    `${s.title} (${s.weeks}wk${s.numOneWeeks > 0 ? `, ${s.numOneWeeks}×#1` : ''})`
   ),
   base: newBase,
   bonus: Number(r.bonus) || 0,
   total: newBase + (Number(r.bonus) || 0),
  });
 }

 const summary = {
  message: `Billboard update complete — ${updated}/${ranked.length} musicians updated`,
  season: season.year,
  timestamp: new Date().toISOString(),
  chartWeeksCached: cachedSet.size + fetchedCount,
  chartWeeksTotal: allChartDates.length,
  newWeeksFetched: fetchedCount,
  remainingToFetch: missingDates.length - fetchedCount,
  rankings,
 };

 console.log(`\n ${summary.message}`);
 if (summary.remainingToFetch > 0) {
  console.log(`  ${summary.remainingToFetch} weeks still need fetching — run again tomorrow`);
 }
 return res.status(200).json(summary);
};