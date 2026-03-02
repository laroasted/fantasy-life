import { useState, useEffect, useRef } from "react";
import { DRAFT_MEMBERS, MEMBER_COLORS, NEW_MEMBER_COLORS } from "../constants/members";
import { DRAFT_CATEGORIES, CATEGORY_ORDER, CATEGORY_KEY_TO_ID } from "../constants/categories";
import { PICK_OPTIONS } from "../constants/pickOptions";
import { theme, cardStyle, inputStyle, buttonStyle, COMMISSIONER_PASSWORD } from "../constants/theme";
import { generateSnakeOrder } from "../utils/helpers";

const TIMER_DURATION = 120; // seconds per pick

export default function DraftTool({ onFinalize }) {
  // Setup state
  const [phase, setPhase] = useState("setup"); // "setup" | "draft"
  const [draftOrder, setDraftOrder] = useState([]);
  const [searchPhrase, setSearchPhrase] = useState("");
  const [actualResults, setActualResults] = useState("");
  const [guesses, setGuesses] = useState({});
  const [activeMembers, setActiveMembers] = useState([...DRAFT_MEMBERS]);
  const [showMemberMgmt, setShowMemberMgmt] = useState(false);
  const [newMemberName, setNewMemberName] = useState("");
  const [newMemberFull, setNewMemberFull] = useState("");
  const [manualOrder, setManualOrder] = useState(null);

  // Draft state
  const [picks, setPicks] = useState({});
  const [currentPick, setCurrentPick] = useState(0);
  const [snakeOrder, setSnakeOrder] = useState([]);
  const [timer, setTimer] = useState(0);
  const [timerActive, setTimerActive] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showRoster, setShowRoster] = useState(null);
  const [customInput, setCustomInput] = useState("");
  const [pickHistory, setPickHistory] = useState([]);
  const [seasonName, setSeasonName] = useState("" + new Date().getFullYear());

  // Finalize state
  const [showFinalizeModal, setShowFinalizeModal] = useState(false);
  const [commPw, setCommPw] = useState("");
  const [pwErr, setPwErr] = useState("");

  const timerRef = useRef(null);

  // Timer effect
  useEffect(() => {
    if (timerActive && timer > 0) {
      timerRef.current = setTimeout(() => setTimer((t) => t - 1), 1000);
    } else {
      setTimerActive(false);
    }
    return () => clearTimeout(timerRef.current);
  }, [timerActive, timer]);

  // Member management
  const addMember = () => {
    if (!newMemberName.trim()) return;
    const id = newMemberName.trim().toLowerCase().replace(/\s+/g, "_");
    if (activeMembers.find((m) => m.id === id)) return;
    if (!MEMBER_COLORS[id]) {
      MEMBER_COLORS[id] = NEW_MEMBER_COLORS[activeMembers.length % NEW_MEMBER_COLORS.length];
    }
    setActiveMembers((prev) => [
      ...prev,
      { id, name: newMemberName.trim(), full: newMemberFull.trim() || newMemberName.trim() },
    ]);
    setNewMemberName("");
    setNewMemberFull("");
  };

  const removeMember = (memberId) => {
    if (activeMembers.length <= 2) return;
    setActiveMembers((prev) => prev.filter((m) => m.id !== memberId));
    setGuesses((g) => { const n = { ...g }; delete n[memberId]; return n; });
    setDraftOrder((prev) => prev.filter((m) => m.id !== memberId));
    if (manualOrder) setManualOrder((prev) => prev.filter((m) => m.id !== memberId));
  };

  // Calculate draft order from guesses
  const calculateOrder = () => {
    const actual = parseInt(actualResults);
    if (isNaN(actual)) return;
    const sorted = activeMembers
      .map((m) => ({ ...m, guess: parseInt(guesses[m.id]) || 0 }))
      .map((m) => ({ ...m, diff: Math.abs(m.guess - actual) }))
      .sort((a, b) => a.diff - b.diff);
    setDraftOrder(sorted);
  };

  // Start the draft
  const startDraft = () => {
    if (draftOrder.length < 2) return;
    const so = generateSnakeOrder(draftOrder, DRAFT_CATEGORIES.length);
    setSnakeOrder(so);
    setPhase("draft");
    setCurrentPick(0);
    setTimer(TIMER_DURATION);
  };

  // Draft helpers
  const isComplete = phase === "draft" && snakeOrder.length > 0 && currentPick >= snakeOrder.length;
  const slot = !isComplete && snakeOrder[currentPick];
  const member = slot ? draftOrder.find((m) => m.id === slot.memberId) : null;

  const getRoster = (mid) =>
    pickHistory
      .filter((h) => h.memberId === mid)
      .map((h) => ({
        category: DRAFT_CATEGORIES.find((c) => c.id === h.categoryId),
        pick: h.selection,
      }));

  const availCats = DRAFT_CATEGORIES.filter((cat) =>
    !Object.keys(picks).some(
      (k) => k.endsWith("-" + cat.id) && picks[k] && k.startsWith((member ? member.id : "") + "-")
    )
  );

  const makePick = (catId, selection) => {
    if (!member) return;
    const key = member.id + "-" + catId;
    setPicks((p) => ({ ...p, [key]: selection }));
    setPickHistory((h) => [...h, { pick: currentPick, memberId: member.id, categoryId: catId, selection }]);
    setCurrentPick((c) => c + 1);
    setSelectedCategory(null);
    setSearchFilter("");
    setCustomInput("");
    setTimer(TIMER_DURATION);
    setTimerActive(false);
  };

  const undoPick = () => {
    if (pickHistory.length === 0) return;
    const last = pickHistory[pickHistory.length - 1];
    setPicks((p) => { const n = { ...p }; delete n[last.memberId + "-" + last.categoryId]; return n; });
    setPickHistory((h) => h.slice(0, -1));
    setCurrentPick((c) => c - 1);
    setSelectedCategory(null);
  };

  // Finalize draft into a new season
  const handleFinalize = () => {
    if (commPw !== COMMISSIONER_PASSWORD) {
      setPwErr("Wrong password.");
      return;
    }
    const categories = {};
    CATEGORY_ORDER.forEach((catKey) => {
      const catId = CATEGORY_KEY_TO_ID[catKey];
      categories[catKey] = draftOrder.map((m) => ({
        owner: m.name,
        pick: picks[m.id + "-" + catId] || "—",
        base: 0,
        bonus: 0,
        total: 0,
      }));
    });
    onFinalize({
      year: parseInt(seasonName) || new Date().getFullYear(),
      name: "Fantasy Life " + seasonName,
      draftDate: new Date().toISOString(),
      memberCount: draftOrder.length,
      members: draftOrder.map((m) => ({ id: m.id, name: m.name, full: m.full })),
      categories,
      detailedData: {},
      status: "active",
    });
  };

  const exportCSV = () => {
    const lines = ["Member," + DRAFT_CATEGORIES.map((c) => c.name).join(",")];
    draftOrder.forEach((m) => {
      lines.push(
        m.name + "," + DRAFT_CATEGORIES.map((c) => '"' + (picks[m.id + "-" + c.id] || "") + '"').join(",")
      );
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "draft_" + seasonName + ".csv";
    a.click();
  };

  // ===== SETUP PHASE =====
  if (phase === "setup") {
    return (
      <div style={{ maxWidth: 600, margin: "0 auto" }}>
        <div style={{ ...cardStyle, marginBottom: 16, textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>🎯</div>
          <h2 style={{ margin: "0 0 8px", fontSize: 22 }}>New Season Draft</h2>
          <p style={{ color: theme.dim, fontSize: 13 }}>
            Set up members, enter guesses, and determine draft order.
          </p>
        </div>

        {/* Member Management */}
        <div style={{ ...cardStyle, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>👥 Members ({activeMembers.length})</h3>
            <button onClick={() => setShowMemberMgmt(!showMemberMgmt)}
              style={{ ...buttonStyle(theme.srf), fontSize: 11, padding: "4px 10px", border: `1px solid ${theme.bdr}` }}>
              {showMemberMgmt ? "Close" : "Manage"}
            </button>
          </div>
          {showMemberMgmt && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
                {activeMembers.map((m) => (
                  <div key={m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "6px 10px", borderRadius: 6, background: theme.srf }}>
                    <span style={{ fontWeight: 600, color: MEMBER_COLORS[m.id] }}>{m.name}</span>
                    <button onClick={() => removeMember(m.id)}
                      style={{ background: "none", border: "none",
                        color: activeMembers.length <= 2 ? "#475569" : "#ef4444",
                        cursor: activeMembers.length <= 2 ? "not-allowed" : "pointer",
                        fontSize: 11, fontWeight: 700 }}>
                      ✕ Remove
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ padding: 12, borderRadius: 8, background: "rgba(59,130,246,0.08)",
                border: "1px solid rgba(59,130,246,0.2)" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: theme.acc, marginBottom: 8 }}>+ Add New Member</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input value={newMemberName} onChange={(e) => setNewMemberName(e.target.value)}
                    placeholder="Display name" style={{ ...inputStyle, flex: 1 }}
                    onKeyDown={(e) => { if (e.key === "Enter") addMember(); }} />
                  <input value={newMemberFull} onChange={(e) => setNewMemberFull(e.target.value)}
                    placeholder="Full name (opt)" style={{ ...inputStyle, flex: 1 }}
                    onKeyDown={(e) => { if (e.key === "Enter") addMember(); }} />
                  <button onClick={addMember} disabled={!newMemberName.trim()}
                    style={{ ...buttonStyle(theme.grn), padding: "8px 16px", fontSize: 13,
                      opacity: newMemberName.trim() ? 1 : 0.4 }}>
                    Add
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Google Results */}
        <div style={{ ...cardStyle, marginBottom: 16 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: theme.mut, display: "block", marginBottom: 6 }}>
            Secret Word/Phrase
          </label>
          <input value={searchPhrase} onChange={(e) => setSearchPhrase(e.target.value)}
            placeholder="purple monkey dishwasher" style={inputStyle} />
          <div style={{ marginTop: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: theme.mut, display: "block", marginBottom: 6 }}>
              Actual Google Results
            </label>
            <input value={actualResults} onChange={(e) => setActualResults(e.target.value)}
              placeholder="e.g. 1234567" type="number" style={inputStyle} />
          </div>
        </div>

        {/* Guesses */}
        <div style={{ ...cardStyle, marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>Member Guesses</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {activeMembers.map((m) => (
              <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, minWidth: 60, color: MEMBER_COLORS[m.id] }}>{m.name}</span>
                <input value={guesses[m.id] || ""}
                  onChange={(e) => setGuesses((g) => ({ ...g, [m.id]: e.target.value }))}
                  placeholder="Guess" type="number" style={{ ...inputStyle, width: 120 }} />
              </div>
            ))}
          </div>
        </div>

        {/* Calculate + Draft Order */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button onClick={calculateOrder} style={{ ...buttonStyle(), flex: 1 }}>Calculate Draft Order</button>
        </div>

        {draftOrder.length > 0 && (
          <div style={{ ...cardStyle, marginBottom: 16 }}>
            <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>🏆 Draft Order (Snake)</h3>
            <p style={{ color: theme.dim, fontSize: 12, margin: "0 0 8px" }}>
              {draftOrder.length} members → max base = {draftOrder.length}
            </p>
            {draftOrder.map((m, i) => (
              <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
                borderRadius: 8, background: i === 0 ? "rgba(234,179,8,0.1)" : theme.srf, marginBottom: 4 }}>
                <span style={{ fontSize: 20, fontWeight: 800, color: i === 0 ? theme.yel : theme.dim, minWidth: 30 }}>
                  #{i + 1}
                </span>
                <span style={{ fontWeight: 700, color: MEMBER_COLORS[m.id], flex: 1 }}>{m.name}</span>
                <span style={{ fontSize: 13, color: theme.mut }}>Guessed: {m.guess?.toLocaleString()}</span>
              </div>
            ))}
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button onClick={() => { setManualOrder(draftOrder); setDraftOrder([]); }}
                style={{ ...buttonStyle(theme.srf), flex: 1, border: `1px solid ${theme.bdr}` }}>
                ✏️ Edit
              </button>
              <button onClick={startDraft}
                style={{ ...buttonStyle(theme.grn), flex: 2, padding: 14, fontSize: 16 }}>
                🚀 Start Draft!
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ===== DRAFT PHASE =====
  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>🎯 {seasonName} Draft</h2>
        <button onClick={() => setShowHistory(!showHistory)}
          style={{ ...buttonStyle(theme.srf), fontSize: 11, border: `1px solid ${theme.bdr}` }}>
          {showHistory ? "Hide" : "History"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 16 }}>
        {/* Rosters sidebar */}
        <div style={{ width: 200, flexShrink: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: theme.mut, marginBottom: 8 }}>ROSTERS</div>
          {draftOrder.map((m) => {
            const roster = getRoster(m.id);
            const isOnClock = !isComplete && member && m.id === member.id;
            return (
              <div key={m.id} onClick={() => setShowRoster(showRoster === m.id ? null : m.id)}
                style={{ ...cardStyle, padding: "10px 12px", marginBottom: 6, cursor: "pointer",
                  border: isOnClock ? `2px solid ${MEMBER_COLORS[m.id]}` : `1px solid ${theme.bdr}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: MEMBER_COLORS[m.id] }}>{m.name}</span>
                  <span style={{ fontSize: 11, color: theme.dim }}>{roster.length}/15</span>
                </div>
                {showRoster === m.id && roster.length > 0 && (
                  <div style={{ marginTop: 8, borderTop: `1px solid ${theme.bdr}`, paddingTop: 8 }}>
                    {roster.map((r, i) => (
                      <div key={i} style={{ fontSize: 11, color: theme.mut, marginBottom: 3, display: "flex", gap: 6 }}>
                        <span>{r.category.icon}</span>
                        <span style={{ color: theme.txt }}>{r.pick}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Main draft area */}
        <div style={{ flex: 1 }}>
          {isComplete ? (
            <div>
              <div style={{ ...cardStyle, textAlign: "center", padding: 32, marginBottom: 16 }}>
                <div style={{ fontSize: 60, marginBottom: 12 }}>🎉</div>
                <h2 style={{ margin: "0 0 8px", fontSize: 24 }}>Draft Complete!</h2>
                <p style={{ color: theme.mut, fontSize: 13, marginBottom: 16 }}>
                  {draftOrder.length} members · Max base: {draftOrder.length}
                </p>
                <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
                  <label style={{ fontSize: 14, color: theme.mut, fontWeight: 600 }}>Season:</label>
                  <input value={seasonName} onChange={(e) => setSeasonName(e.target.value)}
                    style={{ ...inputStyle, width: 120, textAlign: "center", fontSize: 18, fontWeight: 700 }} />
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                  <button onClick={() => setShowFinalizeModal(true)}
                    style={{ ...buttonStyle(theme.grn), padding: "12px 24px", fontSize: 15 }}>
                    🏆 Finalize & Launch {seasonName} Season
                  </button>
                  <button onClick={exportCSV} style={buttonStyle(theme.acc)}>📄 Export CSV</button>
                </div>
              </div>

              {/* Finalize modal */}
              {showFinalizeModal && (
                <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
                  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}>
                  <div style={{ ...cardStyle, maxWidth: 500, width: "100%", padding: 24 }}>
                    <h3 style={{ margin: "0 0 12px", fontSize: 18, color: theme.red }}>⚠️ Commissioner Authorization</h3>
                    <div style={{ fontSize: 13, color: theme.mut, lineHeight: 1.7, marginBottom: 16 }}>
                      This will archive the current season and launch {seasonName}.
                      Base scale: {draftOrder.length} members. All scores start at 0. This cannot be undone.
                    </div>
                    <input type="password" value={commPw}
                      onChange={(e) => { setCommPw(e.target.value); setPwErr(""); }}
                      placeholder="Enter password..." style={{ ...inputStyle, marginBottom: 8 }}
                      onKeyDown={(e) => { if (e.key === "Enter") handleFinalize(); }} />
                    {pwErr && <div style={{ fontSize: 12, color: theme.red, marginBottom: 8 }}>{pwErr}</div>}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => { setShowFinalizeModal(false); setCommPw(""); setPwErr(""); }}
                        style={{ ...buttonStyle(theme.srf), flex: 1, border: `1px solid ${theme.bdr}` }}>Cancel</button>
                      <button onClick={handleFinalize} style={{ ...buttonStyle(theme.red), flex: 2 }}>Confirm & Launch</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div>
              {/* On the clock */}
              <div style={{ ...cardStyle, marginBottom: 16, textAlign: "center",
                border: `2px solid ${MEMBER_COLORS[member ? member.id : ""] || theme.acc}` }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: theme.mut, textTransform: "uppercase",
                  letterSpacing: 1, marginBottom: 8 }}>
                  On The Clock · Pick #{currentPick + 1}
                </div>
                <div style={{ fontSize: 28, fontWeight: 800, color: MEMBER_COLORS[member ? member.id : ""], marginBottom: 12 }}>
                  {member ? member.name : ""}
                </div>
                <div style={{ fontSize: 48, fontWeight: 800, fontFamily: "monospace",
                  color: timer <= 15 ? theme.red : timer <= 30 ? theme.yel : theme.txt, marginBottom: 8 }}>
                  {Math.floor(timer / 60)}:{String(timer % 60).padStart(2, "0")}
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                  {timerActive
                    ? <button onClick={() => setTimerActive(false)} style={buttonStyle(theme.yel)}>⏸ Pause</button>
                    : <button onClick={() => setTimerActive(true)} style={buttonStyle(theme.grn)}>▶ Start</button>}
                  <button onClick={() => { setTimer(TIMER_DURATION); setTimerActive(false); }}
                    style={{ ...buttonStyle(theme.srf), border: `1px solid ${theme.bdr}` }}>↻ Reset</button>
                  {pickHistory.length > 0 && (
                    <button onClick={undoPick}
                      style={{ ...buttonStyle(theme.srf), border: `1px solid ${theme.bdr}` }}>↩ Undo</button>
                  )}
                </div>
              </div>

              {/* Category selection */}
              {!selectedCategory && (
                <div style={cardStyle}>
                  <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>Step 1: Category ({availCats.length} left)</h3>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
                    {availCats.map((cat) => (
                      <button key={cat.id}
                        onClick={() => { setSelectedCategory(cat); setSearchFilter(""); setCustomInput(""); }}
                        style={{ ...buttonStyle(theme.srf), border: `1px solid ${theme.bdr}`, textAlign: "left", padding: 12 }}>
                        <span style={{ fontSize: 18 }}>{cat.icon}</span> {cat.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Pick selection */}
              {selectedCategory && (
                <div style={cardStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <h3 style={{ margin: 0, fontSize: 16 }}>{selectedCategory.icon} {selectedCategory.name}</h3>
                    <button onClick={() => setSelectedCategory(null)}
                      style={{ ...buttonStyle(theme.srf), fontSize: 11, border: `1px solid ${theme.bdr}` }}>← Back</button>
                  </div>
                  <input value={searchFilter} onChange={(e) => setSearchFilter(e.target.value)}
                    placeholder="Search..." style={{ ...inputStyle, marginBottom: 8 }} />
                  <div style={{ maxHeight: 300, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                    {(PICK_OPTIONS[selectedCategory.id] || ["Custom..."])
                      .filter((opt) => opt.toLowerCase().includes(searchFilter.toLowerCase()))
                      .filter((opt) => !Object.values(picks).includes(opt))
                      .map((opt) => {
                        if (opt === "Custom...") {
                          return (
                            <div key="custom" style={{ display: "flex", gap: 8 }}>
                              <input value={customInput} onChange={(e) => setCustomInput(e.target.value)}
                                placeholder="Type custom pick..." style={{ ...inputStyle, flex: 1 }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && customInput.trim())
                                    makePick(selectedCategory.id, customInput.trim());
                                }} />
                              <button onClick={() => {
                                if (customInput.trim()) makePick(selectedCategory.id, customInput.trim());
                              }} style={{ ...buttonStyle(theme.grn), padding: "8px 16px" }}>Pick</button>
                            </div>
                          );
                        }
                        return (
                          <button key={opt} onClick={() => makePick(selectedCategory.id, opt)}
                            style={{ ...buttonStyle(theme.srf), border: `1px solid ${theme.bdr}`,
                              textAlign: "left", padding: "8px 12px" }}>
                            {opt}
                          </button>
                        );
                      })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Pick history sidebar */}
        {showHistory && (
          <div style={{ width: 200, flexShrink: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: theme.mut, marginBottom: 8 }}>PICK HISTORY</div>
            <div style={{ maxHeight: "calc(100vh - 200px)", overflowY: "auto" }}>
              {[...pickHistory].reverse().map((h, i) => {
                const mem = draftOrder.find((m) => m.id === h.memberId);
                const cat = DRAFT_CATEGORIES.find((c) => c.id === h.categoryId);
                return (
                  <div key={i} style={{ ...cardStyle, padding: "8px 10px", marginBottom: 4 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: theme.dim, marginBottom: 2 }}>
                      <span>#{h.pick + 1}</span>
                      <span>{cat ? cat.icon : ""} {cat ? cat.name : ""}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontWeight: 700, fontSize: 12, color: MEMBER_COLORS[h.memberId] }}>
                        {mem ? mem.name : ""}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{h.selection}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Draft Board */}
      <div style={{ marginTop: 16, ...cardStyle, overflowX: "auto" }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>📊 Draft Board</h3>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr>
              <th style={{ padding: "6px 8px", textAlign: "left", color: theme.mut,
                borderBottom: `1px solid ${theme.bdr}`, position: "sticky", left: 0,
                background: theme.card, zIndex: 2 }}>Category</th>
              {draftOrder.map((m) => (
                <th key={m.id} style={{ padding: "6px 8px", textAlign: "center",
                  color: MEMBER_COLORS[m.id], borderBottom: `1px solid ${theme.bdr}`,
                  fontWeight: 700, minWidth: 80 }}>
                  {m.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DRAFT_CATEGORIES.map((cat) => (
              <tr key={cat.id}>
                <td style={{ padding: "6px 8px", borderBottom: `1px solid ${theme.bdr}`,
                  color: theme.mut, fontWeight: 600, position: "sticky", left: 0,
                  background: theme.card, whiteSpace: "nowrap", zIndex: 1 }}>
                  {cat.icon} {cat.name}
                </td>
                {draftOrder.map((m) => {
                  const v = picks[m.id + "-" + cat.id];
                  return (
                    <td key={m.id} style={{ padding: "6px 8px", borderBottom: `1px solid ${theme.bdr}`,
                      textAlign: "center", color: v ? theme.txt : theme.dim,
                      fontWeight: v ? 600 : 400,
                      background: v ? MEMBER_COLORS[m.id] + "10" : "transparent",
                      fontSize: v ? 11 : 10 }}>
                      {v || "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}