import { useState, useMemo, useEffect, useRef } from "react";
import { Lock, ArrowUpRight, ChevronDown, ChevronRight } from "lucide-react";
import { CATEGORY_ORDER, CATEGORY_LABELS, CATEGORY_BONUS_RULES, SPORT_CATEGORIES } from "../constants/categories";
import { MEMBER_COLORS } from "../constants/members";
import { theme, cardStyle } from "../constants/theme";
import { rowBackground, rowBorder, expandedWrapperStyle, expandedHeaderStyle, expandedFooterStyle, hasAnyLock, isPaywalled, getPaywallMessage } from "../utils/helpers";
import { track, EVENTS } from "../utils/analytics";
import { PAYWALL_TOLL_AMOUNT, PAYWALL_TOLL_CURRENCY } from "../constants/paywall";
import PayPalButton from "./PayPalButton";
import ScrollFadeEdges from "./ScrollFadeEdges";
import { Badge, CategoryPill } from "./Badges";

var PAYWALL_BLUR_STYLE = { filter: "blur(5px)", userSelect: "none" };

// ─── Competition-style ranking: tied scores share a rank, and the next
// distinct score skips ahead by the number tied (1, 2, 2, 4 — not 1, 2, 2,
// 3). `sortedArr` must already be sorted by scoreOf() descending.
function withRanks(sortedArr, scoreOf) {
 var out = [];
 var rank = 0, lastScore = null;
 for (var i = 0; i < sortedArr.length; i++) {
  var score = scoreOf(sortedArr[i]);
  if (lastScore === null || score !== lastScore) { rank = i + 1; lastScore = score; }
  out.push(Object.assign({}, sortedArr[i], { rank: rank }));
 }
 return out;
}

// Only 1st place gets the circled-badge treatment (it's the one rank that
// needs to pop at a glance); 2nd and 3rd just get a plain colored number —
// still a clear cue, without three competing circles on screen.
var RANK_TEXT_COLORS = {
 1: theme.acc,     // gold — same amber as the brand accent / 1st-place row border
 2: "#CBD5E1",     // silver
 3: "#D97706",     // bronze
};

// ─── Rank badge — replaces the old medal emoji, which rendered small and
// hard to read on some platforms. Shows the actual rank NUMBER always (so
// two members tied for 2nd both clearly read "2", not a mismatched medal).
function RankBadge({ rank, size }) {
 var dim = size <= 13 ? 22 : 25;
 if (rank === 1) {
  return <Badge color={theme.acc} shape="circle" size={dim} bgAlpha="26" borderAlpha="">{rank}</Badge>;
 }
 return (
  <span style={{
   display: "inline-flex", alignItems: "center", justifyContent: "center",
   width: dim, flexShrink: 0,
   color: RANK_TEXT_COLORS[rank] || "#94a3b8",
   fontSize: size, fontWeight: 800,
  }}>{rank}</span>
 );
}

// ─── Small lock indicator that players see on the scoreboard ───
function LockIndicator({ note }) {
 var _h = useState(false), hover = _h[0], setHover = _h[1];
 return (
  <span style={{ position: "relative", display: "inline-flex", alignItems: "center", marginLeft: 4 }}
   onMouseEnter={function () { setHover(true); }} onMouseLeave={function () { setHover(false); }}>
   <Lock size={10} color={theme.yel} style={{ cursor: "help" }} />
   {hover && (
    <span style={{
     position: "absolute", bottom: "100%", left: "50%", transform: "translateX(-50%)",
     background: theme.card, border: "1px solid #eab308", borderRadius: 6,
     padding: "6px 10px", fontSize: 10, color: "#fef9c3", whiteSpace: "nowrap",
     zIndex: 999, pointerEvents: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
    }}>
     {note || "Commissioner locked this value"}
    </span>
   )}
  </span>
 );
}
 
export default function Scoreboard({ seasonData, surface, onUnlockPaywall }) {
 var surfaceName = surface || "scoreboard";
 // Only the primary Scoreboard tab syncs its selected category to the URL —
 // a non-"scoreboard" surface value means this instance isn't the primary
 // one, and syncing its own "cat" param too would stomp the real one's.
 var _s = useState(function () {
  if (surfaceName !== "scoreboard") return null;
  var params = new URLSearchParams(window.location.search);
  var fromUrl = params.get("cat");
  return fromUrl && CATEGORY_ORDER.includes(fromUrl) ? fromUrl : null;
 }), selCat = _s[0], setSelCat = _s[1];
 var _e = useState(null), expRow = _e[0], setExpRow = _e[1];
 var _m = useState(window.innerWidth < 640), isMobile = _m[0], setIsMobile = _m[1];
 // MOCK ONLY — "wide" breakpoint for the page-level sidebar layout preview.
 var _w = useState(window.innerWidth >= 1024), isWide = _w[0], setIsWide = _w[1];
 var _t = useState(null), toast = _t[0], setToast = _t[1];
 var pillsRef = useRef(null);

 useEffect(function () {
  var onResize = function () {
   setIsMobile(window.innerWidth < 640);
   setIsWide(window.innerWidth >= 1024);
  };
  window.addEventListener("resize", onResize);
  return function () { window.removeEventListener("resize", onResize); };
 }, []);

 useEffect(function () {
  if (surfaceName !== "scoreboard") return;
  var params = new URLSearchParams(window.location.search);
  if (selCat) params.set("cat", selCat); else params.delete("cat");
  var search = params.toString();
  var newUrl = window.location.pathname + (search ? "?" + search : "") + window.location.hash;
  window.history.replaceState(null, "", newUrl);
 }, [selCat, surfaceName]);

 if (!seasonData) {
  return <div style={{ textAlign: "center", padding: 40, color: theme.dim }}>No active season.</div>;
 }
 
 var members = seasonData.members || [];
 var cats = seasonData.categories || {};
 var detail = seasonData.detailedData || {};
 var locks = seasonData.locks || {};
 
 function showToast(msg) {
  setToast(msg);
  setTimeout(function () { setToast(null); }, 3500);
 }

 function handlePaywallPayment(owner, memberId) {
  track(EVENTS.PAYWALL_PAYMENT_COMPLETED, { member_id: memberId, member_name: owner });
  if (!onUnlockPaywall) {
   // Shouldn't happen — renderPaywallPanel only offers checkout when this
   // prop exists (e.g. never in the read-only SeasonHistory view) — but
   // stay honest if it ever does.
   showToast("Payment received, but this view can't unlock it.");
   return;
  }
  // The PayPal charge already happened (this fires from onApprove); the
  // RPC still has to actually succeed before we tell the payer they're
  // unlocked, or a failed write would silently re-lock them on reload.
  Promise.resolve(onUnlockPaywall(memberId)).then(function (ok) {
   if (ok) {
    showToast("I can't believe you just did that");
   } else {
    showToast("Payment went through, but the unlock didn't sync — refresh, or ping the commissioner.");
   }
  });
 }

 // Shown in place of a paywalled member's real breakdown, both in the
 // Overall category grid and inside renderExpanded() for a single category.
 function renderPaywallPanel(owner, memberId) {
  var message = getPaywallMessage(seasonData, memberId) || "Paywalled by the commissioner.";
  return (
   <div style={{ padding: isMobile ? "10px 8px" : "12px 12px" }}>
    <div style={{ textAlign: "center", marginBottom: 10 }}>
     <div style={{ marginBottom: 4, display: "flex", justifyContent: "center" }}><Lock size={22} color={theme.yel} /></div>
     <div style={{ fontSize: 12, color: "#fef9c3", fontWeight: 700 }}>{message}</div>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(3, 1fr)" : "repeat(5, 1fr)", gap: 4, marginBottom: 14 }}>
     {CATEGORY_ORDER.map(function (k) {
      return (
       <div key={k} style={{ padding: "4px 6px", borderRadius: 6, textAlign: "center", background: "rgba(255,255,255,0.06)" }}>
        <div style={{ fontSize: isMobile ? 8 : 9, color: "#64748b", lineHeight: 1.2 }}>{CATEGORY_LABELS[k]}</div>
        <div style={{ fontSize: isMobile ? 12 : 14, fontWeight: 700, color: "#e2e8f0" }}>{"██"}</div>
       </div>
      );
     })}
    </div>
    {onUnlockPaywall ? (
     <>
      <div style={{ display: "flex", justifyContent: "center" }}>
       <PayPalButton amount={PAYWALL_TOLL_AMOUNT}
        description={"Fantasy Life paywall toll — " + owner}
        onApprove={function () { handlePaywallPayment(owner, memberId); }} />
      </div>
      <div style={{ textAlign: "center", fontSize: 9, color: "#64748b", marginTop: 6 }}>
       ${PAYWALL_TOLL_AMOUNT} {PAYWALL_TOLL_CURRENCY} to lift the paywall
      </div>
     </>
    ) : (
     <div style={{ textAlign: "center", fontSize: 10, color: theme.dim }}>
      Checkout isn't available in this read-only view.
     </div>
    )}
   </div>
  );
 }

 // ─── Projections (Monte Carlo "projected final" overlay) ───
 // seasonData.projections is {} when not yet fetched or unavailable for
 // this season — every lookup below degrades to the member's current
 // actual total, never blocks or errors. See
 // docs/projections-feature-plan.md for methodology/confidence tiers.
 var projectionsByCategory = seasonData.projections || {};
 var hasProjections = Object.keys(projectionsByCategory).length > 0;
 var _sp = useState(false), showProjected = _sp[0], setShowProjected = _sp[1];

 function projectedEntryFor(category, ownerName) {
  var byOwner = projectionsByCategory[category];
  return byOwner ? byOwner[ownerName] : null;
 }

 function toggleProjected() {
  var next = !showProjected;
  track(EVENTS.PROJECTIONS_TOGGLED, { surface: surfaceName, is_enabled: next, season_year: seasonData.year });
  setShowProjected(next);
 }

 var overallStandings = useMemo(function () {
  var sorted = members.map(function (m) {
   var totalPts = 0, totalPtsProjected = 0;
   var catScores = {}, catScoresProjected = {};
   CATEGORY_ORDER.forEach(function (k) {
    var entry = (cats[k] || []).find(function (x) { return x.owner === m.name; });
    if (entry) {
     totalPts += entry.total;
     catScores[k] = entry.total;
     var proj = projectedEntryFor(k, m.name);
     var projTotal = proj ? proj.projectedTotal : entry.total;
     totalPtsProjected += projTotal;
     catScoresProjected[k] = projTotal;
    }
   });
   return { owner: m.name, id: m.id, totalPts: totalPts, totalPtsProjected: totalPtsProjected, catScores: catScores, catScoresProjected: catScoresProjected };
  });
  return {
   actual: withRanks(sorted.slice().sort(function (a, b) { return b.totalPts - a.totalPts; }), function (m) { return m.totalPts; }),
   projected: withRanks(sorted.slice().sort(function (a, b) { return b.totalPtsProjected - a.totalPtsProjected; }), function (m) { return m.totalPtsProjected; }),
  };
 }, [members, cats, projectionsByCategory]);

 var catMembersRaw = selCat ? (cats[selCat] || []).map(function (entry) {
  var proj = projectedEntryFor(selCat, entry.owner);
  return Object.assign({}, entry, {
   projectedTotal: proj ? proj.projectedTotal : entry.total,
   projectedBase: proj ? proj.projectedBase : entry.base,
   projectedBonus: proj ? proj.projectedBonusEv : entry.bonus,
   projectionConfidence: proj ? proj.confidence : null,
   projectionNote: proj ? proj.note : null,
  });
 }) : null;
 var catMembers = catMembersRaw
  ? withRanks(catMembersRaw.slice().sort(function (a, b) {
     return showProjected ? (b.projectedTotal - a.projectedTotal) : (b.total - a.total);
    }), function (m) { return showProjected ? m.projectedTotal : m.total; })
  : null;
 var detailArr = selCat ? detail[selCat] : null;

 // MOCK ONLY — category leaders sidebar preview. Real data (each
 // category's #1 finisher, ties included), just not wired to a
 // click-through yet.
 var categoryLeaders = useMemo(function () {
  return CATEGORY_ORDER.map(function (k) {
   var entries = cats[k] || [];
   if (entries.length === 0) return { key: k, owners: [], total: 0 };
   var maxTotal = entries.reduce(function (m, x) { return Math.max(m, x.total); }, -Infinity);
   var owners = entries.filter(function (x) { return x.total === maxTotal; }).map(function (x) { return x.owner; });
   return { key: k, owners: owners, total: maxTotal };
  });
 }, [cats]);
 
 var isSport = SPORT_CATEGORIES.includes(selCat);
 var isFilm = selCat === "Actor" || selCat === "Actress";
 var isMusic = selCat === "Musician";
 var isEvent = selCat === "Tennis" || selCat === "Golf" || selCat === "F1";
 var isCountry = selCat === "Country";
 var isStock = selCat === "Stock";
 
 function bonusNoteDisplay(d) {
  if (!d || !d.bonusNote) return null;
  return (
   <div style={{ marginTop: 4, fontSize: 10, color: "#22c55e", fontStyle: "italic" }}>
    {d.bonusNote}
   </div>
  );
 }
 
 function rowLockIcon(cat, owner, idx) {
  var key = cat + "|" + owner + "|row" + idx;
  if (!locks[key]) return null;
  return <LockIndicator note="This row is locked by the commissioner" />;
 }
 
 // === EXPANDED DETAIL RENDERER ===
 function renderExpanded(m, rank) {
  var memberId = (members.find(function (x) { return x.name === m.owner; }) || {}).id;
  if (isPaywalled(seasonData, memberId)) {
   return (
    <div style={expandedWrapperStyle(rank)}>
     {renderPaywallPanel(m.owner, memberId)}
    </div>
   );
  }
  var d = detailArr ? detailArr.find(function (x) { return x.owner === m.owner; }) : null;
  var wp = expandedWrapperStyle(rank);
  var hd = expandedHeaderStyle;
  var ft = expandedFooterStyle;
  var totalLine = (
   <div style={ft}>
    Total: {m.base} base + {m.bonus} bonus ={" "}
    <b style={{ color: "#f8fafc", fontSize: 13 }}>{m.total} pts</b>
    {hasAnyLock(seasonData, selCat, m.owner) && (
     <LockIndicator note="Some values locked by commissioner" />
    )}
    {bonusNoteDisplay(d)}
    {typeof m.projectedTotal === "number" && (
     <div style={{ marginTop: 4, fontSize: 10, color: theme.dim }}>
      Projected final: <b style={{ color: "#f8fafc" }}>{Math.round(m.projectedTotal)} pts</b>
      {m.projectionConfidence ? " (" + m.projectionConfidence.replace(/_/g, " ") + " confidence)" : ""}
     </div>
    )}
    {m.projectionNote && (
     <div style={{ marginTop: 2, fontSize: 10, color: "#38bdf8", fontStyle: "italic" }}>
      {m.projectionNote}
     </div>
    )}
   </div>
  );
 
  if (!d) {
   return (
    <div style={{ padding: "10px 14px", borderRadius: "0 0 10px 10px", background: theme.card,
     border: "1px solid " + rowBorder(rank), borderTop: `1px solid ${theme.bdr}`, fontSize: 12, color: "#cbd5e1" }}>
     Base: {m.base} + Bonus: {m.bonus} = <b style={{ color: "#f8fafc" }}>{m.total} pts</b>
     {bonusNoteDisplay(d)}
    </div>
   );
  }
 
  // SPORTS
  if (isSport) {
   return (
    <div style={wp}>
     <div style={hd}>
      <b style={{ color: "#cbd5e1" }}>Regular Season: </b>
      <span style={{ color: "#f8fafc", fontSize: 13, fontWeight: 700 }}>{d.record || "\u2014"}</span>
      {" \u2192 " + m.base + " base pts"}
     </div>
     {d.rounds && d.rounds.length > 0 ? (
      <div style={{ padding: "4px 12px" }}>
       {d.rounds.map(function (r, ri) {
        return (
         <div key={ri} style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr 50px 40px" : "1fr 80px 70px 40px",
          gap: 4, alignItems: "center", padding: "4px 0",
          borderBottom: ri === d.rounds.length - 1 ? "none" : `1px solid ${theme.card}`, fontSize: 11,
         }}>
          <div>
           <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{r.round}</span>
           {r.note && <div style={{ fontSize: 10, color: "#22c55e" }}>{r.note}</div>}
           {isMobile && <div style={{ fontSize: 10, color: "#64748b" }}>{r.opponent}</div>}
           {rowLockIcon(selCat, m.owner, ri)}
          </div>
          {!isMobile && <span style={{ color: "#94a3b8", fontSize: 10 }}>{r.opponent}</span>}
          <div style={{ textAlign: "center" }}>
           <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 700,
            background: r.result === "Won" ? "rgba(34,197,94,0.2)" : r.result === "Lost" ? "rgba(239,68,68,0.15)" : "rgba(255,255,255,0.06)",
            color: r.result === "Won" ? "#22c55e" : r.result === "Lost" ? "#ef4444" : "#64748b" }}>
            {r.result === "\u2014" ? "\u2014" : r.result + (isMobile ? "" : " " + r.series)}
           </span>
          </div>
          <div style={{ textAlign: "right", color: r.pts > 0 ? "#f8fafc" : "#475569", fontWeight: 700 }}>
           {r.pts > 0 ? "+" + r.pts : "\u2014"}
          </div>
         </div>
        );
       })}
      </div>
     ) : (
      <div style={{ padding: "8px 12px", fontSize: 11, color: "#475569" }}>Missed Playoffs</div>
     )}
     {totalLine}
    </div>
   );
  }
 
  // FILM
  if (isFilm) {
   return (
    <div style={wp}>
     <div style={{
      display: "grid",
      gridTemplateColumns: isMobile ? "1fr 50px 55px" : "1fr 62px 38px 70px",
      gap: 6, padding: "6px 12px", background: theme.bg, fontSize: 10, fontWeight: 700, color: "#64748b",
     }}>
      <span>Film</span>
      {!isMobile && <span style={{ textAlign: "right" }}>Box Office</span>}
      <span style={{ textAlign: isMobile ? "right" : "center" }}>{isMobile ? "BO/RT" : "RT"}</span>
      <span style={{ textAlign: "right" }}>Score</span>
     </div>
     <div style={{ padding: "4px 12px" }}>
      {d.films.map(function (f, fi) {
       return (
        <div key={fi} style={{
         display: "grid",
         gridTemplateColumns: isMobile ? "1fr 50px 55px" : "1fr 62px 38px 70px",
         gap: 6, alignItems: "center", padding: "5px 0",
         borderBottom: fi === d.films.length - 1 ? "none" : `1px solid ${theme.card}`, fontSize: 11,
        }}>
         <div>
          <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{f.title}</span>
          {!isMobile && <span style={{ color: "#64748b", marginLeft: 6 }}>{f.date}</span>}
          {f.note && <div style={{ fontSize: 10, color: "#f59e0b", marginTop: 1 }}> {f.note}</div>}
          {rowLockIcon(selCat, m.owner, fi)}
         </div>
         {!isMobile && (
          <div style={{ textAlign: "right", color: "#94a3b8" }}>
           {f.bo > 0 ? "$" + f.bo.toFixed(1) + "M" : "\u2014"}
          </div>
         )}
         {isMobile ? (
          <div style={{ textAlign: "right", fontSize: 10, color: "#94a3b8" }}>
           <div>{f.bo > 0 ? "$" + f.bo.toFixed(0) + "M" : "\u2014"}</div>
           <div style={{ color: f.rt >= 70 ? "#22c55e" : f.rt >= 50 ? "#eab308" : f.rt > 0 ? "#ef4444" : "#475569" }}>
            {f.rt > 0 ? f.rt + "%" : "\u2014"}
           </div>
          </div>
         ) : (
          <div style={{ textAlign: "center",
           color: f.rt >= 70 ? "#22c55e" : f.rt >= 50 ? "#eab308" : f.rt > 0 ? "#ef4444" : "#475569" }}>
           {f.rt > 0 ? f.rt + "%" : "\u2014"}
          </div>
         )}
         <div style={{ textAlign: "right", color: "#f1f5f9", fontWeight: 700 }}>
          {f.score > 0 ? f.score.toFixed(2) : "0.00"}
         </div>
        </div>
       );
      })}
     </div>
     {/* Totals row for films */}
     <div style={{ display: "grid",
      gridTemplateColumns: isMobile ? "1fr 50px 55px" : "1fr 62px 38px 70px",
      gap: 6, padding: "6px 12px", background: "rgba(242,184,74,0.08)",
      borderTop: `1px solid ${theme.bdr}`, fontSize: 11, fontWeight: 700 }}>
      <span style={{ color: "#94a3b8" }}>Total ({d.films.length} film{d.films.length !== 1 ? "s" : ""})</span>
      {!isMobile && <div style={{ textAlign: "right", color: "#94a3b8" }}>${d.films.reduce(function(s,f){return s+f.bo;},0).toFixed(1)}M</div>}
      {isMobile ? (
       <div style={{ textAlign: "right", fontSize: 10, color: "#94a3b8" }}>
        <div>${d.films.reduce(function(s,f){return s+f.bo;},0).toFixed(0)}M</div>
       </div>
      ) : <div />}
      <div style={{ textAlign: "right", color: "#f8fafc", fontWeight: 800, fontSize: 13 }}>
       {d.films.reduce(function(s,f){return s+(f.score||0);},0).toFixed(2)}
      </div>
     </div>
     <div style={ft}>
      Combined: {d.totalScore.toFixed(2)} {"\u2192"} {m.base}b + {m.bonus}bn ={" "}
      <b style={{ color: "#f8fafc", fontSize: 13 }}>{m.total} pts</b>
      {hasAnyLock(seasonData, selCat, m.owner) && (
       <LockIndicator note="Some values locked by commissioner" />
      )}
      {bonusNoteDisplay(d)}
      {typeof m.projectedTotal === "number" && (
       <div style={{ marginTop: 4, fontSize: 10, color: theme.dim }}>
        Projected final: <b style={{ color: "#f8fafc" }}>{Math.round(m.projectedTotal)} pts</b>
        {m.projectionConfidence ? " (" + m.projectionConfidence.replace(/_/g, " ") + " confidence)" : ""}
       </div>
      )}
      {m.projectionNote && (
       <div style={{ marginTop: 2, fontSize: 10, color: "#38bdf8", fontStyle: "italic" }}>
        {m.projectionNote}
       </div>
      )}
     </div>
    </div>
   );
  }

  // MUSIC
  if (isMusic) {
   return (
    <div style={wp}>
     {d.songs.length > 0 ? (
      <div>
       <div style={{ display: "grid", gridTemplateColumns: "1fr 55px 55px", gap: 6,
        padding: "6px 12px", background: theme.bg, fontSize: 10, fontWeight: 700, color: "#64748b" }}>
        <span>Song</span>
        <span style={{ textAlign: "right" }}>Weeks</span>
        <span style={{ textAlign: "right" }}>#1 Wks</span>
       </div>
       <div style={{ padding: "4px 12px" }}>
        {d.songs.map(function (sg, si) {
         return (
          <div key={si} style={{ display: "grid", gridTemplateColumns: "1fr 55px 55px", gap: 6,
           padding: "4px 0", borderBottom: si === d.songs.length - 1 ? "none" : `1px solid ${theme.card}`, fontSize: 11 }}>
           <span style={{ color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sg.title}</span>
           <div style={{ textAlign: "right", color: "#94a3b8" }}>{sg.weeks}</div>
           <div style={{ textAlign: "right", color: sg.numOneWeeks > 0 ? "#22c55e" : "#475569", fontWeight: 700 }}>
            {sg.numOneWeeks > 0 ? sg.numOneWeeks : "\u2014"}
           </div>
          </div>
         );
        })}
       </div>
       {/* Totals row for songs */}
       <div style={{ display: "grid", gridTemplateColumns: "1fr 55px 55px", gap: 6,
        padding: "6px 12px", background: "rgba(242,184,74,0.08)",
        borderTop: `1px solid ${theme.bdr}`, fontSize: 11, fontWeight: 700 }}>
        <span style={{ color: "#94a3b8" }}>Total ({d.songs.length} song{d.songs.length !== 1 ? "s" : ""})</span>
        <div style={{ textAlign: "right", color: "#f8fafc", fontWeight: 800 }}>
         {d.songs.reduce(function(s,sg){return s+(Number(sg.weeks)||0);},0)}
        </div>
        <div style={{ textAlign: "right", color: d.songs.reduce(function(s,sg){return s+(Number(sg.numOneWeeks)||0);},0) > 0 ? "#22c55e" : "#475569", fontWeight: 800 }}>
         {d.songs.reduce(function(s,sg){return s+(Number(sg.numOneWeeks)||0);},0) || "\u2014"}
        </div>
       </div>
      </div>
     ) : (
      <div style={{ padding: "8px 12px", fontSize: 11, color: "#475569" }}>No Billboard Hot 100 data</div>
     )}
     {d.grammys.length > 0 && (
      <div>
       <div style={{ display: "grid", gridTemplateColumns: "1fr 50px 50px", gap: 6,
        padding: "6px 12px", background: theme.bg, fontSize: 10, fontWeight: 700, color: "#64748b" }}>
        <span>Grammy Category</span>
        <span style={{ textAlign: "center" }}>Result</span>
        <span style={{ textAlign: "right" }}>Pts</span>
       </div>
       <div style={{ padding: "4px 12px" }}>
        {d.grammys.map(function (g, gi) {
         return (
          <div key={gi} style={{ display: "grid", gridTemplateColumns: "1fr 50px 50px", gap: 6,
           alignItems: "center", padding: "5px 0",
           borderBottom: gi === d.grammys.length - 1 ? "none" : `1px solid ${theme.card}`, fontSize: 11 }}>
           <span style={{ color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.category}</span>
           <span style={{ textAlign: "center", fontSize: 10,
            color: g.result === "win" ? "#22c55e" : "#eab308" }}>
            {g.result === "win" ? " Won" : "Nom"}
           </span>
           <div style={{ textAlign: "right", color: g.pts > 0 ? "#f8fafc" : "#475569", fontWeight: 700 }}>
            {g.pts > 0 ? "+" + g.pts : "\u2014"}
           </div>
          </div>
         );
        })}
       </div>
      </div>
     )}
     {totalLine}
    </div>
   );
  }
 
  // EVENTS
  if (isEvent) {
   return (
    <div style={wp}>
     <div style={hd}>
      <b style={{ color: "#cbd5e1" }}>
       {selCat === "Tennis" ? "Post-AO Ranking" : selCat === "Golf" ? "World Ranking" : "Season Pts"}:{" "}
      </b>
      <span style={{ color: "#f8fafc", fontSize: 13, fontWeight: 700 }}>
       {selCat === "Golf" ? "#" + d.ranking : d.ranking.toLocaleString()}
      </span>
      {" \u2192 " + m.base + " base pts"}
     </div>
     {d.majors && d.majors.length > 0 && (
      <div style={{ padding: "4px 12px" }}>
       {d.majors.map(function (mj, mi) {
        return (
         <div key={mi} style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr 60px 40px" : "1fr 90px 50px",
          gap: 4, alignItems: "center", padding: "5px 0",
          borderBottom: mi === d.majors.length - 1 ? "none" : `1px solid ${theme.card}`, fontSize: 11,
         }}>
          <div>
           <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{mj.event}</span>
           {!isMobile && mj.opponent !== "\u2014" && <span style={{ color: "#64748b", marginLeft: 6 }}>{mj.opponent}</span>}
           {isMobile && mj.opponent !== "\u2014" && <div style={{ fontSize: 10, color: "#64748b" }}>{mj.opponent}</div>}
           {mj.score && mj.score !== "\u2014" && <div style={{ fontSize: 10, color: "#64748b" }}>{mj.score}</div>}
           {rowLockIcon(selCat, m.owner, mi)}
          </div>
          <span style={{ color: "#94a3b8", textAlign: "center", fontSize: isMobile ? 10 : 11 }}>{mj.result}</span>
          <div style={{ textAlign: "right", color: mj.pts > 0 ? "#f8fafc" : "#475569", fontWeight: 700 }}>
           {mj.pts > 0 ? "+" + mj.pts : "\u2014"}
          </div>
         </div>
        );
       })}
      </div>
     )}
     {/* Totals row for event majors */}
     {d.majors && d.majors.length > 0 && (
      <div style={{
       display: "grid",
       gridTemplateColumns: isMobile ? "1fr 60px 40px" : "1fr 90px 50px",
       gap: 4, padding: "6px 12px", background: "rgba(242,184,74,0.08)",
       borderTop: `1px solid ${theme.bdr}`, fontSize: 11, fontWeight: 700,
      }}>
       <span style={{ color: "#94a3b8" }}>Total ({d.majors.length} event{d.majors.length !== 1 ? "s" : ""})</span>
       <div />
       <div style={{ textAlign: "right", color: "#f8fafc", fontWeight: 800 }}>
        +{d.majors.reduce(function(s,mj){return s+(Number(mj.pts)||0);},0)}
       </div>
      </div>
     )}
     {totalLine}
    </div>
   );
  }
 
  // COUNTRY
  if (isCountry) {
   return (
    <div style={wp}>
     <div style={hd}>
      <b style={{ color: "#cbd5e1" }}>GDP Growth: </b>
      <span style={{ color: "#f8fafc", fontSize: 13, fontWeight: 700 }}>{d.gdp}%</span>
      {" \u2192 " + m.base + " base pts"}
     </div>
     {d.olympics && d.olympics.total > 0 ? (
      <div style={{ padding: "8px 12px" }}>
       <div style={{ fontSize: 11, color: "#94a3b8", display: "flex", gap: isMobile ? 8 : 12, flexWrap: "wrap" }}>
        <span> {d.olympics.gold}</span>
        <span> {d.olympics.silver}</span>
        <span> {d.olympics.bronze}</span>
        <span style={{ color: "#f8fafc", fontWeight: 700 }}>= {d.olympics.total}</span>
        <span style={{ color: d.olympics.pts > 0 ? "#22c55e" : "#94a3b8" }}>Rank #{d.olympics.rank}</span>
       </div>
       {d.olympics.note && (
        <div style={{ fontSize: 10, color: d.olympics.pts > 0 ? "#22c55e" : "#64748b", marginTop: 4 }}>{d.olympics.note}</div>
       )}
      </div>
     ) : (
      <div style={{ padding: "8px 12px", fontSize: 11, color: "#475569" }}>
       {d.olympics && d.olympics.note ? d.olympics.note : "Did not win any medals"}
      </div>
     )}
     {totalLine}
    </div>
   );
  }
 
  // STOCK
  if (isStock) {
   return (
    <div style={wp}>
     <div style={{ padding: "8px 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#94a3b8", marginBottom: 4, flexWrap: "wrap", gap: 4 }}>
       <span>Open: ${d.openPrice}</span>
       <span>Close: ${d.closePrice}</span>
       <span style={{ color: d.pctChange >= 0 ? "#22c55e" : "#ef4444", fontWeight: 700 }}>
        {(d.pctChange >= 0 ? "+" : "") + d.pctChange.toFixed(2)}%
       </span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: theme.bg, overflow: "hidden" }}>
       <div style={{ height: "100%", borderRadius: 3,
        width: Math.min(100, Math.abs(d.pctChange || 0) + 5) + "%",
        background: d.pctChange >= 0 ? theme.grn : theme.red }} />
      </div>
      {d.note && <div style={{ fontSize: 10, color: "#64748b", marginTop: 4 }}>{d.note}</div>}
     </div>
     <div style={ft}>
      Total: <b style={{ color: "#f8fafc", fontSize: 13 }}>{m.total} pts</b> (no bonus for Stock)
      {hasAnyLock(seasonData, selCat, m.owner) && (
       <LockIndicator note="Some values locked by commissioner" />
      )}
      {bonusNoteDisplay(d)}
     </div>
    </div>
   );
  }
 
  // Fallback
  return (
   <div style={{ padding: "10px 14px", borderRadius: "0 0 10px 10px", background: theme.card,
    border: "1px solid " + rowBorder(rank), borderTop: `1px solid ${theme.bdr}`, fontSize: 12, color: "#cbd5e1" }}>
    Base: {m.base} + Bonus: {m.bonus} = {m.total} pts
    {bonusNoteDisplay(d)}
   </div>
  );
 }
 
 // === MAIN RENDER ===
 return (
  <div style={{ maxWidth: isWide ? 1080 : 760, margin: "0 auto" }}>
   {/* MOCK ONLY — page-level two-column layout preview. Below 1024px this
       collapses back to exactly what's shipped today (single column,
       sidebar hidden). Not wired up anywhere else yet. */}
   <div style={{ display: isWide ? "flex" : "block", gap: isWide ? 28 : 0, alignItems: "flex-start" }}>
   <div style={{ flex: 1, minWidth: 0 }}>
   {/* Category pills */}
   <ScrollFadeEdges scrollRef={pillsRef} fadeColor={theme.bg}>
   <div ref={pillsRef} style={{
    display: "flex", flexWrap: isMobile ? "nowrap" : "wrap",
    gap: 4, marginBottom: 16, justifyContent: isMobile ? "flex-start" : "center",
    overflowX: isMobile ? "auto" : "visible",
    WebkitOverflowScrolling: "touch",
    paddingBottom: isMobile ? 4 : 0,
    msOverflowStyle: "none", scrollbarWidth: "none",
   }}>
    <CategoryPill active={!selCat} onClick={function () {
       track(EVENTS.CATEGORY_FILTER_CHANGED, { surface: surfaceName, category: "overall", previous_category: selCat || "overall" });
       setSelCat(null); setExpRow(null);
      }}>
     Overall
    </CategoryPill>
    {CATEGORY_ORDER.map(function (k) {
     var isSel = selCat === k;
     return (
      <CategoryPill key={k} active={isSel} onClick={function () {
         track(EVENTS.CATEGORY_FILTER_CHANGED, { surface: surfaceName, category: k, previous_category: selCat || "overall" });
         setSelCat(k); setExpRow(null);
        }}>
       {CATEGORY_LABELS[k]}
      </CategoryPill>
     );
    })}
   </div>
   </ScrollFadeEdges>

   {/* PROJECTED FINAL toggle — degrades to nothing if no projections data
       has loaded for this season (never shows a toggle with nothing behind it). */}
   {hasProjections && (
    <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
     <div style={{ display: "flex", borderRadius: 8, border: `1px solid ${theme.bdr}`, overflow: "hidden" }}>
      <button onClick={function () { if (showProjected) toggleProjected(); }}
       style={{
        padding: "5px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", border: "none",
        background: !showProjected ? theme.acc : "transparent", color: !showProjected ? "#1a1300" : theme.dim,
       }}>Current</button>
      <button onClick={function () { if (!showProjected) toggleProjected(); }}
       style={{
        padding: "5px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", border: "none",
        background: showProjected ? theme.acc : "transparent", color: showProjected ? "#1a1300" : theme.dim,
       }}>Projected Final</button>
     </div>
    </div>
   )}
   {showProjected && (
    <div style={{ textAlign: "center", fontSize: 10, color: theme.dim, marginBottom: 10, marginTop: -4 }}>
     Monte Carlo simulation of where the season could land. Based on current Vegas, Kalshi, Polymarket, etc.
     odds, where available. If future odds aren't available, current scores are shown instead.
     Categories carry different confidence: sports are medium confidence given the data available on them,
     movies and music are low confidence guesses, and stock/country are a current snapshot with no projection.
     See the category view for more detail.
    </div>
   )}

   {/* OVERALL VIEW */}
   {!selCat && (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
     {(showProjected ? overallStandings.projected : overallStandings.actual).map(function (m) {
      var isExp = expRow === m.owner;
      var memberPaywalled = isPaywalled(seasonData, m.id);
      return (
       <div key={m.owner}>
        <div onClick={function () {
           if (!isExp) track(EVENTS.MEMBER_ROW_EXPANDED, { surface: surfaceName, category: "overall", member_name: m.owner });
           setExpRow(isExp ? null : m.owner);
          }}
         style={{
          borderRadius: isExp ? "10px 10px 0 0" : 10,
          background: rowBackground(m.rank), border: "1px solid " + rowBorder(m.rank),
          borderBottom: isExp ? "none" : undefined, cursor: "pointer",
          padding: isMobile ? "8px 10px" : "10px 12px" }}>
         <div style={{ display: "grid",
          gridTemplateColumns: isMobile ? "28px 1fr 50px 16px" : "32px 1fr 60px 20px",
          alignItems: "center", gap: 4 }}>
          <RankBadge rank={m.rank} size={isMobile ? 13 : 15} />
          <span style={{ fontSize: isMobile ? 13 : 15, fontWeight: 700, color: MEMBER_COLORS[m.id] || "#f1f5f9",
           overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.owner}</span>
          <span style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 3 }}>
           {memberPaywalled && <Lock size={isMobile ? 11 : 13} color={theme.yel} />}
           <span style={Object.assign({ fontSize: isMobile ? 17 : 20, fontWeight: 800, color: "#f8fafc", textAlign: "right" },
            memberPaywalled ? PAYWALL_BLUR_STYLE : {})}>{showProjected ? Math.round(m.totalPtsProjected) : m.totalPts}</span>
          </span>
          {isExp ? <ChevronDown size={14} color={theme.dim} /> : <ChevronRight size={14} color={theme.dim} />}
         </div>
         {/* MOCK ONLY — inline category-strength strip + standout caption,
             desktop-width preview. Uses real per-row catScores already
             computed above. Remove this comment once it's real. */}
         {!isMobile && !memberPaywalled && (function () {
          var scores = showProjected ? m.catScoresProjected : m.catScores;
          var ticks = CATEGORY_ORDER.map(function (k) {
           var hasEntry = Object.prototype.hasOwnProperty.call(m.catScores, k);
           var pts = scores[k] || 0;
           var status = !hasEntry ? "none" : pts >= 15 ? "high" : pts <= 3 ? "low" : "mid";
           return { key: k, pts: pts, hasEntry: hasEntry, status: status };
          });
          var standouts = ticks.filter(function (t) { return t.status === "high" || t.status === "low"; });
          return (
           <div>
            <div style={{ display: "flex", gap: 2, marginTop: 7, paddingLeft: 36 }}>
             {ticks.map(function (t) {
              var color = t.status === "none" ? "rgba(255,255,255,0.06)"
               : t.status === "high" ? theme.grn : t.status === "low" ? theme.red : "rgba(255,255,255,0.18)";
              return (
               <div key={t.key} title={t.key + ": " + (t.hasEntry ? t.pts + " pts" : "no pick")}
                style={{ flex: 1, height: 5, borderRadius: 3, background: color }} />
              );
             })}
            </div>
            {standouts.length > 0 && (
             <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", marginTop: 5, paddingLeft: 36, fontSize: 10 }}>
              {standouts.map(function (t) {
               return (
                <span key={t.key} style={{ color: t.status === "high" ? theme.grn : theme.red, fontWeight: 600 }}>
                 {t.key} {t.pts}
                </span>
               );
              })}
             </div>
            )}
           </div>
          );
         })()}
        </div>
        {isExp && (
         <div style={{ padding: isMobile ? "8px 8px" : "10px 12px", borderRadius: "0 0 10px 10px",
          background: theme.card, border: "1px solid " + rowBorder(m.rank), borderTop: `1px solid ${theme.bdr}` }}>
          {memberPaywalled ? renderPaywallPanel(m.owner, m.id) : (
           <div style={{ display: "grid",
            gridTemplateColumns: isMobile ? "repeat(3, 1fr)" : "repeat(5, 1fr)",
            gap: 4 }}>
            {CATEGORY_ORDER.map(function (k) {
             var pts = (showProjected ? m.catScoresProjected : m.catScores)[k] || 0;
             var pickEntry = (cats[k] || []).find(function (x) { return x.owner === m.owner; });
             var pickName = pickEntry ? pickEntry.pick : "";
             return (
              <div key={k}
               onClick={function (e) {
                 e.stopPropagation();
                 track(EVENTS.OVERALL_CATEGORY_TILE_CLICKED, { category: k });
                 setSelCat(k); setExpRow(null);
                }}
               style={{ padding: "4px 6px", borderRadius: 6, textAlign: "center", cursor: "pointer",
                background: pts >= 15 ? "rgba(34,197,94,0.15)" : pts <= 3 ? "rgba(239,68,68,0.1)" : "rgba(255,255,255,0.06)" }}>
               <div style={{ fontSize: isMobile ? 8 : 9, color: "#64748b", lineHeight: 1.2 }}>{CATEGORY_LABELS[k]}</div>
               <div style={{ fontSize: isMobile ? 7 : 8, color: "#94a3b8", lineHeight: 1.2, marginTop: 1,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pickName}</div>
               <div style={{ fontSize: isMobile ? 12 : 14, fontWeight: 700,
                color: pts >= 15 ? "#22c55e" : pts <= 3 ? "#ef4444" : "#e2e8f0" }}>{pts}</div>
              </div>
             );
            })}
           </div>
          )}
         </div>
        )}
       </div>
      );
     })}
    </div>
   )}
 
   {/* CATEGORY VIEW */}
   {selCat && catMembers && (
    <div>
     <div style={{ marginBottom: 12 }}>
      <h2 style={{ fontSize: isMobile ? 15 : 17, fontWeight: 700, color: "#f8fafc", margin: 0 }}>{CATEGORY_LABELS[selCat]}</h2>
     </div>
     <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {catMembers.map(function (m) {
       var isExp = expRow === m.owner;
       var mid = (members.find(function (x) { return x.name === m.owner; }) || {}).id;
       var memberHasLocks = hasAnyLock(seasonData, selCat, m.owner);
       var memberPaywalled = isPaywalled(seasonData, mid);
       return (
        <div key={m.owner}>
         <div onClick={function () {
            if (!isExp) track(EVENTS.MEMBER_ROW_EXPANDED, { surface: surfaceName, category: selCat, member_name: m.owner });
            setExpRow(isExp ? null : m.owner);
           }}
          style={{
           display: "grid",
           gridTemplateColumns: isMobile ? "28px 1fr auto" : "32px 1fr auto",
           alignItems: "center", padding: isMobile ? "8px 10px" : "10px 12px", gap: 8,
           borderRadius: isExp ? "10px 10px 0 0" : 10,
           background: rowBackground(m.rank), border: "1px solid " + rowBorder(m.rank),
           borderBottom: isExp ? "none" : undefined, cursor: "pointer",
          }}>
          <RankBadge rank={m.rank} size={isMobile ? 13 : 15} />
          <div style={{ minWidth: 0 }}>
           <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
            <span style={{ fontSize: isMobile ? 13 : 14, fontWeight: 700, color: MEMBER_COLORS[mid] || "#f1f5f9",
             overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
             {m.owner}
            </span>
            {memberHasLocks && <LockIndicator note="Commissioner has locked some values for this entry" />}
            {memberPaywalled && <Lock size={10} color={theme.yel} style={{ marginLeft: 4, flexShrink: 0 }} />}
            <button
             onClick={function (e) {
               e.stopPropagation();
               track(EVENTS.CATEGORY_FILTER_CHANGED, { surface: surfaceName, category: "overall", previous_category: selCat || "overall" });
               setSelCat(null); setExpRow(m.owner);
              }}
             title={"See " + m.owner + " in every category"}
             style={{ background: "none", border: "none", padding: 0, display: "inline-flex",
              alignItems: "center", color: theme.dim, cursor: "pointer", flexShrink: 0 }}>
             <ArrowUpRight size={12} />
            </button>
           </div>
           <div style={{ fontSize: isMobile ? 10 : 11, color: theme.dim,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.pick}</div>
          </div>
          {(function () {
            var dispTotal = showProjected ? Math.round(m.projectedTotal) : m.total;
            var dispBase = showProjected ? m.projectedBase : m.base;
            var dispBonus = showProjected ? m.projectedBonus : m.bonus;
            return isMobile ? (
             <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div style={Object.assign({ fontSize: 17, fontWeight: 800, color: "#f8fafc" }, memberPaywalled ? PAYWALL_BLUR_STYLE : {})}>{dispTotal}</div>
              <div style={Object.assign({ fontSize: 9, color: "#64748b" }, memberPaywalled ? PAYWALL_BLUR_STYLE : {})}>
               {dispBase}b {dispBonus > 0 ? "+" + dispBonus + "bn" : ""}
              </div>
             </div>
            ) : (
             <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <div style={{ textAlign: "center" }}>
               <div style={{ fontSize: 9, color: "#64748b" }}>{showProjected ? "Proj. Base" : "Base"}</div>
               <div style={Object.assign({ fontSize: 13, fontWeight: 700, color: "#94a3b8" }, memberPaywalled ? PAYWALL_BLUR_STYLE : {})}>{dispBase}</div>
              </div>
              <div style={{ textAlign: "center" }}>
               <div style={{ fontSize: 9, color: "#64748b" }}>{showProjected ? "Proj. Bonus" : "Bonus"}</div>
               <div style={Object.assign({ fontSize: 13, fontWeight: 700, color: dispBonus > 0 ? "#22c55e" : "#475569" }, memberPaywalled ? PAYWALL_BLUR_STYLE : {})}>
                {dispBonus > 0 ? "+" + dispBonus : "0"}
               </div>
              </div>
              <div style={{ textAlign: "center" }}>
               <div style={{ fontSize: 9, color: "#64748b" }}>{showProjected ? "Proj. Total" : "Total"}</div>
               <div style={Object.assign({ fontSize: 17, fontWeight: 800, color: "#f8fafc" }, memberPaywalled ? PAYWALL_BLUR_STYLE : {})}>{dispTotal}</div>
              </div>
             </div>
            );
          })()}
         </div>
         {isExp && renderExpanded(m, m.rank)}
        </div>
       );
      })}
     </div>
     <div style={{ marginTop: 12, padding: 12, borderRadius: 10,
      background: "rgba(255,255,255,0.06)", border: `1px solid ${theme.bdr}` }}>
      <div style={{ fontSize: 11, color: "#94a3b8" }}>
       <b style={{ color: "#f1f5f9" }}>Bonus Rules: </b>
       {CATEGORY_BONUS_RULES[selCat]}
      </div>
     </div>
    </div>
   )}

   </div>

   {/* MOCK ONLY — sidebar. Category Leaders uses real data already passed
       into this component (seasonData.categories). An "Upcoming" card was
       dropped from the first version of this mock — it only had hardcoded
       sample events, which would mislead real viewers once shipped; wiring
       it to real calendar_events is a follow-up, not this PR. */}
   {isWide && (
    <div style={{ width: 300, flexShrink: 0, display: "flex", flexDirection: "column", gap: 16 }}>
     <div style={{ ...cardStyle, padding: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: theme.mut, marginBottom: 10,
       textTransform: "uppercase", letterSpacing: 1 }}>Category Leaders</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
       {categoryLeaders.map(function (cl) {
        var isTied = cl.owners.length > 1;
        var singleId = (!isTied && cl.owners[0])
         ? (members.find(function (x) { return x.name === cl.owners[0]; }) || {}).id : null;
        var nameText = cl.owners.length === 0 ? "—"
         : isTied ? cl.owners.join(" & ")
         : cl.owners[0];
        // Any tied leader being paywalled blurs the shared score — showing
        // one tied member's real number would let you back into the
        // paywalled member's number by elimination.
        var leaderPaywalled = cl.owners.some(function (name) {
         var id = (members.find(function (x) { return x.name === name; }) || {}).id;
         return isPaywalled(seasonData, id);
        });
        return (
         <div key={cl.key} onClick={function () {
            track(EVENTS.CATEGORY_FILTER_CHANGED, { surface: surfaceName, category: cl.key, previous_category: selCat || "overall" });
            setSelCat(cl.key); setExpRow(null);
           }}
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
           gap: 6, cursor: "pointer", padding: "2px 0" }}>
          <span style={{ fontSize: 11, color: theme.dim, flexShrink: 0, width: 92,
           overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{CATEGORY_LABELS[cl.key]}</span>
          <span title={isTied ? "Tied: " + cl.owners.join(", ") : undefined}
           style={{ fontSize: 12, fontWeight: 700, flex: 1, textAlign: "right",
           color: singleId ? (MEMBER_COLORS[singleId] || theme.txt) : (cl.owners.length === 0 ? theme.dim : theme.txt),
           overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex",
           alignItems: "center", justifyContent: "flex-end", gap: 3 }}>
           {leaderPaywalled && <Lock size={10} color={theme.yel} style={{ flexShrink: 0 }} />}
           <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{nameText}</span>
          </span>
          <span style={Object.assign({ fontSize: 12, fontWeight: 800, color: theme.txt, width: 28, textAlign: "right", flexShrink: 0 },
           leaderPaywalled ? PAYWALL_BLUR_STYLE : {})}>
           {cl.owners.length > 0 ? cl.total : ""}
          </span>
         </div>
        );
       })}
      </div>
     </div>
    </div>
   )}
   </div>

   {toast && (
    <div style={{
     position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)",
     background: theme.card, border: "1px solid #eab308", borderRadius: 10,
     padding: "10px 18px", fontSize: 13, fontWeight: 700, color: "#fef9c3",
     boxShadow: "0 8px 24px rgba(0,0,0,0.4)", zIndex: 1000, whiteSpace: "nowrap",
    }}>
     {toast}
    </div>
   )}
  </div>
 );
}
