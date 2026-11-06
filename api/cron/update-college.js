/**
* Fantasy Life — NCAAF & NCAAB AP Rankings + Bowl/Tournament Bonus Updater
* Respects commissioner locks from seasons.locks column.
*
* Tiebreaker: players with the same AP points split/average the base
* points they collectively occupy.
* e.g. 3-way tie for ranks 2–4 out of 12 = (11+10+9)/3 = 10.0 each
*
* FIX (2026-11) — Automated bowl/tournament bonus
*   Bonus used to be commissioner-only manual entry (Settings → Scores &
*   Bonus). Now resolved from ESPN's own postseason schedule data for each
*   picked team, same vendor already trusted for base scoring — mirrors
*   update-sports.js's playoff-bracket bonus (PLAYOFF_ROUNDS/classifyRound/
*   fetchTeamPostseasonGames/computePlayoffTier), rewritten file-local per
*   this repo's no-shared-lib-between-crons convention, with two
*   differences specific to college:
*
*   1. NCAAB's bracket (Round of 32 → Sweet 16 → Elite 8 → Final Four →
*      National Championship) is a clean single-elimination tree, exactly
*      like the five sports in update-sports.js — same "furthest-round-
*      reached, same tier whether won or lost" semantics for every round
*      but the championship.
*
*   2. NCAAF's bonus rule — "10:Win Natl Champ | 7:Lose Natl Champ |
*      5:Lose Semi | 3:Win BCS Bowl | 2:Lose BCS Bowl | 1:Win Other Bowl"
*      — is the 12-team CFP era version, not the old pre-2024 two-bowl
*      system. "BCS Bowl" here means a CFP Quarterfinal specifically (the
*      quarterfinals are always hosted at a fixed rotating pool of New
*      Year's Six bowls), which is why — unlike every other round in this
*      app's bonus automation — the Quarterfinal round itself assigns a
*      DIFFERENT point value for winning (3) vs. losing (2) it, not just
*      the championship. The "1:Win Other Bowl" tier is a team that missed
*      the CFP bracket entirely but won its assigned non-playoff bowl —
*      detected as "last postseason game's round text didn't match any
*      CFP keyword", using the bowl's own name (ESPN's note headline) as
*      the label. A non-playoff bowl LOSS, and a CFP First Round result
*      (win or lose — the rule doesn't score that round at all), are both
*      confidently resolved to 0, not left untouched: these are known,
*      classified outcomes, not an unclassifiable guess.
*
*   Round-name keywords verified live via Firecrawl against the actual
*   completed 2025-26 CFP (Jan 2026) and 2025-26 NCAA tournament (Mar/Apr
*   2026) note-headline text — see docs/bonus-automation.md. Evergreen by
*   design: matched by what ESPN calls the round this year. Bonus
*   resolution is gated per PICK, by that team's own postseason schedule
*   (fetchTeamPostseasonGames) actually having a completed game — not by a
*   day-scoped scoreboard query. An earlier version gated on "does today's
*   seasontype=3 scoreboard slate return anything," which Codex's review on
*   this PR caught as a real bug: both sports' scoreboard endpoint rejects a
*   date-range query (confirmed live — both return 400), and NCAAB's
*   endpoint is day-granular (confirmed live, unlike NCAAF's), so a single
*   gap day between rounds — routine in both brackets — could make that
*   check report "no bracket" and skip an already-decided result for a run
*   or more. A per-team schedule lookup has no such gap: it just returns
*   whatever that team has actually played, any day it's called.
*
*   Team IDs (needed for the per-team schedule lookup) come from a
*   SEPARATE full-roster endpoint (fetchESPNTeams), not the AP rankings
*   endpoint used for base scoring — the AP poll only lists ranked teams,
*   and an unranked team can still win a bowl game. The two fetches are
*   independent on purpose: if the AP poll endpoint has no data yet (e.g.
*   preseason), base scoring is skipped but bonus resolution still runs.
*
*   Like update-sports.js's FIX 8, the old `isActive()` freeze-date early-
*   `continue` (Dec 9 for NCAAF, Mar 5 for NCAAB) has been replaced with a
*   `baseFrozen` flag that only gates base/metric/record writes — bowl
*   season and the NCAA tournament both run well past those dates, so
*   bonus resolution must not be skipped just because base is frozen.
*   Auto-lock is NOT added here — out of scope for this change.
*/

const { createClient } = require('@supabase/supabase-js');
const { writeScoreEventsAndNotify } = require('../_lib/push');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const COLLEGE_LEAGUES = {
 NCAAF: {
  url: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/rankings',
  activeStart: { month: 8, day: 15 }, freezeDate: { month: 12, day: 9 },
  sport: 'football', league: 'college-football',
 },
 NCAAB: {
  url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/rankings',
  activeStart: { month: 11, day: 1 }, freezeDate: { month: 3, day: 5 },
  sport: 'basketball', league: 'mens-college-basketball',
 },
};

// ═══════════════════════════════════════════════════════════════════════
// BOWL / TOURNAMENT BONUS — matched by ROUND NAME, never by calendar date.
// `keywords` are matched case-insensitively against whatever free text
// ESPN attaches to a postseason game (event name/shortName + any
// `notes[].headline`). Verified live (see file header) against:
//   NCAAF: "College Football Playoff First Round Game" /
//          "College Football Playoff Quarterfinal at the <Bowl>" /
//          "College Football Playoff Semifinal at the <Bowl>" /
//          "College Football Playoff National Championship Presented by <Sponsor>"
//   NCAAB: "NCAA Men's Basketball Championship - <Region> - 1st Round" /
//          "... - 2nd Round" / "... - Sweet 16" / "... - Elite 8" /
//          "... - Final Four" / "... - National Championship"
// ═══════════════════════════════════════════════════════════════════════
const NCAAF_ROUNDS = [
 { label: 'CFP First Round', keywords: ['playoff first round'], loseTier: 0 },
 { label: 'CFP Quarterfinal', keywords: ['playoff quarterfinal'], winTier: 3, loseTier: 2 },
 { label: 'CFP Semifinal', keywords: ['playoff semifinal'], loseTier: 5 },
 { label: 'National Championship', keywords: ['national championship'], winTier: 10, loseTier: 7 },
];

const NCAAB_ROUNDS = [
 { label: 'Round of 64', keywords: ['1st round'], loseTier: 0 },
 { label: 'Round of 32', keywords: ['2nd round'], loseTier: 1 },
 { label: 'Sweet 16', keywords: ['sweet 16'], loseTier: 2 },
 { label: 'Elite 8', keywords: ['elite 8'], loseTier: 3 },
 { label: 'Final Four', keywords: ['final four'], loseTier: 5 },
 { label: 'National Championship', keywords: ['national championship'], winTier: 10, loseTier: 7 },
];

// Finds the most-advanced round whose keywords appear in `text`. Checked
// from the championship round backwards — same as update-sports.js.
function classifyRound(text, rounds) {
 var lower = (text || '').toLowerCase();
 for (var i = rounds.length - 1; i >= 0; i--) {
  if (rounds[i].keywords.some(function(k) { return lower.indexOf(k) !== -1; })) return { index: i, round: rounds[i] };
 }
 return null;
}

// Every team in the league (not just AP-ranked ones) — needed to resolve
// an espnTeamId for the per-team schedule lookup below, since an unranked
// team can still win a bowl game. Independent of fetchAPRankings on
// purpose (see file header) — same {id, teamName, displayName,
// abbreviation, location} shape matchTeam() already expects, so it's
// reused as-is against this list.
async function fetchESPNTeams(sport, league) {
 try {
  var url = 'https://site.api.espn.com/apis/site/v2/sports/' + sport + '/' + league + '/teams?limit=1000';
  var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  var data = await res.json();
  var teams = data?.sports?.[0]?.leagues?.[0]?.teams || [];
  var out = [];
  for (var t of teams) {
   var team = t.team || {};
   if (!team.id) continue;
   out.push({ id: team.id, teamName: team.name || '', displayName: team.displayName || '', abbreviation: team.abbreviation || '', location: team.location || '' });
  }
  return out.length > 0 ? out : null;
 } catch (err) { console.error(' ' + league + ': team list fetch error — ' + err.message); return null; }
}

// One team's completed postseason games, oldest first. `noteHeadline` is
// kept separate from the broader `text` classification blob — it's the
// clean bowl-game name used for NCAAF's "Other Bowl" label when a game
// doesn't classify as a CFP round. Never throws.
async function fetchTeamPostseasonGames(sport, league, teamId) {
 try {
  var url = 'https://site.api.espn.com/apis/site/v2/sports/' + sport + '/' + league + '/teams/' + teamId + '/schedule?seasontype=3';
  var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) return [];
  var data = await res.json();
  var events = data?.events || [];
  return events.map(function(e) {
   var comp = e?.competitions?.[0];
   var statusObj = comp?.status || e?.status;
   var completed = !!statusObj?.type?.completed;
   var competitor = (comp?.competitors || []).find(function(c) { return String(c?.team?.id ?? c?.id) === String(teamId); });
   var won = !!competitor?.winner;
   var notes = comp?.notes || [];
   var noteHeadline = notes[0]?.headline || '';
   var textParts = [e?.name, e?.shortName, e?.week?.text].concat(notes.map(function(n) { return n?.headline; })).filter(Boolean);
   var dateMs = e?.date ? new Date(e.date).getTime() : 0;
   return { completed: completed, won: won, text: textParts.join(' | '), noteHeadline: noteHeadline, dateMs: dateMs };
  }).filter(function(g) { return g.completed; }).sort(function(a, b) { return a.dateMs - b.dateMs; });
 } catch (err) { console.error('  Team schedule fetch failed for team ' + teamId + ':', err.message); return []; }
}

// NCAAB: standard furthest-round-reached semantics, identical in shape to
// update-sports.js's computePlayoffTier — every round but the
// championship uses the same tier whether the team won or lost that game
// (the number represents "survived to this depth"). Returns null (no
// change) if the last game's round can't be confidently classified.
function computeNCAABTier(games) {
 if (!games || games.length === 0) return null;
 var last = games[games.length - 1];
 var classified = classifyRound(last.text, NCAAB_ROUNDS);
 if (!classified) return null;
 var index = classified.index, round = classified.round;
 var isFinalRound = index === NCAAB_ROUNDS.length - 1;
 var tier = (last.won && isFinalRound) ? round.winTier : round.loseTier;
 var label = isFinalRound ? ((last.won ? 'Won ' : 'Lost ') + round.label) : ((last.won ? 'Advanced past ' : 'Lost ') + round.label);
 return { tier: tier, label: label };
}

// NCAAF: mostly the same furthest-round-reached semantics as NCAAB, with
// one deviation — the Quarterfinal round ("BCS Bowl") assigns a different
// tier for winning (3) vs. losing (2) it, since the real bonus rule does
// (see file header). A game that doesn't classify as a CFP round at all
// is a non-playoff bowl appearance: won → 1 point (the "Other Bowl" tier),
// lost → 0 — both confidently resolved, not left as "no signal".
function computeNCAAFTier(games) {
 if (!games || games.length === 0) return null;
 var last = games[games.length - 1];
 var classified = classifyRound(last.text, NCAAF_ROUNDS);
 if (classified) {
  var index = classified.index, round = classified.round;
  var isFinalRound = index === NCAAF_ROUNDS.length - 1;
  var isQuarterfinal = round.label === 'CFP Quarterfinal';
  if (isFinalRound || isQuarterfinal) {
   var tier = last.won ? round.winTier : round.loseTier;
   var label = (last.won ? 'Won ' : 'Lost ') + round.label;
   return { tier: tier, label: label };
  }
  return { tier: round.loseTier, label: (last.won ? 'Advanced past ' : 'Lost ') + round.label };
 }
 // Unclassified text: only treat this as a non-playoff "Other Bowl"
 // appearance when it's positively NOT a CFP game (no "College Football
 // Playoff" prefix at all, per the verified note-headline format — see
 // file header) — a CFP round ESPN worded in a way our keywords missed is
 // a real "can't confidently classify" case, not evidence of Other Bowl,
 // so that returns null (no guess) rather than a wrong 0 or 1.
 if ((last.text || '').toLowerCase().indexOf('college football playoff') !== -1) return null;
 var bowlName = last.noteHeadline || 'Bowl Game';
 return last.won ? { tier: 1, label: 'Won ' + bowlName } : { tier: 0, label: 'Lost ' + bowlName };
}

const NAME_ALIASES = { 'Ole Miss': 'Mississippi', 'SMU': 'SMU Mustangs', 'LSU': 'LSU Tigers', 'UCLA': 'UCLA Bruins', 'USC': 'USC Trojans', 'BYU': 'BYU Cougars', 'TCU': 'TCU Horned Frogs' };

/**
* Assigns base points with split/average tiebreaker logic.
* Input array must already be sorted descending by apPoints before calling.
*/
function assignBasePointsWithTiebreaker(matched, totalMembers) {
 var n = matched.length;
 var i = 0;
 while (i < n) {
  var j = i;
  while (j < n && matched[j].apPoints === matched[i].apPoints) j++;
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

function isFieldLocked(locks, category, ownerName, field) {
 if (!locks) return false;
 return !!locks[category + '|' + ownerName + '|' + field];
}

function isActive(config) {
 var now = new Date(), month = now.getMonth() + 1, day = now.getDate(), today = month * 100 + day;
 var start = config.activeStart.month * 100 + config.activeStart.day, freeze = config.freezeDate.month * 100 + config.freezeDate.day;
 return start <= freeze ? (today >= start && today <= freeze) : (today >= start || today <= freeze);
}

async function fetchAPRankings(league, config) {
 try {
  var res = await fetch(config.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) { console.log(' ' + league + ': ESPN returned ' + res.status); return null; }
  var data = await res.json();
  var rankings = data?.rankings || [];
  var apPoll = rankings.find(r => r.name === 'AP Top 25' || r.shortName === 'AP Top 25' || r.type === 'ap' || (r.name || '').toLowerCase().includes('ap'));
  if (!apPoll) { if (rankings.length > 0 && rankings[0].ranks) return parseRanks(rankings[0].ranks); return null; }
  return parseRanks(apPoll.ranks || []);
 } catch (err) { console.error(' ' + league + ': Fetch error — ' + err.message); return null; }
}

function parseRanks(ranks) {
 return ranks.filter(e => e?.team).map(e => ({
  rank: e.current || e.rank || 0, teamName: e.team.name || e.team.shortDisplayName || '',
  displayName: e.team.displayName || e.team.name || '', location: e.team.location || e.team.nickname || '',
  abbreviation: e.team.abbreviation || '', apPoints: e.points || 0,
 }));
}

function matchTeam(pickName, espnTeams) {
 var pick = pickName.trim(), alias = NAME_ALIASES[pick], terms = alias ? [alias, pick] : [pick];
 for (var term of terms) {
  var lower = term.toLowerCase();
  var loc = espnTeams.find(t => t.location.toLowerCase() === lower); if (loc) return loc;
  var con = espnTeams.find(t => t.displayName.toLowerCase().includes(lower) || t.teamName.toLowerCase().includes(lower)); if (con) return con;
  var abbr = espnTeams.find(t => t.abbreviation.toLowerCase() === lower); if (abbr) return abbr;
 }
 return null;
}

module.exports = async function handler(req, res) {
 var authHeader = req.headers['authorization'], cronSecret = process.env.CRON_SECRET;
 if (cronSecret && authHeader !== 'Bearer ' + cronSecret) return res.status(401).json({ error: 'Unauthorized' });
 if (!SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });

 var supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
 console.log(' Fantasy Life — Updating College AP Rankings...\n');

 var { data: season } = await supabase.from('seasons').select('year, locks').eq('status', 'active').single();
 if (!season) return res.status(200).json({ message: 'No active season found, skipping' });

 var seasonYear = season.year, locks = season.locks || {};

 var { data: members } = await supabase.from('members').select('id, name');
 var memberNameById = {};
 (members || []).forEach(function(m) { memberNameById[m.id] = m.name; });

 var results = {};
 // Collected across both leagues, then batch-written once at the end via
 // writeScoreEventsAndNotify (api/_lib/push.js) — same pattern
 // update-sports.js established first. A failure writing these must
 // never block or roll back the picks.update() calls above; the
 // activity feed is a nice-to-have view on top of real scoring, not
 // part of it.
 var scoreEvents = [];

 for (var [league, config] of Object.entries(COLLEGE_LEAGUES)) {
  console.log('Processing ' + league + '...');

  // Base scoring can be frozen for the season (offseason / past the
  // freeze date) while the bowl/tournament bracket that bonus depends on
  // is still live weeks later — so a frozen base no longer skips the
  // league entirely; it only skips the base/metric/record writes below.
  // Bonus resolution always runs. See file header.
  var baseFrozen = !isActive(config);
  if (baseFrozen) {
   var freezeStr = config.freezeDate.month + '/' + config.freezeDate.day;
   console.log(' ' + league + ': Past ' + freezeStr + ' — base frozen, bonus still evaluated');
  }

  var { data: picks, error: pickErr } = await supabase.from('picks').select('id, member_id, pick, base, bonus').eq('season_year', seasonYear).eq('category', league);
  if (pickErr || !picks || picks.length === 0) { results[league] = { status: 'skipped', reason: 'no picks' }; continue; }

  // Independent of bonus resolution below — the AP poll can have no data
  // yet (preseason) without that blocking bowl/tournament bonus.
  var espnTeams = await fetchAPRankings(league, config);
  var matched;
  if (espnTeams) {
   console.log(' ' + league + ': Found ' + espnTeams.length + ' ranked teams');
   matched = [];
   for (var pick of picks) {
    var espnTeam = matchTeam(pick.pick, espnTeams);
    matched.push({ ...pick, espnTeam: espnTeam ? espnTeam.displayName : null, apRank: espnTeam ? espnTeam.rank : 'Unranked', apPoints: espnTeam ? espnTeam.apPoints : 0 });
   }
   matched.sort(function(a, b) { return b.apPoints - a.apPoints; });
   matched = assignBasePointsWithTiebreaker(matched, picks.length);
  } else {
   console.log(' ' + league + ': No AP data — base unchanged, bonus still evaluated');
   matched = picks.map(function(p) { return { ...p, espnTeam: null, apRank: 'Unranked', apPoints: 0, newBase: p.base, rank: 0 }; });
  }

  // ── Bowl/tournament bonus resolution (see NCAAF_ROUNDS/NCAAB_ROUNDS above) ──
  // Gated per pick by that team's own postseason schedule actually having a
  // completed game — not by a day-scoped scoreboard slate (see file header
  // for why; Codex review finding on this PR). The extra per-team calls run
  // every day, not just in-season — each resolves to an empty game list in
  // well under a second during the offseason, same cost class as the base
  // AP-rankings fetch already does unconditionally above.
  var bonusByPickId = {};
  var fullTeams = await fetchESPNTeams(config.sport, config.league);
  if (fullTeams) {
   for (var m of matched) {
    var teamMatch = matchTeam(m.pick, fullTeams);
    if (!teamMatch || !teamMatch.id) continue;
    var games = await fetchTeamPostseasonGames(config.sport, config.league, teamMatch.id);
    var result = league === 'NCAAF' ? computeNCAAFTier(games) : computeNCAABTier(games);
    if (result) bonusByPickId[m.id] = result;
   }
   if (Object.keys(bonusByPickId).length === 0) console.log(' ' + league + ': No bonus changes resolved this run');
  } else {
   console.log(' ' + league + ': Could not fetch team list — bonus unchanged');
  }

  var updated = 0, rankings = [];

  for (var m of matched) {
   var ownerName = memberNameById[m.member_id] || m.member_id;
   var baseLocked = isFieldLocked(locks, league, ownerName, 'base');
   var metricLocked = isFieldLocked(locks, league, ownerName, 'metric');
   var recordLocked = isFieldLocked(locks, league, ownerName, 'record');
   var bonusLocked = isFieldLocked(locks, league, ownerName, 'bonus');

   var bonusResult = bonusByPickId[m.id];
   var bonusWritable = !!bonusResult && !bonusLocked;
   var baseWritable = !baseFrozen && !!espnTeams && !baseLocked;
   var rankingsWritable = !baseFrozen && !!espnTeams;

   var updateObj = { updated_at: new Date().toISOString() };
   if (baseWritable) updateObj.base = m.newBase;
   if (rankingsWritable && !metricLocked) updateObj.metric = m.apPoints;
   if (rankingsWritable && !recordLocked) updateObj.record = m.apPoints > 0 ? m.apPoints + ' AP pts (' + m.apRank + ')' : 'Unranked';
   if (bonusWritable) { updateObj.bonus = bonusResult.tier; updateObj.bonus_note = bonusResult.label; }

   var skipped = [];
   if (rankingsWritable && baseLocked) skipped.push('base');
   if (rankingsWritable && metricLocked) skipped.push('metric');
   if (rankingsWritable && recordLocked) skipped.push('record');
   if (bonusResult && bonusLocked) skipped.push('bonus');
   if (skipped.length > 0) console.log(' ' + ownerName + ': skipped locked/frozen fields: ' + skipped.join(', '));

   var { error: updateErr } = await supabase.from('picks').update(updateObj).eq('id', m.id);
   if (updateErr) { console.error(' Failed to update ' + m.member_id + ':', updateErr.message); continue; }

   updated++;

   // Diff against the pre-update row (m.base, m.bonus) to log what
   // actually moved — same pattern as update-sports.js, now accounting
   // for a bonus change same as base.
   var newBaseVal = baseWritable ? (Number(m.newBase) || 0) : (Number(m.base) || 0);
   var newBonusVal = bonusWritable ? bonusResult.tier : (Number(m.bonus) || 0);
   var oldTotal = (Number(m.base) || 0) + (Number(m.bonus) || 0);
   var newTotal = newBaseVal + newBonusVal;
   var delta = Math.round((newTotal - oldTotal) * 10) / 10;
   if (delta !== 0) {
    var causeParts = [];
    if (baseWritable) causeParts.push((m.espnTeam || 'Unranked') + (m.apPoints > 0 ? ' (#' + m.apRank + ' AP, ' + m.apPoints + ' pts)' : ''));
    if (bonusWritable) causeParts.push(bonusResult.label);
    scoreEvents.push({
     season_year: seasonYear,
     member_id: m.member_id,
     category: league,
     delta: delta,
     cause: causeParts.join(' — ') || (m.espnTeam || 'Unranked'),
     source: 'update-college',
    });
   }

   rankings.push({
    rank: m.rank, member: m.member_id, pick: m.pick, espnMatch: m.espnTeam || 'Unranked', apRank: m.apRank, apPoints: m.apPoints,
    base: newBaseVal, bonus: newBonusVal, total: newBaseVal + newBonusVal,
    ...(bonusResult && { bonusDetected: bonusResult.label }),
    ...(skipped.length > 0 && { lockedFields: skipped }),
   });
  }

  console.log(' ' + league + ': Updated ' + updated + '/' + matched.length + ' picks');
  results[league] = { status: baseFrozen ? 'bonus_only' : 'updated', updated: updated, total: picks.length, rankings: rankings };
 }

 await writeScoreEventsAndNotify(supabase, scoreEvents, memberNameById);

 console.log('\n Done!');
 return res.status(200).json({ message: 'College AP rankings update complete', season: seasonYear, timestamp: new Date().toISOString(), results: results });
};
