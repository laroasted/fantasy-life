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
//
// mixpanel-browser is dynamic-imported below (not a static top-level
// import) so its ~30-40KB isn't sitting in the main bundle's critical
// path — it has zero visual payoff on first paint, so it shouldn't
// compete with real UI code for parse/eval time before the app can
// render. A call made before that import resolves (app_loaded and
// season_loaded both fire within the first render, well before a
// network-fetched chunk could land) is queued and replayed in order once
// it's ready, rather than silently dropped — dropping those would be a
// real analytics gap, not just a harmless race.

const TOKEN = process.env.REACT_APP_MIXPANEL_TOKEN;

let mixpanel = null; // set once the dynamic import below resolves
let ready = false;
let loading = false;
let disabled = false; // the import or mp.init() failed — permanent no-op, same as no token
const queue = [];

function enqueue(run) {
  if (ready) { run(mixpanel); return; }
  if (!loading || disabled) return; // never called, or failed below — permanent no-op either way
  queue.push(run);
}

export function initAnalytics() {
  if (!TOKEN) {
    console.warn("Mixpanel: REACT_APP_MIXPANEL_TOKEN not set, analytics disabled.");
    return;
  }
  loading = true;
  import("mixpanel-browser")
    .then((mod) => {
      const mp = mod.default;
      mp.init(TOKEN, {
        debug: process.env.NODE_ENV !== "production",
        autocapture: false, // manual, deliberate events only
        track_pageview: false, // single-page tab-switcher — "tab_viewed" covers navigation
        cross_subdomain_cookie: false,
        ignore_dnt: false, // respect the browser's Do Not Track setting
        persistence: "localStorage",
      });
      mixpanel = mp;
      ready = true;
      queue.splice(0).forEach((run) => run(mixpanel));
    })
    .catch((e) => {
      // Common, not rare — this is the "blocked by an ad blocker /
      // tracking protection" case this file's top comment already warns
      // about, just arriving as a rejected import instead of a thrown
      // init() now. Without this, every later track()/identifyPerson()/etc.
      // call for the rest of the session would keep pushing onto `queue`
      // with nothing left to ever drain it — an unbounded leak for a
      // single blocked script load, not a one-time cost.
      console.warn("Mixpanel: init failed, analytics disabled.", e);
      disabled = true;
      queue.length = 0;
    });
}

export function track(eventName, properties) {
  enqueue((mixpanel) => {
    try {
      mixpanel.track(eventName, properties);
    } catch (e) {
      console.warn("Mixpanel: track failed.", eventName, e);
    }
  });
}

// Starts a duration timer; the next track() of eventName auto-attaches a
// $duration (seconds) property. Used for Draft Started -> Draft Finalized.
export function timeEvent(eventName) {
  enqueue((mixpanel) => {
    try {
      mixpanel.time_event(eventName);
    } catch (e) {
      console.warn("Mixpanel: time_event failed.", eventName, e);
    }
  });
}

// Single entry point for identifying a signed-in person — picks exactly
// ONE canonical distinct_id, because calling mixpanel.identify() twice in
// the same session with two DIFFERENT values (which used to happen: a
// separate identifyCommissioner(userId) and identifyMember(memberId),
// each firing independently) has no guarantee of merging into one
// Mixpanel profile. The commissioner is usually also a league member, so
// that split was a real, not theoretical, risk for exactly that person's
// own data. member_id wins when known — it's the id a second device
// re-identifies to as well (see AGENTS.md's identity section) — the
// Supabase auth UUID is the fallback for a commissioner with no claimed
// member identity yet. Safe to call on every render where a session
// exists: mixpanel.identify() with the id it's already using is a no-op,
// so the one-time-per-sign-in bookkeeping below (login counts etc.) stays
// in markCommissionerLogin(), gated separately, instead of repeating here.
export function identifyPerson({ userId, email, memberId }) {
  const distinctId = memberId || userId;
  if (!distinctId) return;
  enqueue((mixpanel) => {
    try {
      mixpanel.identify(distinctId);
      if (email) mixpanel.people.set({ $email: email });
      if (memberId) mixpanel.register({ member_id: memberId });
    } catch (e) {
      console.warn("Mixpanel: identifyPerson failed.", e);
    }
  });
}

// One-time-per-sign-in-transition bookkeeping — kept separate from
// identifyPerson() specifically so that function's safe-to-call-repeatedly
// nature doesn't also repeat these (they'd otherwise double-count
// commissioner_login_count on every re-render that touches identity, not
// just on an actual new sign-in).
export function markCommissionerLogin(role) {
  enqueue((mixpanel) => {
    try {
      mixpanel.people.set({ role: role || "commissioner" });
      mixpanel.people.set_once({ first_commissioner_login: new Date().toISOString() });
      mixpanel.people.set({ last_commissioner_login: new Date().toISOString() });
      mixpanel.people.increment("commissioner_login_count", 1);
      mixpanel.register({ is_commissioner: true });
    } catch (e) {
      console.warn("Mixpanel: markCommissionerLogin failed.", e);
    }
  });
}

export function resetIdentity() {
  enqueue((mixpanel) => {
    try {
      mixpanel.register({ is_commissioner: false });
      mixpanel.unregister("member_id");
      mixpanel.reset();
    } catch (e) {
      console.warn("Mixpanel: reset failed.", e);
    }
  });
}

export function setDeviceTypeSuperProperty(isMobile) {
  enqueue((mixpanel) => {
    try {
      mixpanel.register({ device_type: isMobile ? "mobile" : "desktop" });
    } catch (e) {
      console.warn("Mixpanel: setDeviceTypeSuperProperty failed.", e);
    }
  });
}

export function setSeasonSuperProperties({ year, dataSource }) {
  enqueue((mixpanel) => {
    try {
      mixpanel.register({ season_year: year, data_source: dataSource });
    } catch (e) {
      console.warn("Mixpanel: setSeasonSuperProperties failed.", e);
    }
  });
}

// ─── Event name constants ───
// snake_case, {object}_{past_tense_verb} — per Mixpanel's own setup-skill
// naming convention (docs.mixpanel.com / the mixpanel-skill reference).
// Keep this list and the "Event Taxonomy" doc tab in sync — it is the
// single source of truth for what exists.
export const EVENTS = {
  // Shared / cross-surface
  TAB_VIEWED: "tab_viewed",
  CATEGORY_FILTER_CHANGED: "category_filter_changed",
  MEMBER_ROW_EXPANDED: "member_row_expanded",
  DATA_FALLBACK_USED: "data_fallback_used",
  PUSH_NOTIFICATIONS_TOGGLED: "push_notifications_toggled",

  // App lifecycle
  APP_LOADED: "app_loaded",
  SEASON_LOADED: "season_loaded",
  DATA_REFRESH_TRIGGERED: "data_refresh_triggered",

  // Scoreboard
  OVERALL_CATEGORY_TILE_CLICKED: "overall_category_tile_clicked",
  ACTIVITY_FEED_LOAD_FAILED: "activity_feed_load_failed",
  PROJECTIONS_TOGGLED: "projections_toggled",

  // Trends
  TRENDS_VIEW_TOGGLED: "trends_view_toggled",
  TRENDS_SERIES_TOGGLED: "trends_series_toggled",
  TRENDS_SERIES_FOCUSED: "trends_series_focused",
  TRENDS_TABLE_EXPANDED: "trends_table_expanded",
  TRENDS_LOAD_FAILED: "trends_load_failed",

  // Calendar
  CALENDAR_FILTER_CHANGED: "calendar_filter_changed",
  CALENDAR_EVENT_EXPANDED: "calendar_event_expanded",

  // Draft Recap
  DRAFT_RECAP_VIEW_CHANGED: "draft_recap_view_changed",
  DRAFT_RECAP_MEMBER_SELECTED: "draft_recap_member_selected",
  DRAFT_RECAP_ROUND_FILTERED: "draft_recap_round_filtered",

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

  // Member accounts
  MEMBER_CLAIMED: "member_claimed",

  // Season Settings (commissioner-only)
  SETTINGS_MODE_CHANGED: "settings_mode_changed",
  LOCK_TOGGLED: "lock_toggled",
  DETAIL_ROW_ADDED: "detail_row_added",
  DETAIL_ROW_DELETED: "detail_row_deleted",
  SETTINGS_CHANGES_SAVED: "settings_changes_saved",
  SETTINGS_CHANGES_RESET: "settings_changes_reset",

  // Paywall (commissioner-set, PayPal-gated)
  PAYWALL_PAYMENT_COMPLETED: "paywall_payment_completed",
};
