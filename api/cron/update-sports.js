/**
 * Fantasy Life — Daily Sports Standings Updater
 *
 * Updates base points for NFL, NBA, NHL, MLB, MLS from ESPN standings.
 * Bonus points are NEVER touched (locked from previous season playoffs).
 * Respects commissioner locks from the seasons.locks column.
 *
 * ACTIVE WINDOW APPROACH:
 * Uses date-range windows (MM-DD strings) instead of month arrays.
 * This prevents edge cases like MLB missing March, MLS missing early spring,
 * or NFL missing late-January games just because a new month started.
 *
 * Current windows:
 *   MLB  → Mar 20 – Oct 05  (covers early Opening Day + full postseason)
 *   NFL  → Sep 01 – Feb 15  (wraps across Jan 1)
 *   NBA  → Oct 20 – Jun 30  (wraps across Jan 1) — 2026-27 season for base scoring
 *   NHL  → Oct 01 – Jun 30  (wraps across Jan 1) — 2026-27 season for base scoring
 *   MLS  → Mar 20 – Dec 10  (new season opener + full playoff run)
 *
 * NOTE — NBA/NHL base scoring:
 *   Base scoring uses the NEXT season (2026-27), not the current 2025-26 season.
 *   The 2025-26 playoffs are bonus points only. The window above reflects this:
 *   Mar–Sep is excluded so the current season doesn't overwrite base scores.
 *   Resumes Oct 2026 when the 2026-27 seasons tip/drop off.
 *
 * FIXES carried over from previous version:
 * FIX 1 — Strip abbreviation prefix before matching
 *      All 2026 picks are stored as e.g. "LAL Lakers", "BOS Celtics",
 *      "TB Lightning", "KC Chiefs" etc. Strip leading 2-4 char uppercase
 *      prefix before matching against ESPN team names.
 *
 * FIX 2 — Added NYCFC and SD FC to NAME_ALIASES
 *      These two MLS picks fail contains/exact/abbr checks without aliases.
 *
 * FIX 3 — Tie averaging for base points
 *      If two picks tie in metric, average the tied positions
 *      (e.g. 3-way tie for 2nd–4th = (11+10+9)/3 = 10.0 each).
 *
 * FIX 4 — NBA/NHL activeMonths updated for 2026 Fantasy Year
 *      Base scoring uses the 2026-27 season. Window excludes Mar–Sep.
 *
 * FIX 5 — MLS ESPN stat lookup checks lowercase 'pts' abbreviation
 *      ESPN soccer API returns abbreviation as 'pts' (lowercase).
 *
 * FIX 6 — MLS record shows "W-D-L · X pts" instead of just "X pts"
 *
 * FIX 7 — Added missing MLS team name aliases for 2026 picks
 */
 
const { createClient } = require('@supabase/supabase-js');
 
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
 
// ── Date-range window helper ──────────────────────────────────────────────────
// startMMDD and endMMDD are "MM-DD" strings, e.g. "03-20", "10-05"
// Handles windows that wrap across Jan 1 (e.g. NFL Sep–Feb, NBA/NHL Oct–Jun)
function isInWindow(startMMDD, endMMDD) {
  const now = new Date();
  const mmdd = now.toISOString().slice(5, 10); // "MM-DD"
  if (startMMDD <= endMMDD) {
    // Normal window: e.g. "03-20" to "10-05"
    return mmdd >= startMMDD && mmdd <= endMMDD;
  } else {
    // Wraps across Jan 1: e.g. "09-01" to "02-15"
    return mmdd >= startMMDD || mmdd <= endMMDD;
  }
}
 
// ── League config ─────────────────────────────────────────────────────────────
const ESPN_LEAGUES = {
  NFL: {
    url: 'https://site.api.espn.com/apis/v2/sports/football/nfl/standings',
    metricType: 'winpct',
    // Sep 1 – Feb 15 (wraps across Jan 1)
    windowStart: '09-01',
    windowEnd:   '02-15',
  },
  NBA: {
    url: 'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings',
    metricType: 'winpct',
    // Base scoring uses 2026-27 season. Oct 20 – Jun 30 (wraps across Jan 1).
    // Mar–Sep excluded: 2025-26 season is bonus points only + offseason gap.
    windowStart: '10-20',
    windowEnd:   '06-30',
  },
  NHL: {
    url: 'https://site.api.espn.com/apis/v2/sports/hockey/nhl/standings',
    metricType: 'points',
    // Base scoring uses 2026-27 season. Oct 1 – Jun 30 (wraps across Jan 1).
    // Mar–Sep excluded: 2025-26 season is bonus points only + offseason gap.
    windowStart: '10-01',
    windowEnd:   '06-30',
  },
  MLB: {
    url: 'https://site.api.espn.com/apis/v2/sports/baseball/mlb/standings',
    metricType: 'winpct',
    // Mar 20 – Oct 5: covers earliest-ever Opening Day (Mar 25/26 in 2026)
    // through end of regular season + wild card. Postseason bonus handled separately.
    windowStart: '03-20',
    windowEnd:   '10-05',
  },
  MLS: {
    url: 'https://site.api.espn.com/apis/v2/sports/soccer/usa.1/standings',
    metricType: 'points',
    // Mar 20 – Dec 10: aligns with MLB start so early-season MLS games aren't missed.
    // Ends mid-December after MLS Cup playoff run typically wraps up.
    windowStart: '03-20',
    windowEnd:   '12-10',
  },
};
 
// ── Team name aliases ─────────────────────────────────────────────────────────
const NAME_ALIASES = {
  // NBA
  'T-Wolves': 'Timberwolves',
  'Wolves':   'Timberwolves',
  // MLS — FIX 2: NYCFC and SD FC fail contains matching without aliases
  'NYCFC':  'New York City',
  'SD FC':  'San Diego',
  // MLS — FIX 7: 2026 draft pick names that don't match ESPN directly
  'Seattle Sounders': 'Sounders FC',
  'Cincinnati':       'FC Cincinnati',
  'NY Red Bulls':     'New York Red Bulls',
  'St. Louis City':   'St. Louis City SC',
  'Chicago Fire':     'Chicago Fire FC',
  'Orlando City':     'Orlando City SC',
  // MLS — other aliases
  'Red Bull':         'Red Bulls',
  'Atlanta':          'Atlanta United',
  'Columbus Crew':    'Columbus',
  'Vancouver':        'Vancouver Whitecaps',
  'Philadelphia Union': 'Philadelphia',
};
 
// ── Lock helper ───────────────────────────────────────────────────────────────
function isFieldLocked(locks, category, ownerName, field) {
  if (!locks) return false;
  return !!locks[`${category}|${ownerName}|${field}`];
}
 
// ── FIX 1: Strip leading abbreviation prefix from pick names ──────────────────
// Picks stored as e.g. "LAL Lakers", "BOS Celtics", "TB Lightning", "KC Chiefs".
// ESPN returns names without the prefix, so strip it before matching.
function stripPickPrefix(pickName) {
  return pickName.trim().replace(/^[A-Z]{2,4}\s+/, '');
}
 
// ── Team matching ─────────────────────────────────────────────────────────────
function matchTeam(pickName, espnTeams) {
  const pick     = pickName.trim();
  const stripped = stripPickPrefix(pick);
 
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
 
// ── ESPN standings fetcher ────────────────────────────────────────────────────
async function fetchESPNStandings(league, config) {
  try {
    const res = await fetch(config.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) {
      console.log(` ${league}: ESPN returned ${res.status}`);
      return null;
    }
    const data  = await res.json();
    const teams = [];
 
    const children = data?.children || [];
    if (children.length === 0) {
      const entries = data?.standings?.entries || [];
      if (entries.length === 0) {
        console.log(` ${league}: No standings data`);
        return null;
      }
      for (const entry of entries) {
        const t = parseEntry(entry, config);
        if (t) teams.push(t);
      }
    } else {
      for (const group of children) {
        for (const entry of (group?.standings?.entries || [])) {
          const t = parseEntry(entry, config);
          if (t) teams.push(t);
        }
        for (const sub of (group?.children || [])) {
          for (const entry of (sub?.standings?.entries || [])) {
            const t = parseEntry(entry, config);
            if (t) teams.push(t);
          }
        }
      }
    }
 
    if (teams.length === 0) {
      console.log(` ${league}: Parsed 0 teams`);
      return null;
    }
    console.log(` ${league}: Found ${teams.length} teams`);
    return teams;
  } catch (err) {
    console.error(` ${league}: Fetch error — ${err.message}`);
    return null;
  }
}
 
// ── ESPN entry parser ─────────────────────────────────────────────────────────
function parseEntry(entry, config) {
  try {
    const team = entry?.team;
    if (!team) return null;
    const stats = entry?.stats || [];
    let metric = 0, record = '';
 
    if (config.metricType === 'winpct') {
      const wp = stats.find(s => s.name === 'winPercent' || s.abbreviation === 'PCT');
      metric = wp ? parseFloat(wp.value ?? wp.displayValue) : 0;
      const ov = stats.find(s => s.name === 'overall' || s.type === 'total');
      record = ov?.displayValue || '';
      if (!record) {
        const w = stats.find(s => s.name === 'wins')?.value   || 0;
        const l = stats.find(s => s.name === 'losses')?.value || 0;
        record = `${w}-${l}`;
      }
    } else if (config.metricType === 'points') {
      // FIX 5: ESPN soccer API returns 'pts' in lowercase
      const pt = stats.find(s =>
        s.name === 'points' ||
        (s.abbreviation && s.abbreviation.toLowerCase() === 'pts')
      );
      metric = pt ? parseFloat(pt.value ?? pt.displayValue) : 0;
 
      // FIX 6: "W-D-L · X pts" for soccer; "X pts" for hockey
      if (config.url.includes('soccer')) {
        const w = stats.find(s => s.name === 'wins'   || s.abbreviation === 'W')?.value ?? '';
        const d = stats.find(s =>
          s.name === 'ties' || s.name === 'draws' ||
          s.abbreviation === 'D' || s.abbreviation === 'T'
        )?.value ?? '';
        const l = stats.find(s => s.name === 'losses' || s.abbreviation === 'L')?.value ?? '';
        record = (w !== '' && d !== '' && l !== '')
          ? `${w}-${d}-${l} · ${Math.round(metric)} pts`
          : `${Math.round(metric)} pts`;
      } else {
        record = `${Math.round(metric)} pts`;
      }
    }
 
    return {
      teamName:     team.name        || '',
      displayName:  team.displayName || '',
      abbreviation: team.abbreviation || '',
      location:     team.location    || '',
      record,
      metric,
    };
  } catch {
    return null;
  }
}
 
// ── FIX 3: Tie-aware base point assignment ────────────────────────────────────
// Players tied at the same metric share the average of their tied positions.
// e.g. 3-way tie for positions 2–4 out of 12 = (11+10+9)/3 = 10.0 each
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
 
// ── Main handler ──────────────────────────────────────────────────────────────
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
    .from('seasons')
    .select('year, locks')
    .eq('status', 'active')
    .single();
  if (!season) return res.status(200).json({ message: 'No active season found, skipping' });
 
  const seasonYear = season.year;
  const locks      = season.locks || {};
 
  const { data: members } = await supabase.from('members').select('id, name');
  const memberNameById = {};
  (members || []).forEach(m => { memberNameById[m.id] = m.name; });
 
  const results     = {};
  const todayMMDD   = new Date().toISOString().slice(5, 10); // "MM-DD"
 
  for (const [league, config] of Object.entries(ESPN_LEAGUES)) {
    console.log(`Processing ${league}...`);
 
    // Check date-range window
    const active = isInWindow(config.windowStart, config.windowEnd);
    if (!active) {
      console.log(` ${league}: Outside window (${config.windowStart} – ${config.windowEnd}), today is ${todayMMDD} — scores frozen`);
      results[league] = {
        status: 'frozen',
        reason: `Outside season window (${config.windowStart} – ${config.windowEnd})`,
      };
      continue;
    }
 
    console.log(` ${league}: In window (${config.windowStart} – ${config.windowEnd}), today is ${todayMMDD} — updating`);
 
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
    if (!espnTeams) {
      results[league] = { status: 'skipped', reason: 'no ESPN data' };
      continue;
    }
 
    const matched   = [];
    const unmatched = [];
    for (const pick of picks) {
      const espnTeam = matchTeam(pick.pick, espnTeams);
      if (espnTeam) {
        matched.push({
          ...pick,
          espnTeam: espnTeam.displayName,
          record:   espnTeam.record,
          metric:   espnTeam.metric,
        });
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
 
    let updated  = 0;
    const rankings = [];
 
    for (const m of ranked) {
      const ownerName    = memberNameById[m.member_id] || m.member_id;
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
 
      const { error: updateErr } = await supabase
        .from('picks')
        .update(updateObj)
        .eq('id', m.id);
 
      if (updateErr) {
        console.error(` Failed to update ${m.member_id}:`, updateErr.message);
        continue;
      }
 
      updated++;
      rankings.push({
        member:    m.member_id,
        pick:      m.pick,
        espnMatch: m.espnTeam,
        record:    m.record,
        metric:    m.metric,
        base:      baseLocked ? m.base : m.newBase,
        bonus:     Number(m.bonus) || 0,
        total:     (baseLocked ? m.base : m.newBase) + (Number(m.bonus) || 0),
        ...(skippedFields.length > 0 && { lockedFields: skippedFields }),
      });
    }
 
    console.log(` ${league}: Updated ${updated}/${matched.length} picks`);
    results[league] = {
      status:  'updated',
      updated,
      total:   picks.length,
      window:  `${config.windowStart} – ${config.windowEnd}`,
      ...(unmatched.length > 0 && { unmatched }),
      rankings,
    };
  }
 
  console.log('\nDone!');
  return res.status(200).json({
    message:   'Sports standings update complete',
    season:    seasonYear,
    timestamp: new Date().toISOString(),
    today:     todayMMDD,
    results,
  });
};
