/**
 * Persists commissioner Settings edits to Supabase.
 *
 * Before this, handleSettingsSave (App.jsx) only wrote locks and paywalls.
 * Every other Settings edit (base/bonus, bonus notes, pick swaps, and the
 * detail rows: playoff rounds, films, songs, Grammys, majors/GPs) lived
 * only in React state + the localStorage cache, and the next live load
 * silently replaced it with whatever the database still had.
 *
 * Approach: diff the season object before and after the edit, then write
 * only what changed.
 *  - picks columns (pick, base, bonus, bonus_note) through the existing
 *    commissioner RLS policy on `picks` (phase11). A base/bonus change is
 *    conditioned on the value the commissioner was looking at, the same
 *    optimistic-concurrency pattern the crons use, so a stale screen can't
 *    clobber a score a cron moved in the meantime.
 *  - detail rows through the replace_pick_detail_rows RPC (phase23):
 *    that pick's rows in that table are replaced as a whole, in one
 *    transaction. Before replacing, the rows currently in the database
 *    are compared with what the commissioner was editing; if they differ
 *    (a cron rewrote them since the page loaded), nothing is written and
 *    the caller gets an error asking for a reload, rather than wiping the
 *    cron's newer rows.
 *
 * Pure diffing (diffSeasonEdits) is separate from I/O (persistSeasonEdits)
 * so the diff can be tested without a database.
 */

// detailedData array key → table + row mapping. `toDb` mirrors, in
// reverse, the reader in storage.js's fetchSeasonFromSupabase; `fromDb`
// mirrors that reader exactly, so a row read from the database and a row
// from the UI normalize to the same shape for comparison.
// `compareSkip`: derived fields that Settings recomputes locally (film
// score = box office × RT%), excluded when deciding whether a row
// changed or whether the database moved underneath us.
const nullIfEmpty = (v) => (v === undefined || v === null || v === "" ? null : v);
const num = (v) => Number(v) || 0;
// The reader shows a null text column as "—"; write that placeholder back
// as null rather than storing the literal dash.
const dashNull = (v) => (v === "\u2014" ? null : nullIfEmpty(v));

export const DETAIL_TABLES = {
  rounds: {
    table: "sport_rounds",
    orderCol: "round_order",
    cols: ["round_name", "opponent", "result", "series", "pts", "note", "round_order"],
    isPlaceholder: (r) => r.round === "New Round" && r.opponent === "TBD" && !num(r.pts),
    toDb: (r, i) => ({ round_name: r.round, opponent: nullIfEmpty(r.opponent), result: dashNull(r.result), series: dashNull(r.series), pts: num(r.pts), note: nullIfEmpty(r.note), round_order: i + 1 }),
    fromDb: (r) => ({ round: r.round_name, opponent: r.opponent || "", result: r.result || "—", series: r.series || "—", pts: num(r.pts), note: r.note || "" }),
    compareSkip: [],
  },
  films: {
    table: "film_entries",
    orderCol: null,
    cols: ["title", "release_date", "box_office", "rotten_tom", "score", "note"],
    isPlaceholder: (f) => f.title === "New Film" && !num(f.bo) && !num(f.rt),
    toDb: (f) => ({ title: f.title, release_date: f.date || "", box_office: num(f.bo), rotten_tom: num(f.rt), score: num(f.score), note: nullIfEmpty(f.note) }),
    fromDb: (f) => ({ title: f.title, date: f.release_date || "", bo: num(f.box_office), rt: num(f.rotten_tom), score: num(f.score), note: f.note || undefined }),
    compareSkip: ["score"],
  },
  songs: {
    table: "music_songs",
    orderCol: null,
    cols: ["title", "weeks", "num_one_weeks", "note"],
    isPlaceholder: (s) => s.title === "New Song" && !num(s.weeks) && !num(s.numOneWeeks),
    toDb: (s) => ({ title: s.title, weeks: num(s.weeks), num_one_weeks: num(s.numOneWeeks), note: nullIfEmpty(s.note) }),
    fromDb: (s) => ({ title: s.title, weeks: num(s.weeks), numOneWeeks: num(s.num_one_weeks), note: s.note || undefined }),
    compareSkip: [],
  },
  grammys: {
    table: "music_grammys",
    orderCol: null,
    cols: ["category", "result", "entry", "pts", "note"],
    isPlaceholder: (g) => g.category === "New Category" && !num(g.pts) && !g.entry,
    toDb: (g) => ({ category: g.category, result: g.result, entry: nullIfEmpty(g.entry), pts: num(g.pts), note: nullIfEmpty(g.note) }),
    fromDb: (g) => ({ category: g.category, result: g.result, entry: g.entry || "", pts: num(g.pts), note: g.note || "" }),
    compareSkip: [],
  },
  majors: {
    table: "event_majors",
    orderCol: "event_order",
    cols: ["event_name", "result", "opponent", "score", "pts", "note", "event_order"],
    isPlaceholder: (m) => m.event === "New Event" && !num(m.pts),
    toDb: (m, i) => ({ event_name: m.event, result: dashNull(m.result), opponent: dashNull(m.opponent), score: dashNull(m.score), pts: num(m.pts), note: nullIfEmpty(m.note), event_order: i + 1 }),
    fromDb: (m) => ({ event: m.event_name, result: m.result || "—", opponent: m.opponent || "—", score: m.score || "—", pts: num(m.pts), note: m.note || "" }),
    compareSkip: [],
  },
};

// "+ Add" in Settings creates a blank template row (SeasonSettings.jsx's
// newDetailRow) and saves right away. Those blanks are kept out of the
// database, so a half-finished "New Film, $0, 0%" row never shows up on
// the public Scoreboard or survives a cron run. Once its fields are
// filled in it stops matching the template and is written like any row.
function realRows(spec, rows) { return (rows || []).filter((r) => !spec.isPlaceholder(r)); }

// Comparable signature of a UI row: its DB form minus derived fields and
// minus the order column (order is compared by array position instead).
function rowSig(spec, row) {
  const db = spec.toDb(row, 0);
  if (spec.orderCol) delete db[spec.orderCol];
  spec.compareSkip.forEach((k) => delete db[k]);
  return JSON.stringify(db);
}

// Ordered tables compare in order (moving a row is a change); unordered
// tables compare as multisets, since the database hands them back in no
// guaranteed order.
function sameRows(spec, a, b) {
  const sa = (a || []).map((r) => rowSig(spec, r));
  const sb = (b || []).map((r) => rowSig(spec, r));
  if (sa.length !== sb.length) return false;
  if (!spec.orderCol) { sa.sort(); sb.sort(); }
  return sa.every((s, i) => s === sb[i]);
}

/**
 * @returns {{ pickUpdates: Array, detailReplacements: Array }}
 *  pickUpdates: { category, owner, changes: {pick?, base?, bonus?, bonus_note?}, prev: {base, bonus} }
 *  detailReplacements: { category, owner, key, table, prevRows, nextRows }
 */
export function diffSeasonEdits(prev, next) {
  const pickUpdates = [];
  const detailReplacements = [];
  if (!prev || !next || prev === next) return { pickUpdates, detailReplacements };

  const cats = new Set([...Object.keys(next.categories || {}), ...Object.keys(next.detailedData || {})]);
  cats.forEach((cat) => {
    const owners = new Set([
      ...((next.categories || {})[cat] || []).map((x) => x.owner),
      ...((next.detailedData || {})[cat] || []).map((x) => x.owner),
    ]);
    owners.forEach((owner) => {
      const pc = ((prev.categories || {})[cat] || []).find((x) => x.owner === owner);
      const nc = ((next.categories || {})[cat] || []).find((x) => x.owner === owner);
      const pd = ((prev.detailedData || {})[cat] || []).find((x) => x.owner === owner);
      const nd = ((next.detailedData || {})[cat] || []).find((x) => x.owner === owner);

      const changes = {};
      if (pc && nc) {
        if (nc.pick !== pc.pick && String(nc.pick || "").trim()) changes.pick = nc.pick;
        if (num(nc.base) !== num(pc.base)) changes.base = num(nc.base);
        if (num(nc.bonus) !== num(pc.bonus)) changes.bonus = num(nc.bonus);
      }
      if (pd && nd && (nd.bonusNote || "") !== (pd.bonusNote || "")) changes.bonus_note = nd.bonusNote || null;
      if (Object.keys(changes).length > 0) {
        pickUpdates.push({ category: cat, owner, changes, prev: { pick: pc ? pc.pick : null, base: pc ? num(pc.base) : null, bonus: pc ? num(pc.bonus) : null } });
      }

      if (pd && nd) {
        Object.keys(DETAIL_TABLES).forEach((key) => {
          if (!Array.isArray(nd[key]) && !Array.isArray(pd[key])) return;
          const spec = DETAIL_TABLES[key];
          const prevRows = realRows(spec, pd[key]);
          const nextRows = realRows(spec, nd[key]);
          if (sameRows(spec, prevRows, nextRows)) return;
          detailReplacements.push({ category: cat, owner, key, table: spec.table, prevRows, nextRows });
        });
      }
    });
  });
  return { pickUpdates, detailReplacements };
}

/**
 * Writes a diff from diffSeasonEdits. `client` must be the authenticated
 * Supabase client (the commissioner's session), not supabasePublic.
 * Resolves to { written, failures: [message] }; never throws for a
 * per-item failure, so one bad row doesn't stop the rest.
 */
export async function persistSeasonEdits(client, season, diff) {
  const failures = [];
  let written = 0;
  if (!diff.pickUpdates.length && !diff.detailReplacements.length) return { written, failures };

  // Settings addresses rows by (category, owner name); the database by
  // pick id. Resolve once per save.
  const { data: picks, error: pickErr } = await client
    .from("picks").select("id, category, member_id").eq("season_year", season.year);
  if (pickErr || !picks) {
    return { written, failures: ["couldn't look up picks (" + (pickErr ? pickErr.message : "no data") + ")"] };
  }
  const memberIdByName = {};
  (season.members || []).forEach((m) => { memberIdByName[m.name] = m.id; });
  const pickIdFor = (cat, owner) => {
    const memberId = memberIdByName[owner] || owner;
    const p = picks.find((x) => x.category === cat && x.member_id === memberId);
    return p ? p.id : null;
  };

  for (const u of diff.pickUpdates) {
    const label = u.category + " / " + u.owner;
    const pickId = pickIdFor(u.category, u.owner);
    if (!pickId) { failures.push(label + ": pick not found"); continue; }
    let q = client.from("picks").update({ ...u.changes, updated_at: new Date().toISOString() }).eq("id", pickId);
    // Every changed field is conditioned on the value it's replacing, pick
    // swaps included: two quick swaps (A→B, then B→C) can reach the
    // database out of order, and without this the older B would land last
    // and silently win while the screen showed C.
    if ("pick" in u.changes && u.prev.pick !== null) q = q.eq("pick", u.prev.pick);
    if ("base" in u.changes && u.prev.base !== null) q = q.eq("base", u.prev.base);
    if ("bonus" in u.changes && u.prev.bonus !== null) q = q.eq("bonus", u.prev.bonus);
    const { data, error } = await q.select("id");
    if (error) failures.push(label + ": " + error.message);
    else if (!data || data.length === 0) failures.push(label + ": this pick changed on the server since this page loaded. Reload and redo this edit");
    else written++;
  }

  for (const r of diff.detailReplacements) {
    const label = r.category + " / " + r.owner + " (" + r.key + ")";
    const pickId = pickIdFor(r.category, r.owner);
    if (!pickId) { failures.push(label + ": pick not found"); continue; }
    const spec = DETAIL_TABLES[r.key];

    // Refuse to overwrite rows a cron changed after this page loaded.
    let cur = client.from(spec.table).select("*").eq("pick_id", pickId);
    if (spec.orderCol) cur = cur.order(spec.orderCol);
    const { data: current, error: curErr } = await cur;
    if (curErr) { failures.push(label + ": " + curErr.message); continue; }
    if (!sameRows(spec, (current || []).map(spec.fromDb), r.prevRows)) {
      failures.push(label + ": rows changed on the server since this page loaded. Reload and redo this edit");
      continue;
    }

    const rows = r.nextRows.map((row, i) => spec.toDb(row, i));
    // The rows just read and compared above, sent back so the RPC can
    // re-check them under a row lock in the same transaction as the
    // replace. That closes the gap between this read and the write.
    const expected = (current || []).map((row) => {
      const o = {};
      spec.cols.forEach((c) => { o[c] = row[c] === undefined ? null : row[c]; });
      return o;
    });
    const { error } = await client.rpc("replace_pick_detail_rows", { p_table: spec.table, p_pick_id: String(pickId), p_rows: rows, p_expected: expected });
    if (error) failures.push(label + ": " + error.message);
    else written++;
  }
  return { written, failures };
}
