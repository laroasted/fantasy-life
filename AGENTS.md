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

- The app itself still requires no login to view — anyone with the URL can
  browse every tab. Login is for *identity* (which league member this
  device belongs to), not access. An un-signed-in visitor is tracked by
  Mixpanel's auto-generated `$device_id`, never identified.
- Login uses Supabase Google OAuth for everyone — both the commissioner
  role and regular member identity share the same sign-in flow and the
  same `profiles` table (`supabase/phase1_commissioner_auth.sql`,
  `supabase/phase10_member_accounts.sql`). There's no separate "member
  login" mechanism — `signInWithGoogle()` has no allow-list; what a signed-in
  Google account is *authorized to do* is a separate lookup after the fact
  (see below), same as it always was for the commissioner.
- **Commissioner role**: switched from magic-link email after hitting
  Supabase's shared-mailer rate limit and a localStorage session-corruption
  issue; see `docs/commissioner-auth-phase1.md`. On a successful sign-in
  with a configured commissioner email, `App.jsx` calls
  `identifyCommissioner(userId, email, role)`, which:
  - `mixpanel.identify(userId)` — **the Supabase Auth `session.user.id`
    (a stable UUID), not the email.** Emails can change; the database ID
    doesn't. Email goes on the profile via `people.set({ $email })` only.
  - Sets `role`, `first_commissioner_login` (set_once), `last_commissioner_login`,
    increments `commissioner_login_count`.
  - Registers `is_commissioner: true` as a super property.
- **Member identity**: the "who are you?" picker now exists (the account
  menu in `App.jsx`'s header, visible on every tab, not just
  Draft/Settings). The first time a signed-in Google account has no
  `profiles.member_id` yet, it can self-claim one of the static
  `DRAFT_MEMBERS` ids via the `claim_member_identity` RPC
  (`supabase/phase10_member_accounts.sql`), then `App.jsx` calls
  `identifyMember(memberId)`, which:
  - `mixpanel.identify(memberId)` — **the stable member id (e.g. `"adam"`),
    never a display name or email**, per the rule this file already had
    for this feature before it was built. Claiming fires `member_claimed`
    once; every later session re-identifies to the same `member_id`
    automatically (see the `identifyMember`/`memberId` effect in `App.jsx`),
    so no repeat event is needed for the KPI in "Value Moment" below.
  - Registers `member_id` as a super property (unregistered on sign-out).
  - Deliberately open self-claim for now — no gate on which Google account
    can claim which member — because claiming only affects push targeting
    (Phase B) today. Revisit before member_id is ever used to authorize an
    action (e.g. a live draft pick) — see phase10's own migration comment.
- On sign-out, `resetIdentity()` calls `mixpanel.reset()` (and unregisters
  `member_id`) — breaks the identity link so a later visitor on a shared
  device doesn't inherit the previous signed-in person's profile. The
  account menu's visible avatar + name + explicit "Sign out" exists
  specifically so that's obvious to see and easy to act on, rather than
  relying on people remembering to log out of a device that isn't theirs.
- **Never call `identify()` with an email or a league member's display
  name** — identify with the stable `userId` (commissioner) or `member_id`
  (member) instead, per above.

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
| `push_notifications_toggled` | app-wide | `is_enabled`, `reason` (on failure) |
| `category_filter_changed` | scoreboard, trends, settings, recap | `surface`, `category`, `previous_category` |
| `member_row_expanded` | scoreboard | `surface`, `category`, `member_name` |
| `data_fallback_used` | season, calendar, trends, activity_feed | `surface`, `fallback_level`, `reason` |
| `app_loaded` | app | `data_source`, `is_mobile`, `archived_season_count` |
| `season_loaded` | app | `data_source`, `year`, `is_refresh`, `trigger` (`initial`\|`manual_refresh`\|`realtime`) |
| `data_refresh_triggered` | app | `success`, `jobs_succeeded`, `jobs_failed`, `duration_ms`, `is_skipped` |
| `overall_category_tile_clicked` | scoreboard | `category` |
| `activity_feed_load_failed` | scoreboard | `error_message` |
| `projections_toggled` | scoreboard | `surface`, `is_enabled`, `season_year` |
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
| `member_claimed` | header | `member_id` (also calls `identify()`) |
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

## Activity feed (Scoreboard sidebar)

- `score_events` (`supabase/phase7_score_events.sql` — numbered 7 because
  main had already taken phase5/phase6 for Projections by the time this
  merged; the table and column names are unaffected by the filename) is
  an append-only log of individual nonzero score changes, distinct from
  `score_history` (phase 2's one-row-per-member-per-category-per-day
  snapshot that powers Trends). Each row has a `cause` string and a
  `source` naming which cron wrote it.
- Only `api/cron/update-sports.js` (NFL/NBA/NHL/MLB/MLS) writes here —
  diffing each pick's old vs. new total at write time, reusing the matched
  ESPN team/record it already has in memory for the `cause` text. The
  other `update-*.js` crons don't write to `score_events` yet; see
  `docs/score-events-phase7.md` for why that's deliberate, not missing.
- Rendered by `src/components/ActivityFeed.jsx` in `Scoreboard.jsx`'s
  sidebar. A paywalled member's entries still show (name, category,
  cause) but the delta number is blurred with the same
  `PAYWALL_BLUR_STYLE` the rest of Scoreboard.jsx uses — a bare "something
  changed" with no number doesn't undercut the paywall the way a visible
  delta would. Keep this consistent if the feed is ever extended to other
  categories: a paywalled member's events should never show an unblurred
  delta anywhere.
- Clicking an entry filters the scoreboard to that category via the
  existing `EVENTS.CATEGORY_FILTER_CHANGED` with `surface: "scoreboard"`
  — reused, not a new event, per this file's own naming convention.

## Projections

- Full design + category-by-category automation methodology + confidence
  tiers: `docs/projections-feature-plan.md`. Read it before touching
  anything in this section — in particular, this league's scoring is
  **relative rank among the 12 picks per category**, not additive
  fantasy-football-style points, which is the single fact that shapes the
  whole engine.
- `api/cron/update-projections.js` runs a Monte Carlo simulation per
  category and writes to `projections`/`projection_runs`
  (`supabase/phase5_projections.sql`). Read-only with respect to `picks` —
  never mutates a real score.
- Free data sources only (no paid odds API) — Kalshi/Polymarket public
  endpoints for championship/major/awards bonus EV, ESPN power-index for
  sports base projection, TMDB upcoming-release discovery for
  Actor/Actress (reuses `TMDB_API_KEY`), and the league's own cached
  `billboard_weeks`/`music_songs` history for Musician. Country and Stock
  are deliberately NOT simulated — see the design doc for why.
- Frontend: `src/utils/storage.js`'s `fetchProjectionsFromSupabase()` →
  `seasonData.projections`, consumed by the "Current / Projected Final"
  toggle in `src/components/Scoreboard.jsx`. Degrades to hiding the toggle
  entirely if no projections have loaded for the season — never blocks or
  errors the real scoreboard.

## Push notifications (Web Push via the PWA)

- Builds on the PWA setup (`public/manifest.json`, `src/service-worker.js`
  — see that file's `push`/`notificationclick` handlers). Browser-native
  push, not a third-party service. On iOS this only fires for a site
  that's been Added to Home Screen (Safari doesn't deliver web push to an
  ordinary browser tab); desktop and Android work from any tab, open or
  closed.
- **Opt-in UI:** the bell icon in `App.jsx`'s header, visible on every tab
  whenever `isPushSupported()` is true (requires `serviceWorker`,
  `PushManager`, `Notification`, and `REACT_APP_VAPID_PUBLIC_KEY` all
  present — silently hidden otherwise, never a broken button).
  `src/utils/push.js` holds the browser-side logic: `subscribeToPush()`
  requests `Notification` permission, subscribes via
  `registration.pushManager.subscribe()` with the VAPID public key, and
  POSTs the resulting `{endpoint, keys}` to `api/push.js?action=subscribe`;
  `unsubscribeFromPush()` is the mirror image, through
  `api/push.js?action=unsubscribe`. All three actions (`subscribe`,
  `unsubscribe`, the manual `test` trigger) live in the one file
  `api/push.js`, dispatched by the `?action=` query param rather than a
  separate file per route or a `[action].js` dynamic path segment — a
  separate file per route would push this app's Serverless Function
  count over the Vercel Hobby plan's 12-per-deployment cap (this repo
  sits at exactly 11; every file directly under `api/` not prefixed `_`
  is its own function), and the bracket-segment version specifically
  does not route correctly on this project's Vercel config — a request
  to it 404/405s through the static SPA fallback instead of reaching
  the function. A flat, non-nested filename is what every other route
  in this app already uses successfully, so this mirrors that.
- **Storage:** `supabase/phase9_push_subscriptions.sql`'s
  `push_subscriptions` table — one row per browser subscription (not per
  person; there's no regular-member identity to key on). `endpoint` is
  unique and is itself the authorization check (unguessable bearer
  token), so the table has **no anon/authenticated RLS policies at all**
  — `api/push.js` writes with the service role key, same pattern as
  every other write in this app.
- **Sending:** `api/_lib/push.js`'s `sendPushToAllSubscribers()`, via the
  `web-push` package and three env vars (`REACT_APP_VAPID_PUBLIC_KEY`,
  server-only `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`). A subscription the
  push service reports as gone (404/410) is deleted automatically on
  send, so the table self-cleans.
- **The only current caller** is `api/cron/update-sports.js`, right after
  it writes `score_events` — one digest per run via `buildScoreDigest()`
  (single event → a specific message using the same `cause` text the
  Activity Feed shows; multiple → a generic count). This cron runs once
  daily (`vercel.json`), so there's no spam risk from this call site.
  Every other cron stays silent for now — wiring in
  college/stocks/entertainment/etc. is a deliberate future follow-up,
  same reasoning as `score_events` itself only covering sports so far
  (see phase7's own note).
- No per-member targeting (e.g. "only notify me about my own score") —
  every subscriber gets every digest. Revisit if that's annoying in
  practice; not worth the complexity for a 12-person league up front.

## Governance

- No consent gate is implemented. This is a private ~12-person friend
  league, not a public product with known EU/California users — if that
  ever changes, add `opt_out_tracking_by_default: true` to `init()` in
  `analytics.js` and gate `opt_in_tracking()` behind explicit consent
  before shipping to a wider audience.
- Populate Lexicon descriptions for each event/property in the Mixpanel
  UI as they're reviewed — not yet done as of this file's creation.
