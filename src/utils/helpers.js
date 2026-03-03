// Fantasy Life Hub — Shared helper functions

/**
* Generate snake draft order.
* Odd rounds reverse the member order.
* @param {Array} members - Draft-ordered member array
* @param {number} totalRounds - Number of rounds (15 for 15 categories)
* @returns {Array} Array of { round, pick, memberId }
*/
export function generateSnakeOrder(members, totalRounds) {
 const order = [];
 for (let r = 0; r < totalRounds; r++) {
  const roundMembers = r % 2 === 0
   ? [...members]
   : [...members].reverse();
  for (let j = 0; j < roundMembers.length; j++) {
   order.push({
    round: r,
    pick: order.length,
    memberId: roundMembers[j].id,
   });
  }
 }
 return order;
}

/**
* Medal/rank display for scoreboard rows.
* @param {number} index - 0-based rank
* @returns {string} Medal emoji or rank number
*/
export function medalDisplay(index) {
 if (index === 0) return " ";
 if (index === 1) return " ";
 if (index === 2) return " ";
 return `${index + 1}`;
}

/**
* Background gradient for scoreboard rows.
* First place gets a special blue gradient.
* @param {number} index - 0-based rank
* @returns {string} CSS background value
*/
export function rowBackground(index) {
 return index === 0
  ? "linear-gradient(135deg, #1e3a5f, #1e293b)"
  : "#1e293b";
}

/**
* Border color for scoreboard rows.
* First place gets blue accent.
* @param {number} index - 0-based rank
* @returns {string} CSS border color
*/
export function rowBorder(index) {
 return index === 0 ? "#3b82f6" : "#334155";
}

/**
* Expanded detail header style (consistent across all expanded views).
*/
export const expandedHeaderStyle = {
 padding: "8px 12px",
 borderBottom: "1px solid #334155",
 background: "rgba(51,65,85,0.15)",
 fontSize: 11,
 color: "#94a3b8",
};

/**
* Expanded detail footer style (shows total points).
*/
export const expandedFooterStyle = {
 padding: "8px 12px",
 borderTop: "1px solid #334155",
 background: "rgba(51,65,85,0.2)",
 fontSize: 11,
 color: "#cbd5e1",
};

/**
* Wrapper style for expanded detail panels.
* @param {number} index - Row rank (for border color)
* @returns {object} Style object
*/
export function expandedWrapperStyle(index) {
 return {
  borderRadius: "0 0 10px 10px",
  background: "#1e293b",
  border: `1px solid ${rowBorder(index)}`,
  borderTop: "1px solid #334155",
  overflow: "hidden",
 };
}

// ═══════════════════════════════════════════════════════════
// LOCK HELPERS — Used by cron jobs and Scoreboard
// ═══════════════════════════════════════════════════════════

/**
* Check if a top-level field (base, bonus, etc.) is locked.
* Use this in your cron before overwriting a score.
*
* Example:
*  if (!isFieldLocked(seasonData, "NFL", "LaRosa", "base")) {
*   entry.base = newValue;
*  }
*/
export function isFieldLocked(seasonData, category, owner, field) {
 const locks = seasonData?.locks || {};
 return !!locks[`${category}|${owner}|${field}`];
}

/**
* Check if an entire detail row is locked (e.g., a whole playoff round).
* Use this in your cron before overwriting a round/film/event row.
*
* Example:
*  if (!isRowLocked(seasonData, "NFL", "LaRosa", 2)) {
*   entry.rounds[2] = freshData;
*  }
*/
export function isRowLocked(seasonData, category, owner, rowIndex, subArray) {
 const locks = seasonData?.locks || {};
 const key1 = `${category}|${owner}|row${rowIndex}`;
 const key2 = subArray ? `${category}|${owner}|${subArray}|row${rowIndex}` : null;
 return !!locks[key1] || (key2 && !!locks[key2]);
}

/**
* Check if a specific field within a detail row is locked.
*
* Example:
*  if (!isDetailFieldLocked(seasonData, "Actor", "Danny", 0, "rt")) {
*   entry.films[0].rt = newRtScore;
*  }
*/
export function isDetailFieldLocked(seasonData, category, owner, rowIndex, field) {
 const locks = seasonData?.locks || {};
 return !!locks[`${category}|${owner}|d${rowIndex}|${field}`];
}

/**
* Check if ANY field for this category/owner is locked.
* Used by Scoreboard to show a lock icon next to a member's name.
*/
export function hasAnyLock(seasonData, category, owner) {
 const locks = seasonData?.locks || {};
 const prefix = `${category}|${owner}|`;
 return Object.keys(locks).some((k) => k.startsWith(prefix));
}

/**
* Get all locks for a given category/owner combo.
* Useful for displaying lock details.
*/
export function getLocksForEntry(seasonData, category, owner) {
 const locks = seasonData?.locks || {};
 const prefix = `${category}|${owner}|`;
 return Object.entries(locks)
  .filter(([k]) => k.startsWith(prefix))
  .map(([k, v]) => ({ key: k, field: k.slice(prefix.length), ...v }));
}