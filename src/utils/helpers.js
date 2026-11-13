// Fantasy Life Hub — Shared helper functions
import { theme } from "../constants/theme";

/**
* Race a promise against a timeout, resolving to `fallbackValue` if the
* promise hasn't settled in time instead of waiting forever.
*
* Needed because the Supabase client can internally hang (not reject —
* genuinely never settle) while it waits to resolve/refresh a session
* before firing a request, a known class of issue in the SDK. Without
* this, that hang blocks even unrelated public reads (season data), with
* no error to catch — the UI just spins. Public scoreboard reads don't
* depend on auth at all, so falling back on timeout is always safe here.
*/
export function withTimeout(promise, ms, fallbackValue) {
 return Promise.race([
  promise,
  new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms)),
 ]);
}

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
* Background for scoreboard rows — flat, every rank the same surface.
* Rank is signaled by rowBorder() instead, not by a separate fill color.
* @returns {string} CSS background value
*/
export function rowBackground() {
 return theme.card;
}

/**
* Border color for scoreboard rows.
* First place (rank 1 — ties included) gets the brand accent; everyone
* else gets the standard border.
* @param {number} rank - 1-based competition rank (ties share a rank; see
*  Scoreboard.jsx's withRanks()), NOT a raw array index — two members tied
*  for first must both read as rank 1 here.
* @returns {string} CSS border color
*/
export function rowBorder(rank) {
 return rank === 1 ? theme.acc : theme.bdr;
}

/**
* Pick a legible text color for a solid-fill background, using the real
* WCAG relative-luminance formula rather than a hardcoded per-color table —
* stays correct automatically if a MEMBER_COLORS value ever changes, and
* already covers NEW_MEMBER_COLORS (members added during draft setup) for
* free, which a parallel lookup table would silently miss.
* @param {string} hex - background color, e.g. "#3b82f6"
* @returns {string} theme.bg ("#0B0E14") or theme.txt ("#F2F3F5")
*/
export function getContrastText(hex) {
 const c = hex.replace("#", "");
 const r = parseInt(c.substring(0, 2), 16) / 255;
 const g = parseInt(c.substring(2, 4), 16) / 255;
 const b = parseInt(c.substring(4, 6), 16) / 255;
 const linearize = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
 const luminance = 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
 // Relative luminance of theme.bg ("#0B0E14") and theme.txt ("#F2F3F5"),
 // precomputed the same way. Pick whichever candidate actually gives the
 // higher contrast ratio against this background — for a handful of
 // medium-luminance member colors (e.g. the indigo used for one member)
 // neither option clears the ideal 4.5:1 WCAG AA threshold, and defaulting
 // to one fixed choice on "failure" can land on the worse of the two; this
 // always returns the better available option instead.
 const darkLum = 0.004363, lightLum = 0.8973;
 const contrastWithDark = (luminance + 0.05) / (darkLum + 0.05);
 const contrastWithLight = (lightLum + 0.05) / (luminance + 0.05);
 return contrastWithDark >= contrastWithLight ? theme.bg : theme.txt;
}

/**
* Expanded detail header style (consistent across all expanded views).
*/
export const expandedHeaderStyle = {
 padding: "8px 12px",
 borderBottom: `1px solid ${theme.bdr}`,
 background: "rgba(255,255,255,0.03)",
 fontSize: 11,
 color: theme.dim,
};

/**
* Expanded detail footer style (shows total points).
*/
export const expandedFooterStyle = {
 padding: "8px 12px",
 borderTop: `1px solid ${theme.bdr}`,
 background: "rgba(255,255,255,0.045)",
 fontSize: 11,
 color: "#cbd5e1",
};

/**
* Wrapper style for expanded detail panels.
* @param {number} rank - 1-based competition rank (see rowBorder())
* @returns {object} Style object
*/
export function expandedWrapperStyle(rank) {
 return {
  borderRadius: "0 0 10px 10px",
  background: theme.card,
  border: `1px solid ${rowBorder(rank)}`,
  borderTop: `1px solid ${theme.bdr}`,
  overflow: "hidden",
  animation: "expandIn 0.18s ease",
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

// ═══════════════════════════════════════════════════════════
// PAYWALL HELPERS — Used by Scoreboard and SeasonSettings
// ═══════════════════════════════════════════════════════════

/**
* Check whether a member's scoreboard row is currently paywalled.
* Keyed by member id (stable), not display name.
*/
export function isPaywalled(seasonData, memberId) {
 const paywalls = seasonData?.paywalls || {};
 return !!(memberId && paywalls[memberId] && paywalls[memberId].enabled);
}

/**
* Get the commissioner's custom paywall message for a member, if any.
*/
export function getPaywallMessage(seasonData, memberId) {
 const paywalls = seasonData?.paywalls || {};
 return (memberId && paywalls[memberId] && paywalls[memberId].message) || "";
}