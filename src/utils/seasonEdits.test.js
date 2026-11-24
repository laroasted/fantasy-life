import { diffSeasonEdits, persistSeasonEdits } from "./seasonEdits";

const clone = (o) => JSON.parse(JSON.stringify(o));
const DASH = "—";

const prev = {
  year: 2026,
  members: [{ id: "auzy", name: "Auzy" }, { id: "scott", name: "Scott" }],
  categories: {
    F1: [{ owner: "Auzy", pick: "Max Verstappen", base: 11, bonus: 1, total: 12 }],
    Actor: [{ owner: "Scott", pick: "X", base: 5, bonus: 0, total: 5 }],
  },
  detailedData: {
    F1: [{
      owner: "Auzy", pick: "Max Verstappen", base: 11, bonus: 1, bonusNote: "ATX P3 (+1)",
      majors: [
        { event: "Australian GP", result: "Outside P3", opponent: DASH, score: DASH, pts: 0, note: "" },
        { event: "US GP", result: "3rd", opponent: DASH, score: DASH, pts: 1, note: "" },
      ],
    }],
    Actor: [{ owner: "Scott", pick: "X", films: [{ title: "A", date: "", bo: 100, rt: 50, score: 50 }] }],
  },
};

// Rows as the database stores them (nulls where the UI shows "—").
const dbMajors = [
  { id: 1, pick_id: 7, event_name: "Australian GP", result: "Outside P3", opponent: null, score: null, pts: 0, note: null, event_order: 1 },
  { id: 2, pick_id: 7, event_name: "US GP", result: "3rd", opponent: null, score: null, pts: 1, note: "", event_order: 2 },
];

// Minimal chainable stand-in for the supabase-js query builder.
function mockClient(detailRows, calls, currentBonus = 1) {
  return {
    from(table) {
      const q = {
        filters: [], patch: null,
        select() { return q; }, order() { return q; },
        eq(k, v) { q.filters.push([k, v]); return q; },
        update(v) { q.patch = v; return q; },
        then(resolve) {
          if (table === "picks" && !q.patch) {
            return resolve({ data: [{ id: 7, category: "F1", member_id: "auzy" }, { id: 8, category: "Actor", member_id: "scott" }] });
          }
          if (table === "picks") {
            calls.push(["picks.update", q.patch, q.filters]);
            const ok = q.filters.every(([k, v]) => k !== "bonus" || v === currentBonus);
            return resolve({ data: ok ? [{ id: 7 }] : [] });
          }
          return resolve({ data: detailRows });
        },
      };
      return q;
    },
    async rpc(name, args) { calls.push([name, args]); return { error: null }; },
  };
}

function vegasEdit() {
  const next = clone(prev);
  next.categories.F1[0].bonus = 4;
  next.detailedData.F1[0].bonusNote = "ATX P3 (+1) | LV P1 (+3)";
  next.detailedData.F1[0].majors.push({ event: "Las Vegas GP", result: "Winner", opponent: DASH, score: "P1", pts: 3, note: "" });
  return next;
}

test("a recomputed derived field alone is not an edit", () => {
  const next = clone(prev);
  next.detailedData.Actor[0].films[0].score = 49.99;
  const d = diffSeasonEdits(prev, next);
  expect(d.pickUpdates).toHaveLength(0);
  expect(d.detailReplacements).toHaveLength(0);
});

test("score, note and row edits are diffed", () => {
  const d = diffSeasonEdits(prev, vegasEdit());
  expect(d.pickUpdates).toHaveLength(1);
  expect(d.pickUpdates[0].changes).toEqual({ bonus: 4, bonus_note: "ATX P3 (+1) | LV P1 (+3)" });
  expect(d.detailReplacements.map((r) => r.table)).toEqual(["event_majors"]);
});

test("persists picks columns and replaces the pick's rows", async () => {
  const next = vegasEdit();
  const calls = [];
  const r = await persistSeasonEdits(mockClient(dbMajors, calls), next, diffSeasonEdits(prev, next));
  expect(r.failures).toEqual([]);
  expect(r.written).toBe(2);
  const [, update, filters] = calls.find((c) => c[0] === "picks.update");
  expect(update.bonus).toBe(4);
  expect(filters).toContainEqual(["bonus", 1]); // conditioned on what the commissioner saw
  const [, args] = calls.find((c) => c[0] === "replace_pick_detail_rows");
  expect(args.p_table).toBe("event_majors");
  expect(args.p_pick_id).toBe("7");
  expect(args.p_rows).toHaveLength(3);
  expect(args.p_rows[2]).toEqual({ event_name: "Las Vegas GP", result: "Winner", opponent: null, score: "P1", pts: 3, note: null, event_order: 3 });
});

test("refuses to overwrite rows a cron changed after the page loaded", async () => {
  const next = vegasEdit();
  const calls = [];
  const cronAddedRow = { id: 3, pick_id: 7, event_name: "Las Vegas GP", result: "Winner", score: "P1", pts: 3, event_order: 3 };
  const r = await persistSeasonEdits(mockClient([...dbMajors, cronAddedRow], calls), next, diffSeasonEdits(prev, next));
  expect(calls.filter((c) => c[0] === "replace_pick_detail_rows")).toHaveLength(0);
  expect(r.failures.join(" ")).toMatch(/changed on the server/);
});

test("reports a stale score instead of overwriting it", async () => {
  const next = vegasEdit();
  const calls = [];
  const r = await persistSeasonEdits(mockClient(dbMajors, calls, 2), next, diffSeasonEdits(prev, next));
  expect(r.failures.join(" ")).toMatch(/score changed/);
});
