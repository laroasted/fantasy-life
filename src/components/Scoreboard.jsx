import { useState, useMemo } from "react";
import { CATEGORY_ORDER, CATEGORY_LABELS, CATEGORY_BONUS_RULES, SPORT_CATEGORIES } from "../constants/categories";
import { MEMBER_COLORS } from "../constants/members";
import { theme } from "../constants/theme";
import { medalDisplay, rowBackground, rowBorder, expandedWrapperStyle, expandedHeaderStyle, expandedFooterStyle } from "../utils/helpers";

export default function Scoreboard({ seasonData }) {
  const [selCat, setSelCat] = useState(null);
  const [expRow, setExpRow] = useState(null);

  if (!seasonData) {
    return <div style={{ textAlign: "center", padding: 40, color: theme.dim }}>No active season.</div>;
  }

  const members = seasonData.members || [];
  const cats = seasonData.categories || {};
  const detail = seasonData.detailedData || {};

  // Overall standings across all 15 categories
  const overallStandings = useMemo(() => {
    return members.map((m) => {
      let totalPts = 0;
      const catScores = {};
      CATEGORY_ORDER.forEach((k) => {
        const entry = (cats[k] || []).find((x) => x.owner === m.name);
        if (entry) {
          totalPts += entry.total;
          catScores[k] = entry.total;
        }
      });
      return { owner: m.name, id: m.id, totalPts, catScores };
    }).sort((a, b) => b.totalPts - a.totalPts);
  }, [members, cats]);

  // Category-specific members sorted by total
  const catMembers = selCat
    ? [...(cats[selCat] || [])].sort((a, b) => b.total - a.total)
    : null;

  const detailArr = selCat ? detail[selCat] : null;

  // Category type flags
  const isSport = SPORT_CATEGORIES.includes(selCat);
  const isFilm = selCat === "Actor" || selCat === "Actress";
  const isMusic = selCat === "Musician";
  const isEvent = selCat === "Tennis" || selCat === "Golf" || selCat === "F1";
  const isCountry = selCat === "Country";
  const isStock = selCat === "Stock";

  // === EXPANDED DETAIL RENDERER ===
  function renderExpanded(m, idx) {
    const d = detailArr ? detailArr.find((x) => x.owner === m.owner) : null;
    const wp = expandedWrapperStyle(idx);
    const hd = expandedHeaderStyle;
    const ft = expandedFooterStyle;
    const totalLine = (
      <div style={ft}>
        Total: {m.base} base + {m.bonus} bonus ={" "}
        <b style={{ color: "#f8fafc", fontSize: 13 }}>{m.total} pts</b>
      </div>
    );

    // No detail data available — show simple summary
    if (!d) {
      return (
        <div style={{ padding: "10px 14px", borderRadius: "0 0 10px 10px", background: "#1e293b",
          border: `1px solid ${rowBorder(idx)}`, borderTop: "1px solid #334155", fontSize: 12, color: "#cbd5e1" }}>
          Base: {m.base} + Bonus: {m.bonus} = <b style={{ color: "#f8fafc" }}>{m.total} pts</b>
        </div>
      );
    }

    // SPORTS: playoff round-by-round
    if (isSport) {
      return (
        <div style={wp}>
          <div style={hd}>
            <b style={{ color: "#cbd5e1" }}>Regular Season: </b>
            <span style={{ color: "#f8fafc", fontSize: 13, fontWeight: 700 }}>{d.record || "—"}</span>
            {" → " + m.base + " base pts"}
          </div>
          {d.rounds && d.rounds.length > 0 ? (
            <div style={{ padding: "4px 12px" }}>
              {d.rounds.map((r, ri) => (
                <div key={ri} style={{ display: "grid", gridTemplateColumns: "1fr 80px 70px 40px",
                  gap: 4, alignItems: "center", padding: "4px 0",
                  borderBottom: ri === d.rounds.length - 1 ? "none" : "1px solid #1e293b", fontSize: 11 }}>
                  <div>
                    <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{r.round}</span>
                    {r.note && <div style={{ fontSize: 10, color: "#22c55e" }}>{r.note}</div>}
                  </div>
                  <span style={{ color: "#94a3b8", fontSize: 10 }}>{r.opponent}</span>
                  <div style={{ textAlign: "center" }}>
                    <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 700,
                      background: r.result === "Won" ? "rgba(34,197,94,0.2)" : r.result === "Lost" ? "rgba(239,68,68,0.15)" : "rgba(51,65,85,0.3)",
                      color: r.result === "Won" ? "#22c55e" : r.result === "Lost" ? "#ef4444" : "#64748b" }}>
                      {r.result === "—" ? "—" : r.result + " " + r.series}
                    </span>
                  </div>
                  <div style={{ textAlign: "right", color: r.pts > 0 ? "#f8fafc" : "#475569", fontWeight: 700 }}>
                    {r.pts > 0 ? "+" + r.pts : "—"}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ padding: "8px 12px", fontSize: 11, color: "#475569" }}>Missed Playoffs</div>
          )}
          {totalLine}
        </div>
      );
    }

    // FILM: film-by-film table
    if (isFilm) {
      return (
        <div style={wp}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 62px 38px 70px", gap: 6,
            padding: "6px 12px", background: "#0f172a", fontSize: 10, fontWeight: 700, color: "#64748b" }}>
            <span>Film</span>
            <span style={{ textAlign: "right" }}>Box Office</span>
            <span style={{ textAlign: "center" }}>RT</span>
            <span style={{ textAlign: "right" }}>Score</span>
          </div>
          <div style={{ padding: "4px 12px" }}>
            {d.films.map((f, fi) => (
              <div key={fi} style={{ display: "grid", gridTemplateColumns: "1fr 62px 38px 70px", gap: 6,
                alignItems: "center", padding: "5px 0",
                borderBottom: fi === d.films.length - 1 ? "none" : "1px solid #1e293b", fontSize: 11 }}>
                <div>
                  <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{f.title}</span>
                  <span style={{ color: "#64748b", marginLeft: 6 }}>{f.date}</span>
                  {f.note && <div style={{ fontSize: 10, color: "#f59e0b", marginTop: 1 }}>⚠ {f.note}</div>}
                </div>
                <div style={{ textAlign: "right", color: "#94a3b8" }}>
                  {f.bo > 0 ? "$" + f.bo.toFixed(1) + "M" : "—"}
                </div>
                <div style={{ textAlign: "center",
                  color: f.rt >= 70 ? "#22c55e" : f.rt >= 50 ? "#eab308" : f.rt > 0 ? "#ef4444" : "#475569" }}>
                  {f.rt > 0 ? f.rt + "%" : "—"}
                </div>
                <div style={{ textAlign: "right", color: "#f1f5f9", fontWeight: 700 }}>
                  {f.score > 0 ? f.score.toFixed(2) : "0.00"}
                </div>
              </div>
            ))}
          </div>
          <div style={ft}>
            Combined Score: {d.totalScore.toFixed(2)} → {m.base} base + {m.bonus} bonus ={" "}
            <b style={{ color: "#f8fafc", fontSize: 13 }}>{m.total} pts</b>
            {d.bonusNote && <div style={{ marginTop: 4, color: "#22c55e" }}>{d.bonusNote}</div>}
          </div>
        </div>
      );
    }

    // MUSIC: songs + grammys
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
                {d.songs.map((sg, si) => (
                  <div key={si} style={{ display: "grid", gridTemplateColumns: "1fr 55px 55px", gap: 6,
                    padding: "4px 0", borderBottom: si === d.songs.length - 1 ? "none" : "1px solid #1e293b", fontSize: 11 }}>
                    <span style={{ color: "#e2e8f0" }}>{sg.title}</span>
                    <div style={{ textAlign: "right", color: "#94a3b8" }}>{sg.weeks}</div>
                    <div style={{ textAlign: "right", color: sg.numOneWeeks > 0 ? "#22c55e" : "#475569", fontWeight: 700 }}>
                      {sg.numOneWeeks > 0 ? sg.numOneWeeks : "—"}
                    </div>
                  </div>
                ))}
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
                {d.grammys.map((g, gi) => (
                  <div key={gi} style={{ display: "grid", gridTemplateColumns: "1fr 50px 50px", gap: 6,
                    alignItems: "center", padding: "5px 0",
                    borderBottom: gi === d.grammys.length - 1 ? "none" : "1px solid #1e293b", fontSize: 11 }}>
                    <span style={{ color: "#e2e8f0" }}>{g.category}</span>
                    <span style={{ textAlign: "center", fontSize: 10,
                      color: g.result === "win" ? "#22c55e" : "#eab308" }}>
                      {g.result === "win" ? "🏆 Won" : "Nom"}
                    </span>
                    <div style={{ textAlign: "right", color: g.pts > 0 ? "#f8fafc" : "#475569", fontWeight: 700 }}>
                      {g.pts > 0 ? "+" + g.pts : "—"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {totalLine}
        </div>
      );
    }

    // EVENTS: Tennis/Golf/F1 major-by-major
    if (isEvent) {
      return (
        <div style={wp}>
          <div style={hd}>
            <b style={{ color: "#cbd5e1" }}>
              {selCat === "Tennis" ? "Post-AO World Ranking Pts" : selCat === "Golf" ? "World Ranking" : "Season Points"}:{" "}
            </b>
            <span style={{ color: "#f8fafc", fontSize: 13, fontWeight: 700 }}>
              {selCat === "Golf" ? "#" + d.ranking : d.ranking.toLocaleString()}
            </span>
            {" → " + m.base + " base pts"}
          </div>
          {d.majors && d.majors.length > 0 && (
            <div style={{ padding: "4px 12px" }}>
              {d.majors.map((mj, mi) => (
                <div key={mi} style={{ display: "grid", gridTemplateColumns: "1fr 90px 50px", gap: 6,
                  alignItems: "center", padding: "5px 0",
                  borderBottom: mi === d.majors.length - 1 ? "none" : "1px solid #1e293b", fontSize: 11 }}>
                  <div>
                    <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{mj.event}</span>
                    {mj.opponent !== "—" && <span style={{ color: "#64748b", marginLeft: 6 }}>{mj.opponent}</span>}
                    {mj.score && mj.score !== "—" && <div style={{ fontSize: 10, color: "#64748b" }}>{mj.score}</div>}
                  </div>
                  <span style={{ color: "#94a3b8", textAlign: "center" }}>{mj.result}</span>
                  <div style={{ textAlign: "right", color: mj.pts > 0 ? "#f8fafc" : "#475569", fontWeight: 700 }}>
                    {mj.pts > 0 ? "+" + mj.pts : "—"}
                  </div>
                </div>
              ))}
            </div>
          )}
          {totalLine}
        </div>
      );
    }

    // COUNTRY: GDP + Olympics
    if (isCountry) {
      return (
        <div style={wp}>
          <div style={hd}>
            <b style={{ color: "#cbd5e1" }}>GDP Growth: </b>
            <span style={{ color: "#f8fafc", fontSize: 13, fontWeight: 700 }}>{d.gdp}%</span>
            {" → " + m.base + " base pts"}
          </div>
          {d.olympics && d.olympics.total > 0 ? (
            <div style={{ padding: "8px 12px" }}>
              <div style={{ fontSize: 11, color: "#94a3b8", display: "flex", gap: 12 }}>
                <span>🥇 {d.olympics.gold}</span>
                <span>🥈 {d.olympics.silver}</span>
                <span>🥉 {d.olympics.bronze}</span>
                <span style={{ color: "#f8fafc", fontWeight: 700 }}>= {d.olympics.total} medals</span>
                <span style={{ color: d.olympics.pts > 0 ? "#22c55e" : "#94a3b8" }}>
                  Rank #{d.olympics.rank}
                </span>
              </div>
              {d.olympics.note && (
                <div style={{ fontSize: 10, color: d.olympics.pts > 0 ? "#22c55e" : "#64748b", marginTop: 4 }}>
                  {d.olympics.note}
                </div>
              )}
            </div>
          ) : (
            <div style={{ padding: "8px 12px", fontSize: 11, color: "#475569" }}>
              {d.olympics?.note || "Did not win any medals"}
            </div>
          )}
          {totalLine}
        </div>
      );
    }

    // STOCK: price change bar
    if (isStock) {
      return (
        <div style={wp}>
          <div style={{ padding: "8px 12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>
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
          </div>
        </div>
      );
    }

    // Fallback
    return (
      <div style={{ padding: "10px 14px", borderRadius: "0 0 10px 10px", background: "#1e293b",
        border: `1px solid ${rowBorder(idx)}`, borderTop: "1px solid #334155", fontSize: 12, color: "#cbd5e1" }}>
        Base: {m.base} + Bonus: {m.bonus} = {m.total} pts
      </div>
    );
  }

  // === MAIN RENDER ===
  return (
    <div style={{ maxWidth: 760, margin: "0 auto" }}>
      {/* Category pills */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 16, justifyContent: "center" }}>
        <button onClick={() => { setSelCat(null); setExpRow(null); }}
          style={{ padding: "5px 10px", borderRadius: 20,
            border: `1px solid ${!selCat ? "#3b82f6" : "#334155"}`,
            background: !selCat ? "#3b82f6" : "#1e293b",
            color: "#f1f5f9", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
          Overall
        </button>
        {CATEGORY_ORDER.map((k) => (
          <button key={k} onClick={() => { setSelCat(k); setExpRow(null); }}
            style={{ padding: "5px 10px", borderRadius: 20,
              border: `1px solid ${selCat === k ? "#3b82f6" : "#334155"}`,
              background: selCat === k ? "#3b82f6" : "#1e293b",
              color: "#f1f5f9", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
            {CATEGORY_LABELS[k]}
          </button>
        ))}
      </div>

      {/* OVERALL VIEW */}
      {!selCat && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {overallStandings.map((m, idx) => {
            const isExp = expRow === m.owner;
            return (
              <div key={m.owner}>
                <div onClick={() => setExpRow(isExp ? null : m.owner)}
                  style={{ display: "grid", gridTemplateColumns: "32px 1fr 60px",
                    alignItems: "center", padding: "10px 12px",
                    borderRadius: isExp ? "10px 10px 0 0" : 10,
                    background: rowBackground(idx), border: `1px solid ${rowBorder(idx)}`,
                    borderBottom: isExp ? "none" : undefined, cursor: "pointer" }}>
                  <span style={{ fontSize: 15, fontWeight: 800, color: "#94a3b8" }}>{medalDisplay(idx)}</span>
                  <span style={{ fontSize: 15, fontWeight: 700, color: MEMBER_COLORS[m.id] || "#f1f5f9" }}>{m.owner}</span>
                  <span style={{ fontSize: 20, fontWeight: 800, color: "#f8fafc", textAlign: "right" }}>{m.totalPts}</span>
                </div>
                {isExp && (
                  <div style={{ padding: "10px 12px", borderRadius: "0 0 10px 10px",
                    background: "#1e293b", border: `1px solid ${rowBorder(idx)}`, borderTop: "1px solid #334155" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 4 }}>
                      {CATEGORY_ORDER.map((k) => {
                        const pts = m.catScores[k] || 0;
                        return (
                          <div key={k}
                            onClick={(e) => { e.stopPropagation(); setSelCat(k); setExpRow(null); }}
                            style={{ padding: "4px 6px", borderRadius: 6, textAlign: "center", cursor: "pointer",
                              background: pts >= 15 ? "rgba(34,197,94,0.15)" : pts <= 3 ? "rgba(239,68,68,0.1)" : "rgba(51,65,85,0.3)" }}>
                            <div style={{ fontSize: 9, color: "#64748b", lineHeight: 1.2 }}>{CATEGORY_LABELS[k]}</div>
                            <div style={{ fontSize: 14, fontWeight: 700,
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
            <h2 style={{ fontSize: 17, fontWeight: 700, color: "#f8fafc", margin: 0 }}>{CATEGORY_LABELS[selCat]}</h2>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {catMembers.map((m, idx) => {
              const isExp = expRow === m.owner;
              const mid = (members.find((x) => x.name === m.owner) || {}).id;
              return (
                <div key={m.owner}>
                  <div onClick={() => setExpRow(isExp ? null : m.owner)}
                    style={{ display: "grid", gridTemplateColumns: "32px 1fr auto",
                      alignItems: "center", padding: "10px 12px", gap: 8,
                      borderRadius: isExp ? "10px 10px 0 0" : 10,
                      background: rowBackground(idx), border: `1px solid ${rowBorder(idx)}`,
                      borderBottom: isExp ? "none" : undefined, cursor: "pointer" }}>
                    <span style={{ fontSize: 15, fontWeight: 800, color: "#94a3b8" }}>{medalDisplay(idx)}</span>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: MEMBER_COLORS[mid] || "#f1f5f9" }}>{m.owner}</div>
                      <div style={{ fontSize: 11, color: theme.dim }}>{m.pick}</div>
                    </div>
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