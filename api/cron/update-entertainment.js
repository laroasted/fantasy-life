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
 */
 
const { createClient } = require('@supabase/supabase-js');
 
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
  /gala/i,
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
 
    // Layer 2: Deduplicate by fuzzy title + same release month
    // Requires 2+ shared words of 4+ chars to count as a duplicate
    var final = [];
    for (var j = 0; j < deduped.length; j++) {
      var film = deduped[j];
      var dominated = false;
      var filmWords = film.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(function(w) { return w.length >= 4; });
 
      for (var k = 0; k < final.length; k++) {
        var existing = final[k];
        if (film.releaseDate.substring(0, 7) !== existing.releaseDate.substring(0, 7)) continue;
        var existingWords = existing.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(function(w) { return w.length >= 4; });
        var sharedWords = 0;
        for (var w = 0; w < filmWords.length; w++) {
          if (existingWords.indexOf(filmWords[w]) >= 0) sharedWords++;
        }
        if (sharedWords >= 2) {
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
 
  for (var category of ['Actor', 'Actress']) {
    console.log('  Processing ' + category + '...');
 
    var { data: picks, error: pickErr } = await supabase.from('picks').select('id, member_id, pick, base, bonus').eq('season_year', seasonYear).eq('category', category);
    if (pickErr || !picks || picks.length === 0) { results[category] = { status: 'skipped', reason: 'no picks' }; continue; }
 
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
        if (!isFieldLocked(locks, category, own, 'base')) {
          var { error } = await supabase.from('picks').update({ base: r.base }).eq('id', matchingPick.id);
          if (!error) updated++;
        } else { console.log('    ' + own + ': base is locked, skipping'); updated++; }
      }
    }
 
    console.log('  ' + category + ': Updated ' + updated + '/' + picks.length + ' picks\n');
    results[category] = { status: 'updated', updated: updated, total: picks.length, rankings: rankings.map(function(r) { return { rank: r.rank, member: r.member, pick: r.pick, totalScore: r.totalScore, filmCount: r.filmCount, base: r.base, films: r.films }; }) };
  }
 
  console.log('  Done!');
  return res.status(200).json({ message: 'Actor/Actress box office update complete', season: seasonYear, fantasyYear: { start: FY_START, end: FY_END }, timestamp: new Date().toISOString(), results: results });
};
