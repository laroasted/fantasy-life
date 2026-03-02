import { useState, useEffect, useCallback } from "react";
import { theme } from "./constants/theme";
import { build2025 } from "./data";
import { storageGet, storageSet, STORAGE_KEYS, fetchSeasonFromSupabase } from "./utils/storage";
import Scoreboard from "./components/Scoreboard";
import SeasonHistory from "./components/SeasonHistory";
import DraftTool from "./components/DraftTool";
import SeasonSettings from "./components/SeasonSettings";

const TABS = [
  { id: "scoreboard", label: "📊 Scoreboard" },
  { id: "history", label: "🏛️ History" },
  { id: "draft", label: "🎯 New Draft" },
  { id: "settings", label: "⚙️ Settings" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState("scoreboard");
  const [activeSeason, setActiveSeason] = useState(null);
  const [archivedSeasons, setArchivedSeasons] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [dataSource, setDataSource] = useState("loading"); // "supabase" | "local" | "hardcoded"

  // Fetch season data — tries Supabase first, falls back to localStorage, then hardcoded
  const loadSeason = useCallback(async (showRefreshing = false) => {
    if (showRefreshing) setRefreshing(true);

    // Try Supabase first
    let active = await fetchSeasonFromSupabase(2025);
    let source = "supabase";

    if (!active) {
      // Fall back to localStorage
      console.warn("Supabase fetch failed, trying localStorage...");
      try {
        const r = await storageGet(STORAGE_KEYS.ACTIVE_SEASON);
        if (r && r.value) {
          active = JSON.parse(r.value);
          source = "local";
        }
      } catch (e) {
        console.error("Failed to load from localStorage:", e);
      }
    }

    // Fall back to hardcoded data
    if (!active) {
      console.warn("No stored data, using hardcoded build2025()...");
      active = build2025();
      source = "hardcoded";
    }

    setActiveSeason(active);
    setDataSource(source);
    setLastUpdated(new Date());
    if (showRefreshing) setRefreshing(false);

    return active;
  }, []);

  // Load on mount
  useEffect(() => {
    (async () => {
      await loadSeason();

      // Load archived seasons from localStorage
      let archived = [];
      try {
        const r2 = await storageGet(STORAGE_KEYS.ARCHIVED_SEASONS);
        if (r2 && r2.value) archived = JSON.parse(r2.value);
      } catch (e) {
        console.error("Failed to load archived seasons:", e);
      }
      setArchivedSeasons(archived);
      setLoaded(true);
    })();
  }, [loadSeason]);

  // Refresh handler — re-fetches from Supabase
  const handleRefresh = useCallback(async () => {
    await loadSeason(true);
  }, [loadSeason]);

  // Finalize a draft: archive current season, set new one
  const handleFinalize = useCallback(
    async (newSeason) => {
      const newArchived = [activeSeason, ...archivedSeasons].filter(Boolean);
      setArchivedSeasons(newArchived);
      setActiveSeason(newSeason);

      try {
        await storageSet(STORAGE_KEYS.ACTIVE_SEASON, JSON.stringify(newSeason));
      } catch (e) {
        console.error("Failed to save active season:", e);
      }
      try {
        await storageSet(STORAGE_KEYS.ARCHIVED_SEASONS, JSON.stringify(newArchived));
      } catch (e) {
        console.error("Failed to save archived seasons:", e);
      }

      setActiveTab("scoreboard");
    },
    [activeSeason, archivedSeasons]
  );

  // Save settings edits to storage
  const handleSettingsSave = useCallback(async (updatedSeason) => {
    setActiveSeason(updatedSeason);
    try {
      await storageSet(STORAGE_KEYS.ACTIVE_SEASON, JSON.stringify(updatedSeason));
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  }, []);

  // Loading state
  if (!loaded) {
    return (
      <div style={{
        background: theme.bg, minHeight: "100vh",
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        color: theme.dim, fontFamily: "system-ui", gap: 12,
      }}>
        <div style={{ fontSize: 32 }}>🏆</div>
        <div style={{ fontSize: 16, fontWeight: 600 }}>Loading scores...</div>
        <div style={{
          width: 120, height: 3, borderRadius: 2,
          background: "#1e293b", overflow: "hidden",
        }}>
          <div style={{
            width: "40%", height: "100%", borderRadius: 2,
            background: "#3b82f6",
            animation: "pulse 1.5s ease-in-out infinite",
          }} />
        </div>
        <style>{`@keyframes pulse { 0%,100% { opacity: 0.4; transform: translateX(-20px); } 50% { opacity: 1; transform: translateX(80px); } }`}</style>
      </div>
    );
  }

  const draftDateStr = activeSeason?.draftDate
    ? new Date(activeSeason.draftDate).toLocaleDateString("en-US", {
        month: "long", day: "numeric", year: "numeric",
      })
    : "March 15, 2025";
  const year = activeSeason?.year || 2025;
  const memberCount = activeSeason?.memberCount || 11;

  return (
    <div style={{
      background: theme.bg, minHeight: "100vh",
      color: theme.txt, fontFamily: "Inter, system-ui, sans-serif",
    }}>
      {/* Header + Tab Navigation */}
      <div style={{
        background: "linear-gradient(135deg, #1e293b, #0f172a)",
        borderBottom: `1px solid ${theme.bdr}`,
        padding: "16px 20px 0",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <span style={{ fontSize: 32 }}>🏆</span>
            <div style={{ flex: 1 }}>
              <h1 style={{
                fontSize: 22, fontWeight: 800, margin: 0,
                background: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}>
                Fantasy Life
              </h1>
              <p style={{ color: theme.dim, margin: 0, fontSize: 12 }}>
                {memberCount} Members · 15 Categories · Snake Draft
              </p>
            </div>
            {/* Refresh button */}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              style={{
                background: "none", border: `1px solid ${theme.bdr}`,
                borderRadius: 8, padding: "6px 12px",
                color: refreshing ? theme.dim : theme.mut,
                fontSize: 12, cursor: refreshing ? "default" : "pointer",
                display: "flex", alignItems: "center", gap: 6,
                opacity: refreshing ? 0.6 : 1,
                transition: "opacity 0.2s",
              }}
            >
              <span style={{
                display: "inline-block",
                animation: refreshing ? "spin 1s linear infinite" : "none",
              }}>↻</span>
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
            <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
          </div>

          <div style={{ display: "flex", gap: 0 }}>
            {TABS.map((t) => (
              <button key={t.id} onClick={() => setActiveTab(t.id)}
                style={{
                  padding: "10px 20px", background: "none", border: "none",
                  borderBottom: activeTab === t.id ? `2px solid ${theme.acc}` : "2px solid transparent",
                  color: activeTab === t.id ? "#f8fafc" : theme.dim,
                  fontSize: 13, fontWeight: activeTab === t.id ? 700 : 500,
                  cursor: "pointer",
                }}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tab Content */}
      <div style={{ padding: "20px 16px" }}>
        {activeTab === "scoreboard" && (
          <div>
            <div style={{ textAlign: "center", marginBottom: 20, maxWidth: 760, margin: "0 auto 20px" }}>
              <h2 style={{ fontSize: 28, fontWeight: 800, margin: 0, color: "#f8fafc" }}>
                {year} Season
              </h2>
              <p style={{ fontSize: 12, color: theme.dim, margin: "4px 0 0" }}>
                {draftDateStr} through {year + 1} Academy Awards · {memberCount} members
              </p>
              {/* Data source indicator */}
              {lastUpdated && (
                <p style={{ fontSize: 10, color: theme.dim, margin: "4px 0 0", opacity: 0.6 }}>
                  {dataSource === "supabase" ? "🟢 Live" : dataSource === "local" ? "🟡 Cached" : "🔴 Offline"}{" "}
                  · Updated {lastUpdated.toLocaleTimeString()}
                </p>
              )}
            </div>
            <Scoreboard seasonData={activeSeason} />
          </div>
        )}

        {activeTab === "history" && (
          <SeasonHistory archivedSeasons={archivedSeasons} />
        )}

        {activeTab === "draft" && (
          <DraftTool onFinalize={handleFinalize} />
        )}

        {activeTab === "settings" && (
          <SeasonSettings seasonData={activeSeason} onSave={handleSettingsSave} />
        )}
      </div>
    </div>
  );
}