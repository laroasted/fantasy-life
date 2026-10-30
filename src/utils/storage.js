// Fantasy Life Hub — Storage + Supabase fetch layer
//
// Public reads use the anon/publishable key (safe to expose in frontend).
// localStorage is still used for draft tool saves and archived seasons.

import { createClient } from '@supabase/supabase-js';

// ── Supabase client (read-only via anon key) ──
const SUPABASE_URL = 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_9lGdGZ1EEifhWZlPRQa-WA_QVbPD6O6';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const COMMISSIONER_EMAILS = (process.env.REACT_APP_COMMISSIONER_EMAILS || '')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

// ── localStorage helpers (kept for draft/archive/settings) ──
const STORAGE_PREFIX = "fl-";

export async function storageGet(key) {
try {
 const value = localStorage.getItem(STORAGE_PREFIX + key);
 if (value !== null) return { value };
 return null;
} catch (e) {
 console.error("Storage get error:", e);
 return null;
}
}

export async function storageSet(key, value) {
try {
 localStorage.setItem(STORAGE_PREFIX + key, value);
 return { key, value };
} catch (e) {
 console.error("Storage set error:", e);
 return null;
}
}

export async function storageDelete(key) {
try {
 localStorage.removeItem(STORAGE_PREFIX + key);
 return true;
} catch (e) {
 console.error("Storage delete error:", e);
 return false;
}
}

export const STORAGE_KEYS = {
ACTIVE_SEASON: "active-season",
ARCHIVED_SEASONS: "archived-seasons",
// Per-year prefixes — build the real key as `${PREFIX}-${year}` so a cache
// from one season never gets served while viewing another.
TRENDS_HISTORY_PREFIX: "trends-history",
ACTIVITY_FEED_PREFIX: "activity-feed",
DRAFT_RECAP_PREFIX: "draft-recap",
SETTINGS_CHANGELOG_PREFIX: "settings-changelog",
};

export function getConfiguredCommissionerEmails() {
 return COMMISSIONER_EMAILS;
}

function normalizeEmail(email) {
 return (email || '').trim().toLowerCase();
}

function isConfiguredCommissionerEmail(email) {
 const normalized = normalizeEmail(email);
 return !!normalized && COMMISSIONER_EMAILS.includes(normalized);
}

/**
* Start Google OAuth sign-in. Supabase handles the Google consent screen
* and callback entirely — this just kicks off the redirect. There's no
* allow-list pre-check here (unlike the old magic-link flow) because we
* don't know which Google account the user will pick until they're back;
* getCommissionerRole() still gates actual commissioner privileges after
* sign-in, so an unauthorized Google account simply doesn't get the role.
*/
export async function signInWithGoogle() {
 const { error } = await supabase.auth.signInWithOAuth({
 provider: 'google',
 options: {
  redirectTo: window.location.origin,
 },
 });

 if (error) {
 return { ok: false, error: error.message || 'Unable to start Google sign-in.' };
 }

 return { ok: true };
}

export async function signOutCommissioner() {
 const { error } = await supabase.auth.signOut();
 return { ok: !error, error: error?.message || null };
}

export async function getCommissionerSession() {
 const { data, error } = await supabase.auth.getSession();
 if (error) return { session: null, role: null, error: error.message || 'Unable to load session.' };
 const session = data?.session || null;
 const role = await getCommissionerRole(session);
 return { session, role, error: null };
}

export async function getCommissionerRole(session) {
 const activeSession = session || (await supabase.auth.getSession()).data?.session || null;
 if (!activeSession?.user) return null;

 const email = normalizeEmail(activeSession.user.email);
 if (isConfiguredCommissionerEmail(email)) {
 return "commissioner";
 }

 try {
 const { data, error } = await supabase
 .from('profiles')
 .select('role')
 .eq('id', activeSession.user.id)
 .maybeSingle();

 if (error) {
  console.warn('profiles role lookup failed:', error.message);
  return null;
 }

 return data?.role || null;
 } catch (err) {
 console.warn('getCommissionerRole error:', err);
 return null;
 }
}

// ── Sport categories that have rounds[] ──
const SPORT_CATS = ['NFL', 'MLB', 'NBA', 'NHL', 'NCAAF', 'NCAAB', 'MLS'];

/**
* Save locks to Supabase seasons table.
* Called by SeasonSettings when commissioner toggles a lock.
*
* @param {number} year - Season year (e.g. 2026)
* @param {object} locks - The full locks object
* @returns {boolean} true if saved successfully
*/
export async function saveLocksToSupabase(year, locks) {
try {
 const { error } = await supabase
 .from('seasons')
 .update({ locks: locks || {} })
 .eq('year', year);

 if (error) {
 console.error('Failed to save locks to Supabase:', error.message);
 return false;
 }
 console.log('Locks saved to Supabase:', Object.keys(locks || {}).length, 'locks');
 return true;
} catch (err) {
 console.error('saveLocksToSupabase error:', err);
 return false;
}
}

/**
* Save paywall settings to Supabase seasons table.
* Called by SeasonSettings when the commissioner saves the Paywall tab.
*
* @param {number} year - Season year (e.g. 2026)
* @param {object} paywalls - The full paywalls object, keyed by member id
* @returns {boolean} true if saved successfully
*/
export async function savePaywallsToSupabase(year, paywalls) {
try {
 const { error } = await supabase
 .from('seasons')
 .update({ paywalls: paywalls || {} })
 .eq('year', year);

 if (error) {
 console.error('Failed to save paywalls to Supabase:', error.message);
 return false;
 }
 return true;
} catch (err) {
 console.error('savePaywallsToSupabase error:', err);
 return false;
}
}

/**
* Unlock one member's paywall after a successful PayPal payment.
* Goes through a security-definer RPC (see supabase/phase3_paywalls.sql)
* instead of a direct table write, since anonymous visitors have no
* UPDATE grant on the seasons table — the RPC can only flip that one
* member's `enabled` flag to false, nothing else.
*
* @param {number} year - Season year
* @param {string} memberId - The member whose paywall to lift
* @returns {boolean} true if the call succeeded
*/
export async function unlockPaywallRpc(year, memberId) {
try {
 const { error } = await supabase.rpc('unlock_paywall', {
 p_year: year,
 p_member_id: memberId,
 });
 if (error) {
 console.error('Failed to unlock paywall:', error.message);
 return false;
 }
 return true;
} catch (err) {
 console.error('unlockPaywallRpc error:', err);
 return false;
}
}

/**
* Fetch the full season from Supabase and assemble into the same
* shape that build2025() returns — so Scoreboard.jsx needs zero changes.
*
* If year is provided, fetch that specific year.
* If year is null/undefined, fetch whichever season has status = 'active'.
*
* Returns: { year, name, draftDate, memberCount, members, categories, detailedData, locks, status }
*/
export async function fetchSeasonFromSupabase(year = null) {
try {
 // 1. Fetch season info — by year if provided, otherwise by active status
 let query = supabase.from('seasons').select('*');
 if (year) {
 query = query.eq('year', year);
 } else {
 query = query.eq('status', 'active');
 }
 const { data: season, error: sErr } = await query.single();

 if (sErr || !season) {
 console.error('Failed to fetch season:', sErr?.message);
 return null;
 }

 // 2. Fetch members
 const { data: members, error: mErr } = await supabase
 .from('members')
 .select('*')
 .order('id');

 if (mErr) {
 console.error('Failed to fetch members:', mErr.message);
 return null;
 }

 // 3. Fetch ALL picks for this season
 const { data: picks, error: pErr } = await supabase
 .from('picks')
 .select('*')
 .eq('season_year', season.year);

 if (pErr) {
 console.error('Failed to fetch picks:', pErr.message);
 return null;
 }

 // 4. Fetch all detail tables in parallel
 const pickIds = picks.map(p => p.id);

 const [
 { data: sportRounds },
 { data: filmEntries },
 { data: musicSongs },
 { data: musicGrammys },
 { data: eventMajors },
 { data: countryOlympics },
 { data: stockPrices },
 ] = await Promise.all([
 supabase.from('sport_rounds').select('*').in('pick_id', pickIds).order('round_order'),
 supabase.from('film_entries').select('*').in('pick_id', pickIds),
 supabase.from('music_songs').select('*').in('pick_id', pickIds),
 supabase.from('music_grammys').select('*').in('pick_id', pickIds),
 supabase.from('event_majors').select('*').in('pick_id', pickIds).order('event_order'),
 supabase.from('country_olympics').select('*').in('pick_id', pickIds),
 supabase.from('stock_prices').select('*').in('pick_id', pickIds),
 ]);

 // 5. Index detail data by pick_id for fast lookup
 const roundsByPick = groupBy(sportRounds || [], 'pick_id');
 const filmsByPick = groupBy(filmEntries || [], 'pick_id');
 const songsByPick = groupBy(musicSongs || [], 'pick_id');
 const grammysByPick = groupBy(musicGrammys || [], 'pick_id');
 const majorsByPick = groupBy(eventMajors || [], 'pick_id');
 const olympicsByPick = {};
 (countryOlympics || []).forEach(o => { olympicsByPick[o.pick_id] = o; });
 const stockByPick = {};
 (stockPrices || []).forEach(s => { stockByPick[s.pick_id] = s; });

 // 6. Build categories + detailedData in the same shape as build2025()
 const categories = {};
 const detailedData = {};

 // Group picks by category
 const picksByCat = {};
 picks.forEach(p => {
 if (!picksByCat[p.category]) picksByCat[p.category] = [];
 picksByCat[p.category].push(p);
 });

 // Member id→name lookup
 const memberNameById = {};
 members.forEach(m => { memberNameById[m.id] = m.name; });

 for (const [cat, catPicks] of Object.entries(picksByCat)) {
 // categories[cat] = summary array
 categories[cat] = catPicks.map(p => ({
  owner: memberNameById[p.member_id] || p.member_id,
  pick: p.pick,
  base: Number(p.base) || 0,
  bonus: Number(p.bonus) || 0,
  total: Number(p.total) || 0,
 }));

 // detailedData[cat] = full detail array
 if (SPORT_CATS.includes(cat)) {
  detailedData[cat] = catPicks.map(p => ({
  owner: memberNameById[p.member_id],
  pick: p.pick,
  record: p.record || '',
  winPct: Number(p.metric) || 0,
  base: Number(p.base) || 0,
  bonus: Number(p.bonus) || 0,
  total: Number(p.total) || 0,
  bonusNote: p.bonus_note || '',
  rounds: (roundsByPick[p.id] || []).map(r => ({
   round: r.round_name,
   opponent: r.opponent || '',
   result: r.result || '—',
   series: r.series || '—',
   pts: Number(r.pts) || 0,
   note: r.note || '',
  })),
  }));
 } else if (cat === 'Actor' || cat === 'Actress') {
  detailedData[cat] = catPicks.map(p => {
  const films = (filmsByPick[p.id] || []).map(f => ({
   title: f.title,
   date: f.release_date || '',
   bo: Number(f.box_office) || 0,
   rt: Number(f.rotten_tom) || 0,
   score: Number(f.score) || 0,
   note: f.note || undefined,
  }));
  const totalScore = films.reduce((sum, f) => sum + f.score, 0);
  return {
   owner: memberNameById[p.member_id],
   pick: p.pick,
   films,
   totalScore,
   base: Number(p.base) || 0,
   bonus: Number(p.bonus) || 0,
   total: Number(p.total) || 0,
   bonusNote: p.bonus_note || '',
  };
  });
 } else if (cat === 'Musician') {
  detailedData[cat] = catPicks.map(p => ({
  owner: memberNameById[p.member_id],
  pick: p.pick,
  billboard: Number(p.metric) || 0,
  base: Number(p.base) || 0,
  bonus: Number(p.bonus) || 0,
  total: Number(p.total) || 0,
  bonusNote: p.bonus_note || '',
  songs: (songsByPick[p.id] || []).map(s => ({
   title: s.title,
   weeks: Number(s.weeks) || 0,
   numOneWeeks: Number(s.num_one_weeks) || 0,
   note: s.note || undefined,
  })),
  grammys: (grammysByPick[p.id] || []).map(g => ({
   category: g.category,
   result: g.result,
   entry: g.entry || '',
   pts: Number(g.pts) || 0,
   note: g.note || '',
  })),
  }));
 } else if (cat === 'Tennis' || cat === 'Golf' || cat === 'F1') {
  detailedData[cat] = catPicks.map(p => ({
  owner: memberNameById[p.member_id],
  pick: p.pick,
  ranking: Number(p.metric) || 0,
  base: Number(p.base) || 0,
  bonus: Number(p.bonus) || 0,
  total: Number(p.total) || 0,
  bonusNote: p.bonus_note || '',
  majors: (majorsByPick[p.id] || []).map(mj => ({
   event: mj.event_name,
   result: mj.result || '—',
   opponent: mj.opponent || '—',
   score: mj.score || '—',
   pts: Number(mj.pts) || 0,
   note: mj.note || '',
  })),
  }));
 } else if (cat === 'Country') {
  detailedData[cat] = catPicks.map(p => {
  const oly = olympicsByPick[p.id];
  return {
   owner: memberNameById[p.member_id],
   pick: p.pick,
   gdp: Number(p.metric) || 0,
   base: Number(p.base) || 0,
   bonus: Number(p.bonus) || 0,
   total: Number(p.total) || 0,
   bonusNote: p.bonus_note || '',
   olympics: oly ? {
   rank: oly.medal_rank,
   gold: Number(oly.gold) || 0,
   silver: Number(oly.silver) || 0,
   bronze: Number(oly.bronze) || 0,
   total: Number(oly.total_medals) || 0,
   pts: Number(oly.pts) || 0,
   note: oly.note || '',
   } : { rank: null, gold: 0, silver: 0, bronze: 0, total: 0, pts: 0, note: '' },
  };
  });
 } else if (cat === 'Stock') {
  detailedData[cat] = catPicks.map(p => {
  const st = stockByPick[p.id];
  return {
   owner: memberNameById[p.member_id],
   pick: p.pick,
   openPrice: st ? Number(st.open_price) : 0,
   closePrice: st ? Number(st.close_price) : 0,
   pctChange: st ? Number(st.pct_change) : 0,
   base: Number(p.base) || 0,
   total: Number(p.total) || 0,
   note: st?.note || '',
  };
  });
 }
 }

 // 7. Assemble final season object
 return {
 year: season.year,
 name: season.name,
 draftDate: season.draft_date,
 memberCount: members.length,
 members: members.map(m => ({
  id: m.id,
  name: m.name,
  full: m.full_name,
 })),
 categories,
 detailedData,
 locks: season.locks || {},
 paywalls: season.paywalls || {},
 status: season.status,
 };
} catch (err) {
 console.error('fetchSeasonFromSupabase error:', err);
 return null;
}
}

/**
* Fetch the latest projections row per pick for a season, keyed by
* category -> owner name -> projection, so Scoreboard can look one up the
* same way it looks up `cats[category]` entries by `owner`.
*
* Returns {} (not null) on any failure — the Scoreboard "Projected" toggle
* must degrade to "not available yet" per category, never block or error
* out the real (current) scoreboard. See docs/projections-feature-plan.md.
*
* @param {number} year - Season year
* @param {Array} picks - The season's picks (from fetchSeasonFromSupabase's
*  raw picks, or re-derived from categories) — used to map pick_id -> owner.
* @returns {object} { [category]: { [ownerName]: projectionRow } }
*/
export async function fetchProjectionsFromSupabase(year, members) {
try {
 const { data: picks, error: pErr } = await supabase
 .from('picks').select('id, member_id, category').eq('season_year', year);
 if (pErr || !picks) return {};

 const { data: projections, error: projErr } = await supabase
 .from('projections').select('*').eq('season_year', year);
 if (projErr || !projections || projections.length === 0) return {};

 const memberNameById = {};
 (members || []).forEach((m) => { memberNameById[m.id] = m.name; });
 const pickById = {};
 picks.forEach((p) => { pickById[p.id] = p; });

 const byCategoryOwner = {};
 projections.forEach((proj) => {
 const pick = pickById[proj.pick_id];
 if (!pick) return;
 const ownerName = memberNameById[pick.member_id];
 if (!ownerName) return;
 if (!byCategoryOwner[proj.category]) byCategoryOwner[proj.category] = {};
 byCategoryOwner[proj.category][ownerName] = {
  projectedBase: Number(proj.projected_base) || 0,
  projectedBonusEv: Number(proj.projected_bonus_ev) || 0,
  projectedTotal: Number(proj.projected_total) || 0,
  p10: proj.p10 !== null ? Number(proj.p10) : null,
  p50: proj.p50 !== null ? Number(proj.p50) : null,
  p90: proj.p90 !== null ? Number(proj.p90) : null,
  method: proj.method,
  confidence: proj.confidence,
  sourceDetail: proj.source_detail,
  note: proj.note || null,
  computedAt: proj.computed_at,
 };
 });
 return byCategoryOwner;
} catch (err) {
 console.error('fetchProjectionsFromSupabase error:', err);
 return {};
}
}

// ── Utility ──
function groupBy(arr, key) {
const map = {};
arr.forEach(item => {
 const k = item[key];
 if (!map[k]) map[k] = [];
 map[k].push(item);
});
return map;
}
