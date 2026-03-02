import { useState, useEffect, useCallback } from "react";
import { theme } from "./constants/theme";
import { build2025 } from "./data";
import { storageGet, storageSet, STORAGE_KEYS } from "./utils/storage";
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

  // Load season data from storage on mount
  useEffect(() => {
    (async () => {
      let active = null;
      let archived = [];

      try {
        const r = await storageGet(STORAGE_KEYS.ACTIVE_SEASON);
        if (r && r.value) active = JSON.parse(r.value);
      } catch (e) {
        console.error("Failed to load active season:", e);
      }

      // Fall back to hardcoded 2025 data
      if (!active) active = build2025();

      try {
        const r2 = await storageGet(STORAGE_KEYS.ARCHIVED_SEASONS);
        if (r2 && r2.value) archived = JSON.parse(r2.value);
      } catch (e) {
        console.error("Failed to load archived seasons:", e);
      }

      setActiveSeason(active);
      setArchivedSeasons(archived);
      setLoaded(true);
    })();
  }, []);

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

  // Save settings edits (scores, picks) to storage
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
        display: "flex", alignItems: "center", justifyContent: "center",
        color: theme.dim, fontFamily: "system-ui",
      }}>
        Loading...
      </div>
    );
  }

  const draftDateStr = activeSeason?.draftDate
    ? new Date(activeSeason.draftDate).toLocaleDateString("en-US", {
        month: "long", day: "numeric", year: "numeric",
      })
    : "March 1, 2025";
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
            <div>
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