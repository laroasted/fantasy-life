// Fantasy Life Hub — Mixpanel analytics layer
//
// Every Mixpanel call in the app goes through this module so components
// never import mixpanel-browser directly. See the "Mixpanel Tracking
// Strategy" doc for the full event taxonomy and the reasoning behind these
// choices (naming conventions, identity model, super properties).
//
// Mixpanel's script is commonly blocked by ad blockers / tracking
// protection. Every exported function must stay a silent no-op when that
// happens — tracking must never be able to break the app.

import mixpanel from "mixpanel-browser";

const TOKEN = process.env.REACT_APP_MIXPANEL_TOKEN;

let ready = false;

export function initAnalytics() {
  if (!TOKEN) {
    console.warn("Mixpanel: REACT_APP_MIXPANEL_TOKEN not set, analytics disabled.");
    return;
  }
  try {
    mixpanel.init(TOKEN, {
      autocapture: false, // manual, deliberate events only
      track_pageview: false, // single-page tab-switcher — "Tab Viewed" covers navigation
      cross_subdomain_cookie: false,
      ignore_dnt: false, // respect the browser's Do Not Track setting
      persistence: "localStorage",
    });
    ready = true;
  } catch (e) {
    console.warn("Mixpanel: init failed, analytics disabled.", e);
  }
}

export function track(eventName, properties) {
  if (!ready) return;
  try {
    mixpanel.track(eventName, properties);
  } catch (e) {
    console.warn("Mixpanel: track failed.", eventName, e);
  }
}

// Starts a duration timer; the next track() of eventName auto-attaches a
// $duration (seconds) property. Used for Draft Started -> Draft Finalized.
export function timeEvent(eventName) {
  if (!ready) return;
  try {
    mixpanel.time_event(eventName);
  } catch (e) {
    console.warn("Mixpanel: time_event failed.", eventName, e);
  }
}

export function identifyCommissioner(email, role) {
  if (!ready || !email) return;
  try {
    mixpanel.identify(email);
    mixpanel.people.set({ $email: email, role: role || "commissioner" });
    mixpanel.people.set_once({ first_commissioner_login: new Date().toISOString() });
    mixpanel.people.set({ last_commissioner_login: new Date().toISOString() });
    mixpanel.people.increment("commissioner_login_count", 1);
    mixpanel.register({ is_commissioner: true });
  } catch (e) {
    console.warn("Mixpanel: identifyCommissioner failed.", e);
  }
}

export function resetIdentity() {
  if (!ready) return;
  try {
    mixpanel.register({ is_commissioner: false });
    mixpanel.reset();
  } catch (e) {
    console.warn("Mixpanel: reset failed.", e);
  }
}

export function setDeviceTypeSuperProperty(isMobile) {
  if (!ready) return;
  try {
    mixpanel.register({ device_type: isMobile ? "mobile" : "desktop" });
  } catch (e) {
    console.warn("Mixpanel: setDeviceTypeSuperProperty failed.", e);
  }
}

export function setSeasonSuperProperties({ year, dataSource }) {
  if (!ready) return;
  try {
    mixpanel.register({ season_year: year, data_source: dataSource });
  } catch (e) {
    console.warn("Mixpanel: setSeasonSuperProperties failed.", e);
  }
}

// ─── Event name constants ───
// Title Case, {Object} {Verb}. Keep this list and the "Event Taxonomy" doc
// tab in sync — it is the single source of truth for what exists.
export const EVENTS = {
  // Shared / cross-surface
  TAB_VIEWED: "Tab Viewed",
  CATEGORY_FILTER_CHANGED: "Category Filter Changed",
  MEMBER_ROW_EXPANDED: "Member Row Expanded",
  DATA_FALLBACK_USED: "Data Fallback Used",

  // App lifecycle
  APP_LOADED: "App Loaded",
  SEASON_LOADED: "Season Loaded",

  // Scoreboard
  OVERALL_CATEGORY_TILE_CLICKED: "Overall Category Tile Clicked",

  // Trends
  TRENDS_VIEW_TOGGLED: "Trends View Toggled",
  TRENDS_SERIES_TOGGLED: "Trends Series Toggled",
  TRENDS_TABLE_EXPANDED: "Trends Table Expanded",
  TRENDS_LOAD_FAILED: "Trends Load Failed",

  // Calendar
  CALENDAR_FILTER_CHANGED: "Calendar Filter Changed",
  CALENDAR_EVENT_EXPANDED: "Calendar Event Expanded",

  // Draft Recap
  DRAFT_RECAP_VIEW_CHANGED: "Draft Recap View Changed",
  DRAFT_RECAP_MEMBER_SELECTED: "Draft Recap Member Selected",
  DRAFT_RECAP_ROUND_FILTERED: "Draft Recap Round Filtered",

  // Season History
  ARCHIVED_SEASON_EXPANDED: "Archived Season Expanded",

  // Draft Tool — setup
  DRAFT_MEMBER_ADDED: "Draft Member Added",
  DRAFT_MEMBER_REMOVED: "Draft Member Removed",
  DRAFT_ORDER_GENERATED: "Draft Order Generated",
  DRAFT_ORDER_EDIT_REOPENED: "Draft Order Edit Reopened",
  DRAFT_STARTED: "Draft Started",

  // Draft Tool — in-draft
  DRAFT_PICK_MADE: "Draft Pick Made",
  DRAFT_PICK_UNDONE: "Draft Pick Undone",
  DRAFT_TIMER_TOGGLED: "Draft Timer Toggled",
  DRAFT_PANEL_SWITCHED: "Draft Panel Switched",
  DRAFT_ROSTER_VIEWED: "Draft Roster Viewed",
  DRAFT_HISTORY_PANEL_TOGGLED: "Draft History Panel Toggled",

  // Draft Tool — finish
  DRAFT_CSV_EXPORTED: "Draft CSV Exported",
  DRAFT_FINALIZE_MODAL_OPENED: "Draft Finalize Modal Opened",
  DRAFT_FINALIZED: "Draft Finalized",
  DRAFT_FINALIZE_FAILED: "Draft Finalize Failed",

  // Commissioner auth
  COMMISSIONER_LOGIN_SUBMITTED: "Commissioner Login Submitted",
  COMMISSIONER_LOGIN_FAILED: "Commissioner Login Failed",
  COMMISSIONER_SIGNED_IN: "Commissioner Signed In",
  COMMISSIONER_SIGNED_OUT: "Commissioner Signed Out",

  // Season Settings (commissioner-only)
  SETTINGS_MODE_CHANGED: "Settings Mode Changed",
  LOCK_TOGGLED: "Lock Toggled",
  DETAIL_ROW_ADDED: "Detail Row Added",
  DETAIL_ROW_DELETED: "Detail Row Deleted",
  SETTINGS_CHANGES_SAVED: "Settings Changes Saved",
  SETTINGS_CHANGES_RESET: "Settings Changes Reset",
};
