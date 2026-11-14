/**
 * Fantasy Life — Daily Sports Standings Updater
 *
 * Updates base points for NFL, NBA, NHL, MLB, MLS from ESPN standings.
 * Bonus points are NEVER touched (locked from previous season playoffs).
 * Respects commissioner locks from the seasons.locks column.
 *
 * FIXES vs original:
 * FIX 1 — Strip abbreviation prefix before matching
 *      All 2026 picks are stored as e.g. "LAL Lakers", "BOS Celtics",
 *      "TB Lightning", "KC Chiefs" etc. The original matchTeam()
 *      searched for the full string "LAL Lakers" in ESPN data which
 *      returns "Los Angeles Lakers" — so ALL 48 NBA/NHL/NFL/MLB picks
 *      would have failed to match and never updated.
 *      Fix: strip leading 2-4 char uppercase prefix before matching.
 *
 * FIX 2 — Added NYCFC and SD FC to NAME_ALIASES
 *      These two MLS picks fail contains/exact/abbr checks without aliases.
 *
 * FIX 3 — Tie averaging for base points
 *      Original used simple array index rank: totalMembers - i
 *      If two picks tie in metric, the first-sorted one unfairly gets
 *      more points. Fix: average the tied positions (e.g. 3-way tie
 *      for 2nd–4th = (11+10+9)/3 = 10.0 each out of 12 players).
 *
 * FIX 4 — NBA/NHL activeMonths updated for 2026 Fantasy Year
 *      Base scoring for NBA/NHL uses the 2026-27 season, NOT the current
 *      2025-26 season (which is bonus points only via playoffs).
 *      Mar–Sep excluded to prevent current season from overwriting base scores.
 *      Resumes Oct 2026 when the 2026-27 seasons begin.
 *
 * FIX 5 — MLS ESPN stat lookup now checks lowercase 'pts' abbreviation
 *      ESPN soccer API returns abbreviation as 'pts' (lowercase), not
 *      'PTS' or 'Pts', causing metric to silently return 0 for every
 *      MLS team — all base points end up wrong/equal as a result.
 *
 * FIX 6 — MLS record now shows "W-D-L · X pts" instead of just "X pts"
 *      Pulls wins, draws, losses from ESPN stats array when available.
 *
 * FIX 7 — Added missing MLS team name aliases for 2026 picks
 *      "Seattle Sounders" → "Sounders FC"
 *      "Cincinnati"       → "FC Cincinnati"  (stored without "FC" prefix)
 *      "NY Red Bulls"     → "New York Red Bulls"
 *      "St. Louis City"   → "St. Louis City SC"
 *      "Chicago Fire"     → "Chicago Fire FC"
 *      "Orlando City"     → "Orlando City SC"
 *
 * FIX 8 (2026-11) — Automated playoff-bracket bonus
 *      Bonus used to be commissioner-only manual entry (Settings → Scores
 *      & Bonus). Now resolved from ESPN's own postseason schedule data for
 *      each picked team, same vendor already trusted for base scoring.
 *      Deliberately NOT date-driven: a team's furthest round is read from
 *      the round NAME ESPN attaches to each game (PLAYOFF_ROUNDS keyword
 *      match below), and the gate for "is there a bracket to check yet" is
 *      "does ESPN return any seasontype=3 games right now" — not a
 *      hardcoded month/day window — so this doesn't need a yearly edit
 *      when a league's postseason start date moves. See
 *      docs/bonus-automation.md for the full design + per-sport
 *      confidence notes (NBA/NHL round-label and MLS postseason-via-
 *      seasontype are the two least-verified parts — watch their first
 *      live run's logs).
 *      Runs independent of the activeMonths base-score freeze: NBA/NHL's
 *      Mar–Sep freeze (FIX 4) exists for BASE scoring, but that's exactly
 *      when last season's playoffs are live and bonus-relevant, so bonus
 *      resolution must not be skipped just because base is frozen.
 *      Never overwrites a locked `bonus` field, and never writes a guess —
 *      if a team's round can't be confidently classified from the text
 *      ESPN returns, the existing bonus value (including a manual
 *      commissioner entry) is left untouched.
 */

const { createClient } = require('@supabase/supabase-js');
const { writeScoreEventsAndNotify } = require('../_lib/push');
const { resolveOscarNight, fetchWikipediaWikitext } = require('../_lib/fantasyYear');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ESPN_LEAGUES = {
  NFL: {
    url: 'https://site.api.espn.com/apis/v2/sports/football/nfl/standings',
    metricType: 'winpct',
    activeMonths: [9, 10, 11, 12, 1],
    sport: 'football', league: 'nfl',
  },
  NBA: {
    url: 'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings',
    metricType: 'winpct',
    // Base scoring uses the 2026-27 season (starts Oct 2026).
    // Mar–Sep excluded: 2025-26 season is bonus points only + offseason gap.
    activeMonths: [10, 11, 12, 1, 2],
    // ...plus March up to Oscar night, for the season that's ending only
    // (see oscarNightExtension in the handler).
    extendBaseToOscarNight: true,
    sport: 'basketball', league: 'nba',
  },
  NHL: {
    url: 'https://site.api.espn.com/apis/v2/sports/hockey/nhl/standings',
    metricType: 'points',
    // Base scoring uses the 2026-27 season (starts Oct 2026).
    // Mar–Sep excluded: 2025-26 season is bonus points only + offseason gap.
    activeMonths: [10, 11, 12, 1, 2],
    extendBaseToOscarNight: true,
    sport: 'hockey', league: 'nhl',
  },
  MLB: {
    url: 'https://site.api.espn.com/apis/v2/sports/baseball/mlb/standings',
    metricType: 'winpct',
    activeMonths: [4, 5, 6, 7, 8, 9],
    sport: 'baseball', league: 'mlb',
  },
  MLS: {
    url: 'https://site.api.espn.com/apis/v2/sports/soccer/usa.1/standings',
    metricType: 'points',
    // Apr–Dec: through Decision Day (early Nov) so the final matchday counts
    // (Oct used to be the last month, freezing base on Oct 31 standings).
    // Standings don't move after Decision Day, and base auto-locks once MLS
    // Cup is decided (AUTO_LOCK_RULES). Jan–Mar stay frozen so the next
    // season's opening weeks can't overwrite end-of-year scores.
    activeMonths: [4, 5, 6, 7, 8, 9, 10, 11, 12],
    sport: 'soccer', league: 'usa.1',
  },
};

// ═══════════════════════════════════════════════════════════════════════
// PLAYOFF BONUS — matched by ROUND NAME, never by calendar date.
// Each league's bracket is a fixed, ordered sequence of named rounds
// (earliest → championship). `keywords` are matched case-insensitively
// against whatever free text ESPN attaches to a given postseason game
// (event name/shortName + any `notes[].headline`), so a round is
// identified by what ESPN calls it this year, not by which week number
// or calendar date it happens to fall on — the schedule can shift by
// weeks (or the league can add/remove a round) without this breaking.
// `loseTier`/`winTier` are exactly CATEGORY_BONUS_RULES in categories.js.
// Lowest confidence: NBA "second round"/"semifinals" wording and whether
// MLS's postseason is queryable the same seasontype=3 way as the other
// four — both unverified against a live response as of this writing.
// ═══════════════════════════════════════════════════════════════════════
const PLAYOFF_ROUNDS = {
  NFL: [
    { label: 'Wild Card', keywords: ['wild card'], loseTier: 2 },
    { label: 'Divisional', keywords: ['divisional'], loseTier: 3 },
    { label: 'Conference Championship', keywords: ['conference championship'], loseTier: 5 },
    { label: 'Super Bowl', keywords: ['super bowl'], loseTier: 7, winTier: 10 },
  ],
  MLB: [
    { label: 'Wild Card', keywords: ['wild card'], loseTier: 2 },
    { label: 'Division Series', keywords: ['division series', ' lds'], loseTier: 3 },
    { label: 'League Championship Series', keywords: ['league championship series', ' lcs'], loseTier: 5 },
    { label: 'World Series', keywords: ['world series'], loseTier: 7, winTier: 10 },
  ],
  NBA: [
    { label: 'First Round', keywords: ['first round'], loseTier: 2 },
    { label: 'Conference Semifinals', keywords: ['conference semifinal', 'semifinals', 'second round'], loseTier: 3 },
    { label: 'Conference Finals', keywords: ['conference final'], loseTier: 5 },
    { label: 'NBA Finals', keywords: ['nba finals'], loseTier: 7, winTier: 10 },
  ],
  NHL: [
    { label: 'First Round', keywords: ['first round'], loseTier: 2 },
    { label: 'Second Round', keywords: ['second round'], loseTier: 3 },
    { label: 'Conference Final', keywords: ['conference final', 'semifinal'], loseTier: 5 },
    { label: 'Stanley Cup Final', keywords: ['stanley cup final'], loseTier: 7, winTier: 10 },
  ],
  MLS: [
    { label: 'Round One', keywords: ['round one', 'first round', 'wild card'], loseTier: 2 },
    { label: 'Conference Semifinals', keywords: ['conference semifinal'], loseTier: 3 },
    { label: 'Conference Final', keywords: ['conference final'], loseTier: 5 },
    { label: 'MLS Cup', keywords: ['mls cup'], loseTier: 7, winTier: 10 },
  ],
};

// Finds the most-advanced round whose keywords appear in `text`. Checked
// from the championship round backwards so a label containing more than
// one keyword-ish word resolves to the more specific/later round.
function classifyRound(text, rounds) {
  const lower = (text || '').toLowerCase();
  for (let i = rounds.length - 1; i >= 0; i--) {
    if (rounds[i].keywords.some((k) => lower.includes(k))) return { index: i, round: rounds[i] };
  }
  return null;
}

// Gate for the expensive per-team schedule calls below. No `season` param
// on purpose — see docs/bonus-automation.md: this app's internal
// seasonYear is already known (FIX 4 above) to NOT line up with every
// sport's native season-year labeling, and getting that offset wrong
// would silently query the wrong year. Omitting it lets ESPN resolve
// "current" itself, which is what "is a bracket live right now" means.
//
// FIX 9 (2026-11) — `seasontype=3` is silently ignored once there's no
// live bracket: ESPN falls back to the current REGULAR-season slate
// instead of returning an empty `events` array, so `events.length > 0`
// alone was never "a bracket exists" — it was "this league plays games,"
// true essentially every day of the year. Live-verified: in November,
// with no NFL/NBA/NHL postseason anywhere close, this URL still returned
// a normal week's upcoming regular-season games. Confirmed live that this
// incorrectly fired NBA/NHL's `onRegularSeasonEnd` auto-lock on `base` on
// the very first run after the auto-lock migration went live — `base`
// then stayed locked indefinitely (auto-lock fires once per season and
// never re-fires), while `record`/`metric` kept updating fine since they
// aren't gated by this check at all. Each event's own `season.type` field
// reliably reports `3` for a genuine postseason game and `2` for this
// fallback (verified against both the current false-positive response and
// a real historical Finals game), so that's the actual signal to check —
// not the plain presence of events.
async function fetchPostseasonExists(sport, league) {
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard?seasontype=3`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return false;
    const data = await res.json();
    const events = data?.events || [];
    return events.some((e) => e?.season?.type === 3);
  } catch (err) {
    console.error(`  Postseason existence check failed for ${league}:`, err.message);
    return false;
  }
}

// One team's completed postseason games, oldest first, each reduced to
// just what classifyRound() + win/loss needs. Pulls text from every
// field that plausibly carries a round name (event name/shortName,
// week.text, competition notes headlines) rather than betting on one —
// unverified live, intentionally defensive. Never throws; a fetch or
// parse problem just means "no bonus signal yet" for that team.
async function fetchTeamPostseasonGames(sport, league, teamId) {
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${teamId}/schedule?seasontype=3`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    const events = data?.events || [];
    return events
      .map((e) => {
        const comp = e?.competitions?.[0];
        const statusObj = comp?.status || e?.status;
        const completed = !!statusObj?.type?.completed;
        const competitor = (comp?.competitors || []).find((c) => String(c?.team?.id ?? c?.id) === String(teamId));
        const won = !!competitor?.winner;
        const textParts = [e?.name, e?.shortName, e?.week?.text, ...((comp?.notes || []).map((n) => n?.headline))].filter(Boolean);
        const dateMs = e?.date ? new Date(e.date).getTime() : 0;
        return { completed, won, text: textParts.join(' | '), dateMs };
      })
      .filter((g) => g.completed)
      .sort((a, b) => a.dateMs - b.dateMs);
  } catch (err) {
    console.error(`  Team schedule fetch failed for team ${teamId}:`, err.message);
    return [];
  }
}

// Furthest-round-reached semantics: a team still alive gets credit for the
// round it has already survived (its last completed game, won); a team
// eliminated gets the tier for the round it lost; only winning the FINAL
// round earns winTier. Returns null (no change) if the last game's round
// can't be confidently classified — never guesses.
function computePlayoffTier(games, rounds) {
  if (!games || games.length === 0) return null;
  const last = games[games.length - 1];
  const classified = classifyRound(last.text, rounds);
  if (!classified) {
    console.warn(`  Could not classify playoff round from text: "${last.text}"`);
    return null;
  }
  const { index, round } = classified;
  const isFinalRound = index === rounds.length - 1;
  const tier = last.won && isFinalRound ? round.winTier : round.loseTier;
  const label = last.won && isFinalRound ? `Won ${round.label}` : `Lost ${round.label}`;
  return { tier, label };
}

// ═══════════════════════════════════════════════════════════════════════
// AUTO-LOCK — fields a league locks itself once a trigger condition is
// true, instead of waiting on the commissioner to click the lock icon.
// `onFinal`: fields to lock once the championship game is complete.
// `onRegularSeasonEnd`: fields to lock once the regular season is over.
// NOT used for NBA/NHL base (removed 2026-11): per FIX 4 / league rule, the
// {Y} fantasy year scores the Y-(Y+1) regular season as base and the
// spring-Y playoffs as bonus. The playoffs that would trip this rule (e.g.
// April 2027) arrive after the season switch at the next draft, so it
// locked the NEW season's base months before that season's own NBA/NHL
// games even start, and base would never update again. NBA/NHL base is
// already frozen Mar–Sep by activeMonths, and nothing scores a season
// after the switch, so no base lock is needed.
// ═══════════════════════════════════════════════════════════════════════
const AUTO_LOCK_RULES = {
  NFL: { onFinal: ['base', 'bonus'] },
  MLB: { onFinal: ['base', 'bonus'] },
  MLS: { onFinal: ['base', 'bonus'] },
  NBA: { onFinal: ['bonus'] },
  NHL: { onFinal: ['bonus'] },
};

// "Regular season over" reuses hasPostseason (a bracket existing at all
// is definitionally the regular season having ended) — no extra fetch.
// "Championship decided" is its own check: any seasontype=3 game whose
// round-name text matches the FINAL round's keywords and is completed.
// League-wide (not per-picked-team), so it doesn't depend on any of this
// league's 12 teams having actually made the championship game.
async function isChampionshipDecided(sport, league, rounds) {
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard?seasontype=3`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return false;
    const data = await res.json();
    const events = data?.events || [];
    const finalRound = rounds[rounds.length - 1];
    // FIX 9 — same `season.type === 3` requirement as fetchPostseasonExists,
    // for the same reason: a regular-season fallback event could otherwise
    // coincidentally satisfy "completed" + keyword text.
    return events.some((e) => {
      if (e?.season?.type !== 3) return false;
      const comp = e?.competitions?.[0];
      const completed = !!(comp?.status || e?.status)?.type?.completed;
      if (!completed) return false;
      const text = [e?.name, e?.shortName, e?.week?.text, ...((comp?.notes || []).map((n) => n?.headline))]
        .filter(Boolean).join(' | ').toLowerCase();
      return finalRound.keywords.some((k) => text.includes(k));
    });
  } catch (err) {
    console.error(`  Championship-decided check failed for ${league}:`, err.message);
    return false;
  }
}
 
const NAME_ALIASES = {
  // NBA
  'T-Wolves': 'Timberwolves',
  'Wolves': 'Timberwolves',
  // MLS — FIX 2: NYCFC and SD FC fail contains matching without aliases
  'NYCFC': 'New York City',
  'SD FC': 'San Diego',
  // MLS — FIX 7: 2026 draft pick names that don't match ESPN directly
  'Seattle Sounders': 'Sounders FC',
  'Cincinnati': 'FC Cincinnati',        // pick stored as "Cincinnati", ESPN has "FC Cincinnati"
  'NY Red Bulls': 'New York Red Bulls', // strip prefix gives "Red Bulls", not "NY Red Bulls"
  'St. Louis City': 'St. Louis City SC',
  'Chicago Fire': 'Chicago Fire FC',
  'Orlando City': 'Orlando City SC',
  // MLS — other aliases kept from original
  'Red Bull': 'Red Bulls',
  'Atlanta': 'Atlanta United',
  'Columbus Crew': 'Columbus',
  'Vancouver': 'Vancouver Whitecaps',
  'Philadelphia Union': 'Philadelphia',
};
 
// ── Lock helper ──
function isFieldLocked(locks, category, ownerName, field) {
  if (!locks) return false;
  return !!locks[`${category}|${ownerName}|${field}`];
}
 
// FIX 1: Strip leading abbreviation prefix from pick names.
// Picks are stored as e.g. "LAL Lakers", "BOS Celtics", "TB Lightning", "KC Chiefs".
// ESPN returns team names without the prefix, so "LAL Lakers" must become "Lakers"
// before the contains/exact match can work.
function stripPickPrefix(pickName) {
  // Remove leading 2–4 uppercase letters followed by a space: "LAL ", "BOS ", "TB ", "KC "
  return pickName.trim().replace(/^[A-Z]{2,4}\s+/, '');
}
 
function matchTeam(pickName, espnTeams) {
  const pick = pickName.trim();
  const stripped = stripPickPrefix(pick); // FIX 1
 
  // Build search terms: alias of original, alias of stripped, stripped, original
  const terms = [];
  if (NAME_ALIASES[pick])     terms.push(NAME_ALIASES[pick]);
  if (NAME_ALIASES[stripped]) terms.push(NAME_ALIASES[stripped]);
  if (stripped !== pick)      terms.push(stripped);
  terms.push(pick);
 
  for (const term of terms) {
    const lower = term.toLowerCase();
    // 1. Exact teamName match
    const exact = espnTeams.find(t => t.teamName.toLowerCase() === lower);
    if (exact) return exact;
    // 2. displayName/teamName contains, or location exact
    const contains = espnTeams.find(t =>
      t.displayName.toLowerCase().includes(lower) ||
      t.teamName.toLowerCase().includes(lower) ||
      t.location.toLowerCase() === lower
    );
    if (contains) return contains;
    // 3. Abbreviation match
    const abbr = espnTeams.find(t => t.abbreviation.toLowerCase() === lower);
    if (abbr) return abbr;
  }
  return null;
}
 
async function fetchESPNStandings(league, config) {
  try {
    const res = await fetch(config.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) { console.log(` ${league}: ESPN returned ${res.status}`); return null; }
    const data = await res.json();
    const teams = [];
    const children = data?.children || [];
    if (children.length === 0) {
      const entries = data?.standings?.entries || [];
      if (entries.length === 0) { console.log(` ${league}: No standings data`); return null; }
      for (const entry of entries) { const t = parseEntry(entry, config); if (t) teams.push(t); }
    } else {
      for (const group of children) {
        for (const entry of (group?.standings?.entries || [])) { const t = parseEntry(entry, config); if (t) teams.push(t); }
        for (const sub of (group?.children || [])) {
          for (const entry of (sub?.standings?.entries || [])) { const t = parseEntry(entry, config); if (t) teams.push(t); }
        }
      }
    }
    if (teams.length === 0) { console.log(` ${league}: Parsed 0 teams`); return null; }
    console.log(` ${league}: Found ${teams.length} teams`);
    return teams;
  } catch (err) { console.error(` ${league}: Fetch error — ${err.message}`); return null; }
}
 
function parseEntry(entry, config) {
  try {
    const team = entry?.team; if (!team) return null;
    const stats = entry?.stats || [];
    let metric = 0, record = '';
 
    if (config.metricType === 'winpct') {
      const wp = stats.find(s => s.name === 'winPercent' || s.abbreviation === 'PCT');
      metric = wp ? parseFloat(wp.value ?? wp.displayValue) : 0;
      const ov = stats.find(s => s.name === 'overall' || s.type === 'total');
      record = ov?.displayValue || '';
      if (!record) {
        const w = stats.find(s => s.name === 'wins')?.value || 0;
        const l = stats.find(s => s.name === 'losses')?.value || 0;
        record = `${w}-${l}`;
      }
    } else if (config.metricType === 'points') {
      // FIX 5: ESPN soccer API returns abbreviation as lowercase 'pts' — check case-insensitively
      const pt = stats.find(s =>
        s.name === 'points' ||
        (s.abbreviation && s.abbreviation.toLowerCase() === 'pts')
      );
      metric = pt ? parseFloat(pt.value ?? pt.displayValue) : 0;
 
      // FIX 6: Build "W-D-L · X pts" for soccer; keep "X pts" for NHL
      if (config.url.includes('soccer')) {
        const w = stats.find(s => s.name === 'wins' || s.abbreviation === 'W')?.value ?? '';
        const d = stats.find(s =>
          s.name === 'ties' || s.name === 'draws' ||
          s.abbreviation === 'D' || s.abbreviation === 'T'
        )?.value ?? '';
        const l = stats.find(s => s.name === 'losses' || s.abbreviation === 'L')?.value ?? '';
        if (w !== '' && d !== '' && l !== '') {
          record = `${w}-${d}-${l} · ${Math.round(metric)} pts`;
        } else {
          record = `${Math.round(metric)} pts`;
        }
      } else {
        record = `${Math.round(metric)} pts`;
      }
    }
 
    return {
      id: team.id || '',
      teamName: team.name || '',
      displayName: team.displayName || '',
      abbreviation: team.abbreviation || '',
      location: team.location || '',
      record,
      metric,
    };
  } catch { return null; }
}
 
/**
 * FIX 3: Assign base points with proper tie averaging.
 * Players tied at the same metric share the average of their tied positions.
 * e.g. 3-way tie for positions 2–4 out of 12 = (11+10+9)/3 = 10.0 each
 */
function assignBasePointsWithTies(matched, totalMembers) {
  matched.sort((a, b) => b.metric - a.metric);
  const result = [];
  let i = 0;
  while (i < matched.length) {
    let j = i;
    while (j < matched.length && matched[j].metric === matched[i].metric) j++;
    const posSum = Array.from({ length: j - i }, (_, k) => totalMembers - i - k)
      .reduce((a, b) => a + b, 0);
    const avgBase = posSum / (j - i);
    for (let k = i; k < j; k++) result.push({ ...matched[k], newBase: avgBase });
    i = j;
  }
  return result;
}

module.exports = async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });
  }
 
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log('Fantasy Life — Updating Sports Standings...\n');
 
  const { data: season } = await supabase
    .from('seasons').select('id, year, locks, auto_lock_fired').eq('status', 'active').single();
  if (!season) return res.status(200).json({ message: 'No active season found, skipping' });

  const seasonYear = season.year;
  const locks = season.locks || {};
  // autoLockFired (separate seasons.auto_lock_fired column — see
  // supabase/phase20_auto_lock_tracking.sql) tracks "has this league+field's
  // auto-lock already fired this season" independent of locks.jsonb itself.
  // Keeping it out of `locks` matters: SeasonSettings.jsx's Locks tab counts
  // and lists every raw key in that object, so a bookkeeping marker stuffed
  // in there would show up as a phantom lock to the commissioner.
  // Both accumulate here across every league this run, then get written
  // ONCE at the end — after every league's own base/bonus picks.update()
  // calls, never before, so a just-decided championship's correct final
  // bonus/base gets written this same run before its own lock takes effect
  // (locking first would have this run skip writing the value the lock
  // exists to protect).
  const autoLockFired = season.auto_lock_fired || {};
  const autoLockWrites = {};
  const autoLockFiredWrites = {};
 
  const { data: members } = await supabase.from('members').select('id, name');
  const memberNameById = {};
  (members || []).forEach(m => { memberNameById[m.id] = m.name; });
 
  const results = {};
  const currentMonth = new Date().getMonth() + 1;
  // Collected across every league, then batch-inserted once at the end —
  // same shape as snapshot-scores.js's single upsert. A failure writing
  // these must never block or roll back the picks.update() calls above;
  // the activity feed is a nice-to-have view on top of real scoring, not
  // part of it.
  const scoreEvents = [];

  // Oscar-night extension for NBA/NHL base (league rule: the fantasy year
  // ends on Oscar night; see api/_lib/fantasyYear.js). activeMonths stops
  // at February, which used to drop the last ~2 weeks of the year. Applies
  // ONLY while the active season is the one ending this spring (season Y
  // during calendar year Y+1, i.e. before the next draft switches it);
  // once the new season is active, March stays frozen so its picks don't
  // show the old season's standings until October. Through Oscar night +1
  // day UTC so the run after that night's games still counts; off entirely
  // if the ceremony date can't be resolved.
  const todayUTC = new Date().toISOString().slice(0, 10);
  let oscarNightExtension = false;
  if (seasonYear === new Date().getUTCFullYear() - 1) {
    const oscarNight = await resolveOscarNight(seasonYear, fetchWikipediaWikitext);
    if (oscarNight) {
      const graceEnd = new Date(Date.parse(oscarNight) + 864e5).toISOString().slice(0, 10);
      oscarNightExtension = todayUTC <= graceEnd;
      console.log(`Oscar night ${oscarNight}: NBA/NHL base extension ${oscarNightExtension ? 'ON' : 'off'} (today ${todayUTC})`);
    }
  }
 
  for (const [league, config] of Object.entries(ESPN_LEAGUES)) {
    console.log(`Processing ${league}...`);

    // Base scoring can be frozen for the month (offseason / deliberate
    // cross-season gap, FIX 4) while the bonus-relevant postseason from
    // the OTHER side of that gap is still live — so a frozen base no
    // longer skips the league entirely; it only skips the base/metric/
    // record writes below. Bonus resolution always runs.
    const baseFrozen = !!(config.activeMonths && !config.activeMonths.includes(currentMonth))
      && !(config.extendBaseToOscarNight && oscarNightExtension);
    if (baseFrozen) console.log(` ${league}: Offseason — base frozen, bonus still evaluated`);

    const { data: picks, error: pickErr } = await supabase
      .from('picks')
      .select('id, member_id, pick, base, bonus')
      .eq('season_year', seasonYear)
      .eq('category', league);

    if (pickErr || !picks || picks.length === 0) {
      results[league] = { status: 'skipped', reason: 'no picks' };
      continue;
    }

    const espnTeams = await fetchESPNStandings(league, config);
    if (!espnTeams) { results[league] = { status: 'skipped', reason: 'no ESPN data' }; continue; }

    const matched = [], unmatched = [];
    for (const pick of picks) {
      const espnTeam = matchTeam(pick.pick, espnTeams);
      if (espnTeam) {
        matched.push({ ...pick, espnTeam: espnTeam.displayName, espnTeamId: espnTeam.id, record: espnTeam.record, metric: espnTeam.metric });
      } else {
        unmatched.push(pick.pick);
        console.warn(` Could not match "${pick.pick}"`);
      }
    }

    if (matched.length === 0) {
      results[league] = { status: 'skipped', reason: 'no matches', unmatched };
      continue;
    }

    // FIX 3: tie-aware base point assignment (skipped while base is frozen —
    // nothing downstream reads newBase in that case since baseFrozen gates
    // every write of it, but keep the shape consistent either way).
    const ranked = baseFrozen
      ? matched.map((m) => ({ ...m, newBase: m.base }))
      : assignBasePointsWithTies(matched, picks.length);

    // ── Playoff bonus resolution (see PLAYOFF_ROUNDS + FIX 8 above) ──
    const bonusByPickId = {};
    let hasPostseason = false;
    if (PLAYOFF_ROUNDS[league]) {
      hasPostseason = await fetchPostseasonExists(config.sport, config.league);
      if (hasPostseason) {
        for (const m of ranked) {
          if (!m.espnTeamId) continue;
          const games = await fetchTeamPostseasonGames(config.sport, config.league, m.espnTeamId);
          const result = computePlayoffTier(games, PLAYOFF_ROUNDS[league]);
          if (result) bonusByPickId[m.id] = result;
        }
      } else {
        console.log(` ${league}: No postseason bracket live yet — bonus unchanged`);
      }
    }

    let updated = 0;
    const rankings = [];

    for (const m of ranked) {
      const ownerName = memberNameById[m.member_id] || m.member_id;
      const baseLocked   = isFieldLocked(locks, league, ownerName, 'base');
      const metricLocked = isFieldLocked(locks, league, ownerName, 'metric');
      const recordLocked = isFieldLocked(locks, league, ownerName, 'record');
      const bonusLocked  = isFieldLocked(locks, league, ownerName, 'bonus');

      const bonusResult = bonusByPickId[m.id];
      const bonusWritable = !!bonusResult && !bonusLocked;
      const baseWritable = !baseFrozen && !baseLocked;

      const updateObj = { updated_at: new Date().toISOString() };
      if (baseWritable)                       updateObj.base   = m.newBase;
      if (!baseFrozen && !metricLocked)       updateObj.metric = Math.round(m.metric * 1000) / 1000;
      if (!baseFrozen && !recordLocked)       updateObj.record = m.record;
      if (bonusWritable) { updateObj.bonus = bonusResult.tier; updateObj.bonus_note = bonusResult.label; }

      const skippedFields = [
        ...((baseFrozen || baseLocked)   ? ['base']   : []),
        ...((baseFrozen || metricLocked) ? ['metric'] : []),
        ...((baseFrozen || recordLocked) ? ['record'] : []),
        ...(bonusResult && bonusLocked   ? ['bonus']  : []),
      ];
      if (skippedFields.length > 0) {
        console.log(` ${ownerName}: skipped locked/frozen fields: ${skippedFields.join(', ')}`);
      }

      // Optimistic concurrency on whichever of base/bonus this cycle is
      // actually writing: condition the UPDATE on the pre-update value
      // this invocation read (m.base/m.bonus), and check whether it
      // actually matched a row. Without this, two near-simultaneous
      // invocations of this same cron — the scheduled Vercel cron and a
      // visitor's manual Refresh (api/refresh-all.js) hitting it around
      // the same moment, or Vercel itself retrying a cron trigger — both
      // read the same pre-update row, both independently compute the
      // same new value from the same ESPN response (harmless on its
      // own), and both unconditionally overwrote `picks` and pushed
      // their own score_events row for the same real change: the
      // Activity Feed showed the change twice and the member got two
      // push notifications for one score change. Whichever invocation's
      // UPDATE commits first changes base/bonus away from what this one
      // read, so the second invocation's conditional UPDATE matches zero
      // rows — it backs off instead of recording a duplicate.
      let updateQuery = supabase.from('picks').update(updateObj).eq('id', m.id);
      if (baseWritable) updateQuery = updateQuery.eq('base', m.base);
      if (bonusWritable) updateQuery = updateQuery.eq('bonus', m.bonus);
      const { data: updatedRows, error: updateErr } = await updateQuery.select('id');
      if (updateErr) { console.error(` Failed to update ${m.member_id}:`, updateErr.message); continue; }
      if (!updatedRows || updatedRows.length === 0) {
        console.log(` ${m.member_id}: base/bonus changed under us (a concurrent run already applied this) — skipping duplicate score event`);
        continue;
      }

      updated++;

      // Diff against the pre-update row (m.base, m.bonus) to log what
      // actually moved, now accounting for a bonus change same as base.
      const newBaseVal = baseWritable ? (Number(m.newBase) || 0) : (Number(m.base) || 0);
      const newBonusVal = bonusWritable ? bonusResult.tier : (Number(m.bonus) || 0);
      const oldTotal = (Number(m.base) || 0) + (Number(m.bonus) || 0);
      const newTotal = newBaseVal + newBonusVal;
      const delta = Math.round((newTotal - oldTotal) * 10) / 10;
      if (delta !== 0) {
        const causeParts = [];
        if (baseWritable) causeParts.push(m.espnTeam + (m.record ? ` (${m.record})` : ''));
        if (bonusWritable) causeParts.push(bonusResult.label);
        scoreEvents.push({
          season_year: seasonYear,
          member_id: m.member_id,
          category: league,
          delta,
          cause: causeParts.join(' — ') || m.espnTeam,
          source: 'update-sports',
        });
      }

      rankings.push({
        member: m.member_id,
        pick: m.pick,
        espnMatch: m.espnTeam,
        record: m.record,
        metric: m.metric,
        base: newBaseVal,
        bonus: newBonusVal,
        total: newBaseVal + newBonusVal,
        ...(bonusResult && { bonusDetected: bonusResult.label }),
        ...(skippedFields.length > 0 && { lockedFields: skippedFields }),
      });
    }

    console.log(` ${league}: Updated ${updated}/${matched.length} picks`);
    results[league] = {
      status: baseFrozen ? 'bonus_only' : 'updated', updated, total: picks.length,
      ...(unmatched.length > 0 && { unmatched }),
      rankings,
    };

    // ── Auto-lock (see AUTO_LOCK_RULES above) ──
    // `autoLockFired[league|field]` records that this league+field has
    // already auto-locked once THIS season, so a commissioner who
    // manually unlocks an entry afterward to fix a mistake doesn't get
    // immediately fought by the very next cron run re-locking it. Lives
    // in the separate auto_lock_fired column, not `locks` itself — see
    // the comment on that variable's declaration above. Once fired, it
    // only fires again next season (a fresh seasons row).
    const rule = AUTO_LOCK_RULES[league];
    if (rule) {
      const fieldsToLock = new Set();
      if (hasPostseason) {
        for (const f of (rule.onRegularSeasonEnd || [])) fieldsToLock.add(f);
      }
      if (hasPostseason && PLAYOFF_ROUNDS[league]) {
        const champDecided = await isChampionshipDecided(config.sport, config.league, PLAYOFF_ROUNDS[league]);
        if (champDecided) for (const f of (rule.onFinal || [])) fieldsToLock.add(f);
      }
      const newlyFired = [];
      for (const field of fieldsToLock) {
        const marker = `${league}|${field}`;
        if (autoLockFired[marker] || autoLockFiredWrites[marker]) continue; // already fired this season
        autoLockFiredWrites[marker] = true;
        for (const m of ranked) {
          const ownerName = memberNameById[m.member_id] || m.member_id;
          autoLockWrites[`${league}|${ownerName}|${field}`] = { at: new Date().toISOString(), by: 'auto' };
        }
        newlyFired.push(field);
      }
      if (newlyFired.length > 0) console.log(` ${league}: Auto-locked ${newlyFired.join(', ')} for ${ranked.length} picks`);
    }
  }

  if (Object.keys(autoLockWrites).length > 0 || Object.keys(autoLockFiredWrites).length > 0) {
    const { error: lockErr } = await supabase
      .from('seasons')
      .update({
        locks: { ...locks, ...autoLockWrites },
        auto_lock_fired: { ...autoLockFired, ...autoLockFiredWrites },
      })
      .eq('id', season.id);
    if (lockErr) console.error('Failed to write auto-locks:', lockErr.message);
    else console.log(`Wrote ${Object.keys(autoLockWrites).length} auto-lock entries (${Object.keys(autoLockFiredWrites).length} newly fired)`);
  }

  // Logs/sends are internal to this helper and never throw — see its own
  // comment (api/_lib/push.js) for why: score_events/push are additive on
  // top of the real score writes already committed above, never allowed
  // to fail this cron's own response. Shared with every other cron that
  // writes score_events, so this orchestration lives in one place.
  await writeScoreEventsAndNotify(supabase, scoreEvents, memberNameById);

  console.log('\nDone!');
  return res.status(200).json({
    message: 'Sports standings update complete',
    season: seasonYear,
    timestamp: new Date().toISOString(),
    results,
  });
};

// Attached to the handler export (not re-exported as the module's default)
// so api/draft-lookup.js can require() this file's own live ESPN fetch —
// NOT its matchTeam() — to power MLS's draft-time "did you mean" lookup,
// without a second, separately-maintained copy of the standings-fetch URL
// and parsing that could silently drift from this one (the same drift
// problem Country's old duplicated COUNTRY_ISO3 had — see
// src/constants/countries.js's own comment). matchTeam() itself stays
// untouched and un-exported: it's single-best-match-oriented, built for
// resolving an already-fully-typed pick during scoring, not for listing
// several live candidates as someone types — draft-lookup.js does its own
// lightweight substring filter over this same fetched list instead.
module.exports.fetchESPNStandings = fetchESPNStandings;
module.exports.ESPN_LEAGUES = ESPN_LEAGUES;
