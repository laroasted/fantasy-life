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
 */
 
const { createClient } = require('@supabase/supabase-js');
 
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
 
const ESPN_LEAGUES = {
  NFL: {
    url: 'https://site.api.espn.com/apis/v2/sports/football/nfl/standings',
    metricType: 'winpct',
    activeMonths: [9, 10, 11, 12, 1],
  },
  NBA: {
    url: 'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings',
    metricType: 'winpct',
    // Base scoring uses the 2026-27 season (starts Oct 2026).
    // Mar–Sep excluded: 2025-26 season is bonus points only + offseason gap.
    activeMonths: [10, 11, 12, 1, 2],
  },
  NHL: {
    url: 'https://site.api.espn.com/apis/v2/sports/hockey/nhl/standings',
    metricType: 'points',
    // Base scoring uses the 2026-27 season (starts Oct 2026).
    // Mar–Sep excluded: 2025-26 season is bonus points only + offseason gap.
    activeMonths: [10, 11, 12, 1, 2],
  },
  MLB: {
    url: 'https://site.api.espn.com/apis/v2/sports/baseball/mlb/standings',
    metricType: 'winpct',
    activeMonths: [4, 5, 6, 7, 8, 9],
  },
  MLS: {
    url: 'https://site.api.espn.com/apis/v2/sports/soccer/usa.1/standings',
    metricType: 'points',
    // Apr–Oct only: keeps Feb/Mar (new season start) frozen so end-of-year
    // scores aren't overwritten before the commissioner locks them.
    activeMonths: [4, 5, 6, 7, 8, 9, 10],
  },
};
 
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
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });
  }
 
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log('Fantasy Life — Updating Sports Standings...\n');
 
  const { data: season } = await supabase
    .from('seasons').select('year, locks').eq('status', 'active').single();
  if (!season) return res.status(200).json({ message: 'No active season found, skipping' });
 
  const seasonYear = season.year;
  const locks = season.locks || {};
 
  const { data: members } = await supabase.from('members').select('id, name');
  const memberNameById = {};
  (members || []).forEach(m => { memberNameById[m.id] = m.name; });
 
  const results = {};
  const currentMonth = new Date().getMonth() + 1;
 
  for (const [league, config] of Object.entries(ESPN_LEAGUES)) {
    console.log(`Processing ${league}...`);
 
    if (config.activeMonths && !config.activeMonths.includes(currentMonth)) {
      console.log(` ${league}: Offseason — scores frozen`);
      results[league] = { status: 'frozen', reason: 'Offseason' };
      continue;
    }
 
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
        matched.push({ ...pick, espnTeam: espnTeam.displayName, record: espnTeam.record, metric: espnTeam.metric });
      } else {
        unmatched.push(pick.pick);
        console.warn(` Could not match "${pick.pick}"`);
      }
    }
 
    if (matched.length === 0) {
      results[league] = { status: 'skipped', reason: 'no matches', unmatched };
      continue;
    }
 
    // FIX 3: tie-aware base point assignment
    const ranked = assignBasePointsWithTies(matched, picks.length);
 
    let updated = 0;
    const rankings = [];
 
    for (const m of ranked) {
      const ownerName = memberNameById[m.member_id] || m.member_id;
      const baseLocked   = isFieldLocked(locks, league, ownerName, 'base');
      const metricLocked = isFieldLocked(locks, league, ownerName, 'metric');
      const recordLocked = isFieldLocked(locks, league, ownerName, 'record');
 
      const updateObj = { updated_at: new Date().toISOString() };
      if (!baseLocked)   updateObj.base   = m.newBase;
      if (!metricLocked) updateObj.metric = Math.round(m.metric * 1000) / 1000;
      if (!recordLocked) updateObj.record = m.record;
 
      const skippedFields = [
        ...(baseLocked   ? ['base']   : []),
        ...(metricLocked ? ['metric'] : []),
        ...(recordLocked ? ['record'] : []),
      ];
      if (skippedFields.length > 0) {
        console.log(` ${ownerName}: skipped locked fields: ${skippedFields.join(', ')}`);
      }
 
      const { error: updateErr } = await supabase.from('picks').update(updateObj).eq('id', m.id);
      if (updateErr) { console.error(` Failed to update ${m.member_id}:`, updateErr.message); continue; }
 
      updated++;
      rankings.push({
        member: m.member_id,
        pick: m.pick,
        espnMatch: m.espnTeam,
        record: m.record,
        metric: m.metric,
        base: baseLocked ? m.base : m.newBase,
        bonus: Number(m.bonus) || 0,
        total: (baseLocked ? m.base : m.newBase) + (Number(m.bonus) || 0),
        ...(skippedFields.length > 0 && { lockedFields: skippedFields }),
      });
    }
 
    console.log(` ${league}: Updated ${updated}/${matched.length} picks`);
    results[league] = {
      status: 'updated', updated, total: picks.length,
      ...(unmatched.length > 0 && { unmatched }),
      rankings,
    };
  }
 
  console.log('\nDone!');
  return res.status(200).json({
    message: 'Sports standings update complete',
    season: seasonYear,
    timestamp: new Date().toISOString(),
    results,
  });
};
