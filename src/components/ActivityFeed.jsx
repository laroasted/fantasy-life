import { useState, useEffect, useCallback, useRef } from "react";
import { supabase, storageGet, storageSet, STORAGE_KEYS } from "../utils/storage";
import { theme, cardStyle } from "../constants/theme";
import { CATEGORY_LABELS } from "../constants/categories";
import { MEMBER_COLORS } from "../constants/members";
import { track, EVENTS } from "../utils/analytics";
import { isPaywalled } from "../utils/helpers";

var PAYWALL_BLUR_STYLE = { filter: "blur(5px)", userSelect: "none" };
var FEED_LIMIT = 15;

var titleStyle = {
 fontSize: 12, fontWeight: 700, color: theme.mut, marginBottom: 10,
 textTransform: "uppercase", letterSpacing: 1,
};

function fmtWhen(iso) {
 var d = new Date(iso);
 var now = new Date();
 var sameDay = d.toDateString() === now.toDateString();
 return sameDay
  ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Self-contained fetch (its own loading/error/cache state), same pattern
// as Trends.jsx's load() for score_history — this reads score_events,
// a much smaller table (only nonzero-delta rows, only sports categories
// for now; see supabase/phase5_score_events.sql), so no pagination needed.
export default function ActivityFeed({ seasonData, onCategorySelect, surface }) {
 var seasonYear = seasonData && seasonData.year;
 var members = (seasonData && seasonData.members) || [];
 var [rows, setRows] = useState([]);
 var [loading, setLoading] = useState(true);
 var [error, setError] = useState(null);
 var [isStale, setIsStale] = useState(false);
 var requestIdRef = useRef(0);

 var load = useCallback(async function () {
  var myRequestId = ++requestIdRef.current;
  var stillCurrent = function () { return requestIdRef.current === myRequestId; };
  if (!seasonYear) { setLoading(false); return; }
  setLoading(true);
  setError(null);
  var cacheKey = STORAGE_KEYS.ACTIVITY_FEED_PREFIX + "-" + seasonYear;

  var { data, error: err } = await supabase
   .from("score_events")
   .select("member_id, category, delta, cause, occurred_at")
   .eq("season_year", seasonYear)
   .order("occurred_at", { ascending: false })
   .limit(FEED_LIMIT);

  if (err) {
   console.warn("ActivityFeed: Supabase fetch failed, trying cached snapshot...", err.message);
   var cached = null;
   try {
    var r = await storageGet(cacheKey);
    if (r && r.value) cached = JSON.parse(r.value);
   } catch (e) { console.error("ActivityFeed: failed to read cached snapshot:", e); }
   track(EVENTS.DATA_FALLBACK_USED, {
    surface: "activity_feed",
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
   setError(err.message);
   setLoading(false);
   track(EVENTS.ACTIVITY_FEED_LOAD_FAILED, { error_message: err.message });
   return;
  }

  if (!stillCurrent()) return;
  var allRows = data || [];
  setRows(allRows);
  setIsStale(false);
  storageSet(cacheKey, JSON.stringify(allRows)).catch(function () {});
  setLoading(false);
 // Depending on the seasonData reference, not just seasonYear, matters
 // because the Refresh button (App.jsx's handleRefresh) runs the crons
 // and reloads seasonData without changing the year — loadSeason() always
 // calls setActiveSeason() with a freshly fetched object, so this only
 // re-fires on an actual reload, not every unrelated re-render.
 }, [seasonYear, seasonData]);

 useEffect(function () { load(); }, [load]);

 if (loading) {
  return (
   <div style={Object.assign({}, cardStyle, { padding: 16 })}>
    <div style={titleStyle}>Activity</div>
    <div style={{ fontSize: 11, color: theme.dim }}>Loading…</div>
   </div>
  );
 }

 if (error) {
  return (
   <div style={Object.assign({}, cardStyle, { padding: 16 })}>
    <div style={titleStyle}>Activity</div>
    <div style={{ fontSize: 11, color: theme.dim }}>Couldn't load activity right now.</div>
   </div>
  );
 }

 if (rows.length === 0) {
  return (
   <div style={Object.assign({}, cardStyle, { padding: 16 })}>
    <div style={titleStyle}>Activity</div>
    <div style={{ fontSize: 11, color: theme.dim }}>
     No activity yet — check back after today's scores update.
    </div>
   </div>
  );
 }

 return (
  <div style={Object.assign({}, cardStyle, { padding: 16 })}>
   <div style={titleStyle}>
    Activity
    {isStale && <span style={{ fontWeight: 400, textTransform: "none", color: theme.yel, marginLeft: 6 }}>(cached)</span>}
   </div>
   <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
    {rows.map(function (ev, idx) {
     var member = members.find(function (mm) { return mm.id === ev.member_id; });
     var memberName = member ? member.name : ev.member_id;
     var paywalled = isPaywalled(seasonData, ev.member_id);
     var positive = Number(ev.delta) > 0;
     var clickable = !!onCategorySelect;
     return (
      <div key={idx}
       onClick={clickable ? function () {
         track(EVENTS.CATEGORY_FILTER_CHANGED, { surface: surface || "scoreboard", category: ev.category, previous_category: "activity_feed" });
         onCategorySelect(ev.category);
        } : undefined}
       style={{ cursor: clickable ? "pointer" : "default" }}>
       <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: MEMBER_COLORS[ev.member_id] || theme.txt,
         overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
         {memberName}
        </span>
        <span style={Object.assign(
          { fontSize: 12, fontWeight: 800, color: positive ? theme.grn : theme.red, flexShrink: 0 },
          paywalled ? PAYWALL_BLUR_STYLE : {}
         )}>
         {positive ? "+" : ""}{ev.delta}
        </span>
       </div>
       <div style={{ fontSize: 10, color: theme.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {(CATEGORY_LABELS[ev.category] || ev.category)}{ev.cause ? " — " + ev.cause : ""}
        <span style={{ opacity: 0.7 }}> · {fmtWhen(ev.occurred_at)}</span>
       </div>
      </div>
     );
    })}
   </div>
  </div>
 );
}
