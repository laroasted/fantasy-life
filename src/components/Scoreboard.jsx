import { useState, useMemo, useEffect } from "react";
import { CATEGORY_ORDER, CATEGORY_LABELS, CATEGORY_BONUS_RULES, SPORT_CATEGORIES } from "../constants/categories";
import { MEMBER_COLORS } from "../constants/members";
import { theme } from "../constants/theme";
import { medalDisplay, rowBackground, rowBorder, expandedWrapperStyle, expandedHeaderStyle, expandedFooterStyle, hasAnyLock } from "../utils/helpers";

// ─── Small lock indicator that players see on the scoreboard ───
function LockIndicator({ note }) {
 var _h = useState(false), hover = _h[0], setHover = _h[1];
 return (
  <span style={{ position: "relative", display: "inline-flex", alignItems: "center", marginLeft: 4 }}
   onMouseEnter={function () { setHover(true); }} onMouseLeave={function () { setHover(false); }}>
   <span style={{ fontSize: 10, cursor: "help" }}>{"\uD83D\uDD12"}</span>
   {hover && (
    <span style={{
     position: "absolute", bottom: "100%", left: "50%", transform: "translateX(-50%)",
     background: "#1e293b", border: "1px solid #eab308", borderRadius: 6,
     padding: "6px 10px", fontSize: 10, color: "#fef9c3", whiteSpace: "nowrap",
     zIndex: 999, pointerEvents: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
    }}>
     {note || "Commissioner locked this value"}
    </span>
   )}
  </span>
 );
}

export default function Scoreboard({ seasonData }) {
 var _s = useState(null), selCat = _s[0], setSelCat = _s[1];
 var _e = useState(null), expRow = _e[0], setExpRow = _e[1];
 var _m = useState(window.innerWidth < 640), isMobile = _m[0], setIsMobile = _m[1];

 useEffect(function () {
  var onResize = function () { setIsMobile(window.innerWidth < 640); };
  window.addEventListener("resize", onResize);
  return function () { window.removeEventListener("resize", onResize); };
 }, []);

 if (!seasonData) {
  return <div style={{ textAlign: "center", padding: 40, color: theme.dim }}>No active season.</div>;
 }

 var members = seasonData.members || [];
 var cats = seasonData.categories || {};
 var detail = seasonData.detailedData || {};
 var locks = seasonData.locks || {};

 var overallStandings = useMemo(function () {
  return members.map(function (m) {
   var totalPts = 0;
   var catScores = {};
   CATEGORY_ORDER.forEach(function (k) {
    var entry = (cats[k] || []).find(function (x) { return x.owner === m.name; });
    if (entry) { totalPts += entry.total; catScores[k] = entry.total; }
   });
   return { owner: m.name, id: m.id, totalPts: totalPts, catScores: catScores };
  }).sort(function (a, b) { return b.totalPts - a.totalPts; });
 }, [members, cats]);

 var catMembers = selCat ? [].concat(cats[selCat] || []).sort(function (a, b) { return b.total - a.total; }) : null;
 var detailArr = selCat ? detail[selCat] : null;

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
 function renderExpanded(m, idx) {
  var d = detailArr ? detailArr.find(function (x) { return x.owner === m.owner; }) : null;
  var wp = expandedWrapperStyle(idx);
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
   </div>
  );

  if (!d) {
   return (
    <div style={{ padding: "10px 14px", borderRadius: "0 0 10px 10px", background: "#1e293b",
     border: "1px solid " + rowBorder(idx), borderTop: "1px solid #334155", fontSize: 12, color: "#cbd5e1" }}>
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
          borderBottom: ri === d.rounds.length - 1 ? "none" : "1px solid #1e293b", fontSize: 11,
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
            background: r.result === "Won" ? "rgba(34,197,94,0.2)" : r.result === "Lost" ? "rgba(239,68,68,0.15)" : "rgba(51,65,85,0.3)",
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
      gap: 6, padding: "6px 12px", background: "#0f172a", fontSize: 10, fontWeight: 700, color: "#64748b",
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
         borderBottom: fi === d.films.length - 1 ? "none" : "1px solid #1e293b", fontSize: 11,
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
      gap: 6, padding: "6px 12px", background: "rgba(59,130,246,0.08)",
      borderTop: "1px solid #334155", fontSize: 11, fontWeight: 700 }}>
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
        padding: "6px 12px", background: "#0f172a", fontSize: 10, fontWeight: 700, color: "#64748b" }}>
        <span>Song</span>
        <span style={{ textAlign: "right" }}>Weeks</span>
        <span style={{ textAlign: "right" }}>#1 Wks</span>
       </div>
       <div style={{ padding: "4px 12px" }}>
        {d.songs.map(function (sg, si) {
         return (
          <div key={si} style={{ display: "grid", gridTemplateColumns: "1fr 55px 55px", gap: 6,
           padding: "4px 0", borderBottom: si === d.songs.length - 1 ? "none" : "1px solid #1e293b", fontSize: 11 }}>
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
        padding: "6px 12px", background: "rgba(59,130,246,0.08)",
        borderTop: "1px solid #334155", fontSize: 11, fontWeight: 700 }}>
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
        padding: "6px 12px", background: "#0f172a", fontSize: 10, fontWeight: 700, color: "#64748b" }}>
        <span>Grammy Category</span>
        <span style={{ textAlign: "center" }}>Result</span>
        <span style={{ textAlign: "right" }}>Pts</span>
       </div>
       <div style={{ padding: "4px 12px" }}>
        {d.grammys.map(function (g, gi) {
         return (
          <div key={gi} style={{ display: "grid", gridTemplateColumns: "1fr 50px 50px", gap: 6,
           alignItems: "center", padding: "5px 0",
           borderBottom: gi === d.grammys.length - 1 ? "none" : "1px solid #1e293b", fontSize: 11 }}>
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
          borderBottom: mi === d.majors.length - 1 ? "none" : "1px solid #1e293b", fontSize: 11,
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
       gap: 4, padding: "6px 12px", background: "rgba(59,130,246,0.08)",
       borderTop: "1px solid #334155", fontSize: 11, fontWeight: 700,
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
      <div style={{ height: 6, borderRadius: 3, background: "#0f172a", overflow: "hidden" }}>
       <div style={{ height: "100%", borderRadius: 3,
        width: Math.min(100, Math.abs(d.pctChange || 0) + 5) + "%",
        background: d.pctChange >= 0
         ? "linear-gradient(90deg, #22c55e, #16a34a)"
         : "linear-gradient(90deg, #ef4444, #dc2626)" }} />
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
   <div style={{ padding: "10px 14px", borderRadius: "0 0 10px 10px", background: "#1e293b",
    border: "1px solid " + rowBorder(idx), borderTop: "1px solid #334155", fontSize: 12, color: "#cbd5e1" }}>
    Base: {m.base} + Bonus: {m.bonus} = {m.total} pts
    {bonusNoteDisplay(d)}
   </div>
  );
 }

 // === MAIN RENDER ===
 return (
  <div style={{ maxWidth: 760, margin: "0 auto" }}>
   {/* Category pills */}
   <div style={{
    display: "flex", flexWrap: isMobile ? "nowrap" : "wrap",
    gap: 4, marginBottom: 16, justifyContent: isMobile ? "flex-start" : "center",
    overflowX: isMobile ? "auto" : "visible",
    WebkitOverflowScrolling: "touch",
    paddingBottom: isMobile ? 4 : 0,
    msOverflowStyle: "none", scrollbarWidth: "none",
   }}>
    <button onClick={function () { setSelCat(null); setExpRow(null); }}
     style={{ padding: "5px 10px", borderRadius: 20, flexShrink: 0,
      border: "1px solid " + (!selCat ? "#3b82f6" : "#334155"),
      background: !selCat ? "#3b82f6" : "#1e293b",
      color: "#f1f5f9", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
     Overall
    </button>
    {CATEGORY_ORDER.map(function (k) {
     return (
      <button key={k} onClick={function () { setSelCat(k); setExpRow(null); }}
       style={{ padding: "5px 10px", borderRadius: 20, flexShrink: 0,
        border: "1px solid " + (selCat === k ? "#3b82f6" : "#334155"),
        background: selCat === k ? "#3b82f6" : "#1e293b",
        color: "#f1f5f9", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
       {CATEGORY_LABELS[k]}
      </button>
     );
    })}
   </div>

   {/* OVERALL VIEW */}
   {!selCat && (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
     {overallStandings.map(function (m, idx) {
      var isExp = expRow === m.owner;
      return (
       <div key={m.owner}>
        <div onClick={function () { setExpRow(isExp ? null : m.owner); }}
         style={{ display: "grid",
          gridTemplateColumns: isMobile ? "28px 1fr 50px" : "32px 1fr 60px",
          alignItems: "center", padding: isMobile ? "8px 10px" : "10px 12px",
          borderRadius: isExp ? "10px 10px 0 0" : 10,
          background: rowBackground(idx), border: "1px solid " + rowBorder(idx),
          borderBottom: isExp ? "none" : undefined, cursor: "pointer" }}>
         <span style={{ fontSize: isMobile ? 13 : 15, fontWeight: 800, color: "#94a3b8" }}>{medalDisplay(idx)}</span>
         <span style={{ fontSize: isMobile ? 13 : 15, fontWeight: 700, color: MEMBER_COLORS[m.id] || "#f1f5f9",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.owner}</span>
         <span style={{ fontSize: isMobile ? 17 : 20, fontWeight: 800, color: "#f8fafc", textAlign: "right" }}>{m.totalPts}</span>
        </div>
        {isExp && (
         <div style={{ padding: isMobile ? "8px 8px" : "10px 12px", borderRadius: "0 0 10px 10px",
          background: "#1e293b", border: "1px solid " + rowBorder(idx), borderTop: "1px solid #334155" }}>
          <div style={{ display: "grid",
           gridTemplateColumns: isMobile ? "repeat(3, 1fr)" : "repeat(5, 1fr)",
           gap: 4 }}>
           {CATEGORY_ORDER.map(function (k) {
            var pts = m.catScores[k] || 0;
            return (
             <div key={k}
              onClick={function (e) { e.stopPropagation(); setSelCat(k); setExpRow(null); }}
              style={{ padding: "4px 6px", borderRadius: 6, textAlign: "center", cursor: "pointer",
               background: pts >= 15 ? "rgba(34,197,94,0.15)" : pts <= 3 ? "rgba(239,68,68,0.1)" : "rgba(51,65,85,0.3)" }}>
              <div style={{ fontSize: isMobile ? 8 : 9, color: "#64748b", lineHeight: 1.2 }}>{CATEGORY_LABELS[k]}</div>
              <div style={{ fontSize: isMobile ? 12 : 14, fontWeight: 700,
               color: pts >= 15 ? "#22c55e" : pts <= 3 ? "#ef4444" : "#e2e8f0" }}>{pts}</div>
             </div>
            );
           })}
          </div>
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
      {catMembers.map(function (m, idx) {
       var isExp = expRow === m.owner;
       var mid = (members.find(function (x) { return x.name === m.owner; }) || {}).id;
       var memberHasLocks = hasAnyLock(seasonData, selCat, m.owner);
       return (
        <div key={m.owner}>
         <div onClick={function () { setExpRow(isExp ? null : m.owner); }}
          style={{
           display: "grid",
           gridTemplateColumns: isMobile ? "28px 1fr auto" : "32px 1fr auto",
           alignItems: "center", padding: isMobile ? "8px 10px" : "10px 12px", gap: 8,
           borderRadius: isExp ? "10px 10px 0 0" : 10,
           background: rowBackground(idx), border: "1px solid " + rowBorder(idx),
           borderBottom: isExp ? "none" : undefined, cursor: "pointer",
          }}>
          <span style={{ fontSize: isMobile ? 13 : 15, fontWeight: 800, color: "#94a3b8" }}>{medalDisplay(idx)}</span>
          <div style={{ minWidth: 0 }}>
           <div style={{ fontSize: isMobile ? 13 : 14, fontWeight: 700, color: MEMBER_COLORS[mid] || "#f1f5f9",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {m.owner}
            {memberHasLocks && <LockIndicator note="Commissioner has locked some values for this entry" />}
           </div>
           <div style={{ fontSize: isMobile ? 10 : 11, color: theme.dim,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.pick}</div>
          </div>
          {isMobile ? (
           <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 800, color: "#f8fafc" }}>{m.total}</div>
            <div style={{ fontSize: 9, color: "#64748b" }}>
             {m.base}b {m.bonus > 0 ? "+" + m.bonus + "bn" : ""}
            </div>
           </div>
          ) : (
           <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div style={{ textAlign: "center" }}>
             <div style={{ fontSize: 9, color: "#64748b" }}>Base</div>
             <div style={{ fontSize: 13, fontWeight: 700, color: "#94a3b8" }}>{m.base}</div>
            </div>
            <div style={{ textAlign: "center" }}>
             <div style={{ fontSize: 9, color: "#64748b" }}>Bonus</div>
             <div style={{ fontSize: 13, fontWeight: 700, color: m.bonus > 0 ? "#22c55e" : "#475569" }}>
              {m.bonus > 0 ? "+" + m.bonus : "0"}
             </div>
            </div>
            <div style={{ textAlign: "center" }}>
             <div style={{ fontSize: 9, color: "#64748b" }}>Total</div>
             <div style={{ fontSize: 17, fontWeight: 800, color: "#f8fafc" }}>{m.total}</div>
            </div>
           </div>
          )}
         </div>
         {isExp && renderExpanded(m, idx)}
        </div>
       );
      })}
     </div>
     <div style={{ marginTop: 12, padding: 12, borderRadius: 10,
      background: "rgba(51,65,85,0.3)", border: "1px solid #334155" }}>
      <div style={{ fontSize: 11, color: "#94a3b8" }}>
       <b style={{ color: "#f1f5f9" }}>Bonus Rules: </b>
       {CATEGORY_BONUS_RULES[selCat]}
      </div>
     </div>
    </div>
   )}
  </div>
 );
}