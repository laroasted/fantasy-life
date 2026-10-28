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