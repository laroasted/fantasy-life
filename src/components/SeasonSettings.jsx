import { useState, useEffect } from "react";
import { CATEGORY_ORDER, CATEGORY_LABELS } from "../constants/categories";
import { MEMBER_COLORS } from "../constants/members";
import { theme, cardStyle, inputStyle, buttonStyle, COMMISSIONER_PASSWORD } from "../constants/theme";

export default function SeasonSettings({ seasonData, onSave }) {
  const [authed, setAuthed] = useState(false);
  const [pw, setPw] = useState("");
  const [pwErr, setPwErr] = useState("");
  const [mode, setMode] = useState("scores");
  const [editCat, setEditCat] = useState(CATEGORY_ORDER[0]);
  const [edits, setEdits] = useState({});
  const [swaps, setSwaps] = useState({});
  const [saved, setSaved] = useState(false);
  const [changelog, setChangelog] = useState([]);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 640);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (!seasonData) {
    return <div style={{ textAlign: "center", padding: 40, color: theme.dim }}>No active season to edit.</div>;
  }

  const cats = seasonData.categories || {};
  const members = seasonData.members || [];

  function doAuth() {
    if (pw === COMMISSIONER_PASSWORD) { setAuthed(true); setPwErr(""); }
    else { setPwErr("Wrong password."); }
  }

  function getEditVal(cat, owner, field) {
    const key = `${cat}|${owner}|${field}`;
    if (edits[key] !== undefined) return edits[key];
    const entry = (cats[cat] || []).find((x) => x.owner === owner);
    return entry ? entry[field] : 0;
  }

  function setEditVal(cat, owner, field, val) {
    setEdits((prev) => ({ ...prev, [`${cat}|${owner}|${field}`]: val }));
    setSaved(false);
  }

  function getSwapVal(cat, owner) {
    const key = `${cat}|${owner}`;
    if (swaps[key] !== undefined) return swaps[key];
    const entry = (cats[cat] || []).find((x) => x.owner === owner);
    return entry ? entry.pick : "";
  }

  function setSwapVal(cat, owner, val) {
    setSwaps((prev) => ({ ...prev, [`${cat}|${owner}`]: val }));
    setSaved(false);
  }

  function applyChanges() {
    const newSeason = JSON.parse(JSON.stringify(seasonData));
    const newCats = newSeason.categories;
    const log = [];

    Object.keys(edits).forEach((key) => {
      const [cat, owner, field] = key.split("|");
      const newVal = parseFloat(edits[key]) || 0;
      const entry = (newCats[cat] || []).find((x) => x.owner === owner);
      if (entry) {
        const oldVal = entry[field];
        if (oldVal !== newVal) {
          log.push(`${cat} — ${owner}: ${field} ${oldVal} → ${newVal}`);
          entry[field] = newVal;
          entry.total = entry.base + (entry.bonus || 0);
        }
      }
      const detArr = (newSeason.detailedData || {})[cat];
      if (detArr) {
        const dd = detArr.find((x) => x.owner === owner);
        if (dd) { dd[field] = newVal; dd.total = dd.base + (dd.bonus || 0); }
      }
    });

    Object.keys(swaps).forEach((key) => {
      const [cat, owner] = key.split("|");
      const newPick = swaps[key];
      const entry = (newCats[cat] || []).find((x) => x.owner === owner);
      if (entry && entry.pick !== newPick && newPick.trim()) {
        log.push(`${cat} — ${owner}: pick "${entry.pick}" → "${newPick}"`);
        entry.pick = newPick;
        const detArr = (newSeason.detailedData || {})[cat];
        if (detArr) { const dd = detArr.find((x) => x.owner === owner); if (dd) dd.pick = newPick; }
      }
    });

    if (log.length === 0) { setSaved(true); return; }
    setChangelog((prev) => [...log, ...prev]);
    onSave(newSeason);
    setSaved(true); setEdits({}); setSwaps({});
  }

  // === PASSWORD GATE ===
  if (!authed) {
    return (
      <div style={{ maxWidth: 500, margin: "0 auto", ...cardStyle, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🔐</div>
        <h3 style={{ margin: "0 0 8px", fontSize: 18 }}>Commissioner Access Required</h3>
        <p style={{ color: theme.dim, fontSize: 13, marginBottom: 16 }}>
          Settings allow mid-season score edits, bonus adjustments, and pick swaps.
        </p>
        <input type="password" value={pw}
          onChange={(e) => { setPw(e.target.value); setPwErr(""); }}
          placeholder="Commissioner password..."
          style={{ ...inputStyle, marginBottom: 8 }}
          onKeyDown={(e) => { if (e.key === "Enter") doAuth(); }} />
        {pwErr && <div style={{ fontSize: 12, color: theme.red, marginBottom: 8 }}>{pwErr}</div>}
        <button onClick={doAuth} style={{ ...buttonStyle(), width: "100%" }}>Unlock Settings</button>
      </div>
    );
  }

  const catEntries = (cats[editCat] || []).sort((a, b) => a.owner.localeCompare(b.owner));

  // === MAIN SETTINGS UI ===
  return (
    <div style={{ maxWidth: 800, margin: "0 auto" }}>
      {/* Mode tabs */}
      <div style={{ display: "flex", gap: isMobile ? 4 : 8, marginBottom: 16 }}>
        {[
          { id: "scores", label: isMobile ? "📊 Scores" : "📊 Edit Scores" },
          { id: "swaps", label: isMobile ? "🔄 Swaps" : "🔄 Swap Picks" },
          { id: "log", label: `📋 Log${changelog.length ? ` (${changelog.length})` : ""}` },
        ].map((tab) => (
          <button key={tab.id} onClick={() => setMode(tab.id)}
            style={{ ...buttonStyle(mode === tab.id ? theme.acc : theme.srf), flex: 1,
              border: mode === tab.id ? "none" : `1px solid ${theme.bdr}`,
              fontSize: isMobile ? 11 : 13, padding: isMobile ? "8px 6px" : "10px 16px" }}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Category selector — scrollable on mobile */}
      {mode !== "log" && (
        <div style={{
          display: "flex", flexWrap: isMobile ? "nowrap" : "wrap",
          gap: 4, marginBottom: 16, justifyContent: isMobile ? "flex-start" : "center",
          overflowX: isMobile ? "auto" : "visible",
          WebkitOverflowScrolling: "touch",
          paddingBottom: isMobile ? 4 : 0,
          msOverflowStyle: "none", scrollbarWidth: "none",
        }}>
          {CATEGORY_ORDER.map((k) => (
            <button key={k} onClick={() => setEditCat(k)}
              style={{ padding: "5px 10px", borderRadius: 20, flexShrink: 0,
                border: `1px solid ${editCat === k ? "#3b82f6" : "#334155"}`,
                background: editCat === k ? "#3b82f6" : "#1e293b",
                color: "#f1f5f9", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
              {CATEGORY_LABELS[k]}
            </button>
          ))}
        </div>
      )}

      {/* SCORE EDITING */}
      {mode === "scores" && (
        <div style={cardStyle}>
          <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>{CATEGORY_LABELS[editCat]} — Edit Scores</h3>
          <p style={{ color: theme.dim, fontSize: 11, margin: "0 0 16px" }}>
            Adjust base and bonus points. Changes apply when you hit Save.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {catEntries.map((entry) => {
              const mid = (members.find((x) => x.name === entry.owner) || {}).id;
              const baseVal = getEditVal(editCat, entry.owner, "base");
              const bonusVal = getEditVal(editCat, entry.owner, "bonus");
              const total = (parseFloat(baseVal) || 0) + (parseFloat(bonusVal) || 0);
              return (
                <div key={entry.owner} style={{
                  display: "grid",
                  gridTemplateColumns: isMobile ? "1fr" : "100px 1fr 1fr 60px",
                  gap: isMobile ? 6 : 8, alignItems: isMobile ? "stretch" : "center",
                  padding: isMobile ? "10px 12px" : "8px 12px", borderRadius: 8,
                  background: "rgba(51,65,85,0.2)", border: `1px solid ${theme.bdr}`,
                }}>
                  {/* Name + pick */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13, color: MEMBER_COLORS[mid] || theme.txt }}>{entry.owner}</div>
                      <div style={{ fontSize: 10, color: theme.dim, overflow: "hidden",
                        textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: isMobile ? 180 : 90 }}>{entry.pick}</div>
                    </div>
                    {/* Total shown inline with name on mobile */}
                    {isMobile && (
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 9, color: theme.dim }}>Total</div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: "#f8fafc" }}>{total}</div>
                      </div>
                    )}
                  </div>
                  {/* Base + Bonus inputs — side by side on mobile */}
                  <div style={{ display: isMobile ? "flex" : "contents", gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 10, color: theme.dim, display: "block", marginBottom: 2 }}>Base</label>
                      <input type="number" value={baseVal}
                        onChange={(e) => setEditVal(editCat, entry.owner, "base", e.target.value)}
                        style={{ ...inputStyle, padding: "6px 8px", fontSize: 13 }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 10, color: theme.dim, display: "block", marginBottom: 2 }}>Bonus</label>
                      <input type="number" value={bonusVal}
                        onChange={(e) => setEditVal(editCat, entry.owner, "bonus", e.target.value)}
                        style={{ ...inputStyle, padding: "6px 8px", fontSize: 13 }} />
                    </div>
                  </div>
                  {/* Total — desktop only (mobile shown inline above) */}
                  {!isMobile && (
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 9, color: theme.dim }}>Total</div>
                      <div style={{ fontSize: 18, fontWeight: 800, color: "#f8fafc" }}>{total}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <button onClick={applyChanges} style={{ ...buttonStyle(theme.grn), flex: 2, padding: 14, fontSize: 15 }}>
              💾 Save Changes
            </button>
            <button onClick={() => { setEdits({}); setSaved(false); }}
              style={{ ...buttonStyle(theme.srf), flex: 1, border: `1px solid ${theme.bdr}` }}>↩ Reset</button>
          </div>
          {saved && (
            <div style={{ marginTop: 8, padding: 8, borderRadius: 8,
              background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)",
              textAlign: "center", fontSize: 12, color: theme.grn }}>
              Changes saved and synced to scoreboard.
            </div>
          )}
        </div>
      )}

      {/* PICK SWAPS */}
      {mode === "swaps" && (
        <div style={cardStyle}>
          <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>{CATEGORY_LABELS[editCat]} — Swap Picks</h3>
          <p style={{ color: theme.dim, fontSize: 11, margin: "0 0 16px" }}>
            Change a member's selection mid-season.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {catEntries.map((entry) => {
              const mid = (members.find((x) => x.name === entry.owner) || {}).id;
              const swapVal = getSwapVal(editCat, entry.owner);
              const changed = swaps[`${editCat}|${entry.owner}`] !== undefined
                && swaps[`${editCat}|${entry.owner}`] !== entry.pick;
              return (
                <div key={entry.owner} style={{
                  display: "grid",
                  gridTemplateColumns: isMobile ? "1fr" : "100px 1fr",
                  gap: isMobile ? 4 : 12, alignItems: isMobile ? "stretch" : "center",
                  padding: "10px 12px", borderRadius: 8,
                  background: changed ? "rgba(59,130,246,0.08)" : "rgba(51,65,85,0.2)",
                  border: `1px solid ${changed ? theme.acc : theme.bdr}`,
                }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: MEMBER_COLORS[mid] || theme.txt }}>
                    {entry.owner}
                  </div>
                  <div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: isMobile ? "wrap" : "nowrap" }}>
                      <input value={swapVal}
                        onChange={(e) => setSwapVal(editCat, entry.owner, e.target.value)}
                        style={{ ...inputStyle, padding: "6px 8px", fontSize: 13, flex: 1 }}
                        placeholder="Enter new pick..." />
                      {changed && (
                        <span style={{ fontSize: 10, color: theme.acc, whiteSpace: "nowrap" }}>← was: {entry.pick}</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <button onClick={applyChanges} style={{ ...buttonStyle(theme.grn), flex: 2, padding: 14, fontSize: 15 }}>
              💾 Save Swaps
            </button>
            <button onClick={() => { setSwaps({}); setSaved(false); }}
              style={{ ...buttonStyle(theme.srf), flex: 1, border: `1px solid ${theme.bdr}` }}>↩ Reset</button>
          </div>
          {saved && (
            <div style={{ marginTop: 8, padding: 8, borderRadius: 8,
              background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)",
              textAlign: "center", fontSize: 12, color: theme.grn }}>
              Pick swaps saved.
            </div>
          )}
        </div>
      )}

      {/* CHANGE LOG */}
      {mode === "log" && (
        <div style={cardStyle}>
          <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>📋 Change Log</h3>
          {changelog.length === 0 ? (
            <p style={{ color: theme.dim, fontSize: 13 }}>No changes recorded this session.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {changelog.map((entry, i) => (
                <div key={i} style={{ padding: "8px 12px", borderRadius: 8,
                  background: "rgba(51,65,85,0.3)", border: `1px solid ${theme.bdr}`,
                  fontSize: 12, color: theme.txt, wordBreak: "break-word" }}>
                  <span style={{ color: theme.dim, marginRight: 8 }}>#{changelog.length - i}</span>
                  {entry}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}