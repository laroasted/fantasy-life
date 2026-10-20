# Mixpanel tracking — agent guide

This file documents the analytics conventions in this repo so future agents
(and humans) extend tracking consistently instead of reinventing patterns.
Full rationale and reporting plan: see the "Fantasy Life — Mixpanel Tracking
Strategy" doc (linked from the project's Claude Code session history) for
the long-form version; this file is the in-repo quick reference.

## Stack

- SDK: `mixpanel-browser` (client-side only — this is a Create React App SPA
  with no Node backend; the `api/cron/*.js` Vercel functions are data jobs,
  not user-facing, and are not instrumented).
- All calls go through **`src/utils/analytics.js`** — components never
  import `mixpanel-browser` directly.
- Token: `REACT_APP_MIXPANEL_TOKEN` env var (set in Vercel project settings;
  `.env.example` documents the var name, `.env` is gitignored).
- Init happens once, in `src/index.js`, before the app renders.

## Identity

- No login for regular viewers — the app is open to anyone with the URL.
  Anonymous visitors are tracked by Mixpanel's auto-generated `$device_id`,
  never identified.
- The only authenticated role is **commissioner** (Supabase magic-link
  auth, small email allow-list). On a successful sign-in, `App.jsx` calls
  `identifyCommissioner(userId, email, role)`, which:
  - `mixpanel.identify(userId)` — **the Supabase Auth `session.user.id`
    (a stable UUID), not the email.** Emails can change; the database ID
    doesn't. Email goes on the profile via `people.set({ $email })` only.
  - Sets `role`, `first_commissioner_login` (set_once), `last_commissioner_login`,
    increments `commissioner_login_count`.
  - Registers `is_commissioner: true` as a super property.
- On sign-out, `resetIdentity()` calls `mixpanel.reset()` — breaks the
  identity link so a later visitor on a shared device doesn't inherit the
  previous commissioner's profile.
- **Regular (non-commissioner) viewers can also self-identify**, opt-in,
  via the "👋 Who are you?" picker in the header (`App.jsx`). This is
  *not* authentication — anyone can pick anyone's name, it's just a
  standing "this is me" declaration, the same trust level as a display
  name in any casual multiplayer app.
  - Picking a name calls `identifyViewer(memberId, memberName)`:
    `mixpanel.identify("member:" + memberId)` — prefixed so it can never
    collide with a commissioner's Supabase UUID — plus `people.set` for
    `$name`/`viewer_member_id`, and registers `viewer_member_id` as a
    **super property**, so it attaches to every event the viewer fires
    from then on without touching any of the existing `track()` call
    sites.
  - **Why `viewer_member_id`, not `member_id`:** `draft_pick_made` and
    `draft_roster_viewed` already use `member_id` for "whose turn/roster
    this is" — a different question from "who is looking at the
    screen." An event's own properties shadow a same-named super
    property in Mixpanel, so reusing `member_id` here would have
    silently overwritten that signal on exactly those two events.
  - The choice persists in `localStorage` (`fl-viewer-member-id`, via
    `STORAGE_KEYS.VIEWER_MEMBER_ID`) and is restored on every load. On
    commissioner sign-out, the app re-identifies as the stored viewer
    (if any) rather than dropping back to fully anonymous.
  - Picking (or changing) a name fires `viewer_identified` with
    `member_id` and `is_change`.
- **Never call `identify()` with an email.** League member display names
  are fine (see Naming conventions below) — they're not emails and
  they're already public throughout the UI.

## Naming conventions

- **Events:** snake_case, `{object}_{past_tense_verb}` — e.g.
  `draft_pick_made`, `lock_toggled`. This matches Mixpanel's own setup-skill
  guidance. All event names are defined once as constants in the `EVENTS`
  object in `analytics.js` — call sites always use `EVENTS.X`, never a
  literal string, so a rename only ever touches one file.
- **Properties:** snake_case, no abbreviations. Booleans are prefixed
  `is_` (`is_mobile`, `is_custom_pick`, `is_locked`). No `$` or `mp_`
  prefix on custom names (those are reserved). Never `length` or `bucket`
  as a property name (collide with JS internals / a legacy Mixpanel
  reserved name).
- **No dynamic values in event names.** Variable data is always a
  property, never baked into the event name.
- **Reused events over near-duplicates.** The same interaction pattern
  (category-pill filtering, row expansion) fires one shared event with a
  `surface` property (`scoreboard` \| `trends` \| `settings` \| `recap` \|
  `history`) rather than a separate event per component.
- **No PII beyond what's already public in the UI.** Free text a user
  types (bonus notes, custom draft picks, search filters) is never sent as
  an event property. League member names ARE sent — they're public
  throughout the UI with no login required, and are this app's primary
  identifiers, the same way a username is in any multiplayer product.

## Super properties (registered globally)

`is_commissioner`, `device_type` (`mobile`/`desktop`), `season_year`,
`data_source` (`supabase`/`local`/`hardcoded`), `viewer_member_id` (set only
once someone self-identifies, see Identity above) — see `analytics.js` for
the setter functions (`setDeviceTypeSuperProperty`, `setSeasonSuperProperties`,
`identifyViewer`).

## Value Moment

This app has no signup funnel, so the usual "sign_up_completed →
value_moment" mini plan doesn't map directly. The closest equivalent:

- **Value Moment:** `tab_viewed` with `tab_name: "scoreboard"`, at a
  **weekly** cadence during an active season — checking the scoreboard is
  the single action that signals a league member is actively engaged.
- **Supporting KPIs:** weekly unique `distinct_id`s firing any event
  (season engagement); `draft_started` → `draft_finalized` completion rate
  (draft UX health); `data_fallback_used` count (backend reliability).

## Adding a new event

1. Check this file and `analytics.js`'s `EVENTS` object first — reuse an
   existing event + a new `surface`/discriminator value before adding a
   new event name.
2. Add the constant to `EVENTS` in `src/utils/analytics.js` (snake_case,
   `{object}_{verb}`).
3. Call `track(EVENTS.YOUR_EVENT, { ...snake_case_props })` directly in the
   existing event handler — no new abstraction layer.
4. Add a row to this file's reference table below and keep the taxonomy
   doc in sync if you have access to it.

## Event reference

| Event | Surface(s) | Key properties |
| --- | --- | --- |
| `tab_viewed` | app-wide | `tab_name`, `previous_tab`, `is_mobile` |
| `viewer_identified` | header | `member_id`, `is_change` (also calls `identifyViewer()`) |
| `category_filter_changed` | scoreboard, trends, settings, recap | `surface`, `category`, `previous_category` |
| `member_row_expanded` | scoreboard, history | `surface`, `category`, `member_name` |
| `data_fallback_used` | season, calendar | `surface`, `fallback_level`, `reason` |
| `app_loaded` | app | `data_source`, `is_mobile`, `archived_season_count` |
| `season_loaded` | app | `data_source`, `year`, `is_refresh` |
| `overall_category_tile_clicked` | scoreboard | `category` |
| `trends_view_toggled` | trends | `view` |
| `trends_series_toggled` | trends | `member_name`, `is_hidden` |
| `trends_table_expanded` | trends | `total_snapshots` |
| `trends_load_failed` | trends | `error_message` |
| `calendar_filter_changed` | calendar | `filter` |
| `calendar_event_expanded` | calendar | `event_title`, `category`, `event_type`, `status`, `is_bonus_eligible` |
| `draft_recap_view_changed` | recap | `view` |
| `draft_recap_member_selected` | recap | `member_name` |
| `draft_recap_round_filtered` | recap | `round` |
| `archived_season_expanded` | history | `season_year` |
| `draft_member_added` | draft | `member_count_after` |
| `draft_member_removed` | draft | `member_count_after` |
| `draft_order_generated` | draft | `method`, `member_count` |
| `draft_order_edit_reopened` | draft | — |
| `draft_started` | draft | `member_count`, `round_count`, `total_picks` |
| `draft_pick_made` | draft | `pick_number`, `round`, `category`, `member_id`, `is_custom_pick`, `seconds_remaining`, `is_timer_active` |
| `draft_pick_undone` | draft | `pick_number` |
| `draft_timer_toggled` | draft | `action` |
| `draft_panel_switched` | draft | `panel` |
| `draft_roster_viewed` | draft | `member_id` |
| `draft_history_panel_toggled` | draft | `is_visible` |
| `draft_csv_exported` | draft | `member_count` |
| `draft_finalize_modal_opened` | draft | `season_name` |
| `draft_finalized` | draft | `season_year`, `member_count`, `total_picks`, auto `$duration` |
| `draft_finalize_failed` | draft | `season_year`, `error_message` |
| `commissioner_login_submitted` | header | — |
| `commissioner_login_failed` | header | `error_message` |
| `commissioner_signed_in` | header | `role` (also calls `identify()`) |
| `commissioner_signed_out` | header | — (also calls `reset()`) |
| `settings_mode_changed` | settings | `mode` |
| `lock_toggled` | settings | `category`, `field_key`, `is_locked` |
| `detail_row_added` | settings | `category`, `row_type` |
| `detail_row_deleted` | settings | `category`, `row_type` |
| `settings_changes_saved` | settings | `mode`, `changes_count` |
| `settings_changes_reset` | settings | `mode` |

## Session Replay

Enabled in `analytics.js`'s `mixpanel.init()` call: `record_sessions_percent: 100`
(the free plan allows 10k replays/month — nowhere near quota for a ~12-person
app), plus `record_heatmap_data: true` (click/rage-click/dead-click capture,
exempt from the plan's data allowance) and `record_network: true` (request
timing/status only, no headers or bodies unless explicitly allowlisted via
`record_network_options`).

**Masking is intentionally left at the SDK's own defaults**
(`record_mask_all_text` / `record_mask_all_inputs` both default `true`) —
do not set either to `false` without reading this first. Two spots in the
UI render the commissioner's signed-in email as plain text, not inside an
`<input>` (so the "always-masked input types" safety net doesn't cover
them): the draft finalize confirmation modal (`DraftTool.jsx`) and the
Settings commissioner gate (`SeasonSettings.jsx`). Unmasking text globally
would expose that email in replays. If replays turn out too opaque to be
useful (everything on-screen redacted to `****`), the fix is selective
unmasking via `record_unmask_text_selector` targeted at specific safe
containers (Scoreboard, Trends, Calendar, Draft Recap — all public,
no-login-required data), not a global `record_mask_all_text: false`.

No code changes elsewhere were needed — Session Replay is purely an
`init()`-time config, independent of the `track()`/`identify()` calls
already in place. It works for both anonymous and self-identified
(`viewer_member_id`) sessions; replays link to Mixpanel's event data via
the `$mp_replay_id` property automatically.

## Governance

- No consent gate is implemented. This is a private ~12-person friend
  league, not a public product with known EU/California users — if that
  ever changes, add `opt_out_tracking_by_default: true` to `init()` in
  `analytics.js` and gate `opt_in_tracking()` behind explicit consent
  before shipping to a wider audience. Session Replay follows the same
  opt-out setting automatically (see Session Replay above) — no separate
  consent mechanism to wire up.
- Populate Lexicon descriptions for each event/property in the Mixpanel
  UI as they're reviewed — not yet done as of this file's creation.
