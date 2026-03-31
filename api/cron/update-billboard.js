/**
 * Fantasy Life — Billboard Hot 100 Musician Tracker
 *
 * DATA SOURCES (in priority order):
 *   1. mhollingshead/billboard-hot-100 GitHub repo (clean JSON, no parsing needed)
 *   2. Billboard.com HTML scraping (fallback if GitHub data is missing)
 *
 * Respects commissioner locks from seasons.locks column.
 * Bonus points are NEVER touched (locked from Grammy results).
 * Paginates all billboard_weeks rows (Supabase caps at 1000 per query).
 * Cleans HTML entities (&amp; -> &) on insert.
 *
 * Fantasy year dates are read dynamically from seasons.fy_start and seasons.fy_end
 * so no code changes are needed when a new season starts.
 *
 * Tiebreaker: players with the same total chart weeks split/average the base points
 * they collectively occupy.
 * e.g. 3-way tie for ranks 2–4 out of 12 = (11+10+9)/3 = 10.0 each
 *
 * SCORING NOTE:
 * totalWeeks = chart appearances + num_one_weeks bonus
 * i.e. each week a song sits at #1 counts as 2 weeks toward the ranking metric.
 * num_one_weeks is stored separately in music_songs for display/QA purposes.
 * The record string shows both: e.g. "144 chart wks (17 at #1)"
 *
 * CHANGELOG (March 2026):
 * - NEW: Primary data source is now the mhollingshead GitHub JSON API.
 *        Clean structured JSON — no HTML parsing, no bot detection issues.
 * - NEW: Billboard.com HTML scraping kept as automatic fallback.
 * - FIX: 6-day lookahead buffer in getChartDates() so charts published on
 *        Tuesday (dated to the following Saturday) are picked up by Wed cron.
 * - FIX: Improved error logging throughout.
 * - FIX: #1 weeks now count as an extra week toward totalWeeks for ranking.
 *        Each week at #1 = 2 chart weeks total (base week + 1 bonus week).
 *        num_one_weeks still stored separately for QA/display.
 */
 
const { createClient } = require('@supabase/supabase-js');
 
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
 
// ━━━ GitHub JSON source ━━━
const GITHUB_BASE = 'https://raw.githubusercontent.com/mhollingshead/billboard-hot-100/main';
 
// ━━━ Helpers ━━━
 
function assignBasePointsWithTiebreaker(ranked, totalMembers) {
  var n = ranked.length;
  var i = 0;
  while (i < n) {
    var j = i;
    while (j < n && ranked[j].totalWeeks === ranked[i].totalWeeks) j++;
    var pointSum = 0;
    for (var p = i; p < j; p++) pointSum += (totalMembers - p);
    var avgPoints = Math.round((pointSum / (j - i)) * 100) / 100;
    for (var p = i; p < j; p++) {
      ranked[p].newBase = avgPoints;
      ranked[p].rank = i + 1;
    }
    i = j;
  }
  return ranked;
}
 
function isFieldLocked(locks, category, ownerName, field) {
  if (!locks) return false;
  return !!locks[category + '|' + ownerName + '|' + field];
}
 
/**
 * Generates Saturday-aligned chart dates within the Fantasy Year window.
 * Includes a 6-day lookahead so charts published Tuesday (dated next Saturday)
 * are picked up by a Wednesday cron run.
 */
function getChartDates(FY_START, FY_END) {
  var dates = [];
  var start = new Date(FY_START);
  var SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
  var end = new Date(Math.min(Date.now() + SIX_DAYS_MS, new Date(FY_END).getTime()));
  var current = new Date(start);
  var dow = current.getDay();
  if (dow !== 6) current.setDate(current.getDate() + (6 - dow));
  while (current <= end) {
    dates.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 7);
  }
  return dates;
}
 
function cleanText(s) {
  return (s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
 
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SOURCE 1: mhollingshead/billboard-hot-100 GitHub JSON
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 
/**
 * Fetches chart data from the GitHub JSON repo.
 * Returns array of { rank, title, artist } or null if unavailable.
 */
async function fetchFromGitHub(dateStr) {
  var url = GITHUB_BASE + '/date/' + dateStr + '.json';
  try {
    console.log('  [GitHub] Trying ' + url);
    var res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) {
      console.log('  [GitHub] HTTP ' + res.status + ' for ' + dateStr + ' — date not available');
      return null;
    }
    var json = await res.json();
    if (!json || !json.data || json.data.length < 10) {
      console.log('  [GitHub] Got JSON but data array too small (' + (json.data ? json.data.length : 0) + ' entries)');
      return null;
    }
    var entries = json.data.map(function(item) {
      return {
        rank: item.this_week,
        title: (item.song || '').replace(/&amp;/g, '&'),
        artist: (item.artist || '').replace(/&amp;/g, '&'),
      };
    });
    console.log('  [GitHub] ✓ Got ' + entries.length + ' entries for ' + dateStr);
    return entries;
  } catch (err) {
    console.log('  [GitHub] ✗ Error: ' + err.message);
    return null;
  }
}
 
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SOURCE 2: Billboard.com HTML scraping (fallback)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 
async function fetchFromBillboard(dateStr) {
  var url = 'https://www.billboard.com/charts/hot-100/' + dateStr + '/';
  var MAX_RETRIES = 2;
 
  for (var attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log('  [Billboard] Attempt ' + attempt + '/' + MAX_RETRIES + ' — ' + url);
      var res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
      });
 
      if (!res.ok) {
        var errBody = '';
        try { errBody = (await res.text()).substring(0, 200); } catch (e) { /* ignore */ }
        console.log('  [Billboard] ✗ HTTP ' + res.status + ' — ' + errBody.replace(/\n/g, ' ').substring(0, 150));
        if ((res.status === 403 || res.status === 429) && attempt < MAX_RETRIES) {
          await new Promise(function(r) { setTimeout(r, 5000 * attempt); });
          continue;
        }
        return null;
      }
 
      var html = await res.text();
      console.log('  [Billboard] Got ' + html.length + ' bytes');
 
      if (html.length < 5000) {
        console.log('  [Billboard] ⚠ Suspiciously small — possible captcha/JS shell');
        if (attempt < MAX_RETRIES) {
          await new Promise(function(r) { setTimeout(r, 5000 * attempt); });
          continue;
        }
        return null;
      }
 
      var entries = parseBillboardHTML(html);
      if (entries) {
        console.log('  [Billboard] ✓ Parsed ' + entries.length + ' entries for ' + dateStr);
      } else {
        console.log('  [Billboard] ✗ All parser strategies failed for ' + dateStr);
        console.log('  [Billboard]   Has "title-of-a-story":', html.includes('title-of-a-story'));
        console.log('  [Billboard]   Has "c-label":', html.includes('c-label'));
        console.log('  [Billboard]   Has "chart-results-list":', html.includes('chart-results-list'));
      }
      return entries;
 
    } catch (err) {
      console.error('  [Billboard] ✗ Fetch error (attempt ' + attempt + '):', err.message);
      if (attempt < MAX_RETRIES) await new Promise(function(r) { setTimeout(r, 3000 * attempt); });
    }
  }
  return null;
}
 
function parseBillboardHTML(html) {
  var entries;
 
  // Strategy 1: id="title-of-a-story" h3 + c-label span
  entries = parseStrategy1(html);
  if (entries && entries.length >= 10) return entries;
 
  // Strategy 2: o-chart-results-list__item class h3 + span
  entries = parseStrategy2(html);
  if (entries && entries.length >= 10) return entries;
 
  // Strategy 3: Chunk-based split
  entries = parseStrategy3(html);
  if (entries && entries.length >= 10) return entries;
 
  // Strategy 4: Wider h3 search with forward artist scan
  entries = parseStrategy4(html);
  if (entries && entries.length >= 10) return entries;
 
  return null;
}
 
function parseStrategy1(html) {
  var entries = [];
  var match;
  var regex = /id="title-of-a-story"[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<span[^>]*class="[^"]*c-label[^"]*"[^>]*>([\s\S]*?)<\/span>/g;
  while ((match = regex.exec(html)) !== null) {
    var title = cleanText(match[1]);
    var artist = cleanText(match[2]);
    if (title && artist && title !== 'Songwriter(s):' && title !== 'Producer(s):' && title.length < 200) {
      entries.push({ rank: entries.length + 1, title: title, artist: artist });
    }
  }
  return entries.length >= 10 ? entries : null;
}
 
function parseStrategy2(html) {
  var entries = [];
  var match;
  var regex = /<h3[^>]*class="[^"]*o-chart-results-list__item[^"]*"[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/g;
  while ((match = regex.exec(html)) !== null) {
    var t = cleanText(match[1]);
    var a = cleanText(match[2]);
    if (t && a && t.length > 0 && t.length < 200) {
      entries.push({ rank: entries.length + 1, title: t, artist: a });
    }
  }
  return entries.length >= 10 ? entries : null;
}
 
function parseStrategy3(html) {
  var entries = [];
  var chunks = html.split(/chart-results-list__item|data-detail-target/);
  for (var i = 1; i < chunks.length && entries.length < 100; i++) {
    var chunk = chunks[i];
    var tm = chunk.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    var am = chunk.match(/<span[^>]*class="[^"]*c-label[^"]*a-no-trucate[^"]*"[^>]*>([\s\S]*?)<\/span>/)
          || chunk.match(/<span[^>]*class="[^"]*c-label[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    if (tm && am) {
      var tt = cleanText(tm[1]);
      var aa = cleanText(am[1]);
      if (tt && aa && tt.length < 200 && tt !== 'Songwriter(s):' && tt !== 'Producer(s):') {
        entries.push({ rank: entries.length + 1, title: tt, artist: aa });
      }
    }
  }
  return entries.length >= 10 ? entries : null;
}
 
function parseStrategy4(html) {
  var entries = [];
  var titleRegex = /id="title-of-a-story"[^>]*>([\s\S]*?)<\/h3>/g;
  var match;
  var positions = [];
  while ((match = titleRegex.exec(html)) !== null) {
    var title = cleanText(match[1]);
    if (title && title !== 'Songwriter(s):' && title !== 'Producer(s):' && title.length < 200) {
      positions.push({ title: title, endIndex: titleRegex.lastIndex });
    }
  }
  for (var i = 0; i < positions.length; i++) {
    var searchStart = positions[i].endIndex;
    var searchEnd = (i + 1 < positions.length) ? positions[i + 1].endIndex - 50 : searchStart + 2000;
    var searchSlice = html.substring(searchStart, Math.min(searchStart + 2000, searchEnd));
    var artistMatch = searchSlice.match(/<span[^>]*class="[^"]*c-label[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    if (artistMatch) {
      var artist = cleanText(artistMatch[1]);
      if (artist && artist.length < 200) {
        entries.push({ rank: entries.length + 1, title: positions[i].title, artist: artist });
      }
    }
  }
  return entries.length >= 10 ? entries : null;
}
 
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// COMBINED FETCH: GitHub first, Billboard fallback
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 
async function fetchChart(dateStr) {
  // Try GitHub JSON first — fast, reliable, no parsing
  var entries = await fetchFromGitHub(dateStr);
  if (entries) return { entries: entries, source: 'github' };
 
  // Fallback to Billboard HTML scraping
  console.log('  → Falling back to Billboard.com scraping...');
  entries = await fetchFromBillboard(dateStr);
  if (entries) return { entries: entries, source: 'billboard' };
 
  return null;
}
 
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ARTIST MATCHING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 
function artistMatches(pickedArtist, billboardArtist) {
  var picked = pickedArtist.toLowerCase().trim();
  var billboard = billboardArtist.toLowerCase().trim();
  if (billboard === picked || billboard.includes(picked)) return true;
  var pn = picked.replace(/\$/g, 's');
  var bn = billboard.replace(/\$/g, 's');
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
 
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 
module.exports = async function handler(req, res) {
  var authHeader = req.headers['authorization'];
  var cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== 'Bearer ' + cronSecret) return res.status(401).json({ error: 'Unauthorized' });
  if (!SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });
 
  var supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log('━━━ Fantasy Life — Billboard Hot 100 Update ━━━');
  console.log('Run time: ' + new Date().toISOString());
 
  // Pull active season
  var { data: season } = await supabase.from('seasons').select('year, locks, fy_start, fy_end').eq('status', 'active').single();
  if (!season) return res.status(200).json({ message: 'No active season found' });
  if (!season.fy_start || !season.fy_end) return res.status(500).json({ error: 'Active season missing fy_start or fy_end' });
 
  var FY_START = season.fy_start;
  var FY_END = season.fy_end;
  var locks = season.locks || {};
 
  console.log('Fantasy Year: ' + FY_START + ' → ' + FY_END);
 
  var { data: membersArr } = await supabase.from('members').select('id, name');
  var memberNameById = {};
  (membersArr || []).forEach(function(m) { memberNameById[m.id] = m.name; });
 
  var allChartDates = getChartDates(FY_START, FY_END);
  console.log('Chart dates in window: ' + allChartDates.length + ' weeks (' + allChartDates[0] + ' → ' + allChartDates[allChartDates.length - 1] + ')');
 
  // Paginate cached dates
  var cachedDatesSet = new Set();
  var cachePage = 0;
  var cacheKeepFetching = true;
  while (cacheKeepFetching) {
    var { data: cachedBatch } = await supabase
      .from('billboard_weeks')
      .select('chart_date')
      .gte('chart_date', FY_START)
      .lte('chart_date', FY_END)
      .order('chart_date')
      .range(cachePage * 1000, (cachePage + 1) * 1000 - 1);
    if (!cachedBatch || cachedBatch.length === 0) {
      cacheKeepFetching = false;
    } else {
      cachedBatch.forEach(function(d) { cachedDatesSet.add(d.chart_date); });
      cachePage++;
      if (cachedBatch.length < 1000) cacheKeepFetching = false;
    }
  }
 
  var missingDates = allChartDates.filter(function(d) { return !cachedDatesSet.has(d); });
  console.log('Cached: ' + cachedDatesSet.size + ' | Missing: ' + missingDates.length);
  if (missingDates.length > 0) console.log('Missing dates: ' + JSON.stringify(missingDates));
 
  var fetchedCount = 0;
  var failedDates = [];
  var sourceLog = [];
  var MAX_FETCHES_PER_RUN = 8; // higher limit since GitHub fetches are cheap
 
  for (var dateStr of missingDates) {
    if (fetchedCount >= MAX_FETCHES_PER_RUN) {
      console.log('Hit fetch limit (' + MAX_FETCHES_PER_RUN + '), rest will be picked up next run');
      break;
    }
 
    console.log('\n▶ Chart for ' + dateStr);
    var result = await fetchChart(dateStr);
 
    if (!result) {
      failedDates.push(dateStr);
      console.log('✗ Both sources failed for ' + dateStr);
      continue;
    }
 
    var rows = result.entries.map(function(e) {
      return {
        chart_date: dateStr,
        rank: e.rank,
        title: (e.title || '').replace(/&amp;/g, '&'),
        artist: (e.artist || '').replace(/&amp;/g, '&'),
        is_number_one: e.rank === 1,
      };
    });
 
    var { error: insertErr } = await supabase.from('billboard_weeks').upsert(rows, { onConflict: 'chart_date,rank' });
    if (insertErr) {
      console.error('✗ Supabase insert error for ' + dateStr + ':', insertErr.message);
      failedDates.push(dateStr);
    } else {
      fetchedCount++;
      sourceLog.push(dateStr + ':' + result.source);
      console.log('✓ Cached ' + result.entries.length + ' entries via ' + result.source);
    }
 
    // Short delay between fetches (GitHub is fast, but be polite)
    var delayMs = result.source === 'github' ? 500 : 2500;
    if (fetchedCount < MAX_FETCHES_PER_RUN && missingDates.indexOf(dateStr) < missingDates.length - 1) {
      await new Promise(function(r) { setTimeout(r, delayMs); });
    }
  }
 
  // ━━━ Recalculate scores ━━━
 
  var { data: picks } = await supabase.from('picks').select('id, member_id, pick, bonus').eq('season_year', season.year).eq('category', 'Musician');
  if (!picks || picks.length === 0) return res.status(200).json({ message: 'No Musician picks found' });
 
  // Paginate all chart entries in FY window
  var allEntries = [];
  var pageSize = 1000;
  var page = 0;
  var keepFetching = true;
  while (keepFetching) {
    var { data: batch } = await supabase
      .from('billboard_weeks')
      .select('chart_date, rank, title, artist, is_number_one')
      .gte('chart_date', FY_START)
      .lte('chart_date', FY_END)
      .order('chart_date')
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (!batch || batch.length === 0) {
      keepFetching = false;
    } else {
      allEntries = allEntries.concat(batch);
      page++;
      if (batch.length < pageSize) keepFetching = false;
    }
  }
 
  if (allEntries.length === 0) return res.status(200).json({ message: 'No chart data cached yet' });
  console.log('\n━━━ Scoring from ' + allEntries.length + ' chart entries ━━━');
 
  var artistStats = {};
  for (var pick of picks) {
    var artistName = pick.pick;
    var songs = {};
    // totalWeeks = chart appearances + num_one_weeks bonus
    // Each week at #1 counts as 2 weeks (1 base + 1 bonus)
    var totalWeeks = 0;
 
    for (var entry of allEntries) {
      if (artistMatches(artistName, entry.artist)) {
        var songKey = entry.title;
        if (!songs[songKey]) songs[songKey] = { title: entry.title, weeks: 0, numOneWeeks: 0 };
 
        songs[songKey].weeks++;
        totalWeeks++;                         // count every chart appearance
 
        if (entry.rank === 1) {
          songs[songKey].numOneWeeks++;
          totalWeeks++;                       // ← #1 bonus: counts as an extra week
        }
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
 
  var ranked = Object.values(artistStats).sort(function(a, b) { return b.totalWeeks - a.totalWeeks; });
  ranked = assignBasePointsWithTiebreaker(ranked, picks.length);
 
  var updated = 0;
  var rankings = [];
 
  for (var r of ranked) {
    var ownerName = memberNameById[r.member_id] || r.member_id;
    var baseLocked = isFieldLocked(locks, 'Musician', ownerName, 'base');
    var metricLocked = isFieldLocked(locks, 'Musician', ownerName, 'metric');
 
    // Sum up #1 weeks across all songs for the record string
    var totalNumOne = r.songs.reduce(function(sum, s) { return sum + s.numOneWeeks; }, 0);
 
    var updateObj = { updated_at: new Date().toISOString() };
    if (!baseLocked) updateObj.base = r.newBase;
    if (!metricLocked) {
      updateObj.metric = r.totalWeeks;
      // Display format: "144 chart wks (17 at #1)" — shows raw weeks + bonus context
      updateObj.record = totalNumOne > 0
        ? r.totalWeeks + ' chart wks (' + totalNumOne + ' at #1)'
        : r.totalWeeks + ' chart wks';
    }
 
    var skipped = [];
    if (baseLocked) skipped.push('base');
    if (metricLocked) skipped.push('metric');
    if (skipped.length > 0) console.log('  ' + ownerName + ': locked — ' + skipped.join(', '));
 
    var { error: pickErr } = await supabase.from('picks').update(updateObj).eq('id', r.id);
    if (pickErr) { console.error('✗ Failed to update pick ' + r.member_id + ':', pickErr.message); continue; }
 
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
      var { error: songErr } = await supabase.from('music_songs').insert(songRows);
      if (songErr) console.error('✗ Songs insert error for ' + r.member_id + ':', songErr.message);
    }
 
    updated++;
    rankings.push({
      rank: r.rank,
      member: r.member_id,
      artist: r.pick,
      totalWeeks: r.totalWeeks,
      numOneWeeks: totalNumOne,
      songCount: r.songs.length,
      base: baseLocked ? Number(r.bonus) || 0 : r.newBase,
      bonus: Number(r.bonus) || 0,
      total: (baseLocked ? Number(r.bonus) || 0 : r.newBase) + (Number(r.bonus) || 0),
      lockedFields: skipped.length > 0 ? skipped : undefined,
    });
  }
 
  var summary = {
    message: 'Billboard update complete — ' + updated + '/' + ranked.length + ' musicians updated',
    season: season.year,
    timestamp: new Date().toISOString(),
    fantasyYear: { start: FY_START, end: FY_END },
    chartWeeksCached: cachedDatesSet.size + fetchedCount,
    chartWeeksTotal: allChartDates.length,
    newWeeksFetched: fetchedCount,
    remainingToFetch: missingDates.length - fetchedCount,
    failedDates: failedDates.length > 0 ? failedDates : undefined,
    sources: sourceLog.length > 0 ? sourceLog : undefined,
    totalChartEntriesScanned: allEntries.length,
    rankings: rankings,
  };
 
  console.log('\n━━━ Summary ━━━');
  console.log(summary.message);
  console.log('Scanned ' + allEntries.length + ' entries across ' + (cachedDatesSet.size + fetchedCount) + ' weeks');
  if (sourceLog.length > 0) console.log('Sources: ' + sourceLog.join(', '));
  if (failedDates.length > 0) console.log('⚠ Failed: ' + failedDates.join(', '));
  return res.status(200).json(summary);
};
