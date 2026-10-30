import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { TrendingUp, TrendingDown, AlertTriangle } from "lucide-react";
import { supabase, storageGet, storageSet, STORAGE_KEYS } from "../utils/storage";
import { theme, cardStyle, radius } from "../constants/theme";
import { CATEGORY_ORDER, CATEGORY_LABELS } from "../constants/categories";
import { MEMBER_COLORS } from "../constants/members";
import { track, EVENTS } from "../utils/analytics";
import ScrollFadeEdges from "./ScrollFadeEdges";
import { Dot, CategoryPill } from "./Badges";

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

// One member's whole trajectory at a glance — scaled to *their own* min/max,
// not the shared axis, so the shape of a tight race and a blowout both read
// clearly. The small-multiples alternative to the single combined chart:
// trades "who was ahead of whom on date X" for "is each line's shape obvious
// without untangling it from ten others" — see choosing-a-form.md's guidance
// that past ~4 converging series, small multiples is usually the right call.
function SparkTile({ sr, firstDateLabel, isMobile, onClick }) {
  const n = sr.values.length;
  const first = sr.values[0];
  const last = sr.values[n - 1];
  const delta = Math.round((last - first) * 100) / 100;
  const isUp = delta >= 0;

  let lo = Infinity, hi = -Infinity;
  sr.values.forEach((v) => { if (v < lo) lo = v; if (v > hi) hi = v; });
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12 || 1;
  lo -= pad; hi += pad;

  const w = 100, h = 34;
  const xFor = (i) => (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  const yFor = (v) => h - ((v - lo) / (hi - lo)) * h;
  const path = sr.values.map((v, i) => (i === 0 ? "M" : "L") + xFor(i).toFixed(1) + "," + yFor(v).toFixed(1)).join(" ");
  const areaPath = path + ` L${xFor(n - 1).toFixed(1)},${h} L0,${h} Z`;

  return (
    <button onClick={onClick} style={{
      display: "flex", flexDirection: "column", gap: 6, textAlign: "left",
      background: s.srf, border: "1px solid " + s.bdr, borderRadius: radius.sm,
      padding: 10, cursor: "pointer", minWidth: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, color: sr.color, minWidth: 0 }}>
          <Dot color={sr.color} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sr.name}</span>
        </span>
        <span style={{ fontSize: 13, fontWeight: 800, color: s.txt, flexShrink: 0 }}>{last}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none"
        style={{ width: "100%", height: isMobile ? 36 : 42, display: "block" }}>
        <path d={areaPath} fill={sr.color} opacity={0.1} stroke="none" />
        <path d={path} fill="none" stroke={sr.color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={xFor(n - 1)} cy={yFor(last)} r={2.5} fill={sr.color} />
      </svg>
      <span style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10.5, fontWeight: 600,
        color: isUp ? theme.grn : theme.red }}>
        {isUp ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
        {isUp && delta > 0 ? "+" : ""}{delta} since {firstDateLabel}
      </span>
    </button>
  );
}

export default function Trends({ seasonData }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isStale, setIsStale] = useState(false);
  const [viewCat, setViewCat] = useState("ALL");
  const [chartMode, setChartMode] = useState("lines");
  const [hidden, setHidden] = useState(() => new Set());
  const [focusId, setFocusId] = useState(null);
  const [hoverIdx, setHoverIdx] = useState(null);
  const [showTable, setShowTable] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 640);
  const svgWrapRef = useRef(null);
  const pillsRef = useRef(null);
  const requestIdRef = useRef(0);

  const seasonYear = seasonData?.year;
  const members = useMemo(() => seasonData?.members || [], [seasonData]);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // A focused member hidden via the legend, or a switch to a category/season
  // they have no history in, would otherwise leave every other line dimmed
  // with nothing highlighted to show for it.
  useEffect(() => {
    if (focusId && hidden.has(focusId)) setFocusId(null);
  }, [focusId, hidden]);
  useEffect(() => { setFocusId(null); }, [viewCat, seasonYear]);

  // A request abandoned by a year switch (or a stale manual retry) must
  // skip its own setState calls when it finally resolves. This used to be
  // threaded through as an isCancelled callback passed into load() by its
  // caller — but that broke the moment a retry button did `onClick={load}`
  // directly: React passes the click event as load's first argument, so
  // isCancelled became the event object, and calling it as a function threw,
  // leaving the UI stuck on its loading state. A shared ref sidesteps that
  // entirely: load() takes no arguments, so it's safe to pass as a handler
  // directly, and every call (effect-triggered or a manual retry) stamps
  // its own id — only the most recent one commits.
  const load = useCallback(async () => {
    const myRequestId = ++requestIdRef.current;
    const stillCurrent = () => requestIdRef.current === myRequestId;
    if (!seasonYear) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    const cacheKey = `${STORAGE_KEYS.TRENDS_HISTORY_PREFIX}-${seasonYear}`;
    // PostgREST caps unpaginated responses at 1000 rows. At 11 members x 15
    // categories = 165 rows/day, a season blows past that in under a week,
    // so this paginates the same way api/cron/update-billboard.js does.
    const pageSize = 1000;
    let page = 0;
    let allRows = [];
    let keepFetching = true;
    let fetchError = null;
    while (keepFetching) {
      const { data, error: err } = await supabase
        .from("score_history")
        .select("snapshot_date, member_id, category, total")
        .eq("season_year", seasonYear)
        .order("snapshot_date")
        // snapshot_date alone isn't unique (~165 rows share each date), so
        // ties can land in a different order across separate paginated
        // requests without a unique tiebreaker — silently duplicating or
        // dropping rows at page boundaries. `id` is the table's identity PK.
        .order("id")
        .range(page * pageSize, (page + 1) * pageSize - 1);
      if (err) { fetchError = err; break; }
      const batch = data || [];
      allRows = allRows.concat(batch);
      page++;
      if (batch.length < pageSize) keepFetching = false;
    }
    if (fetchError) {
      // Same resilience App.jsx's loadSeason() and Calendar.jsx already have
      // for Supabase hiccups — Trends used to just throw a raw error here.
      console.warn("Trends: Supabase fetch failed, trying cached snapshot...", fetchError.message);
      let cached = null;
      try {
        const r = await storageGet(cacheKey);
        if (r && r.value) cached = JSON.parse(r.value);
      } catch (e) { console.error("Trends: failed to read cached snapshot:", e); }
      track(EVENTS.DATA_FALLBACK_USED, {
        surface: "trends",
        fallback_level: cached && cached.length > 0 ? "local" : "none",
        reason: "supabase_fetch_failed",
      });
      if (!stillCurrent()) return;
      if (cached && cached.length > 0) {
        setRows(cached);
        setIsStale(true);
        setLoading(false);
        return;
      }
      setError(fetchError.message);
      setLoading(false);
      track(EVENTS.TRENDS_LOAD_FAILED, { error_message: fetchError.message });
      return;
    }
    if (!stillCurrent()) return;
    setRows(allRows);
    setIsStale(false);
    storageSet(cacheKey, JSON.stringify(allRows)).catch(() => {});
    setLoading(false);
  }, [seasonYear]);

  useEffect(() => {
    load();
  }, [load]);

  const memberMeta = useMemo(() => {
    const m = {};
    members.forEach((mem) => { m[mem.id] = mem; });
    return m;
  }, [members]);

  // Rows visible in the current view (all categories, or just the selected one).
  const filteredRows = useMemo(() => {
    return viewCat === "ALL" ? rows : rows.filter((r) => r.category === viewCat);
  }, [rows, viewCat]);

  // ── date x member -> total, within the current view ──
  const byDate = useMemo(() => {
    const m = new Map();
    filteredRows.forEach((r) => {
      if (!m.has(r.snapshot_date)) m.set(r.snapshot_date, {});
      const d = m.get(r.snapshot_date);
      const sum = (d[r.member_id] || 0) + (Number(r.total) || 0);
      // Round away float noise from summing decimal totals (e.g. tie-split points).
      d[r.member_id] = Math.round(sum * 100) / 100;
    });
    return m;
  }, [filteredRows]);

  const dates = useMemo(() => [...byDate.keys()].sort(), [byDate]);

  // Only chart members who actually have a snapshot row in the current view —
  // a member with none yet (just added, snapshotting hasn't caught up, or no
  // history in this specific category) would otherwise draw as a flat line at
  // 0 and clutter the legend/tooltip for everyone else. Must come from the
  // same filtered set as byDate, not all rows, or switching to a category a
  // member has no history in reintroduces the flat-zero-line bug scoped to
  // that view.
  const memberIds = useMemo(() => {
    const ids = new Set(filteredRows.map((r) => r.member_id));
    return [...ids];
  }, [filteredRows]);

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

  // Dynamic Y axis: zoom to the actual spread of the visible series instead of
  // always anchoring at 0. Standings over a season tend to cluster in a narrow
  // band relative to their absolute size (e.g. 410-460), so a zero-anchored
  // axis flattens every line into a near-overlapping cluster — exactly what
  // makes it hard to tell members apart at a glance, especially on a small
  // mobile screen. Rounds the domain to clean tick steps (1/2/5 x 10^n) so the
  // gridlines still read as real numbers, not an arbitrary crop.
  const yScale = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    visibleSeries.forEach((sr) => sr.values.forEach((v) => {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }));
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (lo === hi) { lo -= 1; hi += 1; }
    const targetTicks = isMobile ? 7 : 8;
    const rawStep = (hi - lo) / targetTicks;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const min = Math.floor(lo / step) * step;
    const max = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let v = min; v <= max + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
    return { min, max, ticks };
  }, [visibleSeries, isMobile]);

  function toggleMember(mid) {
    const nowHidden = !hidden.has(mid);
    track(EVENTS.TRENDS_SERIES_TOGGLED, { member_name: memberMeta[mid]?.name || mid, is_hidden: nowHidden });
    setHidden((prev) => {
      const n = new Set(prev);
      if (n.has(mid)) n.delete(mid); else n.add(mid);
      return n;
    });
  }

  // Tap a member's name (end label or legend chip) to spotlight just their
  // line — the real fix for "too many crossing lines to tell apart" on a
  // crowded roster, versus hiding members one at a time.
  function toggleFocus(mid) {
    const nowFocused = focusId !== mid;
    track(EVENTS.TRENDS_SERIES_FOCUSED, { member_name: memberMeta[mid]?.name || mid, is_focused: nowFocused });
    setFocusId(nowFocused ? mid : null);
  }

  // ── chart geometry ── bigger overall, and extra right-hand room for the
  // per-series end labels that replace the single "leader" label. Members
  // can be added with arbitrary names (not just the fixed roster), so size
  // the right margin off the longest *visible* name instead of a fixed guess.
  // H is deliberately much taller than W: the plot's pixel height tracks H
  // directly (height:auto keeps the render aspect-locked to viewBox W:H, so
  // this is real vertical room, not a stretch/distortion trick), which is
  // what actually separates 11 similarly-hued lines on a narrow phone.
  const W = 720, H = isMobile ? 1040 : 620;
  const labelCharW = isMobile ? 6.2 : 6.8;
  const maxNameLen = visibleSeries.reduce((m, sr) => Math.max(m, sr.name.length), 4);
  const padL = 36, padR = Math.min(110, Math.max(isMobile ? 42 : 52, maxNameLen * labelCharW + 13));
  const padT = 16, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = dates.length;
  const xFor = (i) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yFor = (v) => padT + plotH - ((v - yScale.min) / (yScale.max - yScale.min)) * plotH;

  function pathFor(values) {
    return values.map((v, i) => (i === 0 ? "M" : "L") + xFor(i).toFixed(2) + "," + yFor(v).toFixed(2)).join(" ");
  }

  const gridLines = yScale.ticks.map((val) => ({
    y: yFor(val),
    val,
  }));

  function handlePointerX(clientX) {
    if (n === 0 || !svgWrapRef.current) return;
    const rect = svgWrapRef.current.getBoundingClientRect();
    const relX = ((clientX - rect.left) / rect.width) * W;
    let idx = Math.round(((relX - padL) / plotW) * (n - 1));
    idx = Math.max(0, Math.min(n - 1, idx));
    setHoverIdx(idx);
  }
  function handleMove(e) {
    handlePointerX(e.clientX);
  }
  // Touch never had a crosshair at all before — only onMouseMove was wired
  // up, so a finger drag did nothing. Now that the chart is tall enough to
  // fill most of a phone screen, that gap matters more: touchAction "none"
  // was blocking the page's vertical scroll over the chart for no benefit.
  // "pan-y" lets a vertical swipe scroll the page normally; a touchmove
  // that isn't purely vertical still reaches this handler for the crosshair.
  function handleTouchMove(e) {
    if (e.touches && e.touches.length) handlePointerX(e.touches[0].clientX);
  }

  const tableDates = useMemo(() => [...dates].reverse().slice(0, showTable === "all" ? dates.length : 21), [dates, showTable]);

  if (loading) {
    return (
      <div style={{ maxWidth: 800, margin: "0 auto", textAlign: "center", padding: 60, color: s.dim }}>
        <TrendingUp size={24} style={{ marginBottom: 8 }} />
        <div style={{ fontSize: 14, fontWeight: 600 }}>Loading trends...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ maxWidth: 800, margin: "0 auto", ...cardStyle, textAlign: "center", padding: 40 }}>
        <AlertTriangle size={28} color={s.red} style={{ marginBottom: 10 }} />
        <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>Couldn't load trend history</h3>
        <p style={{ color: s.dim, fontSize: 12, maxWidth: 360, margin: "0 auto 14px" }}>
          No cached snapshot to fall back to either — this usually clears up on its own.
        </p>
        <button onClick={() => { track(EVENTS.TRENDS_LOAD_FAILED, { error_message: error }); load(); }}
          style={{ background: "none", border: "1px solid " + s.bdr, borderRadius: 8,
            padding: "7px 16px", color: s.txt, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
          Try again
        </button>
      </div>
    );
  }

  if (n < 2) {
    return (
      <div style={{ maxWidth: 800, margin: "0 auto", ...cardStyle, textAlign: "center", padding: 40 }}>
        <TrendingUp size={32} color={s.dim} style={{ marginBottom: 10 }} />
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

  // Per-series end-of-line labels — every visible member gets their name
  // pinned to where their line ends, not just the current leader. This is
  // the main fix for "hard to tell the lines apart": color alone doesn't
  // carry across 11 similarly-hued lines on a phone screen, but a name does.
  // Labels are nudged apart (keeping their top-to-bottom order) so they never
  // overlap when two members are tied or close together.
  const labelFontSize = isMobile ? 10 : 11;
  const minLabelGap = labelFontSize + 4;
  const endLabels = (() => {
    if (!visibleSeries.length) return [];
    const items = visibleSeries
      .map((sr) => ({ id: sr.id, name: sr.name, color: sr.color, actualY: yFor(sr.values[n - 1]) }))
      .sort((a, b) => a.actualY - b.actualY);
    items.forEach((it) => { it.y = it.actualY; });
    for (let i = 1; i < items.length; i++) {
      if (items[i].y - items[i - 1].y < minLabelGap) {
        items[i].y = items[i - 1].y + minLabelGap;
      }
    }
    const overflow = items[items.length - 1].y - (padT + plotH);
    if (overflow > 0) {
      for (let i = items.length - 1; i >= 0; i--) items[i].y -= overflow;
    }
    return items;
  })();

  return (
    <div style={{ maxWidth: 800, margin: "0 auto" }}>
      {/* Category pills */}
      <ScrollFadeEdges scrollRef={pillsRef} fadeColor={s.bg}>
      <div ref={pillsRef} style={{
        display: "flex", flexWrap: isMobile ? "nowrap" : "wrap",
        gap: 4, marginBottom: 16, justifyContent: isMobile ? "flex-start" : "center",
        overflowX: isMobile ? "auto" : "visible", WebkitOverflowScrolling: "touch",
        paddingBottom: isMobile ? 4 : 0, msOverflowStyle: "none", scrollbarWidth: "none",
      }}>
        <CategoryPill active={viewCat === "ALL"} onClick={() => {
            track(EVENTS.CATEGORY_FILTER_CHANGED, { surface: "trends", category: "overall", previous_category: viewCat });
            setViewCat("ALL");
          }}>
          Overall
        </CategoryPill>
        {CATEGORY_ORDER.map((k) => (
          <CategoryPill key={k} active={viewCat === k} onClick={() => {
              track(EVENTS.CATEGORY_FILTER_CHANGED, { surface: "trends", category: k, previous_category: viewCat });
              setViewCat(k);
            }}>
            {CATEGORY_LABELS[k]}
          </CategoryPill>
        ))}
      </div>
      </ScrollFadeEdges>

      {isStale && (
        <div style={{ ...cardStyle, marginBottom: 12, padding: "8px 12px", display: "flex",
          alignItems: "center", gap: 8, border: "1px solid " + s.yel }}>
          <AlertTriangle size={13} color={s.yel} style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 11, color: s.dim }}>
            Showing a cached snapshot — couldn't reach the live data just now.
          </span>
          <button onClick={load} style={{ marginLeft: "auto", background: "none", border: "none",
            color: s.acc, fontSize: 11, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>
            Retry
          </button>
        </div>
      )}

      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, flexWrap: "wrap", gap: 6 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>
            {viewCat === "ALL" ? "Overall Standings" : CATEGORY_LABELS[viewCat]} Over Time
          </h3>
          <span style={{ fontSize: 10, color: s.dim }}>
            {n} snapshot{n !== 1 ? "s" : ""} · {fmtShort(dates[0])} → {fmtShort(dates[n - 1])}
          </span>
        </div>

        {/* Lines vs. grid: the combined chart is best for "who was ahead of
            whom on date X"; the grid is best for scanning everyone's shape
            (rising/falling/flat) at once without untangling crossing lines. */}
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {[{ key: "lines", label: "Compare" }, { key: "grid", label: "By Member" }].map((opt) => (
            <button key={opt.key} onClick={() => {
                if (chartMode !== opt.key) {
                  track(EVENTS.TRENDS_VIEW_TOGGLED, { view: opt.key });
                  setChartMode(opt.key);
                }
              }}
              style={{
                background: chartMode === opt.key ? s.accSoft : "none",
                border: "1px solid " + (chartMode === opt.key ? s.acc : s.bdr),
                borderRadius: 8, padding: "5px 12px", fontSize: 11, fontWeight: 700,
                color: chartMode === opt.key ? s.acc : s.mut, cursor: "pointer",
              }}>
              {opt.label}
            </button>
          ))}
        </div>

        {chartMode === "lines" && (focusId ? (
          <div style={{ marginBottom: 8, fontSize: 11, color: s.dim }}>
            Spotlighting <strong style={{ color: MEMBER_COLORS[focusId] || FALLBACK_COLOR }}>
              {memberMeta[focusId]?.name || focusId}
            </strong> —{" "}
            <button onClick={() => setFocusId(null)} style={{ background: "none", border: "none",
              color: s.acc, fontSize: 11, fontWeight: 700, cursor: "pointer", padding: 0 }}>
              show everyone
            </button>
          </div>
        ) : (
          <div style={{ marginBottom: 8, fontSize: 10.5, color: s.dim }}>
            Tap a name to spotlight that line.
          </div>
        ))}

        {/* Grid view — each member's own trajectory, independently scaled.
            Tapping a tile jumps to the lines view with that member spotlit,
            for a closer side-by-side look. */}
        {chartMode === "grid" && (
          <div style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 10,
          }}>
            {visibleSeries.map((sr) => (
              <SparkTile key={sr.id} sr={sr} firstDateLabel={fmtShort(dates[0])} isMobile={isMobile}
                onClick={() => { toggleFocus(sr.id); setChartMode("lines"); }} />
            ))}
          </div>
        )}

        {/* Chart */}
        {chartMode === "lines" && (
        <div ref={svgWrapRef} style={{ position: "relative", width: "100%", touchAction: "pan-y" }}
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIdx(null)}
          onTouchMove={handleTouchMove}
          onTouchEnd={() => setHoverIdx(null)}>
          <svg viewBox={"0 0 " + W + " " + H} style={{ width: "100%", height: "auto", display: "block" }}>
            {/* Gridlines */}
            {gridLines.map((g, i) => (
              <g key={i}>
                <line x1={padL} y1={g.y} x2={W - padR} y2={g.y} stroke="#334155" strokeWidth={1} opacity={0.4} />
                <text x={padL - 7} y={g.y + 3} textAnchor="end" fontSize={10} fill={s.dim}>{g.val}</text>
              </g>
            ))}

            {/* X axis ticks (sparse) */}
            {dates.map((d, i) => {
              const step = Math.max(1, Math.ceil(n / (isMobile ? 4 : 7)));
              if (i % step !== 0 && i !== n - 1) return null;
              return (
                <text key={d} x={xFor(i)} y={H - 8} textAnchor="middle" fontSize={10} fill={s.dim}>
                  {fmtShort(d)}
                </text>
              );
            })}

            {/* Lines — focused series draws last (on top) and full-strength;
                everyone else fades back so the one line the user picked
                reads clearly through the rest of the pack. */}
            {(focusId
              ? [...visibleSeries.filter((sr) => sr.id !== focusId), ...visibleSeries.filter((sr) => sr.id === focusId)]
              : visibleSeries
            ).map((sr) => {
              const isFocused = focusId === sr.id;
              const dimmed = focusId && !isFocused;
              return (
                <path key={sr.id} d={pathFor(sr.values)} fill="none" stroke={sr.color}
                  strokeWidth={isFocused ? 4.5 : dimmed ? 1.5 : 3} opacity={dimmed ? 0.16 : 1}
                  strokeLinecap="round" strokeLinejoin="round" />
              );
            })}

            {/* Last-point markers */}
            {visibleSeries.map((sr) => {
              const isFocused = focusId === sr.id;
              const dimmed = focusId && !isFocused;
              return (
                <circle key={sr.id} cx={xFor(n - 1)} cy={yFor(sr.values[n - 1])} r={isFocused ? 5.5 : 4}
                  fill={sr.color} stroke={s.card} strokeWidth={2} opacity={dimmed ? 0.3 : 1} />
              );
            })}

            {/* Per-series end labels, nudged apart so ties/close scores don't
                overlap. Tap one to spotlight that member's line — the hit
                target (the transparent rect) is taller than the text itself
                so it's comfortably tappable on a phone. */}
            {endLabels.map((lb) => {
              const shifted = Math.abs(lb.y - lb.actualY) > 2;
              const isFocused = focusId === lb.id;
              const dimmed = focusId && !isFocused;
              return (
                <g key={"lbl" + lb.id} onClick={() => toggleFocus(lb.id)} style={{ cursor: "pointer" }}>
                  <rect x={xFor(n - 1)} y={lb.y - 12} width={padR} height={24} fill="transparent" />
                  {shifted && (
                    <line x1={xFor(n - 1) + 2} y1={lb.actualY} x2={xFor(n - 1) + 7} y2={lb.y}
                      stroke={lb.color} strokeWidth={1} opacity={dimmed ? 0.2 : 0.5} />
                  )}
                  <text x={xFor(n - 1) + (shifted ? 9 : 7)} y={lb.y + labelFontSize / 3}
                    fontSize={isFocused ? labelFontSize + 1.5 : labelFontSize} fontWeight={isFocused ? 800 : 700}
                    fill={dimmed ? s.mut : lb.color} opacity={dimmed ? 0.55 : 1} textAnchor="start">
                    {lb.name}
                  </text>
                </g>
              );
            })}

            {/* Crosshair */}
            {hoverX !== null && (
              <line x1={hoverX} y1={padT} x2={hoverX} y2={padT + plotH} stroke="#94a3b8" strokeWidth={1} strokeDasharray="3,3" opacity={0.6} />
            )}
            {hoverX !== null && visibleSeries.map((sr) => (
              <circle key={"h" + sr.id} cx={hoverX} cy={yFor(sr.values[hoverIdx])} r={4.5}
                fill={s.card} stroke={sr.color} strokeWidth={2.5} />
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
                    <Dot color={r.color} />
                    {r.name}
                  </span>
                  <span style={{ fontWeight: 700, color: "#f8fafc" }}>{r.v}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        )}

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
                <Dot color={sr.color} />
                {sr.name}
              </button>
            );
          })}
        </div>

        {/* Table view toggle (accessible alternative to the chart) */}
        <div style={{ marginTop: 14, textAlign: "center" }}>
          <button onClick={() => {
              track(EVENTS.TRENDS_VIEW_TOGGLED, { view: showTable ? "chart" : "table" });
              setShowTable(showTable ? false : 21);
            }}
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
                <button onClick={() => {
                    track(EVENTS.TRENDS_TABLE_EXPANDED, { total_snapshots: dates.length });
                    setShowTable("all");
                  }}
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
