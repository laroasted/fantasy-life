import { useState } from "react";
import { theme, cardStyle } from "../constants/theme";
import Scoreboard from "./Scoreboard";

/**
 * SeasonHistory — displays archived past seasons.
 * Click a season to expand and see its full scoreboard.
 */
export default function SeasonHistory({ archivedSeasons }) {
  const [viewingYear, setViewingYear] = useState(null);

  if (!archivedSeasons.length) {
    return (
      <div style={{ maxWidth: 800, margin: "0 auto", ...cardStyle, textAlign: "center", padding: 40 }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🏛️</div>
        <h3 style={{ margin: "0 0 8px", fontSize: 18 }}>No Archived Seasons</h3>
        <p style={{ color: theme.dim, fontSize: 13 }}>
          When a new draft is finalized, the current season gets archived here.
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", display: "flex", flexDirection: "column", gap: 8 }}>
      {archivedSeasons.map((szn) => {
        const isOpen = viewingYear === szn.year;
        const dateStr = new Date(szn.draftDate).toLocaleDateString();

        return (
          <div key={szn.year}>
            <div
              onClick={() => setViewingYear(isOpen ? null : szn.year)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "14px 16px",
                borderRadius: isOpen ? "12px 12px 0 0" : 12,
                background: isOpen ? theme.acc + "20" : theme.card,
                border: `1px solid ${isOpen ? theme.acc : theme.bdr}`,
                borderBottom: isOpen ? "none" : undefined,
                cursor: "pointer",
              }}
            >
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>🏆 {szn.name}</div>
                <div style={{ fontSize: 12, color: theme.dim, marginTop: 2 }}>
                  Drafted {dateStr} · {szn.memberCount} members
                </div>
              </div>
              <span style={{ fontSize: 20, color: theme.dim }}>{isOpen ? "▾" : "▸"}</span>
            </div>

            {isOpen && (
              <div style={{
                padding: 16,
                background: theme.bg,
                border: `1px solid ${theme.acc}`,
                borderTop: "none",
                borderRadius: "0 0 12px 12px",
              }}>
                <Scoreboard seasonData={szn} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}