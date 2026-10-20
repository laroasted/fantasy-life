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
      debug: process.env.NODE_ENV !== "production",
      autocapture: false, // manual, deliberate events only
      track_pageview: false, // single-page tab-switcher — "tab_viewed" covers navigation
      cross_subdomain_cookie: false,
      ignore_dnt: false, // respect the browser's Do Not Track setting — also governs session replay opt-out
      persistence: "localStorage",

      // Session Replay. Free plan allows 10k replays/month, so 100% sampling
      // is nowhere near quota for a ~12-person app. Left at the SDK's own
      // default privacy posture (record_mask_all_text / record_mask_all_inputs
      // both default true) rather than loosened — several commissioner-only
      // screens render the signed-in email as plain text (not inside an
      // <input>, e.g. the draft finalize modal and the Settings gate), so
      // unmasking text globally would expose it in replays. See the Privacy
      // section of the tracking doc / AGENTS.md before changing this.
      record_sessions_percent: 100,
      record_heatmap_data: true, // click / rage-click / dead-click capture; exempt from the plan's data allowance
      record_network: true, // request timing + status only — no headers/bodies unless explicitly allowlisted
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

// Per Mixpanel's identity guidance: identify with a stable database ID,
// never an email (emails can change or be reused). Supabase Auth's
// session.user.id is that stable ID here; email is stored as a profile
// property only, not as the distinct_id.
export function identifyCommissioner(userId, email, role) {
  if (!ready || !userId) return;
  try {
    mixpanel.identify(userId);
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

// Self-reported identity for regular (non-commissioner) viewers — lets a
// league member say "this is me" from a dropdown of the current season's
// members, so events can be attributed to a person instead of just a
// device. This is opt-in and not an authenticated identity: anyone could
// pick anyone's name. distinct_id is prefixed "member:" so it can never
// collide with a commissioner's Supabase UUID.
//
// The super property is named viewer_member_id, not member_id — several
// existing events (draft_pick_made, draft_roster_viewed) already use
// member_id for "whose turn/roster this is", which is a different
// question from "who is looking at the screen right now". Mixpanel lets
// an event's own properties shadow a super property of the same name, so
// reusing member_id here would have silently overwritten the real signal
// on exactly those two events.
export function identifyViewer(memberId, memberName) {
  if (!ready || !memberId) return;
  try {
    mixpanel.identify("member:" + memberId);
    mixpanel.people.set({ $name: memberName, viewer_member_id: memberId });
    mixpanel.people.set_once({ first_identified_at: new Date().toISOString() });
    mixpanel.register({ viewer_member_id: memberId });
  } catch (e) {
    console.warn("Mixpanel: identifyViewer failed.", e);
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
// snake_case, {object}_{past_tense_verb} — per Mixpanel's own setup-skill
// naming convention (docs.mixpanel.com / the mixpanel-skill reference).
// Keep this list and the "Event Taxonomy" doc tab in sync — it is the
// single source of truth for what exists.
export const EVENTS = {
  // Shared / cross-surface
  TAB_VIEWED: "tab_viewed",
  VIEWER_IDENTIFIED: "viewer_identified",
  CATEGORY_FILTER_CHANGED: "category_filter_changed",
  MEMBER_ROW_EXPANDED: "member_row_expanded",
  DATA_FALLBACK_USED: "data_fallback_used",

  // App lifecycle
  APP_LOADED: "app_loaded",
  SEASON_LOADED: "season_loaded",

  // Scoreboard
  OVERALL_CATEGORY_TILE_CLICKED: "overall_category_tile_clicked",

  // Trends
  TRENDS_VIEW_TOGGLED: "trends_view_toggled",
  TRENDS_SERIES_TOGGLED: "trends_series_toggled",
  TRENDS_TABLE_EXPANDED: "trends_table_expanded",
  TRENDS_LOAD_FAILED: "trends_load_failed",

  // Calendar
  CALENDAR_FILTER_CHANGED: "calendar_filter_changed",
  CALENDAR_EVENT_EXPANDED: "calendar_event_expanded",

  // Draft Recap
  DRAFT_RECAP_VIEW_CHANGED: "draft_recap_view_changed",
  DRAFT_RECAP_MEMBER_SELECTED: "draft_recap_member_selected",
  DRAFT_RECAP_ROUND_FILTERED: "draft_recap_round_filtered",

  // Season History
  ARCHIVED_SEASON_EXPANDED: "archived_season_expanded",

  // Draft Tool — setup
  DRAFT_MEMBER_ADDED: "draft_member_added",
  DRAFT_MEMBER_REMOVED: "draft_member_removed",
  DRAFT_ORDER_GENERATED: "draft_order_generated",
  DRAFT_ORDER_EDIT_REOPENED: "draft_order_edit_reopened",
  DRAFT_STARTED: "draft_started",

  // Draft Tool — in-draft
  DRAFT_PICK_MADE: "draft_pick_made",
  DRAFT_PICK_UNDONE: "draft_pick_undone",
  DRAFT_TIMER_TOGGLED: "draft_timer_toggled",
  DRAFT_PANEL_SWITCHED: "draft_panel_switched",
  DRAFT_ROSTER_VIEWED: "draft_roster_viewed",
  DRAFT_HISTORY_PANEL_TOGGLED: "draft_history_panel_toggled",

  // Draft Tool — finish
  DRAFT_CSV_EXPORTED: "draft_csv_exported",
  DRAFT_FINALIZE_MODAL_OPENED: "draft_finalize_modal_opened",
  DRAFT_FINALIZED: "draft_finalized",
  DRAFT_FINALIZE_FAILED: "draft_finalize_failed",

  // Commissioner auth
  COMMISSIONER_LOGIN_SUBMITTED: "commissioner_login_submitted",
  COMMISSIONER_LOGIN_FAILED: "commissioner_login_failed",
  COMMISSIONER_SIGNED_IN: "commissioner_signed_in",
  COMMISSIONER_SIGNED_OUT: "commissioner_signed_out",

  // Season Settings (commissioner-only)
  SETTINGS_MODE_CHANGED: "settings_mode_changed",
  LOCK_TOGGLED: "lock_toggled",
  DETAIL_ROW_ADDED: "detail_row_added",
  DETAIL_ROW_DELETED: "detail_row_deleted",
  SETTINGS_CHANGES_SAVED: "settings_changes_saved",
  SETTINGS_CHANGES_RESET: "settings_changes_reset",
};
