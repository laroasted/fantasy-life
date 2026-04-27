// Fantasy Life Hub — Draft Recap
// Shows the snake draft order with live scores from Supabase.
// Three sub-views: Draft Order, Member Report Card, Category Breakdown.
//
// Draft board data is read from the `draft_board` JSONB column on the
// `seasons` table. The 2026 board is also hardcoded as a fallback.
// Future seasons auto-populate when DraftTool saves on finalize.
 
import { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "../utils/storage";
import { theme, cardStyle } from "../constants/theme";
import { MEMBER_COLORS } from "../constants/members";
 
// ═══════════════════════════════════════════════════════════════════
// HARDCODED FALLBACK — only used if seasons.draft_board is null
// ═══════════════════════════════════════════════════════════════════
 
const FALLBACK_BOARDS = {
  2026: {
    memberOrder: ["jordan","jack","larosa","marsh","alan","dhruv","danny","mike","auzy","adam","evan","scott"],
    board: {
      jordan: ["Tennis","Golf","NFL","F1","NCAAF","MLB","MLS","NCAAB","Musician","Actor","NBA","Actress","NHL","Stock","Country"],
      jack:   ["Golf","NHL","MLS","NBA","Actress","F1","Actor","Tennis","MLB","NCAAF","Musician","Country","NFL","NCAAB","Stock"],
      larosa: ["Tennis","NBA","NHL","NFL","F1","NCAAF","NCAAB","Golf","MLS","Musician","Country","Actor","Actress","Stock","MLB"],
      marsh:  ["Golf","NBA","NFL","Tennis","NCAAF","Actress","NCAAB","MLB","Actor","NHL","MLS","Musician","Country","F1","Stock"],
      alan:   ["F1","NBA","NCAAB","MLB","Musician","Actor","NFL","Actress","NCAAF","Tennis","NHL","Country","MLS","Stock","Golf"],
      dhruv:  ["Golf","NCAAF","NCAAB","NFL","NHL","MLB","Musician","Actor","Actress","Country","Tennis","MLS","F1","Stock","NBA"],
      danny:  ["Tennis","NHL","NFL","F1","NCAAB","Musician","NCAAF","MLB","NBA","MLS","Golf","Actor","Actress","Stock","Country"],
      mike:   ["Musician","NCAAF","Golf","MLB","Actor","MLS","Actress","Tennis","Country","NBA","NCAAB","NFL","NHL","Stock","F1"],
      auzy:   ["MLB","F1","MLS","NFL","Country","NHL","Golf","NBA","Actor","Actress","NCAAF","Musician","NCAAB","Tennis","Stock"],
      adam:   ["NBA","MLS","NCAAF","NCAAB","Tennis","NHL","Golf","Country","F1","Musician","Actor","NFL","MLB","Actress","Stock"],
      evan:   ["Tennis","Actress","MLB","NBA","Golf","Actor","NFL","NCAAB","F1","NHL","Musician","NCAAF","MLS","Country","Stock"],
      scott:  ["NFL","NCAAB","Musician","F1","NBA","Actor","NHL","MLB","Actress","Golf","Country","MLS","Stock","Tennis","NCAAF"],
    },
  },
};
 
const ALL_CATS = ["NFL","NBA","MLB","NHL","NCAAF","NCAAB","Tennis","Golf","F1","MLS","Actor","Actress","Musician","Country","Stock"];
const CAT_ICONS = { NFL:"🏈", NBA:"🏀", MLB:"⚾", NHL:"🏒", NCAAF:"🏟️", NCAAB:"🎓", Tennis:"🎾", Golf:"⛳", F1:"🏎️", MLS:"⚽", Actor:"🎬", Actress:"💫", Musician:"🎵", Country:"🌍", Stock:"📈" };
 
// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════
 
function buildSnakeOrder(draftBoard) {
  const { memberOrder, board } = draftBoard;
  const numMembers = memberOrder.length;
  const numRounds = board[memberOrder[0]].length;
  const picks = [];
  let pickNum = 1;
  for (let r = 0; r < numRounds; r++) {
    const fwd = r % 2 === 0;
    for (let i = 0; i < numMembers; i++) {
      const mIdx = fwd ? i : numMembers - 1 - i;
      const mid = memberOrder[mIdx];
      const cat = board[mid][r];
      picks.push({ pickNum, round: r + 1, memberId: mid, category: cat });
      pickNum++;
    }
  }
  return picks;
}
 
function buildRoundLookup(draftBoard) {
  const lookup = {};
  const { memberOrder, board } = draftBoard;
  memberOrder.forEach(mid => {
    lookup[mid] = {};
    board[mid].forEach((cat, i) => { lookup[mid][cat] = i + 1; });
  });
  return lookup;
}
 
function getPointsColor(pts) {
  if (pts === null || pts === undefined) return theme.dim;
  if (pts >= 15) return "#22c55e";
  if (pts >= 10) return "#4ade80";
  if (pts >= 6) return "#facc15";
  if (pts >= 3) return "#fb923c";
  return "#ef4444";
}
 
const ROUND_COLORS = [
  "", "#22c55e","#3bdb72","#5ee89a","#86efac","#bef264",
  "#facc15","#fbbf24","#fb923c","#f97316","#ef4444",
  "#dc2626","#b91c1c","#991b1b","#7c3aed","#6d28d9"
];
 
// ═══════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════
 
export default function DraftRecap({ seasonYear = 2026 }) {
  const [view, setView] = useState("draft");
  const [selMember, setSelMember] = useState(null);
  const [selCat, setSelCat] = useState("NFL");
  const [filterRound, setFilterRound] = useState("All");
  const [picks, setPicks] = useState([]);
  const [members, setMembers] = useState([]);
  const [draftBoard, setDraftBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
 
  // ── Fetch draft board, picks, and members from Supabase ──
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [
          { data: seasonData, error: sErr },
          { data: pickData, error: pErr },
          { data: memberData, error: mErr },
        ] = await Promise.all([
          supabase.from("seasons").select("draft_board").eq("year", seasonYear).single(),
          supabase.from("picks").select("member_id, category, pick, total").eq("season_year", seasonYear),
          supabase.from("members").select("id, name, color"),
        ]);
        if (pErr) throw new Error(pErr.message);
        if (mErr) throw new Error(mErr.message);
        if (!cancelled) {
          setPicks(pickData || []);
          setMembers(memberData || []);
          // Use Supabase draft_board if available, else fall back to hardcoded
          const board = seasonData?.draft_board || FALLBACK_BOARDS[seasonYear] || null;
          setDraftBoard(board);
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [seasonYear]);
 
  // ── Derived data ──
  const memberNameMap = useMemo(() => {
    const m = {};
    members.forEach(mem => { m[mem.id] = mem.name; });
    return m;
  }, [members]);
 
  const memberColorMap = useMemo(() => {
    const m = {};
    members.forEach(mem => { m[mem.id] = mem.color || MEMBER_COLORS[mem.id] || "#64748b"; });
    return m;
  }, [members]);
 
  const pickLookup = useMemo(() => {
    const m = {};
    picks.forEach(p => {
      if (!m[p.member_id]) m[p.member_id] = {};
      m[p.member_id][p.category] = { pick: p.pick, total: p.total };
    });
    return m;
  }, [picks]);
 
  const snakeOrder = useMemo(() => {
    if (!draftBoard) return [];
    return buildSnakeOrder(draftBoard);
  }, [draftBoard]);
 
  const roundLookup = useMemo(() => {
    if (!draftBoard) return {};
    return buildRoundLookup(draftBoard);
  }, [draftBoard]);
 
  // Default selected member
  useEffect(() => {
    if (draftBoard && !selMember) {
      setSelMember(draftBoard.memberOrder[0]);
    }
  }, [draftBoard, selMember]);
 
  // Build pickNum lookup: memberId+category → overall pick number
  const pickNumLookup = useMemo(() => {
    const m = {};
    snakeOrder.forEach(s => {
      m[s.memberId + "|" + s.category] = s.pickNum;
    });
    return m;
  }, [snakeOrder]);
 
  // ── Enriched snake picks ──
  const enrichedSnake = useMemo(() => {
    return snakeOrder.map(s => {
      const pl = pickLookup[s.memberId]?.[s.category];
      return { ...s, pick: pl?.pick || "—", total: pl?.total ?? null, member: memberNameMap[s.memberId] || s.memberId };
    });
  }, [snakeOrder, pickLookup, memberNameMap]);
 
  // ── Member Report Card ──
  const memberCard = useMemo(() => {
    if (!selMember || !roundLookup[selMember]) return [];
    return ALL_CATS.map(cat => {
      const round = roundLookup[selMember]?.[cat] ?? "—";
      const pl = pickLookup[selMember]?.[cat];
      const pickNum = pickNumLookup[selMember + "|" + cat] ?? 999;
      return { category: cat, pick: pl?.pick || "—", total: pl?.total ?? null, round, pickNum };
    }).sort((a, b) => a.pickNum - b.pickNum);
  }, [selMember, roundLookup, pickLookup, pickNumLookup]);
 
  // ── Category Breakdown ──
  const catBreakdown = useMemo(() => {
    if (!draftBoard) return [];
    return draftBoard.memberOrder.map(mid => {
      const round = roundLookup[mid]?.[selCat] ?? 99;
      const pl = pickLookup[mid]?.[selCat];
      const pickNum = pickNumLookup[mid + "|" + selCat] ?? 999;
      return { memberId: mid, member: memberNameMap[mid] || mid, pick: pl?.pick || "—", total: pl?.total ?? null, round, pickNum };
    }).sort((a, b) => a.pickNum - b.pickNum);
  }, [draftBoard, selCat, roundLookup, pickLookup, pickNumLookup, memberNameMap]);
 
  // ── Filtered draft order ──
  const draftFiltered = useMemo(() => {
    return enrichedSnake.filter(p => filterRound === "All" || p.round === parseInt(filterRound));
  }, [enrichedSnake, filterRound]);
 
  // ── Styles ──
  const pill = (active) => ({
    padding: "8px 16px", borderRadius: 20, border: "none", cursor: "pointer",
    fontSize: 13, fontWeight: active ? 700 : 500,
    background: active ? theme.acc : theme.card,
    color: active ? "#fff" : theme.mut,
    transition: "all 0.15s",
  });
 
  const memberBtn = (mid, selected) => ({
    padding: "6px 12px", borderRadius: 8, cursor: "pointer",
    fontSize: 12, fontWeight: selected ? 700 : 500, border: "none",
    background: selected ? `${memberColorMap[mid]}20` : theme.card,
    color: selected ? memberColorMap[mid] : theme.mut,
    outline: selected ? `2px solid ${memberColorMap[mid]}50` : "none",
    outlineOffset: -2, transition: "all 0.15s",
  });
 
  const roundBadge = (r) => {
    const c = ROUND_COLORS[r] || theme.mut;
    return {
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      minWidth: 26, height: 26, borderRadius: 7, fontSize: 11, fontWeight: 800,
      background: `${c}18`, color: c, border: `1.5px solid ${c}35`, flexShrink: 0,
    };
  };
 
  // ── Loading / Error / No data ──
  if (loading) {
    return (
      <div style={{ textAlign: "center", padding: 60, color: theme.dim }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>📋</div>
        <div style={{ fontSize: 14 }}>Loading draft data...</div>
      </div>
    );
  }
 
  if (error) {
    return (
      <div style={{ textAlign: "center", padding: 60, color: theme.red }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>⚠️</div>
        <div style={{ fontSize: 14 }}>Failed to load: {error}</div>
      </div>
    );
  }
 
  if (!draftBoard) {
    return (
      <div style={{ textAlign: "center", padding: 60, color: theme.dim }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>📋</div>
        <div style={{ fontSize: 14 }}>No draft board data available for {seasonYear}.</div>
        <div style={{ fontSize: 12, marginTop: 4, color: theme.mut }}>
          Draft board data is saved automatically when a draft is finalized.
        </div>
      </div>
    );
  }
 
  const numMembers = draftBoard.memberOrder.length;
  const numRounds = draftBoard.board[draftBoard.memberOrder[0]].length;
  const totalPicks = numMembers * numRounds;
 
  return (
    <div style={{ maxWidth: 860, margin: "0 auto" }}>
      {/* ── Header ── */}
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        <h2 style={{ fontSize: 26, fontWeight: 800, margin: 0, color: "#f8fafc" }}>
          {seasonYear} Draft Recap
        </h2>
        <p style={{ fontSize: 12, color: theme.dim, margin: "4px 0 0" }}>
          {numMembers} members · {numRounds} rounds · {totalPicks} picks · snake format
        </p>
      </div>
 
      {/* ── View Tabs ── */}
      <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 24, flexWrap: "wrap" }}>
        <button onClick={() => setView("draft")} style={pill(view === "draft")}>📜 Draft Order</button>
        <button onClick={() => setView("member")} style={pill(view === "member")}>🪪 Report Card</button>
        <button onClick={() => setView("category")} style={pill(view === "category")}>📊 By Category</button>
      </div>
 
      {/* ═══════════ DRAFT ORDER ═══════════ */}
      {view === "draft" && (
        <div>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
            <select value={filterRound} onChange={e => setFilterRound(e.target.value)}
              style={{ ...cardStyle, padding: "8px 14px", fontSize: 13, color: theme.txt, cursor: "pointer", outline: "none" }}>
              <option value="All">All Rounds</option>
              {Array.from({ length: numRounds }, (_, i) => <option key={i} value={i + 1}>Round {i + 1}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {draftFiltered.map((p, idx) => {
              const prev = idx > 0 ? draftFiltered[idx - 1].round : null;
              const isStart = p.round !== prev;
              const ptsColor = getPointsColor(p.total);
              return (
                <div key={p.pickNum}>
                  {isStart && filterRound === "All" && (
                    <div style={{ padding: "14px 0 6px", display: "flex", alignItems: "center", gap: 10,
                      borderTop: p.round > 1 ? `1px solid ${theme.bdr}` : "none", marginTop: p.round > 1 ? 8 : 0 }}>
                      <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 3, color: theme.mut }}>ROUND {p.round}</span>
                      <span style={{ fontSize: 10, color: theme.dim }}>{p.round % 2 === 1 ? "↓" : "↑ snake"}</span>
                    </div>
                  )}
                  <div style={{
                    display: "grid", gridTemplateColumns: "38px 72px 1fr 68px 54px",
                    alignItems: "center", gap: 6, padding: "7px 10px", borderRadius: 8,
                    background: idx % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent",
                  }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: theme.dim, fontVariantNumeric: "tabular-nums" }}>
                      {String(p.pickNum).padStart(3, "0")}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: memberColorMap[p.memberId] || theme.txt, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.member}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: theme.txt, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.pick}
                    </span>
                    <span style={{ fontSize: 10, color: theme.mut, whiteSpace: "nowrap" }}>
                      {CAT_ICONS[p.category]} {p.category}
                    </span>
                    <div style={{ textAlign: "right" }}>
                      <span style={{ fontSize: 13, fontWeight: 800, color: ptsColor, fontVariantNumeric: "tabular-nums" }}>
                        {p.total !== null ? p.total : "—"}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
 
      {/* ═══════════ MEMBER REPORT CARD ═══════════ */}
      {view === "member" && (
        <div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center", marginBottom: 20 }}>
            {draftBoard.memberOrder.map(mid => (
              <button key={mid} onClick={() => setSelMember(mid)} style={memberBtn(mid, selMember === mid)}>
                {memberNameMap[mid] || mid}
              </button>
            ))}
          </div>
          {selMember && (
            <div style={{ textAlign: "center", marginBottom: 16 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: memberColorMap[selMember] }}>
                {memberNameMap[selMember]}'s Draft
              </div>
              <div style={{ fontSize: 12, color: theme.dim, marginTop: 2 }}>
                #{draftBoard.memberOrder.indexOf(selMember) + 1} overall pick · sorted by pick order
              </div>
            </div>
          )}
          <div style={{ ...cardStyle, padding: 0, overflow: "hidden" }}>
            <div style={{
              display: "grid", gridTemplateColumns: "34px 40px 72px 1fr 54px",
              padding: "10px 14px", fontSize: 10, fontWeight: 700, color: theme.mut,
              letterSpacing: 1, textTransform: "uppercase", background: "rgba(0,0,0,0.2)",
            }}>
              <span>RD</span><span>PICK</span><span>Category</span><span>Pick</span><span style={{ textAlign: "right" }}>PTS</span>
            </div>
            {memberCard.map((row, i) => {
              const ptsColor = getPointsColor(row.total);
              return (
                <div key={row.category} style={{
                  display: "grid", gridTemplateColumns: "34px 40px 72px 1fr 54px",
                  alignItems: "center", padding: "9px 14px",
                  background: i % 2 === 0 ? "rgba(255,255,255,0.015)" : "transparent",
                  borderTop: `1px solid ${theme.bdr}22`,
                }}>
                  <div style={roundBadge(row.round)}>{row.round}</div>
                  <span style={{ fontSize: 11, fontWeight: 600, color: theme.dim, fontVariantNumeric: "tabular-nums" }}>
                    #{row.pickNum}
                  </span>
                  <span style={{ fontSize: 11, color: theme.dim }}>{CAT_ICONS[row.category]} {row.category}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: theme.txt }}>{row.pick}</span>
                  <div style={{ textAlign: "right" }}>
                    <span style={{ fontSize: 15, fontWeight: 800, color: ptsColor, fontVariantNumeric: "tabular-nums" }}>
                      {row.total !== null ? row.total : "—"}
                    </span>
                  </div>
                </div>
              );
            })}
            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "12px 14px", borderTop: `1px solid ${theme.bdr}`, background: "rgba(0,0,0,0.15)",
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: theme.dim }}>
                Total ({memberCard.filter(r => r.total !== null).length}/{numRounds} scored)
              </span>
              <span style={{ fontSize: 20, fontWeight: 900, color: "#f8fafc", fontVariantNumeric: "tabular-nums" }}>
                {memberCard.some(r => r.total !== null) ? memberCard.reduce((s, r) => s + (r.total || 0), 0) : "—"}
              </span>
            </div>
          </div>
        </div>
      )}
 
      {/* ═══════════ CATEGORY BREAKDOWN ═══════════ */}
      {view === "category" && (
        <div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center", marginBottom: 20 }}>
            {ALL_CATS.map(cat => (
              <button key={cat} onClick={() => setSelCat(cat)} style={pill(selCat === cat)}>
                {CAT_ICONS[cat]} {cat}
              </button>
            ))}
          </div>
          <div style={{ textAlign: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 24, fontWeight: 800 }}>{CAT_ICONS[selCat]} {selCat}</div>
            <div style={{ fontSize: 12, color: theme.dim, marginTop: 2 }}>
              Sorted by draft pick order — who reached and who found late value?
            </div>
          </div>
          <div style={{ ...cardStyle, padding: 0, overflow: "hidden" }}>
            <div style={{
              display: "grid", gridTemplateColumns: "34px 40px 76px 1fr 54px",
              padding: "10px 14px", fontSize: 10, fontWeight: 700, color: theme.mut,
              letterSpacing: 1, textTransform: "uppercase", background: "rgba(0,0,0,0.2)",
            }}>
              <span>RD</span><span>PICK</span><span>Member</span><span>Pick</span><span style={{ textAlign: "right" }}>PTS</span>
            </div>
            {catBreakdown.map((row, i) => {
              const ptsColor = getPointsColor(row.total);
              return (
                <div key={row.memberId} style={{
                  display: "grid", gridTemplateColumns: "34px 40px 76px 1fr 54px",
                  alignItems: "center", padding: "9px 14px",
                  background: i % 2 === 0 ? "rgba(255,255,255,0.015)" : "transparent",
                  borderTop: `1px solid ${theme.bdr}22`,
                }}>
                  <div style={roundBadge(row.round)}>{row.round}</div>
                  <span style={{ fontSize: 11, fontWeight: 600, color: theme.dim, fontVariantNumeric: "tabular-nums" }}>
                    #{row.pickNum}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: memberColorMap[row.memberId] }}>{row.member}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: theme.txt }}>{row.pick}</span>
                  <div style={{ textAlign: "right" }}>
                    <span style={{ fontSize: 15, fontWeight: 800, color: ptsColor, fontVariantNumeric: "tabular-nums" }}>
                      {row.total !== null ? row.total : "—"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          {(() => {
            const scored = catBreakdown.filter(r => r.total !== null);
            if (scored.length === 0) return null;
            const best = [...scored].sort((a, b) => b.total - a.total)[0];
            const earliest = catBreakdown[0];
            return (
              <div style={{ ...cardStyle, marginTop: 12, fontSize: 12, color: theme.dim, lineHeight: 1.8 }}>
                <span style={{ fontWeight: 700, color: theme.txt }}>📝 Insight: </span>
                <span style={{ color: memberColorMap[earliest.memberId], fontWeight: 700 }}>{earliest.member}</span>
                {" "}took {selCat} earliest in Rd {earliest.round}.
                {best && (
                  <> The top scorer is{" "}
                    <span style={{ color: memberColorMap[best.memberId], fontWeight: 700 }}>{best.member}</span>
                    {" "}with {best.total} pts (Rd {best.round})
                    {best.round >= 8 ? " — a late-round steal!" : best.round <= 3 ? " — the early investment paid off." : "."}
                  </>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
 
