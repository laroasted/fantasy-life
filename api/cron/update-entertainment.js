/**
 * Fantasy Life — Actor/Actress Box Office + RT Score Updater
 * Respects commissioner locks from seasons.locks column.
 * Fantasy year dates are read dynamically from seasons.fy_start and seasons.fy_end
 * so no code changes are needed when a new season starts.
 *
 * Tiebreaker: players with the same metric score split/average the base points
 * they collectively occupy.
 * e.g. all 12 tied at 0 → (12+11+...+1)/12 = 6.5 each
 *
 * CHANGELOG (May 2026):
 * - FIX: Cross-pick BO borrowing — if TMDB returns 0 revenue for a film,
 *   check if another pick already has non-zero BO for the same title and use it.
 * - FIX: Cross-pick RT borrowing — same logic for Rotten Tomatoes scores.
 * - FIX: Filter out premiere events, red carpets, TV episodes, and other
 *   non-theatrical TMDB entries before processing.
 * - FIX: Fuzzy title dedup threshold raised from 1 shared word to 2, to avoid
 *   false positives on unrelated films sharing one common word.
 * - FIX: Title containment dedup — "X" inside "Y: X" dedupes regardless of month.
 * - FIX: /gala/i → /\bgala\b/i so "Galaxy" is not filtered as non-theatrical.
 *
 * CHANGELOG (2026-11) — Automated Oscar bonus
 *   Bonus (CATEGORY_BONUS_RULES.Actor/Actress) used to be commissioner-only
 *   manual entry. Now resolved from the Academy Awards' own Wikipedia
 *   article — NOT Wikidata (its structured "award received" statements lag
 *   real-time editing of the article's own prose/tables by hours to days;
 *   Wikipedia's winners table gets edited live during the broadcast) — and
 *   kept entirely separate from update-projections.js's `applyOscarBonus`,
 *   which stays exactly what it is: a PRE-outcome probability estimate from
 *   Kalshi/Polymarket odds for the "Projected Final" toggle, never mutating
 *   a real score. This is the POST-outcome settlement of the real thing.
 *   Evergreen: the article is looked up by trying "{year} Academy Awards"
 *   (a title Wikipedia redirects to the real ordinal-numbered article, e.g.
 *   "98th Academy Awards") for the current year then the prior year, and
 *   "has this ceremony actually happened" is answered by whether a winner
 *   can be parsed out — not a hardcoded date — so it self-corrects across
 *   the New Year boundary before a given year's ceremony has aired yet.
 *   Unlike the projections version, this covers the FULL bonus rule
 *   (Supporting categories included) since it isn't limited to whatever
 *   markets happen to exist.
 *   Confidence: moderate. The winner-is-bold-wikitext convention is
 *   long-standing and stable on this specific recurring article, but
 *   wasn't live-verified from this build's network-restricted sandbox —
 *   see docs/bonus-automation.md. Never guesses: if a category's winner
 *   can't be confidently parsed, it's skipped and logged, never faked.
 */

const { createClient } = require('@supabase/supabase-js');
const { writeScoreEventsAndNotify } = require('../_lib/push');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const OMDB_API_KEY = process.env.OMDB_API_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';
 
const delay = (ms) => new Promise(r => setTimeout(r, ms));
 
// ─── Non-theatrical patterns ────────────────────────────────────────────────
// TMDB sometimes returns premiere events, TV episodes, talk shows, etc.
// as movie credits. Filter these out before processing.
const NON_FILM_PATTERNS = [
  /red carpet/i,
  /world premiere/i,
  /premiere of/i,
  /season \d+ episode/i,
  /episode \d+/i,
  /town hall/i,
  /tonight show/i,
  /late (night|show|late)/i,
  /\bCNN\b/i,
  /\bNBC\b.*special/i,
  /variety.*special/i,
  /award.*show/i,
  /behind the scenes/i,
  /making of/i,
  /talk show/i,
  /interview/i,
  /press conference/i,
  /\bgala\b/i,
  /photocall/i,
];
 
/**
 * Assigns base points with split/average tiebreaker logic.
 * Input array must already be sorted descending by totalScore before calling.
 */
function assignBasePointsWithTiebreaker(rankings, totalMembers) {
  var n = rankings.length;
  var i = 0;
  while (i < n) {
    var j = i;
    while (j < n && rankings[j].totalScore === rankings[i].totalScore) j++;
    var pointSum = 0;
    for (var p = i; p < j; p++) pointSum += (totalMembers - p);
    var avgPoints = Math.round((pointSum / (j - i)) * 100) / 100;
    for (var p = i; p < j; p++) {
      rankings[p].base = avgPoints;
      rankings[p].rank = i + 1;
    }
    i = j;
  }
  return rankings;
}
 
function isFieldLocked(locks, category, ownerName, field) {
  if (!locks) return false;
  return !!locks[category + '|' + ownerName + '|' + field];
}

// ═══════════════════════════════════════════════════════════════════════
// OSCAR BONUS — resolved from the Academy Awards' own Wikipedia article.
// See the 2026-11 changelog above for why Wikipedia (not Wikidata) and why
// this is a separate concern from update-projections.js's market-based
// version.
// ═══════════════════════════════════════════════════════════════════════
const OSCAR_CATEGORIES = {
  Actor: [
    { label: 'Best Actor', keywords: ['actor in a leading role'], winTier: 10, nomTier: 3 },
    { label: 'Best Supporting Actor', keywords: ['actor in a supporting role'], winTier: 7, nomTier: 2 },
  ],
  Actress: [
    { label: 'Best Actress', keywords: ['actress in a leading role'], winTier: 10, nomTier: 3 },
    { label: 'Best Supporting Actress', keywords: ['actress in a supporting role'], winTier: 7, nomTier: 2 },
  ],
};

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
// pages are NOT ==heading== sections — verified live against the 97th
// Academy Awards article's real wikitext. Each category is a
// `{{Award category|color|[[Real Name|Display Name]]}}` template marker
// inside a wikitable (two categories per row, `|-` separating rows), e.g.:
//   | {{Award category|#F9EFAA|[[Academy Award for Best Actor|Best Actor in a Leading Role]]}}
//   * '''[[Adrien Brody]] – ''[[The Brutalist]]'' as László Tóth ‡'''
//   ** [[Timothée Chalamet]] – ''[[A Complete Unknown]]'' as [[Bob Dylan]]
//   ** ...
// Matches the keyword against the marker line itself (its target or
// display text, either way) rather than a heading, and the block runs
// until the next marker, the next table row, or the next real heading.
function extractCategoryBlock(wikitext, categoryKeywords) {
  var lines = wikitext.split('\n');
  var markerRegex = /\{\{Award category\|/i;
  var startIdx = -1;
  for (var i = 0; i < lines.length; i++) {
    if (markerRegex.test(lines[i])) {
      var lower = lines[i].toLowerCase();
      if (categoryKeywords.some(function (k) { return lower.includes(k); })) { startIdx = i; break; }
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

// Winner = the first bulleted (* or **) line in the block that's bolded;
// every OTHER bulleted line is a nominee candidate (Oscar acting
// categories have no credit sub-lines to worry about — see the matching
// comment in update-billboard.js's copy of this function, which does,
// for why there's no credit-line filtering here either). Returns
// candidate NAME LISTS, not one resolved name — deliberately: which
// wikilink on a line is "the person" vs. "the film" differs by line (an
// Oscar nominee's own line is `[[Person]] – ''[[Film]]''`), so every name
// on the line is kept as a candidate and left to namesMatch() at the
// call site, which only ever matches a real person's name — a film title
// just won't match.
function extractWinnerAndNominees(sectionText) {
  if (!sectionText) return null;
  var bulletLines = sectionText.split('\n').filter(function (l) { return /^\s*\*/.test(l); });
  if (bulletLines.length === 0) return null;
  var winnerIdx = bulletLines.findIndex(function (l) { return l.includes("'''"); });
  if (winnerIdx === -1) return null;
  var winnerCandidates = extractWikiNames(bulletLines[winnerIdx]);
  var nextIsOwnCredit = !!(bulletLines[winnerIdx + 1] && bulletLines[winnerIdx + 1].includes("'''"));
  if (nextIsOwnCredit) winnerCandidates = winnerCandidates.concat(extractWikiNames(bulletLines[winnerIdx + 1]));
  if (winnerCandidates.length === 0) return null;

  var nomineeSet = {};
  for (var i = 0; i < bulletLines.length; i++) {
    if (i === winnerIdx || (i === winnerIdx + 1 && nextIsOwnCredit)) continue;
    for (var n of extractWikiNames(bulletLines[i])) nomineeSet[n] = true;
  }
  return { winnerCandidates: winnerCandidates, nomineeCandidates: Object.keys(nomineeSet) };
}

function namesMatch(pickName, candidateName) {
  var a = (pickName || '').toLowerCase().trim();
  var b = (candidateName || '').toLowerCase().trim();
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

// One category's parsed result, cached for reuse across every pick in
// that category (parsing the wikitext per-pick would be redundant work).
function computeOscarCategoryResults(wikitext, categories) {
  var results = [];
  for (var cat of categories) {
    var parsed = extractWinnerAndNominees(extractCategoryBlock(wikitext, cat.keywords));
    if (!parsed) { console.warn('  Oscar: could not resolve winner for "' + cat.label + '"'); continue; }
    results.push({ cat: cat, winnerCandidates: parsed.winnerCandidates, nomineeCandidates: parsed.nomineeCandidates });
  }
  return results;
}

// Tries "{year} Academy Awards" (a title Wikipedia redirects to the real
// ordinal article, e.g. "98th Academy Awards") for the current year, then
// the prior year. "Has this ceremony happened" is answered by whether a
// winner can actually be parsed out of it — live API state, not a
// hardcoded date — so this self-corrects across the New Year boundary
// before a given year's ceremony has aired.
async function resolveOscarWikitext() {
  var allCategories = OSCAR_CATEGORIES.Actor.concat(OSCAR_CATEGORIES.Actress);
  var currentYear = new Date().getFullYear();
  for (var year of [currentYear, currentYear - 1]) {
    var title = year + ' Academy Awards';
    var wikitext = await fetchWikipediaWikitext(title);
    if (!wikitext) { console.log('  Oscar: no Wikipedia page resolved for "' + title + '"'); continue; }
    var hasWinner = computeOscarCategoryResults(wikitext, allCategories).length > 0;
    if (hasWinner) { console.log('  Oscar: using "' + title + '"'); return wikitext; }
    console.log('  Oscar: "' + title + '" has no resolvable winners yet (ceremony likely not aired)');
  }
  return null;
}

// Best (highest-tier) Oscar result for this pick's name this ceremony —
// checked against every category's precomputed candidate lists. A person
// only has one line in CATEGORY_BONUS_RULES.Actor/Actress, not a per-GP
// stacking rule like F1, so this is a max, not a sum.
function resolveOscarBonusForPick(pickName, categoryResults) {
  var best = null;
  for (var r of categoryResults) {
    if (r.winnerCandidates.some(function (c) { return namesMatch(pickName, c); })) {
      if (!best || best.tier < r.cat.winTier) best = { tier: r.cat.winTier, label: 'Won ' + r.cat.label };
    } else if (r.nomineeCandidates.some(function (c) { return namesMatch(pickName, c); })) {
      if (!best || best.tier < r.cat.nomTier) best = { tier: r.cat.nomTier, label: 'Nominated ' + r.cat.label };
    }
  }
  return best;
}
 
async function findPersonId(name) {
  try {
    var url = TMDB_BASE + '/search/person?api_key=' + TMDB_API_KEY + '&query=' + encodeURIComponent(name);
    var res = await fetch(url);
    if (!res.ok) return null;
    var data = await res.json();
    if (!data.results || data.results.length === 0) return null;
    var exact = data.results.find(function(p) { return p.name.toLowerCase() === name.toLowerCase(); });
    return exact ? exact.id : data.results[0].id;
  } catch (err) {
    console.error('  TMDB search error for "' + name + '":', err.message);
    return null;
  }
}
 
async function getActorFilms(personId, FY_START, FY_END) {
  try {
    var url = TMDB_BASE + '/person/' + personId + '/movie_credits?api_key=' + TMDB_API_KEY;
    var res = await fetch(url);
    if (!res.ok) return [];
    var data = await res.json();
    var raw = (data.cast || []).filter(function(f) {
      return f.release_date && f.release_date >= FY_START && f.release_date <= FY_END;
    });
 
    // Layer 0: Filter out non-theatrical entries (premieres, TV eps, talk shows)
    raw = raw.filter(function(f) {
      var dominated = NON_FILM_PATTERNS.some(function(pattern) { return pattern.test(f.title); });
      if (dominated) console.log('    Filtered out non-theatrical: "' + f.title + '"');
      return !dominated;
    });
 
    // Layer 1: Deduplicate by exact TMDB movie ID
    var seenIds = {};
    var deduped = [];
    for (var i = 0; i < raw.length; i++) {
      var f = raw[i];
      if (!seenIds[f.id]) {
        seenIds[f.id] = true;
        deduped.push({ tmdbId: f.id, title: f.title, releaseDate: f.release_date });
      }
    }
 
    // Layer 2: Deduplicate by fuzzy title match
    // Two checks (either triggers a dedup):
    //   A) Title containment — one title is a substring of the other (any month)
    //      e.g. "The Mandalorian and Grogu" inside "Star Wars: The Mandalorian and Grogu"
    //   B) 2+ shared words of 4+ chars in the same release month
    var final = [];
    for (var j = 0; j < deduped.length; j++) {
      var film = deduped[j];
      var dominated = false;
      var filmLower = film.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
      var filmWords = filmLower.split(/\s+/).filter(function(w) { return w.length >= 4; });
 
      for (var k = 0; k < final.length; k++) {
        var existing = final[k];
        var existingLower = existing.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
        var isDupe = false;
 
        // Check A: title containment (no month restriction)
        if (filmLower.indexOf(existingLower) >= 0 || existingLower.indexOf(filmLower) >= 0) {
          isDupe = true;
        }
 
        // Check B: shared words (same month only)
        if (!isDupe && film.releaseDate.substring(0, 7) === existing.releaseDate.substring(0, 7)) {
          var existingWords = existingLower.split(/\s+/).filter(function(w) { return w.length >= 4; });
          var sharedWords = 0;
          for (var w = 0; w < filmWords.length; w++) {
            if (existingWords.indexOf(filmWords[w]) >= 0) sharedWords++;
          }
          if (sharedWords >= 2) isDupe = true;
        }
 
        if (isDupe) {
          console.log('    Dedup: "' + film.title + '" looks like duplicate of "' + existing.title + '" — skipping');
          dominated = true;
          if (film.title.length > existing.title.length) {
            final[k] = film;
            console.log('    Keeping "' + film.title + '" over "' + existing.title + '" (longer title)');
          }
          break;
        }
      }
      if (!dominated) final.push(film);
    }
    return final;
  } catch (err) { return []; }
}
 
async function getBoxOffice(tmdbId) {
  try {
    var url = TMDB_BASE + '/movie/' + tmdbId + '?api_key=' + TMDB_API_KEY;
    var res = await fetch(url);
    if (!res.ok) return 0;
    var data = await res.json();
    return (data.revenue || 0) / 1000000;
  } catch (err) { return 0; }
}
 
async function getRTScore(title, year) {
  try {
    var url = 'https://www.omdbapi.com/?apikey=' + OMDB_API_KEY + '&t=' + encodeURIComponent(title) + '&y=' + year + '&type=movie';
    var res = await fetch(url);
    if (!res.ok) return 0;
    var data = await res.json();
    if (data.Response === 'False') return 0;
    var ratings = data.Ratings || [];
    var rt = ratings.find(function(r) { return r.Source === 'Rotten Tomatoes'; });
    return (rt && rt.Value) ? (parseInt(rt.Value.replace('%', '')) || 0) : 0;
  } catch (err) { return 0; }
}
 
function formatDate(isoDate) {
  if (!isoDate) return '';
  var p = isoDate.split('-');
  return p.length === 3 ? p[1] + '-' + p[2] + '-' + p[0].slice(2) : isoDate;
}
 
module.exports = async function handler(req, res) {
  var authHeader = req.headers['authorization'], cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== 'Bearer ' + cronSecret) return res.status(401).json({ error: 'Unauthorized' });
  if (!SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY' });
  if (!TMDB_API_KEY) return res.status(500).json({ error: 'Missing TMDB_API_KEY' });
  if (!OMDB_API_KEY) return res.status(500).json({ error: 'Missing OMDB_API_KEY' });
 
  var supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log('  Fantasy Life — Updating Actor/Actress Box Office...\n');
 
  var { data: season } = await supabase.from('seasons').select('year, locks, fy_start, fy_end').eq('status', 'active').single();
  if (!season) return res.status(200).json({ message: 'No active season found' });
  if (!season.fy_start || !season.fy_end) return res.status(500).json({ error: 'Active season is missing fy_start or fy_end — please set these in the seasons table' });
 
  var seasonYear = season.year;
  var locks = season.locks || {};
  var FY_START = season.fy_start;
  var FY_END = season.fy_end;
 
  console.log('  Fantasy Year window: ' + FY_START + ' → ' + FY_END + '\n');
 
  var { data: membersArr } = await supabase.from('members').select('id, name');
  var memberNameById = {};
  (membersArr || []).forEach(function(m) { memberNameById[m.id] = m.name; });
 
  var results = {};
  // Collected across both categories, then batch-written once at the end
  // via writeScoreEventsAndNotify (api/_lib/push.js) — same pattern
  // update-sports.js established first.
  var scoreEvents = [];

  // Fetched once (same Wikipedia article serves both Actor and Actress
  // categories), not per category — see resolveOscarWikitext() above.
  var oscarWikitext = await resolveOscarWikitext();

  for (var category of ['Actor', 'Actress']) {
    console.log('  Processing ' + category + '...');

    var { data: picks, error: pickErr } = await supabase.from('picks').select('id, member_id, pick, base, bonus').eq('season_year', seasonYear).eq('category', category);
    if (pickErr || !picks || picks.length === 0) { results[category] = { status: 'skipped', reason: 'no picks' }; continue; }

    var oscarCategoryResults = oscarWikitext ? computeOscarCategoryResults(oscarWikitext, OSCAR_CATEGORIES[category]) : [];

    var rankings = [];
 
    for (var pick of picks) {
      var actorName = pick.pick, ownerName = memberNameById[pick.member_id] || pick.member_id;
      console.log('  ' + pick.member_id + ': ' + actorName);
 
      var personId = await findPersonId(actorName); await delay(250);
      if (!personId) {
        console.log('    Could not find "' + actorName + '" on TMDB');
        var { data: existingFilms } = await supabase.from('film_entries').select('score').eq('pick_id', pick.id);
        var existingTotal = (existingFilms || []).reduce(function(sum, f) { return sum + Number(f.score || 0); }, 0);
        rankings.push({ member: pick.member_id, pick: actorName, totalScore: existingTotal, films: [], status: 'not found on TMDB' });
        continue;
      }
 
      var films = await getActorFilms(personId, FY_START, FY_END); await delay(250);
 
      // Load existing RT scores for this pick (for RT fallback on same pick)
      var { data: existingFilmRows } = await supabase.from('film_entries').select('title, rotten_tom').eq('pick_id', pick.id);
      var existingRT = {};
      (existingFilmRows || []).forEach(function(f) { existingRT[f.title.toLowerCase()] = Number(f.rotten_tom) || 0; });
 
      var filmResults = [];
      for (var film of films) {
        var boMillions = await getBoxOffice(film.tmdbId); await delay(250);
        var releaseYear = film.releaseDate.split('-')[0];
        var rtScore = await getRTScore(film.title, releaseYear); await delay(200);
 
        // ── RT fallback 1: check this pick's existing DB row ──
        if (rtScore === 0) {
          var ev = existingRT[film.title.toLowerCase()];
          if (ev > 0) {
            rtScore = ev;
            console.log('    ' + film.title + ': Using existing RT from own DB row (' + rtScore + '%)');
          }
        }
 
        // ── RT fallback 2: check OTHER picks' film_entries for same title ──
        if (rtScore === 0) {
          try {
            var { data: siblingRT } = await supabase
              .from('film_entries')
              .select('rotten_tom')
              .ilike('title', film.title)
              .gt('rotten_tom', 0)
              .limit(1);
            if (siblingRT && siblingRT.length > 0) {
              rtScore = Number(siblingRT[0].rotten_tom);
              console.log('    ' + film.title + ': Borrowed RT from sibling pick (' + rtScore + '%)');
            }
          } catch (e) { /* ignore lookup failures */ }
        }
 
        // ── BO fallback: check OTHER picks' film_entries for same title ──
        if (boMillions === 0) {
          try {
            var { data: siblingBO } = await supabase
              .from('film_entries')
              .select('box_office, rotten_tom')
              .ilike('title', film.title)
              .gt('box_office', 0)
              .limit(1);
            if (siblingBO && siblingBO.length > 0) {
              boMillions = Number(siblingBO[0].box_office);
              console.log('    ' + film.title + ': Borrowed BO from sibling pick ($' + boMillions.toFixed(1) + 'M)');
              // Also grab RT if we still don't have it
              if (rtScore === 0 && Number(siblingBO[0].rotten_tom) > 0) {
                rtScore = Number(siblingBO[0].rotten_tom);
                console.log('    ' + film.title + ': Also borrowed RT from sibling pick (' + rtScore + '%)');
              }
            }
          } catch (e) { /* ignore lookup failures */ }
        }
 
        var score = Math.round((boMillions * rtScore / 100) * 100) / 100;
        filmResults.push({ title: film.title, releaseDate: formatDate(film.releaseDate), bo: Math.round(boMillions * 100) / 100, rt: rtScore, score: score });
        console.log('    ' + film.title + ': BO=' + boMillions.toFixed(1) + 'M, RT=' + rtScore + '%, Score=' + score.toFixed(2));
      }
 
      var totalScore = filmResults.reduce(function(sum, f) { return sum + f.score; }, 0);
 
      if (filmResults.length > 0) {
        var tmdbTitles = filmResults.map(function(f) { return f.title.toLowerCase(); });
        var { data: currentFilms } = await supabase.from('film_entries').select('*').eq('pick_id', pick.id);
        var preservedFilms = (currentFilms || []).filter(function(f) { return !tmdbTitles.includes(f.title.toLowerCase()); }).map(function(f) { return { title: f.title, releaseDate: f.release_date, bo: Number(f.box_office) || 0, rt: Number(f.rotten_tom) || 0, score: Number(f.score) || 0, note: f.note }; });
        var allFilms = filmResults.concat(preservedFilms);
 
        await supabase.from('film_entries').delete().eq('pick_id', pick.id);
        var filmRows = allFilms.map(function(f) { return { pick_id: pick.id, title: f.title, release_date: f.releaseDate || '', box_office: f.bo, rotten_tom: f.rt, score: f.score, note: f.note || null }; });
        var { error: filmErr } = await supabase.from('film_entries').insert(filmRows);
        if (filmErr) console.error('    Failed to update films for ' + actorName + ':', filmErr.message);
 
        totalScore = allFilms.reduce(function(sum, f) { return sum + f.score; }, 0);
 
        if (!isFieldLocked(locks, category, ownerName, 'metric')) {
          await supabase.from('picks').update({ metric: Math.round(totalScore * 100) / 100, updated_at: new Date().toISOString() }).eq('id', pick.id);
        } else { console.log('    ' + ownerName + ': metric is locked, skipping'); }
 
        rankings.push({ member: pick.member_id, pick: actorName, totalScore: Math.round(totalScore * 100) / 100, filmCount: allFilms.length, films: allFilms.map(function(f) { return f.title + ' (' + f.bo + 'M × ' + f.rt + '% = ' + f.score + ')'; }) });
      } else {
        var { data: existingAll } = await supabase.from('film_entries').select('score').eq('pick_id', pick.id);
        var existingTot = (existingAll || []).reduce(function(sum, f) { return sum + Number(f.score || 0); }, 0);
        rankings.push({ member: pick.member_id, pick: actorName, totalScore: existingTot, filmCount: 0, films: [], status: 'no TMDB films in FY window' });
      }
    }
 
    // Sort descending by totalScore, then apply tiebreaker
    rankings.sort(function(a, b) { return b.totalScore - a.totalScore; });
    rankings = assignBasePointsWithTiebreaker(rankings, picks.length);
 
    var updated = 0;
    for (var r of rankings) {
      var matchingPick = picks.find(function(p) { return p.member_id === r.member; });
      if (matchingPick) {
        var own = memberNameById[matchingPick.member_id] || matchingPick.member_id;
        var baseLocked = isFieldLocked(locks, category, own, 'base');

        // Oscar bonus (see OSCAR_CATEGORIES/resolveOscarBonusForPick above) —
        // matched by fuzzy name against each category's precomputed
        // winner/nominee candidates, never overwriting a lock, never
        // guessed if nothing was confidently resolved for this person.
        var bonusEntry = resolveOscarBonusForPick(r.pick, oscarCategoryResults);
        var bonusLocked = isFieldLocked(locks, category, own, 'bonus');
        var bonusWritable = !!bonusEntry && !bonusLocked;
        r.bonusDetected = bonusEntry ? bonusEntry.label : undefined;

        var updateObj = {};
        if (!baseLocked) updateObj.base = r.base;
        else console.log('    ' + own + ': base is locked, skipping');
        if (bonusWritable) { updateObj.bonus = bonusEntry.tier; updateObj.bonus_note = bonusEntry.label; }
        else if (bonusEntry && bonusLocked) console.log('    ' + own + ': bonus is locked, skipping');

        // newBaseVal/newBonusVal/writeFailed feed the score_events diff
        // below — a locked field is a legitimate no-op (value unchanged),
        // a failed write is NOT (nothing actually changed in the DB, so
        // there's nothing to log a delta for).
        var newBaseVal, newBonusVal, writeFailed = false;
        if (Object.keys(updateObj).length > 0) {
          var { error } = await supabase.from('picks').update(updateObj).eq('id', matchingPick.id);
          if (!error) {
            updated++;
            newBaseVal = baseLocked ? (Number(matchingPick.base) || 0) : (Number(r.base) || 0);
            newBonusVal = bonusWritable ? bonusEntry.tier : (Number(matchingPick.bonus) || 0);
          } else {
            writeFailed = true;
            newBaseVal = Number(matchingPick.base) || 0;
            newBonusVal = Number(matchingPick.bonus) || 0;
          }
        } else {
          updated++;
          newBaseVal = Number(matchingPick.base) || 0;
          newBonusVal = Number(matchingPick.bonus) || 0;
        }

        // Diff against the pre-update row (matchingPick.base/bonus) — same
        // pattern as update-sports.js, just computed here in the second
        // pass since that's where base actually gets written for this
        // cron (base is ranked/assigned only after ALL picks' metrics
        // are known, unlike sports/college/events/billboard where it's
        // inline in the same per-pick loop). Now accounts for a bonus
        // change too, not just base.
        if (!writeFailed) {
          var oldTotal = (Number(matchingPick.base) || 0) + (Number(matchingPick.bonus) || 0);
          var newTotal = newBaseVal + newBonusVal;
          var delta = Math.round((newTotal - oldTotal) * 10) / 10;
          if (delta !== 0) {
            var causeParts = [];
            if (!baseLocked) causeParts.push((Math.round((r.totalScore || 0) * 100) / 100) + ' pts' +
              (r.filmCount ? ' (' + r.filmCount + ' film' + (r.filmCount === 1 ? '' : 's') + ')' : '') +
              (r.status ? ' [' + r.status + ']' : ''));
            if (bonusWritable) causeParts.push(bonusEntry.label);
            scoreEvents.push({
              season_year: seasonYear,
              member_id: matchingPick.member_id,
              category: category,
              delta: delta,
              cause: r.pick + ' — ' + (causeParts.join(' — ') || 'updated'),
              source: 'update-entertainment',
            });
          }
        }
      }
    }

    console.log('  ' + category + ': Updated ' + updated + '/' + picks.length + ' picks\n');
    results[category] = { status: 'updated', updated: updated, total: picks.length, rankings: rankings.map(function(r) { return { rank: r.rank, member: r.member, pick: r.pick, totalScore: r.totalScore, filmCount: r.filmCount, base: r.base, bonusDetected: r.bonusDetected, films: r.films }; }) };
  }

  await writeScoreEventsAndNotify(supabase, scoreEvents, memberNameById);

  console.log('  Done!');
  return res.status(200).json({ message: 'Actor/Actress box office update complete', season: seasonYear, fantasyYear: { start: FY_START, end: FY_END }, timestamp: new Date().toISOString(), results: results });
};
