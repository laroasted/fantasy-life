/**
 * Fantasy Life — Draft-time pick lookup / "did you mean" autocomplete
 *
 * Read-only, on-demand resolver for the draft tool's free-text "Custom..."
 * input, for the categories with no closed, fully-curated option list:
 * actor/actress (TMDB), musician (MusicBrainz), stock (Yahoo Finance
 * ticker search), and the team-sports categories whose curated dropdown is
 * a popularity-trimmed subset of a much bigger real league — NCAAF, NCAAB,
 * MLS (see src/constants/pickOptions.js's own "Custom..." entries).
 *
 * WHY THIS EXISTS: every one of these categories' scoring cron
 * (update-entertainment.js, update-billboard.js, update-stocks.js,
 * update-sports.js, update-college.js) resolves a drafted pick's free text
 * against its real-world source weeks later, with no human in the loop.
 * A misspelling there either fails silently (frozen score, nobody ever
 * notices — see update-country.js's own equivalent comment on this before
 * the Country dropdown fix) or, for TMDB's fuzzy person search
 * specifically, can resolve to a different, wrong real person with no
 * error at all (findPersonId()'s `data.results[0].id` fallback in
 * update-entertainment.js). This endpoint runs the EXACT SAME kind of
 * lookup live, at draft time, so the person typing sees real candidates
 * and picks one — the draft tool then submits the matched CANONICAL
 * string (not their raw typed text) as the actual pick, so the scoring
 * cron is guaranteed to re-resolve it via its own exact/near-exact match
 * path, never falling through to a risky fuzzy guess.
 *
 * ONE FILE, `?category=` DISPATCHED — same reasoning as api/push.js's own
 * `?action=` dispatch: a separate file per category would be this repo's
 * 13th+ Serverless Function, over the Vercel Hobby plan's 12-function cap
 * (see AGENTS.md's push-notifications section). This file is the 12th.
 *
 * TEAM SPORTS reuse the live ESPN fetch functions already exported by
 * update-sports.js (fetchESPNStandings/ESPN_LEAGUES) and update-college.js
 * (fetchESPNTeams/COLLEGE_LEAGUES) rather than keeping a second copy of
 * those URLs/parsing here — same "one source of truth" reasoning as the
 * Country dropdown fix (src/constants/countries.js). Deliberately NOT
 * reusing those files' own matchTeam() — that function is single-best-
 * match-oriented, built for resolving an already-fully-typed pick during
 * scoring, not for listing several live candidates as someone types. This
 * file does its own lightweight substring filter over the same fetched
 * list instead, and submits back whichever team's `displayName` the user
 * confirms — matchTeam()'s own tier-2 check (`displayName.includes(x)`) is
 * then guaranteed to re-match it later, regardless of which of a team's
 * several naming fields a sport's curated dropdown convention happens to
 * use.
 *
 * TENNIS/GOLF/F1 are deliberately NOT covered here — their scoring match
 * (update-events.js) depends on HTML-scraped ESPN/Billboard-style pages
 * rather than clean JSON APIs, too slow/fragile to call synchronously from
 * a draft-time autocomplete, and their curated dropdowns already cover
 * the realistic field well enough that Custom is rarely reached for them.
 *
 * No auth, no DB access, nothing written — purely a read-through proxy so
 * TMDB_API_KEY stays server-side and these three.js APIs can be called
 * from the browser without CORS/key-exposure problems. Every lookup
 * function is defensive the same way this repo's cron fetches already are
 * (src/utils/analytics.js's and src/utils/push.js's own comments on this
 * pattern): any failure degrades to an empty candidate list, never a
 * thrown error — a lookup failing must never block someone from still
 * submitting their raw typed text as a Custom pick, exactly like today.
 */

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';

// MusicBrainz's API usage policy requires a descriptive User-Agent
// identifying the calling application — an anonymous/default one risks
// being rate-limited or blocked outright.
const MUSICBRAINZ_USER_AGENT = 'FantasyLifeHub/1.0 (+https://github.com/laroasted/fantasy-life)';

async function lookupActor(query) {
  if (!TMDB_API_KEY) return [];
  try {
    const url = TMDB_BASE + '/search/person?api_key=' + TMDB_API_KEY + '&query=' + encodeURIComponent(query);
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).slice(0, 6).map(function (p) {
      return {
        id: String(p.id),
        label: p.name,
        sublabel: (p.known_for || []).map(function (k) { return k.title || k.name; }).filter(Boolean).slice(0, 2).join(', ') || null,
        photoUrl: p.profile_path ? 'https://image.tmdb.org/t/p/w92' + p.profile_path : null,
      };
    });
  } catch (err) {
    console.warn('draft-lookup: TMDB search failed:', err.message);
    return [];
  }
}

async function lookupMusician(query) {
  try {
    const url = 'https://musicbrainz.org/ws/2/artist?query=' + encodeURIComponent(query) + '&fmt=json&limit=6';
    const res = await fetch(url, { headers: { 'User-Agent': MUSICBRAINZ_USER_AGENT } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.artists || []).map(function (a) {
      return {
        id: a.id,
        label: a.name,
        sublabel: a.disambiguation || a.type || null,
        photoUrl: null,
      };
    });
  } catch (err) {
    console.warn('draft-lookup: MusicBrainz search failed:', err.message);
    return [];
  }
}

async function lookupStock(query) {
  try {
    const url = 'https://query1.finance.yahoo.com/v1/finance/search?q=' + encodeURIComponent(query) + '&quotesCount=6&newsCount=0';
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.quotes || [])
      .filter(function (q) { return !!q.symbol; })
      .slice(0, 6)
      .map(function (q) {
        return {
          id: q.symbol,
          label: q.symbol.toUpperCase(),
          sublabel: q.longname || q.shortname || q.exchange || null,
          photoUrl: null,
        };
      });
  } catch (err) {
    console.warn('draft-lookup: Yahoo Finance search failed:', err.message);
    return [];
  }
}

async function lookupTeam(query, sport) {
  try {
    const lower = query.toLowerCase().trim();
    if (!lower) return [];

    let teams = null;
    if (sport === 'mls') {
      const { fetchESPNStandings, ESPN_LEAGUES } = require('./cron/update-sports');
      teams = await fetchESPNStandings('MLS', ESPN_LEAGUES.MLS);
    } else if (sport === 'ncaaf' || sport === 'ncaab') {
      const { fetchESPNTeams, COLLEGE_LEAGUES } = require('./cron/update-college');
      const cfg = COLLEGE_LEAGUES[sport.toUpperCase()];
      if (!cfg) return [];
      teams = await fetchESPNTeams(cfg.sport, cfg.league);
    } else {
      return [];
    }
    if (!teams) return [];

    return teams
      .filter(function (t) {
        return (
          (t.displayName || '').toLowerCase().includes(lower) ||
          (t.teamName || '').toLowerCase().includes(lower) ||
          (t.location || '').toLowerCase().includes(lower)
        );
      })
      .slice(0, 6)
      .map(function (t) {
        return {
          id: String(t.id),
          label: t.displayName,
          sublabel: t.abbreviation || null,
          photoUrl: null,
        };
      });
  } catch (err) {
    console.warn('draft-lookup: team search failed:', err.message);
    return [];
  }
}

module.exports = async function handler(req, res) {
  const category = String(req.query.category || '').toLowerCase();
  const query = String(req.query.query || '').trim();
  const sport = String(req.query.sport || '').toLowerCase();

  // Same floor as a typical typeahead debounce — a 1-character query
  // against TMDB/MusicBrainz/Yahoo returns a huge, useless result set for
  // real network cost; not worth it before there's enough to narrow on.
  if (!query || query.length < 2) return res.status(200).json({ candidates: [] });

  let candidates = [];
  if (category === 'actor' || category === 'actress') candidates = await lookupActor(query);
  else if (category === 'musician') candidates = await lookupMusician(query);
  else if (category === 'stock') candidates = await lookupStock(query);
  else if (category === 'team') candidates = await lookupTeam(query, sport);
  else return res.status(400).json({ error: 'Unknown category' });

  return res.status(200).json({ candidates });
};
