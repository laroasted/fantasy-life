import { useState, useEffect, useMemo, useRef } from "react";
import { supabase } from "../utils/storage";
import { theme, cardStyle } from "../constants/theme";
import { CATEGORY_ORDER, CATEGORY_LABELS } from "../constants/categories";
import { MEMBER_COLORS } from "../constants/members";

// ══════════════════════════════════════════════════════
//  TRENDS — standings-over-time chart, backed by the
//  score_history table (one row/member/category/day,
//  written by api/cron/snapshot-scores.js).
// ══════════════════════════════════════════════════════

const s = theme;
const FALLBACK_COLOR = "#64748b";

function pD(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function fmtShort(str) {
  return pD(str).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function fmtLong(str) {
  return pD(str).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export default function Trends({ seasonData }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [viewCat, setViewCat] = useState("ALL");
  const [hidden, setHidden] = useState(() => new Set());
  const [hoverIdx, setHoverIdx] = useState(null);
  const [showTable, setShowTable] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 640);
  const svgWrapRef = useRef(null);

  const seasonYear = seasonData?.year;
  const members = useMemo(() => seasonData?.members || [], [seasonData]);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!seasonYear) { setLoading(false); return; }
      setLoading(true);
      setError(null);
      const { data, error: err } = await supabase
        .from("score_history")
        .select("snapshot_date, member_id, category, total")
        .eq("season_year", seasonYear)
        .order("snapshot_date");
      if (cancelled) return;
      if (err) { setError(err.message); setLoading(false); return; }
      setRows(data || []);
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [seasonYear]);

  const memberMeta = useMemo(() => {
    const m = {};
    members.forEach((mem) => { m[mem.id] = mem; });
    return m;
  }, [members]);

  // ── date x member x category -> total ──
  const byDate = useMemo(() => {
    const m = new Map();
    rows.forEach((r) => {
      if (viewCat !== "ALL" && r.category !== viewCat) return;
      if (!m.has(r.snapshot_date)) m.set(r.snapshot_date, {});
      const d = m.get(r.snapshot_date);
      const sum = (d[r.member_id] || 0) + (Number(r.total) || 0);
      // Round away float noise from summing decimal totals (e.g. tie-split points).
      d[r.member_id] = Math.round(sum * 100) / 100;
    });
    return m;
  }, [rows, viewCat]);

  const dates = useMemo(() => [...byDate.keys()].sort(), [byDate]);

  // Only chart members who actually have a snapshot row somewhere — a member
  // with none yet (just added, or snapshotting hasn't caught up) would otherwise
  // draw as a flat line at 0 and clutter the legend/tooltip for everyone else.
  const memberIds = useMemo(() => {
    const ids = new Set(rows.map((r) => r.member_id));
    return [...ids];
  }, [rows]);

  const series = useMemo(() => {
    return memberIds
      .map((mid) => ({
        id: mid,
        name: memberMeta[mid]?.name || mid,
        color: MEMBER_COLORS[mid] || FALLBACK_COLOR,
        values: dates.map((d) => byDate.get(d)?.[mid] ?? 0),
      }))
      .sort((a, b) => (b.values[b.values.length - 1] || 0) - (a.values[a.values.length - 1] || 0));
  }, [memberIds, memberMeta, dates, byDate]);

  const visibleSeries = series.filter((sr) => !hidden.has(sr.id));

  const maxVal = useMemo(() => {
    let max = 0;
    visibleSeries.forEach((sr) => sr.values.forEach((v) => { if (v > max) max = v; }));
    return max || 1;
  }, [visibleSeries]);

  function toggleMember(mid) {
    setHidden((prev) => {
      const n = new Set(prev);
      if (n.has(mid)) n.delete(mid); else n.add(mid);
      return n;
    });
  }

  // ── chart geometry ──
  const W = 720, H = isMobile ? 240 : 300;
  const padL = 34, padR = 12, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = dates.length;
  const xFor = (i) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yFor = (v) => padT + plotH - (v / maxVal) * plotH;

  function pathFor(values) {
    return values.map((v, i) => (i === 0 ? "M" : "L") + xFor(i).toFixed(2) + "," + yFor(v).toFixed(2)).join(" ");
  }

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    y: padT + plotH - f * plotH,
    val: Math.round(maxVal * f),
  }));

  const leader = useMemo(() => {
    if (visibleSeries.length === 0 || n === 0) return null;
    let best = null;
    visibleSeries.forEach((sr) => {
      const v = sr.values[n - 1];
      if (!best || v > best.v) best = { id: sr.id, name: sr.name, color: sr.color, v };
    });
    return best;
  }, [visibleSeries, n]);

  function handleMove(e) {
    if (n === 0 || !svgWrapRef.current) return;
    const rect = svgWrapRef.current.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    let idx = Math.round(((relX - padL) / plotW) * (n - 1));
    idx = Math.max(0, Math.min(n - 1, idx));
    setHoverIdx(idx);
  }

  const tableDates = useMemo(() => [...dates].reverse().slice(0, showTable === "all" ? dates.length : 21), [dates, showTable]);

  if (loading) {
    return (
      <div style={{ maxWidth: 800, margin: "0 auto", textAlign: "center", padding: 60, color: s.dim }}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>📈</div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Loading trends...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ maxWidth: 800, margin: "0 auto", textAlign: "center", padding: 60, color: s.red }}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>⚠️</div>
        <div style={{ fontSize: 14 }}>Failed to load trends: {error}</div>
      </div>
    );
  }

  if (n < 2) {
    return (
      <div style={{ maxWidth: 800, margin: "0 auto", ...cardStyle, textAlign: "center", padding: 40 }}>
        <div style={{ fontSize: 40, marginBottom: 10 }}>📈</div>
        <h3 style={{ margin: "0 0 8px", fontSize: 17 }}>Not enough history yet</h3>
        <p style={{ color: s.dim, fontSize: 13, maxWidth: 420, margin: "0 auto" }}>
          Trends build from a daily snapshot of every score. This tab needs at least
          two days of snapshots before a line means anything — check back tomorrow.
        </p>
      </div>
    );
  }

  const hoverDate = hoverIdx !== null ? dates[hoverIdx] : null;
  const hoverRows = hoverDate
    ? visibleSeries
      .map((sr) => ({ id: sr.id, name: sr.name, color: sr.color, v: sr.values[hoverIdx] }))
      .sort((a, b) => b.v - a.v)
    : [];
  const hoverX = hoverIdx !== null ? xFor(hoverIdx) : null;

  return (
    <div style={{ maxWidth: 800, margin: "0 auto" }}>
      {/* Category pills */}
      <div style={{
        display: "flex", flexWrap: isMobile ? "nowrap" : "wrap",
        gap: 4, marginBottom: 16, justifyContent: isMobile ? "flex-start" : "center",
        overflowX: isMobile ? "auto" : "visible", WebkitOverflowScrolling: "touch",
        paddingBottom: isMobile ? 4 : 0, msOverflowStyle: "none", scrollbarWidth: "none",
      }}>
        <button onClick={() => setViewCat("ALL")}
          style={{ padding: "5px 10px", borderRadius: 20, flexShrink: 0,
            border: "1px solid " + (viewCat === "ALL" ? "#3b82f6" : "#334155"),
            background: viewCat === "ALL" ? "#3b82f6" : "#1e293b",
            color: "#f1f5f9", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
          Overall
        </button>
        {CATEGORY_ORDER.map((k) => (
          <button key={k} onClick={() => setViewCat(k)}
            style={{ padding: "5px 10px", borderRadius: 20, flexShrink: 0,
              border: "1px solid " + (viewCat === k ? "#3b82f6" : "#334155"),
              background: viewCat === k ? "#3b82f6" : "#1e293b",
              color: "#f1f5f9", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
            {CATEGORY_LABELS[k]}
          </button>
        ))}
      </div>

      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>
            {viewCat === "ALL" ? "Overall Standings" : CATEGORY_LABELS[viewCat]} Over Time
          </h3>
          <span style={{ fontSize: 10, color: s.dim }}>
            {n} snapshot{n !== 1 ? "s" : ""} · {fmtShort(dates[0])} → {fmtShort(dates[n - 1])}
          </span>
        </div>

        {/* Chart */}
        <div ref={svgWrapRef} style={{ position: "relative", width: "100%", touchAction: "none" }}
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIdx(null)}>
          <svg viewBox={"0 0 " + W + " " + H} style={{ width: "100%", height: "auto", display: "block" }}>
            {/* Gridlines */}
            {gridLines.map((g, i) => (
              <g key={i}>
                <line x1={padL} y1={g.y} x2={W - padR} y2={g.y} stroke="#334155" strokeWidth={1} opacity={0.4} />
                <text x={padL - 6} y={g.y + 3} textAnchor="end" fontSize={9} fill={s.dim}>{g.val}</text>
              </g>
            ))}

            {/* X axis ticks (sparse) */}
            {dates.map((d, i) => {
              const step = Math.max(1, Math.ceil(n / (isMobile ? 4 : 7)));
              if (i % step !== 0 && i !== n - 1) return null;
              return (
                <text key={d} x={xFor(i)} y={H - 6} textAnchor="middle" fontSize={9} fill={s.dim}>
                  {fmtShort(d)}
                </text>
              );
            })}

            {/* Lines */}
            {visibleSeries.map((sr) => (
              <path key={sr.id} d={pathFor(sr.values)} fill="none" stroke={sr.color} strokeWidth={2}
                strokeLinecap="round" strokeLinejoin="round" />
            ))}

            {/* Last-point markers */}
            {visibleSeries.map((sr) => (
              <circle key={sr.id} cx={xFor(n - 1)} cy={yFor(sr.values[n - 1])} r={3} fill={sr.color} />
            ))}

            {/* Leader direct label */}
            {leader && (
              <text x={Math.min(W - padR - 2, xFor(n - 1) + 4)} y={yFor(leader.v) - 6}
                fontSize={10} fontWeight={700} fill={leader.color} textAnchor="end">
                {leader.name}
              </text>
            )}

            {/* Crosshair */}
            {hoverX !== null && (
              <line x1={hoverX} y1={padT} x2={hoverX} y2={padT + plotH} stroke="#94a3b8" strokeWidth={1} strokeDasharray="3,3" opacity={0.6} />
            )}
            {hoverX !== null && visibleSeries.map((sr) => (
              <circle key={"h" + sr.id} cx={hoverX} cy={yFor(sr.values[hoverIdx])} r={3.5}
                fill={s.card} stroke={sr.color} strokeWidth={2} />
            ))}
          </svg>

          {/* Tooltip */}
          {hoverDate && (
            <div style={{
              position: "absolute", top: 8,
              left: hoverX > W / 2 ? undefined : Math.min(70, (hoverX / W) * 100) + "%",
              right: hoverX > W / 2 ? Math.min(70, ((W - hoverX) / W) * 100) + "%" : undefined,
              background: "#0f172a", border: "1px solid " + s.bdr, borderRadius: 8,
              padding: "8px 10px", fontSize: 11, minWidth: 130, maxHeight: 220, overflowY: "auto",
              boxShadow: "0 8px 20px rgba(0,0,0,0.4)", pointerEvents: "none", zIndex: 5,
            }}>
              <div style={{ fontWeight: 700, color: "#f1f5f9", marginBottom: 4, fontSize: 10 }}>
                {fmtLong(hoverDate)}
              </div>
              {hoverRows.map((r) => (
                <div key={r.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "1px 0" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 5, color: "#cbd5e1" }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: r.color, display: "inline-block" }} />
                    {r.name}
                  </span>
                  <span style={{ fontWeight: 700, color: "#f8fafc" }}>{r.v}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Legend (toggleable) */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12, justifyContent: "center" }}>
          {series.map((sr) => {
            const isHidden = hidden.has(sr.id);
            return (
              <button key={sr.id} onClick={() => toggleMember(sr.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 5, padding: "3px 8px", borderRadius: 20,
                  border: "1px solid " + (isHidden ? "#334155" : sr.color + "55"),
                  background: isHidden ? "transparent" : sr.color + "12",
                  cursor: "pointer", fontSize: 10, fontWeight: 600,
                  color: isHidden ? "#475569" : "#e2e8f0", opacity: isHidden ? 0.5 : 1,
                }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: sr.color, display: "inline-block" }} />
                {sr.name}
              </button>
            );
          })}
        </div>

        {/* Table view toggle (accessible alternative to the chart) */}
        <div style={{ marginTop: 14, textAlign: "center" }}>
          <button onClick={() => setShowTable(showTable ? false : 21)}
            style={{ background: "none", border: "1px solid " + s.bdr, borderRadius: 8,
              padding: "5px 12px", color: s.mut, fontSize: 11, cursor: "pointer" }}>
            {showTable ? "Hide data table" : "View as table"}
          </button>
        </div>

        {showTable && (
          <div style={{ marginTop: 12, overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr>
                  <th style={{ padding: "6px 8px", textAlign: "left", color: s.mut,
                    borderBottom: "1px solid " + s.bdr, position: "sticky", left: 0, background: s.card }}>
                    Date
                  </th>
                  {visibleSeries.map((sr) => (
                    <th key={sr.id} style={{ padding: "6px 8px", textAlign: "right", color: sr.color,
                      borderBottom: "1px solid " + s.bdr, whiteSpace: "nowrap" }}>
                      {sr.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableDates.map((d) => (
                  <tr key={d}>
                    <td style={{ padding: "5px 8px", color: s.dim, borderBottom: "1px solid #1e293b",
                      position: "sticky", left: 0, background: s.card, whiteSpace: "nowrap" }}>
                      {fmtShort(d)}
                    </td>
                    {visibleSeries.map((sr) => (
                      <td key={sr.id} style={{ padding: "5px 8px", textAlign: "right", color: "#e2e8f0",
                        borderBottom: "1px solid #1e293b" }}>
                        {byDate.get(d)?.[sr.id] ?? 0}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {showTable !== "all" && dates.length > 21 && (
              <div style={{ textAlign: "center", marginTop: 8 }}>
                <button onClick={() => setShowTable("all")}
                  style={{ background: "none", border: "none", color: s.acc, fontSize: 11, cursor: "pointer" }}>
                  Show all {dates.length} snapshots
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
