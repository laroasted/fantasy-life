/**
 * Fantasy Life — Tennis, Golf, F1 Rankings Updater
 * Respects commissioner locks from seasons.locks column.
 *
 * Tiebreaker: players with the same metric split/average the base points
 * they collectively occupy.
 * e.g. 2-way tie for ranks 1–2 out of 12 = (12+11)/2 = 11.5 each
 *
 * CHANGELOG (2026-05-19):
 *   - FIX: Added normalizeStr() to strip diacritics (Å→A, ø→o, etc.)
 *     before name matching. Fixes Ludvig Åberg ranking as 201.
 *   - matchAthlete now uses normalizeStr for all comparisons.
 *
 * CHANGELOG (2026-03-17):
 *   - F1: Added Jolpica API (Ergast successor) as PRIMARY data source
 *   - F1: ESPN kept as fallback (currently returning empty for 2026)
 *   - F1: Added season year parameter to Jolpica request
 *
 * CHANGELOG (2026-11) — Automated F1 featured-GP + Tennis/Golf major bonus
 *   Bonus for these three used to be commissioner-only manual entry
 *   (Settings → Scores & Bonus). Now resolved from the same data vendors
 *   already trusted for base scoring (Jolpica for F1, ESPN for Tennis/Golf).
 *   Deliberately NOT date-driven: F1's 4 bonus-eligible Grands Prix are
 *   matched by raceName (FEATURED_GPS), and Tennis/Golf majors are matched
 *   by tournament NAME (MAJOR_NAMES) against whatever ESPN returns for the
 *   current calendar year — none of the three needs a yearly date edit
 *   when a race/major's exact week moves. See docs/bonus-automation.md for
 *   the full design and per-feature confidence notes. F1 and Golf majors
 *   are high/high-moderate confidence (stable, well-documented endpoint
 *   shapes); Tennis majors is the lowest confidence of the three — it
 *   classifies Final/semifinal exits from free-text match labels rather
 *   than a flat leaderboard, and that text shape wasn't verified live.
 *   Like every bonus write in this file: never overwrites a locked
 *   `bonus` field, and never guesses — an unresolved pick's existing
 *   bonus (including a manual commissioner entry) is left untouched.
 *
 * CHANGELOG (2026-11-22) — Breakdown rows
 *   The bonus total/note were automated but the per-event breakdown under
 *   an expanded Scoreboard row (event_majors) was still hand-entered, so
 *   the 2026 Las Vegas GP bonus landed with no matching row. All three
 *   leagues now upsert one event_majors row per finished bonus event per
 *   pick (syncEventRows), including while a league is frozen (rows only,
 *   base/bonus untouched). Tennis rows are coarser than Golf/F1: the
 *   source only lists semifinalists, so everyone else reads "Before SF".
 */
 
const { createClient } = require('@supabase/supabase-js');
const { writeScoreEventsAndNotify } = require('../_lib/push');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
 
const EVENT_LEAGUES = {
  Tennis: { metricType: 'points', sortDirection: 'desc', activeStart: { month: 2, day: 1 }, freezeDate: { month: 1, day: 31 } },
  Golf:   { metricType: 'position', sortDirection: 'asc',  activeStart: { month: 1, day: 1 }, freezeDate: { month: 8, day: 31 } },
  F1:     { metricType: 'points', sortDirection: 'desc', activeStart: { month: 3, day: 1 }, freezeDate: { month: 12, day: 15 } },
};
 
const NAME_ALIASES = { 'Ludvig Åberg': 'Aberg', 'Ludvig Aberg': 'Aberg' };
 
/**
 * Strips diacritics / accent marks and lowercases.
 * e.g. "Ludvig Åberg" → "ludvig aberg"
 *      "Nicolai Højgaard" → "nicolai hojgaard"
 */
function normalizeStr(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
 
/**
 * Assigns base points with split/average tiebreaker logic.
 */
function assignBasePointsWithTiebreaker(matched, totalMembers) {
  var n = matched.length;
  var i = 0;
  while (i < n) {
    var j = i;
    while (j < n && matched[j].metric === matched[i].metric) j++;
    var pointSum = 0;
    for (var p = i; p < j; p++) pointSum += (totalMembers - p);
    var avgPoints = Math.round((pointSum / (j - i)) * 100) / 100;
    for (var p = i; p < j; p++) {
      matched[p].newBase = avgPoints;
      matched[p].rank = i + 1;
    }
    i = j;
  }
  return matched;
}
 
function isFieldLocked(locks, category, ownerName, field) { return locks ? !!locks[category + '|' + ownerName + '|' + field] : false; }

// ═══════════════════════════════════════════════════════════════════════
// F1 FEATURED-GP BONUS — matched by RACE NAME, never by calendar date.
// F1 moves its calendar by weeks every year; matching the 4 bonus-eligible
// Grands Prix by their stable raceName (not a hardcoded month/week) keeps
// this working without a yearly edit. High confidence: Jolpica's
// /races.json and /{round}/results.json shapes are long-documented,
// stable Ergast-compatible endpoints.
// ═══════════════════════════════════════════════════════════════════════
// `label` is the event_majors.event_name the Scoreboard breakdown shows;
// `rowMatch` recognizes an existing row for this GP however it was
// originally typed (the pre-automation rows were entered by hand, e.g.
// "US GP" or "US GP (Austin)"), so the cron updates that row in place
// instead of adding a duplicate next to it.
const FEATURED_GPS = [
  { tier: 'AUS', keywords: ['australian grand prix'], label: 'Australian GP', rowMatch: function (n) { return n.includes('australia'); } },
  { tier: 'MIA', keywords: ['miami grand prix'], label: 'Miami GP', rowMatch: function (n) { return n.includes('miami'); } },
  { tier: 'ATX', keywords: ['united states grand prix'], label: 'US GP', rowMatch: function (n) { return !n.includes('vegas') && (n.includes('us gp') || n.includes('united states') || n.includes('austin') || n.includes('cota')); } },
  { tier: 'LV', keywords: ['las vegas grand prix'], label: 'Las Vegas GP', rowMatch: function (n) { return n.includes('vegas'); } },
];
const PODIUM_LABEL = { 1: 'Winner', 2: '2nd', 3: '3rd' };
const FEATURED_GP_BONUS = { 1: 3, 2: 2, 3: 1 };
// ~2h race + time for Jolpica to publish the classification.
const RACE_RESULT_BUFFER_MS = 3 * 60 * 60 * 1000;

// Returns { podiums, races }: `podiums` feeds the bonus total exactly as
// before; `races` is every featured GP that has run, with its full
// classification, so the per-GP breakdown rows (event_majors) can be
// written for every pick — "Outside P3" included — not just podium
// finishers.
async function fetchFeaturedGPPodiums(seasonYear) {
  var podiums = [], races = [];
  try {
    var url = 'https://api.jolpi.ca/ergast/f1/' + seasonYear + '/races.json?limit=40';
    var res = await fetch(url, { headers: { 'User-Agent': 'FantasyLifeHub/1.0' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { podiums: podiums, races: races };
    var data = await res.json();
    var schedule = data?.MRData?.RaceTable?.Races || [];
    var now = Date.now();
    for (var race of schedule) {
      var raceName = (race.raceName || '').toLowerCase();
      var gp = FEATURED_GPS.find(function (g) { return g.keywords.some(function (k) { return raceName.includes(k); }); });
      if (!gp) continue;
      // Jolpica's `date` is the race's UTC calendar date and `time` its
      // UTC lights-out. Comparing the bare date (UTC midnight) treated a
      // night race as "already run" hours before it started — the Las
      // Vegas GP (Sat 8pm PT = 04:00Z Sunday) was checked mid-race and
      // came back with no results. Require lights-out + a buffer instead,
      // so "has happened" means "should have a classified result".
      var startMs = race.date ? Date.parse(race.date + 'T' + (race.time || '00:00:00Z')) : NaN;
      var hasHappened = !isNaN(startMs) && startMs + RACE_RESULT_BUFFER_MS <= now;
      if (!hasHappened) continue;
      try {
        var resultsUrl = 'https://api.jolpi.ca/ergast/f1/' + seasonYear + '/' + race.round + '/results.json';
        var rres = await fetch(resultsUrl, { headers: { 'User-Agent': 'FantasyLifeHub/1.0' }, signal: AbortSignal.timeout(10000) });
        if (!rres.ok) continue;
        var rdata = await rres.json();
        var raceResults = rdata?.MRData?.RaceTable?.Races?.[0]?.Results || [];
        if (raceResults.length === 0) console.log('  F1: ' + race.raceName + ' has no published results yet — bonus will resolve on a later run');
        if (raceResults.length > 0) {
          races.push({
            gp: gp,
            raceName: race.raceName,
            finishers: raceResults.map(function (r) {
              var d = r.Driver || {};
              return { name: ((d.givenName || '') + ' ' + (d.familyName || '')).trim(), position: parseInt(r.position, 10), positionText: r.positionText || '' };
            }).filter(function (f) { return f.name; }),
          });
        }
        for (var r of raceResults) {
          var pos = parseInt(r.position, 10);
          if (!FEATURED_GP_BONUS[pos]) continue;
          var driver = r.Driver || {};
          var fullName = ((driver.givenName || '') + ' ' + (driver.familyName || '')).trim();
          if (!fullName) continue;
          podiums.push({ gpTier: gp.tier, raceName: race.raceName, driverName: fullName, position: pos, bonus: FEATURED_GP_BONUS[pos] });
        }
      } catch (err) { console.error('  F1 featured GP results fetch failed for ' + race.raceName + ':', err.message); }
    }
  } catch (err) { console.error('  F1 featured GP schedule fetch failed:', err.message); }
  return { podiums: podiums, races: races };
}

// Jolpica positionText: a number when classified, otherwise R (retired),
// D (disqualified), W (withdrawn / did not start), N/E/F (not classified,
// excluded, failed to qualify).
function finishText(f) {
  if (!f) return 'Did not race';
  if (/^\d+$/.test(f.positionText)) return 'P' + f.positionText;
  return { R: 'DNF', D: 'DSQ', W: 'DNS', N: 'NC', E: 'EX', F: 'DNQ' }[f.positionText] || f.positionText || '—';
}

// Writes the per-event breakdown shown under an expanded Scoreboard row
// (event_majors) for Tennis, Golf and F1. Before this, only
// picks.bonus/bonus_note were automated, so a bonus total could move while
// the breakdown table (hand-entered rows) never gained the new event.
//
// `events`: [{ label, rowMatch(lowerName) → bool, rowFor(pickName) →
// { result, score, pts } }], one per bonus event that has finished. Every
// pick gets a row per event ("Outside P3" / "Before SF" included), so the
// table reads the same for everyone and its total matches the bonus.
//
// Guardrails, same as the bonus write: skips a pick whose bonus is locked
// (the commissioner owns that pick's bonus, breakdown included) and any
// single row locked in Settings (`<League>|<owner>|row<idx>`, idx =
// position in event_order order, the index Scoreboard.jsx's rowLockIcon
// and SeasonSettings.jsx use). Existing rows are matched by name and
// updated in place, never duplicated; unchanged rows aren't rewritten.
async function syncEventRows(supabase, league, picks, events, locks, memberNameById) {
  // Display-only: a failure here is logged and must never stop the
  // base/bonus scoring that runs after it.
  try { await syncEventRowsInner(supabase, league, picks, events, locks, memberNameById); }
  catch (err) { console.error('  ' + league + ': breakdown row sync failed:', err.message); }
}

async function syncEventRowsInner(supabase, league, picks, events, locks, memberNameById) {
  if (!events.length || !picks.length) return;
  var pickIds = picks.map(function (p) { return p.id; });
  var { data: existing, error: exErr } = await supabase.from('event_majors')
    .select('id, pick_id, event_name, event_order, result, score, pts').in('pick_id', pickIds);
  if (exErr) { console.error('  ' + league + ': event_majors read failed, skipping breakdown sync:', exErr.message); return; }
  var byPick = {};
  (existing || []).forEach(function (row) { (byPick[row.pick_id] = byPick[row.pick_id] || []).push(row); });

  var inserted = 0, changed = 0;
  for (var pick of picks) {
    var ownerName = memberNameById[pick.member_id] || pick.member_id;
    if (isFieldLocked(locks, league, ownerName, 'bonus')) continue;
    var rows = (byPick[pick.id] || []).slice().sort(function (a, b) { return (Number(a.event_order) || 0) - (Number(b.event_order) || 0); });
    var maxOrder = rows.reduce(function (m, r) { return Math.max(m, Number(r.event_order) || 0); }, 0);

    for (var ev of events) {
      var want = ev.rowFor(pick.pick);
      var idx = rows.findIndex(function (r) { return ev.rowMatch((r.event_name || '').toLowerCase()); });
      if (idx >= 0) {
        var row = rows[idx];
        if (locks[league + '|' + ownerName + '|row' + idx]) continue;
        if (row.result === want.result && row.score === want.score && Number(row.pts) === want.pts) continue;
        var { error: upErr } = await supabase.from('event_majors').update(want).eq('id', row.id);
        if (upErr) console.error('  ' + league + ': event_majors update failed for ' + ownerName + ' / ' + ev.label + ':', upErr.message);
        else changed++;
      } else {
        maxOrder += 1;
        var { error: insErr } = await supabase.from('event_majors').insert(Object.assign({ pick_id: pick.id, event_name: ev.label, event_order: maxOrder, note: '' }, want));
        if (insErr) console.error('  ' + league + ': event_majors insert failed for ' + ownerName + ' / ' + ev.label + ':', insErr.message);
        else inserted++;
      }
    }
  }
  console.log('  ' + league + ': breakdown rows — ' + inserted + ' added, ' + changed + ' updated');
}

function f1BreakdownEvents(races) {
  return races.map(function (race) {
    return {
      label: race.gp.label,
      rowMatch: race.gp.rowMatch,
      rowFor: function (pickName) {
        var f = matchAthlete(pickName, race.finishers);
        var pos = f && /^\d+$/.test(f.positionText) ? f.position : null;
        return {
          result: pos && PODIUM_LABEL[pos] ? PODIUM_LABEL[pos] : 'Outside P3',
          score: finishText(f),
          pts: pos && FEATURED_GP_BONUS[pos] ? FEATURED_GP_BONUS[pos] : 0,
        };
      },
    };
  });
}

// Sums podium bonus per driver across every featured GP already run this
// season (a driver can podium at more than one of the 4) and keyed by the
// driver's own full name so matchAthlete() can resolve it the same way it
// resolves base-scoring driver names.
function aggregateF1Bonus(podiums) {
  var byDriver = {};
  for (var p of podiums) {
    if (!byDriver[p.driverName]) byDriver[p.driverName] = { total: 0, notes: [] };
    byDriver[p.driverName].total += p.bonus;
    byDriver[p.driverName].notes.push(p.gpTier + ' P' + p.position + ' (+' + p.bonus + ')');
  }
  return byDriver;
}

// ═══════════════════════════════════════════════════════════════════════
// TENNIS / GOLF MAJOR BONUS — matched by TOURNAMENT NAME, never by
// calendar date. Majors drift by a week or two year to year; scanning the
// whole current calendar year for an event whose name contains one of
// these (rather than assuming e.g. "Wimbledon is always late June") keeps
// this working without a yearly edit.
// Golf: high-moderate confidence — flat per-tournament leaderboard.
// Tennis: lowest confidence of everything in this file — classifies
// Final/semifinal exits from free-text match-event labels rather than a
// single leaderboard call, and that exact label shape wasn't verified
// live from this build environment (network-policy blocked). Watch its
// first live run's logs (classification misses are logged, never guessed).
// ═══════════════════════════════════════════════════════════════════════
const MAJOR_NAMES = {
  Tennis: ['australian open', 'french open', 'roland garros', 'wimbledon', 'us open'],
  Golf: ['masters tournament', 'the masters', 'pga championship', 'u.s. open', 'us open', 'the open championship', 'british open'],
};
const TENNIS_MAJOR_BONUS = { win: 5, final: 3, semifinal: 2 };
const GOLF_MAJOR_BONUS = { win: 5, runnerup: 3, top10: 2 };

// Canonical display name + breakdown-row matcher per major. `rowMatch`
// recognizes an existing event_majors row however it was originally typed
// (rows were hand-entered before this automation), so the cron updates it
// in place rather than adding a duplicate. Ordered so the more specific
// name is checked first ("U.S. Open" before "The Open").
const GOLF_MAJORS = [
  { label: 'Masters', match: function (n) { return n.includes('masters'); } },
  { label: 'PGA Championship', match: function (n) { return n.includes('pga'); } },
  { label: 'U.S. Open', match: function (n) { return n.includes('u.s. open') || n.includes('us open'); } },
  { label: 'The Open Championship', match: function (n) { return n.includes('open championship') || n.includes('british open') || n.trim() === 'the open' || n.trim() === 'open'; } },
];
const TENNIS_MAJORS = [
  { label: 'Australian Open', match: function (n) { return n.includes('australian open') || n.includes('aus open'); } },
  { label: 'French Open', match: function (n) { return n.includes('french open') || n.includes('roland garros') || n.includes('roland-garros'); } },
  { label: 'Wimbledon', match: function (n) { return n.includes('wimbledon'); } },
  { label: 'US Open', match: function (n) { return n.includes('us open') || n.includes('u.s. open'); } },
];
function findMajor(list, lowerName) { return list.find(function (m) { return m.match(lowerName); }) || null; }

// Golf: returns { byAthlete, events }. byAthlete feeds the bonus exactly as
// before. events has one breakdown entry per completed major with the
// whole field, so every pick gets a row (Winner / Runner-up / Top 10 /
// Outside top 10 / Missed cut / Did not play).
async function fetchGolfMajorBonus() {
  var byGolfer = {}, events = [];
  try {
    var year = new Date().getFullYear();
    var url = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=' + year + '0101-' + year + '1231';
    var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { byAthlete: byGolfer, events: events };
    var data = await res.json();
    var allEvents = data?.events || [];
    var majors = allEvents.filter(function (e) {
      var name = (e.name || e.shortName || '').toLowerCase();
      var completed = !!e?.status?.type?.completed;
      return completed && MAJOR_NAMES.Golf.some(function (m) { return name.includes(m); });
    });
    for (var major of majors) {
      try {
        var lbUrl = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/leaderboard?tournamentId=' + major.id;
        var lres = await fetch(lbUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
        if (!lres.ok) continue;
        var ldata = await lres.json();
        var competitors = ldata?.events?.[0]?.competitions?.[0]?.competitors || [];
        var field = [];
        for (var c of competitors) {
          var name = c?.athlete?.displayName || c?.athlete?.name;
          var posRaw = String(c?.status?.position?.displayValue ?? c?.status?.position?.id ?? '');
          var posMatch = posRaw.match(/\d+/);
          var pos = posMatch ? parseInt(posMatch[0], 10) : null;
          if (name) field.push({ name: name, position: pos, positionText: posRaw });
          if (!pos || !name) continue;
          var tier = 0, label = '';
          if (pos === 1) { tier = GOLF_MAJOR_BONUS.win; label = 'Won ' + major.name; }
          else if (pos === 2) { tier = GOLF_MAJOR_BONUS.runnerup; label = 'Runner-up ' + major.name; }
          else if (pos <= 10) { tier = GOLF_MAJOR_BONUS.top10; label = 'Top 10 ' + major.name; }
          if (tier === 0) continue;
          if (!byGolfer[name]) byGolfer[name] = { total: 0, notes: [] };
          byGolfer[name].total += tier;
          byGolfer[name].notes.push(label);
        }
        var def = findMajor(GOLF_MAJORS, (major.name || '').toLowerCase());
        if (def && field.length > 0) events.push(golfBreakdownEvent(def, field));
        else if (!def) console.log('  Golf: completed major "' + major.name + '" has no breakdown-row mapping, skipping its row');
      } catch (err) { console.error('  Golf major leaderboard fetch failed for ' + major.name + ':', err.message); }
    }
  } catch (err) { console.error('  Golf major scoreboard fetch failed:', err.message); }
  return { byAthlete: byGolfer, events: events };
}

function golfBreakdownEvent(def, field) {
  return {
    label: def.label,
    rowMatch: def.match,
    rowFor: function (pickName) {
      var g = matchAthlete(pickName, field);
      if (!g) return { result: 'Did not play', score: '—', pts: 0 };
      var pos = g.position, text = g.positionText || '—';
      if (pos === 1) return { result: 'Winner', score: text, pts: GOLF_MAJOR_BONUS.win };
      if (pos === 2) return { result: 'Runner-up', score: text, pts: GOLF_MAJOR_BONUS.runnerup };
      if (pos && pos <= 10) return { result: 'Top 10', score: text, pts: GOLF_MAJOR_BONUS.top10 };
      if (pos) return { result: 'Outside top 10', score: text, pts: 0 };
      if (/wd/i.test(text)) return { result: 'Withdrew', score: text, pts: 0 };
      if (/dq/i.test(text)) return { result: 'DQ', score: text, pts: 0 };
      return { result: 'Missed cut', score: text || 'CUT', pts: 0 };
    },
  };
}

// Tennis: returns { byAthlete, events }. Unlike Golf, this source only
// shows who reached the semifinals and final of each major, not the whole
// draw. So a pick who isn't among the last four gets "Before SF" with no
// finer detail: it can't tell an early loss from not entering. A
// breakdown row is only written for a major once its final has been seen
// (i.e. the major is over), so a mid-tournament run never labels anyone.
async function fetchTennisMajorBonus() {
  var byPlayer = {}, finalists = {};
  try {
    var year = new Date().getFullYear();
    var url = 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard?dates=' + year + '0101-' + year + '1231';
    var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { byAthlete: byPlayer, events: [] };
    var data = await res.json();
    var allEvents = data?.events || [];
    for (var e of allEvents) {
      if (!e?.status?.type?.completed) continue;
      var textParts = [e?.name, e?.shortName].concat((e?.competitions?.[0]?.notes || []).map(function (n) { return n?.headline; })).filter(Boolean);
      var lower = textParts.join(' | ').toLowerCase();
      var majorName = MAJOR_NAMES.Tennis.find(function (m) { return lower.includes(m); });
      if (!majorName) continue;
      // 'final' is a substring of 'quarterfinal' (and would be of
      // 'semifinal' too, hence that exclusion already being here) — a
      // quarterfinal exit has no Tennis bonus tier, so it must fall
      // through to the `continue` below, not get misread as a Final.
      var isQuarterfinal = lower.includes('quarterfinal') || lower.includes('quarter-final');
      var isSemi = lower.includes('semifinal') || lower.includes('semi-final');
      var isFinal = lower.includes('final') && !isSemi && !isQuarterfinal;
      if (!isFinal && !isSemi) continue;

      var def = findMajor(TENNIS_MAJORS, majorName);
      var bucket = def ? (finalists[def.label] = finalists[def.label] || { def: def, finalSeen: false, players: [] }) : null;
      if (bucket && isFinal) bucket.finalSeen = true;

      var competitors = e?.competitions?.[0]?.competitors || [];
      for (var c of competitors) {
        var name = c?.athlete?.displayName || c?.athlete?.name;
        if (!name) continue;
        var won = !!c?.winner;
        var tier = 0, label = '', rowResult = '';
        if (isFinal && won) { tier = TENNIS_MAJOR_BONUS.win; label = 'Won ' + majorName; rowResult = 'Winner'; }
        else if (isFinal && !won) { tier = TENNIS_MAJOR_BONUS.final; label = 'Runner-up ' + majorName; rowResult = 'Runner-up'; }
        else if (isSemi && !won) { tier = TENNIS_MAJOR_BONUS.semifinal; label = 'Lost ' + majorName + ' SF'; rowResult = 'Semifinal'; }
        if (tier === 0) continue;
        if (!byPlayer[name]) byPlayer[name] = { total: 0, notes: [] };
        byPlayer[name].total += tier;
        byPlayer[name].notes.push(label);
        if (bucket) bucket.players.push({ name: name, result: rowResult, pts: tier });
      }
    }
  } catch (err) { console.error('  Tennis major fetch failed:', err.message); }
  var events = Object.keys(finalists).map(function (k) { return finalists[k]; })
    .filter(function (b) { return b.finalSeen; })
    .map(tennisBreakdownEvent);
  return { byAthlete: byPlayer, events: events };
}

function tennisBreakdownEvent(bucket) {
  return {
    label: bucket.def.label,
    rowMatch: bucket.def.match,
    rowFor: function (pickName) {
      var p = matchAthlete(pickName, bucket.players);
      if (!p) return { result: 'Before SF', score: '—', pts: 0 };
      return { result: p.result, score: '—', pts: p.pts };
    },
  };
}

function isActive(config) {
  var now = new Date(), month = now.getMonth() + 1, day = now.getDate(), today = month * 100 + day;
  var start = config.activeStart.month * 100 + config.activeStart.day, freeze = config.freezeDate.month * 100 + config.freezeDate.day;
  return start <= freeze ? (today >= start && today <= freeze) : (today >= start || today <= freeze);
}
 
async function fetchTennisRankings() {
  try {
    var res = await fetch('https://site.api.espn.com/apis/site/v2/sports/tennis/atp/rankings', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    var data = await res.json();
    var rankings = data?.rankings || [];
    var sr = rankings.find(function(r) { return (r.name || '').toLowerCase().includes('singles') || (r.name || '').toLowerCase().includes('atp') || rankings.length === 1; }) || rankings[0];
    if (!sr?.ranks) return null;
    return sr.ranks.map(function(e) { return { name: e.athlete?.displayName || e.athlete?.name || '', shortName: e.athlete?.shortName || '', points: e.points || e.stat || 0, rank: e.current || e.rank || 0 }; });
  } catch (err) { console.error(' Tennis fetch error:', err.message); return null; }
}
 
async function fetchGolfRankings() {
  try {
    var res = await fetch('https://www.espn.com/golf/rankings', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    var html = await res.text();
    var golfers = [], regex = /golf\/player\/_\/id\/\d+\/([^"]+)"[^>]*>([^<]+)/g, match, rank = 1;
    while ((match = regex.exec(html)) !== null) {
      var name = match[2].trim();
      if (name && !golfers.find(function(g) { return g.name === name; })) { golfers.push({ name: name, position: rank, shortName: '' }); rank++; }
    }
    return golfers.length > 0 ? golfers : null;
  } catch (err) { console.error(' Golf fetch error:', err.message); return null; }
}
 
// ═══════════════════════════════════════════════════════════
// F1 STANDINGS — ESPN HTML scrape (primary) + Jolpica (fallback)
// ═══════════════════════════════════════════════════════════
 
/**
 * PRIMARY: ESPN Racing standings page (server-rendered HTML)
 * URL: https://www.espn.com/racing/standings/_/series/f1/year/{season}
 * This is the OLD racing section — it renders standings as HTML table,
 * unlike espn.com/f1/standings which uses client-side JS.
 * Same pattern used by fetchGolfRankings() in this cron.
 */
async function fetchF1FromESPNHtml(seasonYear) {
  try {
    var url = 'https://www.espn.com/racing/standings/_/series/f1/year/' + seasonYear;
    console.log('  F1: Trying ESPN HTML scrape → ' + url);
    var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) {
      console.log('  F1: ESPN HTML returned HTTP ' + res.status);
      return null;
    }
    var html = await res.text();
 
    // Parse driver rows from the standings table
    // Each row has: racing/driver/_/id/{id}/{slug}  and then the driver name + points
    var drivers = [];
    var regex = /racing\/driver\/_\/id\/\d+\/[^"]*"[^>]*>([^<]+)<[\s\S]*?<td[^>]*>([\d.]+)<\/td>/g;
    var match;
    while ((match = regex.exec(html)) !== null) {
      var name = match[1].trim();
      var points = parseFloat(match[2]) || 0;
      if (name && !drivers.find(function(d) { return d.name === name; })) {
        drivers.push({ name: name, shortName: '', points: points });
      }
    }
 
    // Fallback regex if the table structure is slightly different
    if (drivers.length === 0) {
      // Try a simpler approach: find all driver links followed by point values
      var simpleRegex = /racing\/driver\/_\/id\/\d+\/[^"]+">([^<]+)/g;
      var pointRegex = /<td[^>]*class="[^"]*"[^>]*>(\d+)<\/td>/g;
      var names = [], pts = [];
      while ((match = simpleRegex.exec(html)) !== null) names.push(match[1].trim());
      while ((match = pointRegex.exec(html)) !== null) pts.push(parseFloat(match[1]) || 0);
      // The first set of numbers after driver names should be points
      for (var i = 0; i < names.length && i < pts.length; i++) {
        drivers.push({ name: names[i], shortName: '', points: pts[i] });
      }
    }
 
    if (drivers.length > 0) {
      console.log('  F1: ESPN HTML returned ' + drivers.length + ' drivers');
    } else {
      console.log('  F1: ESPN HTML — could not parse driver data');
    }
    return drivers.length > 0 ? drivers : null;
  } catch (err) {
    console.error('  F1: ESPN HTML fetch error:', err.message);
    return null;
  }
}
 
/**
 * FALLBACK 1: Jolpica API (Ergast successor)
 * Endpoint: https://api.jolpi.ca/ergast/f1/{season}/driverStandings.json
 * Updates on Mondays after each race weekend.
 * Rate limit: 200 requests/hour (unauthenticated)
 */
async function fetchF1FromJolpica(seasonYear) {
  try {
    var url = 'https://api.jolpi.ca/ergast/f1/' + seasonYear + '/driverStandings.json';
    console.log('  F1: Trying Jolpica API → ' + url);
    var res = await fetch(url, {
      headers: { 'User-Agent': 'FantasyLifeHub/1.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      console.log('  F1: Jolpica returned HTTP ' + res.status);
      return null;
    }
    var data = await res.json();
 
    var standingsTable = data?.MRData?.StandingsTable;
    var standingsLists = standingsTable?.StandingsLists;
    if (!standingsLists || standingsLists.length === 0) {
      console.log('  F1: Jolpica returned empty StandingsLists');
      return null;
    }
 
    var driverStandings = standingsLists[0]?.DriverStandings;
    if (!driverStandings || driverStandings.length === 0) {
      console.log('  F1: Jolpica returned empty DriverStandings');
      return null;
    }
 
    var drivers = driverStandings.map(function(entry) {
      var driver = entry.Driver || {};
      var firstName = driver.givenName || '';
      var lastName = driver.familyName || '';
      var fullName = (firstName + ' ' + lastName).trim();
      var points = parseFloat(entry.points) || 0;
      return { name: fullName, shortName: (driver.code || '').toUpperCase(), points: points };
    });
 
    console.log('  F1: Jolpica returned ' + drivers.length + ' drivers');
    return drivers.length > 0 ? drivers : null;
  } catch (err) {
    console.error('  F1: Jolpica fetch error:', err.message);
    return null;
  }
}
 
/**
 * FALLBACK 2: ESPN hidden JSON API
 * Known issue: Returns empty/zero data for 2026 F1 season.
 * Kept as last resort in case it starts working again.
 */
async function fetchF1FromESPNApi() {
  try {
    console.log('  F1: Trying ESPN JSON API fallback...');
    var res = await fetch('https://site.api.espn.com/apis/site/v2/sports/racing/f1/standings', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    var data = await res.json();
    var drivers = [];
 
    for (var group of (data?.children || [])) {
      for (var entry of (group?.standings?.entries || [])) {
        var ath = entry?.athlete || entry?.team; if (!ath) continue;
        var stats = entry?.stats || [];
        var pt = stats.find(function(s) { return s.name === 'points' || s.abbreviation === 'PTS'; });
        drivers.push({ name: ath.displayName || ath.name || '', shortName: ath.shortName || '', points: pt ? parseFloat(pt.value || pt.displayValue) : 0 });
      }
    }
    if (drivers.length === 0) {
      for (var entry2 of (data?.standings?.entries || [])) {
        var ath2 = entry2?.athlete || entry2?.team; if (!ath2) continue;
        var stats2 = entry2?.stats || [];
        var pt2 = stats2.find(function(s) { return s.name === 'points' || s.abbreviation === 'PTS'; });
        drivers.push({ name: ath2.displayName || ath2.name || '', shortName: ath2.shortName || '', points: pt2 ? parseFloat(pt2.value || pt2.displayValue) : 0 });
      }
    }
 
    console.log('  F1: ESPN API returned ' + drivers.length + ' drivers');
    return drivers.length > 0 ? drivers : null;
  } catch (err) {
    console.error('  F1: ESPN API fetch error:', err.message);
    return null;
  }
}
 
/**
 * Combined F1 fetch — tries 3 sources in order:
 *   1. ESPN HTML scrape (most reliable for 2026)
 *   2. Jolpica API (Ergast successor)
 *   3. ESPN JSON API (currently broken for F1 2026)
 * Also validates total points > 0 to avoid resetting with stale data.
 */
async function fetchF1Standings(seasonYear) {
  var drivers = await fetchF1FromESPNHtml(seasonYear);
 
  if (!drivers) {
    drivers = await fetchF1FromJolpica(seasonYear);
  }
 
  if (!drivers) {
    drivers = await fetchF1FromESPNApi();
  }
 
  if (!drivers || drivers.length === 0) {
    console.log('  F1: All 3 sources failed — no data available');
    return null;
  }
 
  // Safety check: don't return all-zero standings mid-season
  var totalPoints = drivers.reduce(function(sum, d) { return sum + d.points; }, 0);
  if (totalPoints === 0) {
    console.log('  F1: All drivers have 0 points — likely stale data, skipping');
    return null;
  }
 
  return drivers;
}
 
/**
 * Matches a pick name against ESPN athlete data.
 * Uses normalizeStr() to strip diacritics before comparing,
 * so "Åberg" matches "Aberg", "Højgaard" matches "Hojgaard", etc.
 */
function matchAthlete(pickName, espnAthletes) {
  var pick = pickName.trim(), alias = NAME_ALIASES[pick], terms = alias ? [alias, pick] : [pick];
  for (var term of terms) {
    var lower = normalizeStr(term);
    var exact = espnAthletes.find(function(a) { return normalizeStr(a.name) === lower; }); if (exact) return exact;
    var lastName = lower.split(' ').pop();
    var lnm = espnAthletes.find(function(a) { return normalizeStr(a.name).split(' ').pop() === lastName; }); if (lnm) return lnm;
    var con = espnAthletes.find(function(a) { return normalizeStr(a.name).includes(lower) || lower.includes(normalizeStr(a.name)); }); if (con) return con;
  }
  return null;
}
 
// One place that knows each league's bonus source. Returns { byAthlete,
// events }: byAthlete drives picks.bonus/bonus_note, events drives the
// event_majors breakdown rows (see syncEventRows).
async function fetchBonusData(league, seasonYear) {
  if (league === 'F1') {
    var gpData = await fetchFeaturedGPPodiums(seasonYear);
    return { byAthlete: aggregateF1Bonus(gpData.podiums), events: f1BreakdownEvents(gpData.races) };
  }
  if (league === 'Golf') return fetchGolfMajorBonus();
  if (league === 'Tennis') return fetchTennisMajorBonus();
  return { byAthlete: {}, events: [] };
}

module.exports = async function handler(req, res) {
  var authHeader = req.headers['authorization'], cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== 'Bearer ' + cronSecret) return res.status(401).json({ error: 'Unauthorized' });
  if (!SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });
 
  var supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log(' Fantasy Life — Updating Event Rankings...\n');
 
  var { data: season } = await supabase.from('seasons').select('year, locks').eq('status', 'active').single();
  if (!season) return res.status(200).json({ message: 'No active season found, skipping' });
 
  var seasonYear = season.year, locks = season.locks || {};
  var { data: membersArr } = await supabase.from('members').select('id, name');
  var memberNameById = {};
  (membersArr || []).forEach(function(m) { memberNameById[m.id] = m.name; });
 
  var results = {};
  // Collected across all three leagues, then batch-written once at the
  // end via writeScoreEventsAndNotify (api/_lib/push.js) — same pattern
  // update-sports.js established first.
  var scoreEvents = [];

  for (var [league, config] of Object.entries(EVENT_LEAGUES)) {
    console.log('Processing ' + league + '...');
    if (!isActive(config)) {
      // Frozen: base and bonus stay exactly as they are. Breakdown rows are
      // still synced, since they're display-only and their points come
      // from the same data that set the (now frozen) bonus. Without this,
      // a league that froze before this sync existed (Golf, Aug 31) would
      // never get rows for the majors it already scored.
      var { data: frozenPicks } = await supabase.from('picks').select('id, member_id, pick').eq('season_year', seasonYear).eq('category', league);
      if (frozenPicks && frozenPicks.length > 0) {
        var frozenBonus = await fetchBonusData(league, seasonYear);
        await syncEventRows(supabase, league, frozenPicks, frozenBonus.events, locks, memberNameById);
      }
      results[league] = { status: 'frozen', reason: 'Past freeze date (breakdown rows synced only)' };
      continue;
    }
 
    var { data: picks, error: pickErr } = await supabase.from('picks').select('id, member_id, pick, base, bonus').eq('season_year', seasonYear).eq('category', league);
    if (pickErr || !picks || picks.length === 0) { results[league] = { status: 'skipped', reason: 'no picks' }; continue; }
 
    var espnData = null;
    if (league === 'Tennis') espnData = await fetchTennisRankings();
    else if (league === 'Golf') espnData = await fetchGolfRankings();
    else if (league === 'F1') espnData = await fetchF1Standings(seasonYear);
    if (!espnData || espnData.length === 0) { results[league] = { status: 'skipped', reason: 'no data from any source' }; continue; }
 
    console.log(' ' + league + ': Found ' + espnData.length + ' athletes/drivers');
 
    var matched = [];
    for (var pick of picks) {
      var athlete = matchAthlete(pick.pick, espnData);
      var metric = 0, record = 'Not found';
      if (athlete) {
        if (league === 'Golf') { metric = athlete.position || 999; record = '#' + metric; }
        else { metric = athlete.points || 0; record = metric.toLocaleString() + ' pts'; }
      }
      matched.push({ ...pick, espnName: athlete ? athlete.name : null, metric: metric, record: record });
    }

    var totalMetric = matched.reduce(function(sum, m) { return sum + m.metric; }, 0);
    if (totalMetric === 0) { results[league] = { status: 'skipped', reason: 'all metrics zero' }; continue; }

    if (config.sortDirection === 'asc') matched.sort(function(a, b) { return a.metric - b.metric; });
    else matched.sort(function(a, b) { return b.metric - a.metric; });

    matched = assignBasePointsWithTiebreaker(matched, picks.length);

    // ── Bonus resolution (F1 featured GPs / Tennis+Golf majors) ──
    // See FEATURED_GPS/MAJOR_NAMES + the 2026-11 changelog at the top of
    // this file. Keyed by athlete display name so matchAthlete() resolves
    // a pick against it exactly the same way it resolves base-score names.
    var bonusData = await fetchBonusData(league, seasonYear);
    var bonusByAthlete = bonusData.byAthlete;
    await syncEventRows(supabase, league, picks, bonusData.events, locks, memberNameById);
    var bonusAthleteList = Object.keys(bonusByAthlete).map(function (name) { return { name: name }; });

    var updated = 0, rankings = [];

    for (var m of matched) {
      var ownerName = memberNameById[m.member_id] || m.member_id;
      var baseLocked = isFieldLocked(locks, league, ownerName, 'base');
      var metricLocked = isFieldLocked(locks, league, ownerName, 'metric');
      var recordLocked = isFieldLocked(locks, league, ownerName, 'record');
      var bonusLocked = isFieldLocked(locks, league, ownerName, 'bonus');

      var bonusMatch = bonusAthleteList.length > 0 ? matchAthlete(m.pick, bonusAthleteList) : null;
      var bonusEntry = bonusMatch ? bonusByAthlete[bonusMatch.name] : null;
      var bonusWritable = !!bonusEntry && !bonusLocked;
      var newBonusVal = bonusWritable ? bonusEntry.total : (Number(m.bonus) || 0);

      var updateObj = { updated_at: new Date().toISOString() };
      if (!baseLocked) updateObj.base = m.newBase;
      if (!metricLocked) updateObj.metric = m.metric;
      if (!recordLocked) updateObj.record = m.record;
      if (bonusWritable) { updateObj.bonus = bonusEntry.total; updateObj.bonus_note = bonusEntry.notes.join(' | '); }

      var skipped = [];
      if (baseLocked) skipped.push('base');
      if (metricLocked) skipped.push('metric');
      if (recordLocked) skipped.push('record');
      if (bonusEntry && bonusLocked) skipped.push('bonus');
      if (skipped.length > 0) console.log('  ' + ownerName + ': skipped locked: ' + skipped.join(', '));

      // Optimistic concurrency on whichever of base/bonus this cycle
      // writes — same fix, same reasoning as update-sports.js's
      // identical comment: without conditioning on the pre-update value
      // just read (m.base/m.bonus), two near-simultaneous invocations of
      // this cron (the scheduled run and a visitor's manual Refresh via
      // api/refresh-all.js, or a retried Vercel cron trigger) both push
      // their own score_events row for the same real change. Whichever
      // commits first moves base/bonus away from what this one read, so
      // a second invocation's conditional UPDATE matches zero rows.
      var updateQuery = supabase.from('picks').update(updateObj).eq('id', m.id);
      if (!baseLocked) updateQuery = updateQuery.eq('base', m.base);
      if (bonusWritable) updateQuery = updateQuery.eq('bonus', m.bonus);
      var { data: updatedRows, error: updateErr } = await updateQuery.select('id');
      if (updateErr) { console.error(' Failed to update ' + m.member_id + ':', updateErr.message); continue; }
      if (!updatedRows || updatedRows.length === 0) {
        console.log('  ' + m.member_id + ': base/bonus changed under us (a concurrent run already applied this) — skipping duplicate score event');
        continue;
      }
      updated++;

      // Diff against the pre-update row (m.base, m.bonus) to log what
      // actually moved — same pattern as update-sports.js, now also
      // accounting for a bonus change (F1/Tennis/Golf bonus resolved
      // above), not just base. A locked field's "new" value was never
      // set, so it stays equal to the pre-update value and contributes 0
      // to delta — no special case needed to skip locked no-ops.
      var newBaseVal = baseLocked ? (Number(m.base) || 0) : (Number(m.newBase) || 0);
      var oldTotal = (Number(m.base) || 0) + (Number(m.bonus) || 0);
      var newTotal = newBaseVal + newBonusVal;
      var delta = Math.round((newTotal - oldTotal) * 10) / 10;
      if (delta !== 0) {
        var causeParts = [];
        if (!baseLocked) causeParts.push(m.espnName ? (m.espnName + ' (' + m.record + ')') : 'Not found');
        if (bonusWritable) causeParts.push(bonusEntry.notes.join(' | '));
        scoreEvents.push({
          season_year: seasonYear,
          member_id: m.member_id,
          category: league,
          delta: delta,
          cause: causeParts.join(' — ') || (m.espnName || 'Not found'),
          source: 'update-events',
        });
      }

      rankings.push({ rank: m.rank, member: m.member_id, pick: m.pick, espnMatch: m.espnName || 'Not found', metric: m.metric, record: m.record, base: newBaseVal, bonus: newBonusVal, total: newBaseVal + newBonusVal, bonusDetected: bonusEntry ? bonusEntry.notes.join(' | ') : undefined, lockedFields: skipped.length > 0 ? skipped : undefined });
    }

    console.log(' ' + league + ': Updated ' + updated + '/' + matched.length + ' picks');
    results[league] = { status: 'updated', updated: updated, total: picks.length, rankings: rankings };
  }

  await writeScoreEventsAndNotify(supabase, scoreEvents, memberNameById);

  console.log('\n Done!');
  return res.status(200).json({ message: 'Event rankings update complete', season: seasonYear, timestamp: new Date().toISOString(), results: results });
};
