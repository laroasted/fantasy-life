const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
 process.env.SUPABASE_URL,
 process.env.SUPABASE_SERVICE_KEY
);

// ── Draft picks: ESPN abbreviation per member ──
const DRAFT = {
 NFL: { Adam:"WSH",Dhruv:"PHI",Marsh:"BUF",Jordan:"DEN",Alan:"CIN",Evan:"KC",LaRosa:"GB",Jack:"DET",Mike:"SEA",Danny:"BAL",Auzy:"SF" },
 NBA: { Adam:"MIL",Dhruv:"MIN",Marsh:"LAL",Jordan:"HOU",Alan:"OKC",Evan:"NY",LaRosa:"BOS",Jack:"MEM",Mike:"CLE",Danny:"DEN",Auzy:"GS" },
 MLB: { Adam:"HOU",Dhruv:"NYM",Marsh:"LAD",Jordan:"ARI",Alan:"TEX",Evan:"ATL",LaRosa:"BAL",Jack:"NYY",Mike:"PHI",Danny:"SD",Auzy:"BOS" },
 NHL: { Adam:"OTT",Dhruv:"DAL",Marsh:"CAR",Jordan:"WPG",Alan:"EDM",Evan:"COL",LaRosa:"TOR",Jack:"FLA",Mike:"VGK",Danny:"TB",Auzy:"WSH" },
 MLS: { Adam:"Inter Miami CF",Dhruv:"LA Galaxy",Marsh:"New York Red Bulls",Jordan:"Seattle Sounders FC",Alan:"FC Cincinnati",Evan:"Atlanta United FC",LaRosa:"Los Angeles FC",Jack:"Columbus Crew",Mike:"Philadelphia Union",Danny:"San Diego FC",Auzy:"Vancouver Whitecaps FC" },
 F1: { Adam:"antonelli",Dhruv:"verstappen",Marsh:"hamilton",Jordan:"leclerc",Alan:"piastri",Evan:"albon",LaRosa:"norris",Jack:"russell",Mike:"sainz",Danny:"alonso",Auzy:"lawson" },
 NCAAF: { Adam:"Texas",Dhruv:"LSU",Marsh:"Penn St",Jordan:"Notre Dame",Alan:"Oregon",Evan:"Alabama",LaRosa:"Ohio St",Jack:"Miami",Mike:"Ole Miss",Danny:"Clemson",Auzy:"Georgia" },
 NCAABB: { Adam:"Michigan St",Dhruv:"Duke",Marsh:"Tennessee",Jordan:"Houston",Alan:"Auburn",Evan:"Alabama",LaRosa:"Florida",Jack:"St John's",Mike:"Texas Tech",Danny:"Gonzaga",Auzy:"Arizona" },
};

const ESPN_URLS = {
 NFL: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams",
 NBA: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams",
 MLB: "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams",
 NHL: "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams",
 MLS: "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/teams",
};

const MEMBERS = ["Adam","Dhruv","Marsh","Jordan","Alan","Evan","LaRosa","Jack","Mike","Danny","Auzy"];

async function fetchESPN(url) {
 const r = await fetch(url);
 if (!r.ok) return {};
 const d = await r.json();
 const teams = d?.sports?.[0]?.leagues?.[0]?.teams || [];
 const out = {};
 teams.forEach(({ team: t }) => {
  const rec = t.record?.items?.[0];
  const w = rec?.stats?.find(s => s.name === "wins")?.value || 0;
  const l = rec?.stats?.find(s => s.name === "losses")?.value || 0;
  const ti = rec?.stats?.find(s => s.name === "ties")?.value || 0;
  const gp = w + l + ti;
  const entry = { name: t.displayName, winPct: gp > 0 ? (w + ti * 0.5) / gp : 0, record: rec?.summary || `${w}-${l}` };
  out[t.abbreviation] = entry;
  out[t.displayName] = entry;
  if (t.shortDisplayName) out[t.shortDisplayName] = entry;
 });
 return out;
}

async function fetchF1() {
 const r = await fetch("https://api.jolpi.ca/ergast/f1/current/driverStandings.json");
 if (!r.ok) return {};
 const d = await r.json();
 const out = {};
 (d?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings || []).forEach(s => {
  out[s.Driver.driverId] = { name: `${s.Driver.givenName} ${s.Driver.familyName}`, points: parseFloat(s.points), team: s.Constructors?.[0]?.name || "" };
 });
 return out;
}

async function fetchRankings(url) {
 const r = await fetch(url);
 if (!r.ok) return {};
 const d = await r.json();
 const ap = d?.rankings?.find(r => r.name?.includes("AP")) || d?.rankings?.[0];
 if (!ap) return {};
 const out = {};
 (ap.ranks || []).forEach(r => {
  const t = r.team;
  const entry = { name: t.location, rank: r.current, points: r.points || (26 - r.current), record: r.recordSummary || "" };
  out[t.location] = entry;
  if (t.abbreviation) out[t.abbreviation] = entry;
  if (t.nickname) out[t.nickname] = entry;
  if (t.shortDisplayName) out[t.shortDisplayName] = entry;
 });
 return out;
}

function findPick(data, pick) {
 if (!data || !pick) return null;
 if (data[pick]) return data[pick];
 const lp = pick.toLowerCase();
 for (const [k, v] of Object.entries(data)) {
  if (k.toLowerCase().includes(lp) || lp.includes(k.toLowerCase())) return v;
 }
 return null;
}

function scoreCategory(league, data, getValue) {
 const picks = DRAFT[league];
 if (!picks) return [];
 const vals = MEMBERS.map(m => {
  const pick = picks[m];
  const match = findPick(data, pick);
  return { member: m, pick: match?.name || pick, value: getValue(match), record: match?.record || "", metric: "" };
 });
 // Roti scoring
 const sorted = [...vals].sort((a, b) => b.value - a.value);
 return sorted.map((v, i) => ({ ...v, baseline: sorted.length - i, rank: i + 1 }));
}

module.exports = async function handler(req, res) {
 if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
  return res.status(401).json({ error: "Unauthorized" });
 }

 const log = [];

 // ESPN leagues
 for (const [league, url] of Object.entries(ESPN_URLS)) {
  try {
   const data = await fetchESPN(url);
   const scored = scoreCategory(league, data, m => m?.winPct || 0);
   scored.forEach(s => { s.metric = `${((findPick(data, DRAFT[league][s.member])?.winPct || 0) * 100).toFixed(1)}%`; });

   const rows = scored.map(s => ({
    category: league, member: s.member, pick: s.pick,
    baseline: s.baseline, bonus: 0, metric: s.metric,
    raw_value: s.value, record: s.record, source: "ESPN",
    updated_at: new Date().toISOString()
   }));

   const { error } = await supabase.from('scores').upsert(rows, { onConflict: 'category,member' });
   log.push({ league, status: error ? "error" : "ok", count: rows.length, error: error?.message });
  } catch (e) {
   log.push({ league, status: "error", error: e.message });
  }
 }

 // F1
 try {
  const data = await fetchF1();
  const scored = scoreCategory("F1", data, m => m?.points || 0);
  scored.forEach(s => {
   const d = findPick(data, DRAFT.F1[s.member]);
   s.metric = d ? `${d.points} pts` : "";
   s.record = d?.team || "";
  });
  const rows = scored.map(s => ({
   category: "F1", member: s.member, pick: s.pick,
   baseline: s.baseline, bonus: 0, metric: s.metric,
   raw_value: s.value, record: s.record, source: "Jolpica F1",
   updated_at: new Date().toISOString()
  }));
  const { error } = await supabase.from('scores').upsert(rows, { onConflict: 'category,member' });
  log.push({ league: "F1", status: error ? "error" : "ok", count: rows.length });
 } catch (e) {
  log.push({ league: "F1", status: "error", error: e.message });
 }

 // NCAAF
 try {
  const data = await fetchRankings("https://site.api.espn.com/apis/site/v2/sports/football/college-football/rankings");
  const scored = scoreCategory("NCAAF", data, m => m?.points || 0);
  scored.forEach(s => {
   const d = findPick(data, DRAFT.NCAAF[s.member]);
   s.metric = d ? `#${d.rank} (${d.points} pts)` : "Unranked";
  });
  const rows = scored.map(s => ({
   category: "NCAAF", member: s.member, pick: s.pick,
   baseline: s.baseline, bonus: 0, metric: s.metric,
   raw_value: s.value, record: s.record || "", source: "ESPN Rankings",
   updated_at: new Date().toISOString()
  }));
  const { error } = await supabase.from('scores').upsert(rows, { onConflict: 'category,member' });
  log.push({ league: "NCAAF", status: error ? "error" : "ok", count: rows.length });
 } catch (e) {
  log.push({ league: "NCAAF", status: "error", error: e.message });
 }

 // NCAABB
 try {
  const data = await fetchRankings("https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/rankings");
  const scored = scoreCategory("NCAABB", data, m => m?.points || 0);
  scored.forEach(s => {
   const d = findPick(data, DRAFT.NCAABB[s.member]);
   s.metric = d ? `#${d.rank} (${d.points} pts)` : "Unranked";
  });
  const rows = scored.map(s => ({
   category: "NCAABB", member: s.member, pick: s.pick,
   baseline: s.baseline, bonus: 0, metric: s.metric,
   raw_value: s.value, record: s.record || "", source: "ESPN Rankings",
   updated_at: new Date().toISOString()
  }));
  const { error } = await supabase.from('scores').upsert(rows, { onConflict: 'category,member' });
  log.push({ league: "NCAABB", status: error ? "error" : "ok", count: rows.length });
 } catch (e) {
  log.push({ league: "NCAABB", status: "error", error: e.message });
 }

 return res.status(200).json({ message: "Sports cron complete", log, timestamp: new Date().toISOString() });
};