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
- The only authenticated role is **commissioner** (Supabase Google OAuth,
  small email allow-list — switched from magic-link email after hitting
  Supabase's shared-mailer rate limit and a localStorage session-corruption
  issue; see `docs/commissioner-auth-phase1.md`). On a successful sign-in, `App.jsx` calls
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
- **Never call `identify()` with an email or a league member's display
  name.** If a future "who are you?" picker is added for regular members,
  identify with a generated/stable `member_id`, not their display name.

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
  `surface` property (`scoreboard` \| `trends` \| `settings` \| `recap`)
  rather than a separate event per component.
- **No PII beyond what's already public in the UI.** Free text a user
  types (bonus notes, custom draft picks, search filters) is never sent as
  an event property. League member names ARE sent — they're public
  throughout the UI with no login required, and are this app's primary
  identifiers, the same way a username is in any multiplayer product.

## Super properties (registered globally)

`is_commissioner`, `device_type` (`mobile`/`desktop`), `season_year`,
`data_source` (`supabase`/`local`/`hardcoded`) — see `analytics.js` for the
setter functions (`setDeviceTypeSuperProperty`, `setSeasonSuperProperties`).

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
| `category_filter_changed` | scoreboard, trends, settings, recap | `surface`, `category`, `previous_category` |
| `member_row_expanded` | scoreboard | `surface`, `category`, `member_name` |
| `data_fallback_used` | season, calendar | `surface`, `fallback_level`, `reason` |
| `app_loaded` | app | `data_source`, `is_mobile`, `archived_season_count` |
| `season_loaded` | app | `data_source`, `year`, `is_refresh` |
| `data_refresh_triggered` | app | `success`, `jobs_succeeded`, `jobs_failed`, `duration_ms`, `is_skipped` |
| `overall_category_tile_clicked` | scoreboard | `category` |
| `trends_view_toggled` | trends | `view` |
| `trends_series_toggled` | trends | `member_name`, `is_hidden` |
| `trends_series_focused` | trends | `member_name`, `is_focused` |
| `trends_table_expanded` | trends | `total_snapshots` |
| `trends_load_failed` | trends | `error_message` |
| `calendar_filter_changed` | calendar | `filter` |
| `calendar_event_expanded` | calendar | `event_title`, `category`, `event_type`, `status`, `is_bonus_eligible` |
| `draft_recap_view_changed` | recap | `view` |
| `draft_recap_member_selected` | recap | `member_name` |
| `draft_recap_round_filtered` | recap | `round` |
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
| `settings_changes_saved` | settings | `mode`, `changes_count` (also fires for `mode: "paywall"`) |
| `settings_changes_reset` | settings | `mode` |
| `paywall_payment_completed` | scoreboard | `member_id`, `member_name` |

## Paywall (commissioner novelty feature)

- Commissioner-only toggle in Settings → Paywall: per-member `enabled` +
  custom `message`, stored as `seasonData.paywalls[memberId]` (parallel to
  `locks`, persisted via `savePaywallsToSupabase` in `src/utils/storage.js`).
- Enforced in `src/components/Scoreboard.jsx`: blurs a paywalled member's
  total/category numbers and swaps their expanded breakdown for a
  `PayPalButton` (`src/components/PayPalButton.jsx`) + the commissioner's
  message. Off = zero behavior change from status quo.
- PayPal is loaded via the public JS SDK (`REACT_APP_PAYPAL_CLIENT_ID`,
  safe to expose client-side — see `.env.example`), with order create/capture
  done entirely in the browser since this app has no backend. There is no
  server-side verification of the payment — acceptable for a joke toll in a
  private friend league, not a pattern to copy for anything that matters.
- A paying visitor unlocks only their own row through the
  `unlock_paywall` Postgres RPC (`supabase/phase3_paywalls.sql`), a
  security-definer function that can only flip one member's `enabled` flag.
  Anonymous visitors have no other write access to `seasons` — don't widen
  that without re-checking the RLS policies in `supabase/phase1_commissioner_auth.sql`.
- Toll amount/currency: `src/constants/paywall.js`.

## Governance

- No consent gate is implemented. This is a private ~12-person friend
  league, not a public product with known EU/California users — if that
  ever changes, add `opt_out_tracking_by_default: true` to `init()` in
  `analytics.js` and gate `opt_in_tracking()` behind explicit consent
  before shipping to a wider audience.
- Populate Lexicon descriptions for each event/property in the Mixpanel
  UI as they're reviewed — not yet done as of this file's creation.
