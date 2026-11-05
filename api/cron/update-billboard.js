/**
 * Fantasy Life — Billboard Hot 100 Musician Tracker
 *
 * DATA SOURCES (in priority order):
 *   1. mhollingshead/billboard-hot-100 GitHub repo (clean JSON, no parsing needed)
 *   2. Billboard.com HTML scraping (fallback if GitHub returns 404 or invalid data)
 *
 * Respects commissioner locks from seasons.locks column.
 * Bonus points are resolved from the Grammy's own Wikipedia article (see
 * GRAMMY_CATEGORIES/the 2026-11 changelog entry below) — no longer purely
 * manual, though a locked `bonus` field is still never overwritten.
 * Paginates all billboard_weeks rows (Supabase caps at 1000 per query).
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
 * CHANGELOG:
 * - NEW (March 2026): Primary data source switched to mhollingshead GitHub JSON API.
 *        Clean structured JSON — no HTML parsing, no bot detection issues.
 * - NEW (March 2026): Billboard.com HTML scraping kept as automatic fallback.
 * - FIX (March 2026): 6-day lookahead buffer in getChartDates() so charts published
 *        on Tuesday (dated to the following Saturday) are picked up by Wed cron.
 * - FIX (March 2026): #1 weeks now count as an extra week toward totalWeeks.
 *        Each week at #1 = 2 chart weeks total (base week + 1 bonus week).
 *        num_one_weeks stored separately for QA/display.
 * - FIX (April 2026): Removed GitHub index/date-guard approach — it was causing
 *        GitHub to be skipped for all dates, falling through to the Billboard
 *        scraper which injected garbage at rank 1 ("Gains in Weekly Performance").
 *        Now tries GitHub directly for every date; a 404 is the natural fallback
 *        signal. Simple and reliable.
 * - FIX (April 2026): Added GARBAGE_TITLE_BLOCKLIST to Billboard parser — known
 *        Billboard UI strings that were being picked up as chart entries are now
 *        explicitly rejected before they can corrupt the data.
 * - FIX (April 2026): Post-fetch validation strips rank > 100 (Bubbling Under
 *        bleed-through), rejects batch if < 90 valid entries remain, rejects
 *        batch if no genuine #1 entry is present.
 * - FIX (April 2026): cleanText() handles &#039; apostrophe entity.
 * - FIX (April 2026): Scoring query filters rank <= 100 as belt-and-suspenders
 *        so any rank > 100 rows that slipped into the DB are never scored.
 * - NEW (2026-11): Automated Grammy bonus. Resolved from the ceremony's own
 *        Wikipedia article — NOT Wikidata (its structured statements lag
 *        real-time article editing by hours to days) — and kept entirely
 *        separate from update-projections.js's market-based
 *        `applyGrammyBonus` (pre-outcome odds for the "Projected Final"
 *        toggle, never a real score). Evergreen: looked up by trying
 *        "{year} Grammy Awards" for the current year then the prior year;
 *        "has this ceremony happened" is answered by whether a winner can
 *        be parsed out, not a hardcoded date. Covers the FULL bonus rule
 *        (Pop/Rock/Rap/New Artist all at tier 3, plus nomination-without-
 *        win) since it isn't limited to whatever market happens to exist.
 *        See docs/bonus-automation.md for the confidence-level writeup —
 *        the winner-is-bold-wikitext parsing wasn't live-verified from
 *        this build's network-restricted sandbox.
 */
 
const { createClient } = require('@supabase/supabase-js');
const { writeScoreEventsAndNotify } = require('../_lib/push');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
 
// ━━━ GitHub JSON source ━━━
const GITHUB_BASE = 'https://raw.githubusercontent.com/mhollingshead/billboard-hot-100/main';
 
// ━━━ Minimum valid entries after rank > 100 strip ━━━
const MIN_VALID_ENTRIES = 90;
 
// ━━━ Known Billboard UI strings that are NOT songs ━━━
// These appear in the HTML scraper output when Billboard's page structure
// bleeds non-chart content into the parsed results. Any entry whose title
// matches one of these is rejected outright before validation.
const GARBAGE_TITLE_BLOCKLIST = [
  'gains in weekly performance',
  'debut chart date',
  'peak chart date',
  'chart history',
  'peak position',
  'weeks on chart',
  'last week',
  'this week',
];
 
function isGarbageTitle(title) {
  if (!title) return true;
  var lower = title.toLowerCase().trim();
  for (var i = 0; i < GARBAGE_TITLE_BLOCKLIST.length; i++) {
    if (lower.startsWith(GARBAGE_TITLE_BLOCKLIST[i])) return true;
  }
  // Also reject entries where the artist field is just a number
  return false;
}
 
function isGarbageArtist(artist) {
  if (!artist) return true;
  // Reject entries where artist is purely numeric (e.g. "1", "2", "42")
  return /^\d+$/.test(artist.trim());
}
 
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 
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

// ═══════════════════════════════════════════════════════════════════════
// GRAMMY BONUS — resolved from the ceremony's own Wikipedia article.
// Same rationale as update-entertainment.js's Oscar bonus (see its own
// 2026-11 changelog): Wikipedia over Wikidata for freshness, kept entirely
// separate from update-projections.js's market-based `applyGrammyBonus`
// (pre-outcome odds for the "Projected Final" toggle, never a real
// score), and this version covers the FULL bonus rule — Pop/Rock/Rap/New
// Artist all at tier 3, plus the nomination-without-win tier — since it
// isn't limited to whatever Polymarket/Kalshi market happens to exist.
// ═══════════════════════════════════════════════════════════════════════
const GRAMMY_CATEGORIES = [
  { label: 'Album of the Year', keywords: ['album of the year'], winTier: 7, nomTier: 1 },
  { label: 'Record of the Year', keywords: ['record of the year'], winTier: 7, nomTier: 1 },
  { label: 'Song of the Year', keywords: ['song of the year'], winTier: 7, nomTier: 1 },
  { label: 'Best Pop Vocal Album', keywords: ['best pop vocal album'], winTier: 3, nomTier: 1 },
  { label: 'Best Rock Album', keywords: ['best rock album'], winTier: 3, nomTier: 1 },
  { label: 'Best Rap Album', keywords: ['best rap album'], winTier: 3, nomTier: 1 },
  { label: 'Best New Artist', keywords: ['best new artist'], winTier: 3, nomTier: 1 },
];

async function fetchWikipediaWikitext(title) {
  try {
    var url = 'https://en.wikipedia.org/w/api.php?action=parse&page=' + encodeURIComponent(title) + '&prop=wikitext&format=json&redirects=1';
    var res = await fetch(url, { headers: { 'User-Agent': 'FantasyLifeHub/1.0 (private league scoring tool)' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    var data = await res.json();
    if (data.error) return null;
    return (data.parse && data.parse.wikitext && data.parse.wikitext['*']) || null;
  } catch (err) { console.error('  Wikipedia fetch failed for "' + title + '":', err.message); return null; }
}

// FIX (2026-11, Codex review on PR #55): categories on these ceremony
// pages are NOT ==heading== sections — verified live against the 2025
// Grammy Awards article's real wikitext. Each category is a
// `{{Award category|color|[[Real Name|Display Name]]}}` template marker
// inside a wikitable (one or two categories per row). Two different
// nominee shapes exist on the SAME page: "General Field" categories
// (Album/Record/Song of the Year) list one `*` bullet PER NOMINEE with a
// `**` producer/engineer credits sub-line each; genre categories (Best
// Rock Album, etc.) list only the WINNER as a `*` bullet with every other
// nominee as a `**` sub-line. extractWinnerAndNominees() below handles
// both: winner = first bolded bullet at any depth, nominees = every
// other bullet line that isn't a credits line.
function extractCategoryBlock(wikitext, categoryKeywords) {
  var lines = wikitext.split('\n');
  var markerRegex = /\{\{Award category\|/i;
  var startIdx = -1;
  for (var i = 0; i < lines.length; i++) {
    if (markerRegex.test(lines[i])) {
      var lower = lines[i].toLowerCase();
      if (categoryKeywords.some(function(k) { return lower.includes(k); })) { startIdx = i; break; }
    }
  }
  if (startIdx === -1) return null;
  var buffer = [];
  for (var j = startIdx + 1; j < lines.length; j++) {
    var line = lines[j];
    if (markerRegex.test(line)) break;   // next category's marker
    if (/^\s*\|-/.test(line)) break;     // table row separator
    if (/^={2,4}/.test(line)) break;     // next real heading
    buffer.push(line);
  }
  return buffer.length > 0 ? buffer.join('\n') : null;
}

function extractWikiNames(line) {
  var names = [], m, re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  while ((m = re.exec(line)) !== null) {
    var n = m[1].trim();
    if (n && !/^(file|category|image):/i.test(n)) names.push(n);
  }
  return names;
}

// A credit sub-line (producer/engineer/songwriter/mixer wording) belongs
// to whichever entry immediately precedes it, not a competing nominee.
function isCreditLine(line) { return /\b(producers?|engineers?|mixers?|songwriters?|mastering engineer)\b/i.test(line); }

// Returns candidate NAME LISTS, not one resolved name — deliberately:
// which wikilink on a line is "the artist" vs. "the song/album" differs
// by line (`"[[Song]]" – [[Artist]]` or `''[[Album]]'' – [[Artist]]`), so
// every name on the line is kept as a candidate and left to
// artistMatches() at the call site, which only ever matches a real
// artist's name — a song/album title just won't match. No blanket
// credit-line filtering: verified live that excluding every
// "songwriter"/"producer" line actively loses real matches — Grammy's
// "General Field" categories (Album/Record/Song of the Year) put the
// performer's name ONLY on that sub-line for some nominees (Song of the
// Year's winner line is just the song title in quotes; the songwriter/
// performer is named on the `**` line beneath it), so that line has to
// stay in the candidate pool. A producer or engineer's own name landing
// in there too is harmless noise for the same reason a film/song title is.
function extractWinnerAndNominees(sectionText) {
  if (!sectionText) return null;
  var bulletLines = sectionText.split('\n').filter(function(l) { return /^\s*\*/.test(l); });
  if (bulletLines.length === 0) return null;
  var winnerIdx = bulletLines.findIndex(function(l) { return l.includes("'''"); });
  if (winnerIdx === -1) return null;
  var winnerCandidates = extractWikiNames(bulletLines[winnerIdx]);
  // The winner's own very-next bullet line is its own credit sub-line
  // when it READS like one (producer/songwriter/engineer wording) —
  // merge it into winnerCandidates (not the general nominee pool) since
  // it's the same winner's own credit, not a competing entry. Checked by
  // CONTENT, not by whether it's also bolded: verified live (Codex review
  // on PR #55) that a winner's own credit sub-line isn't bolded with
  // 100% consistency across every category on these pages, so relying
  // on bold alone silently lost a real win in that case. A genuinely
  // different nominee's plain `**` line right under the winner (the
  // genre-category shape) correctly reads as not-a-credit-line and is
  // left alone, going to the nominee pool instead.
  var nextLine = bulletLines[winnerIdx + 1];
  var nextIsOwnCredit = !!(nextLine && isCreditLine(nextLine));
  if (nextIsOwnCredit) winnerCandidates = winnerCandidates.concat(extractWikiNames(nextLine));
  if (winnerCandidates.length === 0) return null;

  var nomineeSet = {};
  for (var i = 0; i < bulletLines.length; i++) {
    if (i === winnerIdx || (i === winnerIdx + 1 && nextIsOwnCredit)) continue;
    for (var n of extractWikiNames(bulletLines[i])) nomineeSet[n] = true;
  }
  return { winnerCandidates: winnerCandidates, nomineeCandidates: Object.keys(nomineeSet) };
}

// Each category's parsed result, cached for reuse across every pick
// (parsing the wikitext per-pick would be redundant work).
function computeGrammyCategoryResults(wikitext) {
  var results = [];
  for (var cat of GRAMMY_CATEGORIES) {
    var parsed = extractWinnerAndNominees(extractCategoryBlock(wikitext, cat.keywords));
    if (!parsed) { console.warn('  Grammy: could not resolve winner for "' + cat.label + '"'); continue; }
    results.push({ cat: cat, winnerCandidates: parsed.winnerCandidates, nomineeCandidates: parsed.nomineeCandidates });
  }
  return results;
}

// The ceremony's own infobox date (e.g. "| date = February 2, 2025"), not
// which year's ARTICLE happened to resolve — needed because "the most
// recent ceremony with a winner" is wrong the moment a new season starts
// (new picks drafted) before THAT season's own ceremony has aired: the
// prior, already-decided ceremony would otherwise get silently credited
// to the new season's unrelated picks (Codex review on PR #55).
function extractCeremonyDate(wikitext) {
  var m = wikitext.match(/\{\{Infobox[^\n]*/);
  if (!m) return null;
  var block = wikitext.slice(m.index, m.index + 3000); // date field lives near the top
  var dm = block.match(/\|\s*date\s*=\s*([^\n|]+)/);
  if (!dm) return null;
  var parsed = new Date(dm[1].trim());
  return isNaN(parsed.getTime()) ? null : parsed;
}

// Tries "{year} Grammy Awards" (this show's articles are titled by
// calendar year directly, unlike the Oscars' ordinal titles) for each
// calendar year this season's Fantasy Year window spans (newest first) —
// not the wall-clock year, which can resolve to a real but WRONG
// (already-scored, prior-season) ceremony. A candidate is only accepted
// if its own ceremony date actually falls inside [fyStart, fyEnd]; "has
// this ceremony happened yet" beyond that is answered by whether a
// winner can actually be parsed out of it — live content state, not a
// hardcoded date — so this still self-corrects before a given year's
// ceremony has aired.
async function resolveGrammyWikitext(fyStart, fyEnd) {
  var fyStartDate = new Date(fyStart), fyEndDate = new Date(fyEnd);
  var candidateYears = Array.from(new Set([fyEndDate.getFullYear(), fyStartDate.getFullYear()]));
  for (var year of candidateYears) {
    var title = year + ' Grammy Awards';
    var wikitext = await fetchWikipediaWikitext(title);
    if (!wikitext) { console.log('  Grammy: no Wikipedia page resolved for "' + title + '"'); continue; }
    var ceremonyDate = extractCeremonyDate(wikitext);
    if (!ceremonyDate || ceremonyDate < fyStartDate || ceremonyDate > fyEndDate) {
      console.log('  Grammy: "' + title + '" ceremony date (' + (ceremonyDate ? ceremonyDate.toISOString().slice(0, 10) : 'unknown') + ') is outside this season\'s Fantasy Year window (' + fyStart + ' to ' + fyEnd + ') — skipping');
      continue;
    }
    var hasWinner = computeGrammyCategoryResults(wikitext).length > 0;
    if (hasWinner) { console.log('  Grammy: using "' + title + '" (ceremony ' + ceremonyDate.toISOString().slice(0, 10) + ')'); return wikitext; }
    console.log('  Grammy: "' + title + '" has no resolvable winners yet (ceremony likely not aired)');
  }
  return null;
}

// SUMS credit across every DISTINCT category this pick's name matches —
// NOT a max. Confirmed against this league's own historical record
// (src/data/musician.js): e.g. Bad Bunny's bonus=9 breaks down as
// bonusNote "AOTY win, ROTY nom, SOTY nom" = 7 (AOTY win) + 1 (ROTY nom)
// + 1 (SOTY nom); Kendrick Lamar's bonus=15 = 7 + 3 + 3 + 1 + 1 across 5
// categories. An artist nominated in several Grammy categories the same
// year is common (the "General Field" categories are explicitly
// cross-nominated with genre categories), so this has to accumulate.
// Within a single category a win always replaces a nomination — never
// double-counted — because extractWinnerAndNominees() already excludes
// the winner's own line(s) from that category's nomineeCandidates.
function resolveGrammyBonusForPick(pickName, categoryResults) {
  var total = 0, labels = [];
  for (var r of categoryResults) {
    if (r.winnerCandidates.some(function(c) { return artistMatches(pickName, c); })) {
      total += r.cat.winTier;
      labels.push('Won ' + r.cat.label);
    } else if (r.nomineeCandidates.some(function(c) { return artistMatches(pickName, c); })) {
      total += r.cat.nomTier;
      labels.push('Nominated ' + r.cat.label);
    }
  }
  return labels.length > 0 ? { tier: total, label: labels.join(' | ') } : null;
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
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
 
/**
 * Validates and cleans a fetched set of entries:
 *   1. Strips garbage titles and numeric-only artists (Billboard UI bleed-through)
 *   2. Strips any entries with rank > 100 (Bubbling Under bleed-through)
 *   3. Rejects the entire batch if fewer than MIN_VALID_ENTRIES remain
 *   4. Rejects the batch if no #1 entry is present
 *
 * Returns { entries, valid, reason }
 */
function validateAndCleanEntries(entries, source, dateStr) {
  var before = entries.length;
 
  // Strip known garbage titles and numeric-only artists
  var cleaned = entries.filter(function(e) {
    return !isGarbageTitle(e.title) && !isGarbageArtist(e.artist);
  });
  var garbageStripped = before - cleaned.length;
  if (garbageStripped > 0) {
    console.log('  [Validate] ⚠ Stripped ' + garbageStripped + ' garbage title/artist entries from ' + source + ' for ' + dateStr);
  }
 
  // Strip Bubbling Under / rank > 100
  var beforeRankStrip = cleaned.length;
  cleaned = cleaned.filter(function(e) { return e.rank >= 1 && e.rank <= 100; });
  var rankStripped = beforeRankStrip - cleaned.length;
  if (rankStripped > 0) {
    console.log('  [Validate] ⚠ Stripped ' + rankStripped + ' entries with rank > 100 from ' + source + ' for ' + dateStr);
  }
 
  // Reject if too few valid entries remain
  if (cleaned.length < MIN_VALID_ENTRIES) {
    var reason = 'Only ' + cleaned.length + ' valid entries after stripping (need ' + MIN_VALID_ENTRIES + '+)';
    console.log('  [Validate] ✗ Rejecting ' + dateStr + ' from ' + source + ': ' + reason);
    return { entries: [], valid: false, reason: reason };
  }
 
  // Reject if no #1 entry present
  var numberOne = cleaned.find(function(e) { return e.rank === 1; });
  if (!numberOne) {
    var reason = 'No #1 entry found after cleaning';
    console.log('  [Validate] ✗ Rejecting ' + dateStr + ' from ' + source + ': ' + reason);
    return { entries: [], valid: false, reason: reason };
  }
 
  console.log('  [Validate] ✓ ' + cleaned.length + ' valid entries for ' + dateStr
    + (garbageStripped + rankStripped > 0 ? ' (' + (garbageStripped + rankStripped) + ' total stripped)' : '')
    + ' | #1: "' + numberOne.title + '" — ' + numberOne.artist);
  return { entries: cleaned, valid: true };
}
 
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SOURCE 1: mhollingshead/billboard-hot-100 GitHub JSON
// Tries the date directly — a 404 means it's not in the repo yet
// and we fall through to Billboard scraping naturally.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 
async function fetchFromGitHub(dateStr) {
  var url = GITHUB_BASE + '/date/' + dateStr + '.json';
  try {
    console.log('  [GitHub] Trying ' + url);
    var res = await fetch(url, { headers: { 'Accept': 'application/json' } });
 
    if (!res.ok) {
      console.log('  [GitHub] HTTP ' + res.status + ' for ' + dateStr + ' — not in repo yet, falling back to Billboard');
      return null;
    }
 
    var json = await res.json();
    if (!json || !json.data || json.data.length < 10) {
      console.log('  [GitHub] Data array too small (' + (json.data ? json.data.length : 0) + ' entries) — falling back');
      return null;
    }
 
    var raw = json.data.map(function(item) {
      return {
        rank: item.this_week,
        title: cleanText(item.song || ''),
        artist: cleanText(item.artist || ''),
      };
    });
 
    var validation = validateAndCleanEntries(raw, 'github', dateStr);
    if (!validation.valid) return null;
 
    return validation.entries;
  } catch (err) {
    console.log('  [GitHub] ✗ Error: ' + err.message + ' — falling back to Billboard');
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
 
      var parsed = parseBillboardHTML(html);
      if (!parsed) {
        console.log('  [Billboard] ✗ All parser strategies failed for ' + dateStr);
        console.log('  [Billboard]   Has "title-of-a-story":', html.includes('title-of-a-story'));
        console.log('  [Billboard]   Has "c-label":', html.includes('c-label'));
        console.log('  [Billboard]   Has "chart-results-list":', html.includes('chart-results-list'));
        if (attempt < MAX_RETRIES) {
          await new Promise(function(r) { setTimeout(r, 3000 * attempt); });
          continue;
        }
        return null;
      }
 
      // Validate: strip garbage, strip rank > 100, check minimum count and #1
      var validation = validateAndCleanEntries(parsed, 'billboard', dateStr);
      if (!validation.valid) {
        if (attempt < MAX_RETRIES) {
          console.log('  [Billboard] Retrying after validation failure...');
          await new Promise(function(r) { setTimeout(r, 3000 * attempt); });
          continue;
        }
        return null;
      }
 
      return validation.entries;
 
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
  // Try GitHub JSON first — fast, reliable, no parsing needed.
  // A 404 means the date isn't in the repo yet and we fall back naturally.
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
  var MAX_FETCHES_PER_RUN = 8;
 
  for (var dateStr of missingDates) {
    if (fetchedCount >= MAX_FETCHES_PER_RUN) {
      console.log('Hit fetch limit (' + MAX_FETCHES_PER_RUN + '), rest will be picked up next run');
      break;
    }
 
    console.log('\n▶ Chart for ' + dateStr);
    var result = await fetchChart(dateStr);
 
    if (!result) {
      failedDates.push(dateStr);
      console.log('✗ Both sources failed or produced invalid data for ' + dateStr);
      continue;
    }
 
    var rows = result.entries.map(function(e) {
      return {
        chart_date: dateStr,
        rank: e.rank,
        title: e.title,    // already cleaned via cleanText() upstream
        artist: e.artist,  // already cleaned via cleanText() upstream
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
 
    // Short delay between fetches (GitHub is fast, Billboard needs more breathing room)
    var delayMs = result.source === 'github' ? 500 : 2500;
    if (fetchedCount < MAX_FETCHES_PER_RUN && missingDates.indexOf(dateStr) < missingDates.length - 1) {
      await new Promise(function(r) { setTimeout(r, delayMs); });
    }
  }
 
  // ━━━ Recalculate scores ━━━
 
  var { data: picks } = await supabase.from('picks').select('id, member_id, pick, base, bonus').eq('season_year', season.year).eq('category', 'Musician');
  if (!picks || picks.length === 0) return res.status(200).json({ message: 'No Musician picks found' });

  // Grammy bonus (see GRAMMY_CATEGORIES/computeGrammyCategoryResults
  // above) — fetched once per run, independent of the chart-data
  // pagination below.
  var grammyWikitext = await resolveGrammyWikitext(FY_START, FY_END);
  var grammyCategoryResults = grammyWikitext ? computeGrammyCategoryResults(grammyWikitext) : [];

  // Paginate all chart entries in FY window
  // rank <= 100 is belt-and-suspenders: never score rank > 100 rows
  // even if any slipped through into the DB
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
      .lte('rank', 100)
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
        totalWeeks++;                   // count every chart appearance
 
        if (entry.rank === 1) {
          songs[songKey].numOneWeeks++;
          totalWeeks++;                 // ← #1 bonus: counts as an extra week
        }
      }
    }
 
    artistStats[pick.id] = {
      id: pick.id,
      member_id: pick.member_id,
      pick: pick.pick,
      base: pick.base,
      bonus: pick.bonus,
      totalWeeks: totalWeeks,
      songs: Object.values(songs).sort(function(a, b) { return b.weeks - a.weeks; }),
    };
  }
 
  var ranked = Object.values(artistStats).sort(function(a, b) { return b.totalWeeks - a.totalWeeks; });
  ranked = assignBasePointsWithTiebreaker(ranked, picks.length);
 
  var updated = 0;
  var rankings = [];
  // Collected across every artist, then batch-written once at the end via
  // writeScoreEventsAndNotify (api/_lib/push.js) — same pattern
  // update-sports.js established first.
  var scoreEvents = [];

  for (var r of ranked) {
    var ownerName = memberNameById[r.member_id] || r.member_id;
    var baseLocked = isFieldLocked(locks, 'Musician', ownerName, 'base');
    var metricLocked = isFieldLocked(locks, 'Musician', ownerName, 'metric');
    var bonusLocked = isFieldLocked(locks, 'Musician', ownerName, 'bonus');

    var bonusEntry = resolveGrammyBonusForPick(r.pick, grammyCategoryResults);
    var bonusWritable = !!bonusEntry && !bonusLocked;
    var newBonusVal = bonusWritable ? bonusEntry.tier : (Number(r.bonus) || 0);

    var totalNumOne = r.songs.reduce(function(sum, s) { return sum + s.numOneWeeks; }, 0);
    // e.g. "144 chart wks (17 at #1)" — computed unconditionally (not just
    // when !metricLocked) since the score_events cause text below wants
    // the artist's current standing regardless of whether the stored
    // `record` field itself is being updated this run.
    var recordText = totalNumOne > 0
      ? r.totalWeeks + ' chart wks (' + totalNumOne + ' at #1)'
      : r.totalWeeks + ' chart wks';

    var updateObj = { updated_at: new Date().toISOString() };
    if (!baseLocked) updateObj.base = r.newBase;
    if (!metricLocked) {
      updateObj.metric = r.totalWeeks;
      updateObj.record = recordText;
    }
    if (bonusWritable) { updateObj.bonus = bonusEntry.tier; updateObj.bonus_note = bonusEntry.label; }

    var skipped = [];
    if (baseLocked) skipped.push('base');
    if (metricLocked) skipped.push('metric');
    if (bonusEntry && bonusLocked) skipped.push('bonus');
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

    // Diff against the pre-update row (r.base, r.bonus) to log what
    // actually moved — same pattern as update-sports.js, now accounting
    // for a Grammy bonus change too, not just base. A locked field's
    // "new" value stays equal to the pre-update value, so it contributes
    // 0 to delta — no special case needed to skip locked no-ops.
    var newBaseVal = baseLocked ? (Number(r.base) || 0) : (Number(r.newBase) || 0);
    var oldTotal = (Number(r.base) || 0) + (Number(r.bonus) || 0);
    var newTotal = newBaseVal + newBonusVal;
    var delta = Math.round((newTotal - oldTotal) * 10) / 10;
    if (delta !== 0) {
      var causeParts = [recordText];
      if (bonusWritable) causeParts.push(bonusEntry.label);
      scoreEvents.push({
        season_year: season.year,
        member_id: r.member_id,
        category: 'Musician',
        delta: delta,
        cause: r.pick + ' (' + causeParts.join(' — ') + ')',
        source: 'update-billboard',
      });
    }

    rankings.push({
      rank: r.rank,
      member: r.member_id,
      artist: r.pick,
      totalWeeks: r.totalWeeks,
      numOneWeeks: totalNumOne,
      songCount: r.songs.length,
      // Pre-existing display bug, fixed in passing (by main, PR #53):
      // this used to read r.bonus here instead of r.base when locked.
      base: baseLocked ? (Number(r.base) || 0) : r.newBase,
      bonus: newBonusVal,
      total: (baseLocked ? (Number(r.base) || 0) : r.newBase) + newBonusVal,
      bonusDetected: bonusEntry ? bonusEntry.label : undefined,
      lockedFields: skipped.length > 0 ? skipped : undefined,
    });
  }

  await writeScoreEventsAndNotify(supabase, scoreEvents, memberNameById);

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
