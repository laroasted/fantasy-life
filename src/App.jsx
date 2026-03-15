import { useState, useEffect, useCallback } from "react";
import { theme } from "./constants/theme";
import { build2025 } from "./data";
import { supabase, storageGet, storageSet, STORAGE_KEYS, fetchSeasonFromSupabase, saveLocksToSupabase } from "./utils/storage";
import Scoreboard from "./components/Scoreboard";
import SeasonHistory from "./components/SeasonHistory";
import DraftTool from "./components/DraftTool";
import SeasonSettings from "./components/SeasonSettings";

const TABS = [
{ id: "scoreboard", label: " Scoreboard", short: " " },
{ id: "history", label: " History", short: " " },
{ id: "draft", label: " Draft", short: " " },
{ id: "settings", label: " Settings", short: " " },
];

export default function App() {
const [activeTab, setActiveTab] = useState("scoreboard");
const [activeSeason, setActiveSeason] = useState(null);
const [archivedSeasons, setArchivedSeasons] = useState([]);
const [loaded, setLoaded] = useState(false);
const [refreshing, setRefreshing] = useState(false);
const [lastUpdated, setLastUpdated] = useState(null);
const [dataSource, setDataSource] = useState("loading");
const [isMobile, setIsMobile] = useState(window.innerWidth < 640);

// Track viewport width
useEffect(() => {
 const onResize = () => setIsMobile(window.innerWidth < 640);
 window.addEventListener("resize", onResize);
 return () => window.removeEventListener("resize", onResize);
}, []);

const loadSeason = useCallback(async (showRefreshing = false) => {
 if (showRefreshing) setRefreshing(true);
 // Fetch whichever season is currently active (status = 'active')
 let active = await fetchSeasonFromSupabase();
 let source = "supabase";
 if (!active) {
 console.warn("Supabase fetch failed, trying localStorage...");
 try {
  const r = await storageGet(STORAGE_KEYS.ACTIVE_SEASON);
  if (r && r.value) { active = JSON.parse(r.value); source = "local"; }
 } catch (e) { console.error("Failed to load from localStorage:", e); }
 }
 if (!active) { console.warn("No stored data, using hardcoded build2025()..."); active = build2025(); source = "hardcoded"; }
 setActiveSeason(active);
 setDataSource(source);
 setLastUpdated(new Date());
 if (showRefreshing) setRefreshing(false);
 return active;
}, []);

useEffect(() => {
 (async () => {
 await loadSeason();
 // Load archived seasons from Supabase
 let archived = [];
 try {
  const { data: archivedData } = await supabase
  .from('seasons')
  .select('year, name, status, draft_date')
  .eq('status', 'archived')
  .order('year', { ascending: false });
  if (archivedData) archived = archivedData;
 } catch (e) { console.error("Failed to load archived seasons:", e); }
 setArchivedSeasons(archived);
 setLoaded(true);
 })();
}, [loadSeason]);

const handleRefresh = useCallback(async () => { await loadSeason(true); }, [loadSeason]);

const handleFinalize = useCallback(async (newSeason) => {
 const newArchived = [activeSeason, ...archivedSeasons].filter(Boolean);
 setArchivedSeasons(newArchived);
 setActiveSeason(newSeason);
 try { await storageSet(STORAGE_KEYS.ACTIVE_SEASON, JSON.stringify(newSeason)); } catch (e) {}
 try { await storageSet(STORAGE_KEYS.ARCHIVED_SEASONS, JSON.stringify(newArchived)); } catch (e) {}
 setActiveTab("scoreboard");
}, [activeSeason, archivedSeasons]);

// ── Settings save: update state + localStorage + push locks to Supabase ──
const handleSettingsSave = useCallback(async (updatedSeason) => {
 setActiveSeason(updatedSeason);
 // Save full season to localStorage (as before)
 try { await storageSet(STORAGE_KEYS.ACTIVE_SEASON, JSON.stringify(updatedSeason)); } catch (e) {}
 // Also push locks to Supabase so cron jobs can see them
 if (updatedSeason.locks && updatedSeason.year) {
 await saveLocksToSupabase(updatedSeason.year, updatedSeason.locks);
 }
}, []);

if (!loaded) {
 return (
 <div style={{ background: theme.bg, minHeight: "100vh", display: "flex", flexDirection: "column",
  alignItems: "center", justifyContent: "center", color: theme.dim, fontFamily: "system-ui", gap: 12 }}>
  <div style={{ fontSize: 32 }}> </div>
  <div style={{ fontSize: 16, fontWeight: 600 }}>Loading scores...</div>
  <div style={{ width: 120, height: 3, borderRadius: 2, background: "#1e293b", overflow: "hidden" }}>
  <div style={{ width: "40%", height: "100%", borderRadius: 2, background: "#3b82f6",
   animation: "pulse 1.5s ease-in-out infinite" }} />
  </div>
  <style>{`@keyframes pulse { 0%,100% { opacity: 0.4; transform: translateX(-20px); } 50% { opacity: 1; transform: translateX(80px); } }`}</style>
 </div>
 );
}

var draftDateStr = activeSeason && activeSeason.draftDate
 ? new Date(activeSeason.draftDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
 : "March 15, 2026";
var year = (activeSeason && activeSeason.year) || 2026;
var memberCount = (activeSeason && activeSeason.memberCount) || 12;

return (
 <div style={{ background: theme.bg, minHeight: "100vh", color: theme.txt,
 fontFamily: "Inter, system-ui, sans-serif" }}>
 {/* ── Header + Tabs ── */}
 <div style={{
  background: "linear-gradient(135deg, #1e293b, #0f172a)",
  borderBottom: "1px solid " + theme.bdr,
  padding: isMobile ? "12px 12px 0" : "16px 20px 0",
  position: "sticky", top: 0, zIndex: 100,
 }}>
  <div style={{ maxWidth: 900, margin: "0 auto" }}>
  {/* Title row */}
  <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 12,
   marginBottom: isMobile ? 10 : 16 }}>
   <span style={{ fontSize: isMobile ? 24 : 32 }}> </span>
   <div style={{ flex: 1, minWidth: 0 }}>
   <h1 style={{
    fontSize: isMobile ? 18 : 22, fontWeight: 800, margin: 0,
    background: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
    WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
   }}>Fantasy Life</h1>
   <p style={{ color: theme.dim, margin: 0, fontSize: isMobile ? 10 : 12 }}>
    {memberCount} Members · 15 Categories
   </p>
   </div>
   <button onClick={handleRefresh} disabled={refreshing}
   style={{
    background: "none", border: "1px solid " + theme.bdr, borderRadius: 8,
    padding: isMobile ? "5px 8px" : "6px 12px",
    color: refreshing ? theme.dim : theme.mut,
    fontSize: isMobile ? 11 : 12, cursor: refreshing ? "default" : "pointer",
    display: "flex", alignItems: "center", gap: 4,
    opacity: refreshing ? 0.6 : 1, transition: "opacity 0.2s",
    flexShrink: 0,
   }}>
   <span style={{ display: "inline-block",
    animation: refreshing ? "spin 1s linear infinite" : "none" }}>↻</span>
   {!isMobile && (refreshing ? "Refreshing..." : "Refresh")}
   </button>
   <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
  </div>

  {/* Tab bar */}
  <div style={{ display: "flex", gap: 0 }}>
   {TABS.map(function (t) {
   return (
    <button key={t.id} onClick={function () { setActiveTab(t.id); }}
    style={{
     flex: isMobile ? 1 : "unset",
     padding: isMobile ? "8px 4px" : "10px 20px",
     background: "none", border: "none",
     borderBottom: activeTab === t.id ? "2px solid " + theme.acc : "2px solid transparent",
     color: activeTab === t.id ? "#f8fafc" : theme.dim,
     fontSize: isMobile ? 11 : 13,
     fontWeight: activeTab === t.id ? 700 : 500,
     cursor: "pointer", whiteSpace: "nowrap",
    }}>
    {isMobile ? t.short + " " + t.id.charAt(0).toUpperCase() + t.id.slice(1) : t.label}
    </button>
   );
   })}
  </div>
  </div>
 </div>

 {/* ── Tab Content ── */}
 <div style={{ padding: isMobile ? "12px 8px" : "20px 16px" }}>
  {activeTab === "scoreboard" && (
  <div>
   <div style={{ textAlign: "center", marginBottom: 20, maxWidth: 760, margin: "0 auto 20px" }}>
   <h2 style={{ fontSize: isMobile ? 22 : 28, fontWeight: 800, margin: 0, color: "#f8fafc" }}>
    {year} Season
   </h2>
   <p style={{ fontSize: isMobile ? 11 : 12, color: theme.dim, margin: "4px 0 0" }}>
    {draftDateStr} through {year + 1} Academy Awards · {memberCount} members
   </p>
   {lastUpdated && (
    <p style={{ fontSize: 10, color: theme.dim, margin: "4px 0 0", opacity: 0.6 }}>
    {dataSource === "supabase" ? " Live" : dataSource === "local" ? " Cached" : " Offline"}
    {" "}· Updated {lastUpdated.toLocaleTimeString()}
    </p>
   )}
   </div>
   <Scoreboard seasonData={activeSeason} />
  </div>
  )}
  {activeTab === "history" && <SeasonHistory archivedSeasons={archivedSeasons} />}
  {activeTab === "draft" && <DraftTool onFinalize={handleFinalize} />}
  {activeTab === "settings" && <SeasonSettings seasonData={activeSeason} onSave={handleSettingsSave} />}
 </div>
 </div>
);
}