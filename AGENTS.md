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
- **One `mixpanel.identify()` call per person, ever — never two different
  values in the same session.** The commissioner role and member identity
  used to identify independently (`identifyCommissioner(userId)` and
  `identifyMember(memberId)`, each its own effect in `App.jsx`) — fine in
  isolation, but the commissioner is usually *also* a league member, so
  both fired for the same real person and Mixpanel has no guarantee of
  merging a UUID-keyed profile and a member-id-keyed profile into one.
  Both are now `identifyPerson({ userId, email, memberId })` in
  `analytics.js`, called from one combined effect in `App.jsx`: it picks
  **member_id over the Supabase auth UUID whenever both are known** — the
  UUID is only the distinct_id for a commissioner who hasn't claimed a
  member identity. Safe to call on every render with a session (a no-op
  if the id hasn't changed); the one-time-per-sign-in bookkeeping (login
  counts, `first_commissioner_login`, etc.) lives separately in
  `markCommissionerLogin(role)`, gated to the actual sign-in transition
  so it doesn't fire again on every re-render that touches identity.
- **Commissioner role**: switched from magic-link email after hitting
  Supabase's shared-mailer rate limit and a localStorage session-corruption
  issue; see `docs/commissioner-auth-phase1.md`. `markCommissionerLogin(role)`
  sets `role`, `first_commissioner_login` (set_once), `last_commissioner_login`,
  increments `commissioner_login_count`, and registers `is_commissioner: true`
  as a super property — called once per actual sign-in transition, not
  on every render.
- **Member identity**: mostly automatic now. `supabase/phase13_email_member_map.sql`
  maps each real league member's email to their static `DRAFT_MEMBERS`
  id (seeded manually, not committed — see that file's own note, same
  reasoning as `commissioner_emails`). On every sign-in with no
  `profiles.member_id` yet, `App.jsx`'s auth listener calls
  `auto_claim_member_identity()` — if the account's email is mapped, it's
  claimed immediately, no UI interaction needed at all. The manual "who
  are you?" picker (the account menu in `App.jsx`'s header, visible on
  every tab, `claim_member_identity` RPC from phase10) still exists as a
  **fallback** for any email that isn't in the map — a guest, a changed
  email, someone added after the map was last updated — rather than being
  removed; it's just unreachable in practice for anyone the map already
  covers, since `memberId` resolves before they'd ever open the menu.
  Either path lands in the same `identifyPerson()` call above — the
  stable member id (e.g. `"adam"`), never a display name or email, per
  the rule this file already had for this feature before it was built.
  Claiming fires `member_claimed` once, with `method: "auto"` or
  `"manual"`; every later session re-identifies to the same `member_id`
  automatically, so no repeat event is needed for the KPI in "Value
  Moment" below. `member_id` is registered as a super property
  (unregistered on sign-out).
  - The open-self-claim gap this file used to flag (phase10's own
    migration comment) is closed for anyone in the map — the automatic
    path makes a mismatch physically require signing in as someone
    else's actual Google account, not just picking their name from a
    list. The manual fallback is still open self-claim for an unmapped
    email; keep that in mind if member_id is ever used to authorize an
    action (e.g. a live draft pick) for someone who reached it that way.
- On sign-out, `resetIdentity()` calls `mixpanel.reset()` (and unregisters
  `member_id`) — breaks the identity link so a later visitor on a shared
  device doesn't inherit the previous signed-in person's profile. The
  account menu's visible avatar + name + explicit "Sign out" exists
  specifically so that's obvious to see and easy to act on, rather than
  relying on people remembering to log out of a device that isn't theirs.
- **Never call `identify()` with an email or a league member's display
  name** — identify with the stable `userId` (commissioner-only, no
  claimed member identity) or `member_id` (everyone else) instead, per
  `identifyPerson()` above.
- **`authReady` vs. `authConfirmed` in `App.jsx`**: on mount, `commissionerSession`/
  `commissionerRole`/`memberId` are optimistically hydrated straight from
  localStorage (the same `sb-...-auth-token` blob Supabase itself persists,
  plus a small `fl-cached-identity` cache this app writes) so the account
  menu doesn't sit blank for several seconds waiting on supabase-js's
  lock-gated `getSession()` on every refresh — see the "Optimistic auth
  hydration" comment above `App()`. `authReady` is `true` from the first
  render because of this and no longer means "the real check finished."
  `identifyPerson()` fires off `commissionerSession` alone (including the
  optimistic one) — safe, since it's explicitly idempotent (see
  analytics.js's own comment), and gating it on confirmation turned out to
  be a real bug, not extra safety: a role-lookup timeout with nothing left
  to retry it could leave that whole session's activity anonymous. Only
  the genuinely non-idempotent bookkeeping — `markCommissionerLogin()`,
  `COMMISSIONER_SIGNED_IN`/`OUT` — gates on the separate `authConfirmed`
  flag, which only flips once `loadAuth()`/`onAuthStateChange` actually
  resolves a role (now with one retry on timeout before giving up — see
  that branch's comment). Any new effect that isn't idempotent should gate
  on `authConfirmed`, the same way; anything that is (like `identifyPerson()`)
  doesn't need to.
- **Known limitation, not yet fixed**: a few foundational events
  (`app_loaded` in particular) can fire before the async auth check
  resolves and `identifyPerson()` has run, landing under the anonymous
  `$device_id` instead of the now-identified profile for a split second
  of page-load race. Most mixpanel-browser projects' default ID-merge
  behavior retroactively associates that anonymous activity with the
  identified profile once `identify()` fires in the same browser session,
  but that depends on this project's specific Mixpanel ID-merge
  configuration, which hasn't been verified either way. Low practical
  impact (it's a handful of the very first events in a session, not
  ongoing double-counting), but worth knowing if "weekly unique
  distinct_ids" ever looks inflated relative to the real league size.

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
| `member_claimed` | header | `member_id`, `method` (`auto`\|`manual`) (also calls `identify()`) |
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
- `api/cron/update-sports.js` (NFL/NBA/NHL/MLB/MLS), `update-college.js`
  (NCAAF/NCAAB), `update-events.js` (Tennis/Golf/F1), `update-billboard.js`
  (Musician), `update-entertainment.js` (Actor/Actress), `update-stocks.js`
  (Stock), and `update-country.js` (Country) write here — each diffs its
  own pick's old vs. new total at write time, reusing whatever stat it
  already has in memory (matched ESPN team/athlete, chart weeks,
  box-office/RT score, % price change, GDP growth %, Olympic medal rank)
  for the `cause` text, then calls the shared `writeScoreEventsAndNotify()`
  (`api/_lib/push.js`) to batch-insert the run's `scoreEvents` and send
  the resulting pushes — extracted there (originally inline, only in
  update-sports.js) specifically so this logic has one copy shared across
  every cron, not one per file. `update-country.js` is the one category
  where a single run can write *two* score_events rows for the same
  member: GDP (→ `base`) and Olympics (→ `bonus`) are independent
  mechanisms with their own lock keys, so both a rank shift and a medal-
  count shift can land in the same run. `buildScoreDigest()` handles this
  — see its own comment in `api/_lib/push.js` — by naming the one real
  category instead of claiming "2 categories updated" when a member's
  batch of events all share the same `category`, and `writeScoreEventsAndNotify()`'s
  existing per-member grouping already guarantees exactly one push either
  way. Two things worth noting from the billboard/entertainment/stocks
  extension pass: `update-stocks.js` deliberately diffs
  `base` only, never `bonus` — `bonus` is unconditionally reset to 0
  every run regardless of any real change (there's no actual Stock bonus
  mechanism), so diffing it would generate a misleading "bonus −X" event
  on every single run. `update-billboard.js` had a pre-existing display
  bug fixed in passing: its rankings output showed `bonus` in place of
  `base` whenever base was locked, because `base` was never fetched from
  `picks` at all before this pass added it (needed for the new diff).
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
  person; a subscription predates per-member identity entirely, and
  someone can still have multiple devices subscribed under the same
  member, or none). `endpoint` is unique and is itself the authorization
  check (unguessable bearer token), so the table has **no
  anon/authenticated RLS policies at all** — `api/push.js` writes with
  the service role key, same pattern as every other write in this app.
  `supabase/phase12_push_member_targeting.sql` added a nullable
  `member_id` column (FK to `members`, `on delete set null`):
  `subscribeToPush(memberId)` (`src/utils/push.js`) sends the browser's
  current claimed identity (or `null`) on every subscribe call, so the
  stored row always reflects live state — including clearing it back to
  `null` if someone ever un-claims. `App.jsx`'s `handleClaimMember` also
  re-calls `subscribeToPush()` right after a successful claim if push was
  already on, so a device that enabled push *before* claiming an
  identity doesn't stay stuck with `member_id: null` forever.
- **Sending:** `api/_lib/push.js` exports three entry points over one
  shared `sendPush()` core, via the `web-push` package and three env vars
  (`REACT_APP_VAPID_PUBLIC_KEY`, server-only `VAPID_PRIVATE_KEY`,
  `VAPID_SUBJECT`): `sendPushToAllSubscribers()` (literally everyone —
  used by the manual `?action=test` trigger when called with no
  `memberId`; pass one in the test request body to exercise
  `sendPushToMember()` instead, on demand, rather than waiting for a real
  score change to a claimed member's pick),
  `sendPushToUnclaimedSubscribers()` (only `member_id is null` rows —
  the broad digest's actual audience, see below), and
  `sendPushToMember(memberId, ...)` (one member's device(s) only). A
  subscription the push service reports as gone (404/410) is deleted
  automatically on send, so the table self-cleans, regardless of which
  of the three sent it.
- **The only current caller** is `api/cron/update-sports.js`, right after
  it writes `score_events`. Per run: the broad "N score updates" digest
  (`buildScoreDigest()` — single event → a specific message using the
  same `cause` text the Activity Feed shows; multiple → a generic count)
  goes only to unclaimed subscribers now; separately, `score_events` for
  this run are grouped by `member_id` and each member whose own score
  moved gets one targeted `sendPushToMember()` push via the same
  `buildScoreDigest()`, called with `{ targeted: true }`, scoped to just
  their events — **targeted replaces broad for a claimed member, it
  doesn't add to it**: if their own score didn't move this run, they get
  nothing from this run even if other members' scores did. With
  `targeted: true`, a multi-category run also names each category's own
  delta (`"NFL +16 · NBA +5"`) instead of falling back to a bare count,
  since there's one specific person to be specific for — the broad,
  potentially-multi-member digest keeps the generic count, there's no
  single person to deep-link it to. Every push's `url` deep-links into
  the relevant category via `scoreboardUrl()` (`/?tab=scoreboard&cat=X`,
  or no `cat` for the multi-category/broad cases) — reuses the `cat` URL
  param `Scoreboard.jsx`'s own `selCat` effect already reads on mount,
  no new frontend wiring needed. `service-worker.js`'s
  `notificationclick` handler navigates an already-open tab to that URL
  (falling back to a plain focus if `WindowClient.navigate()` isn't
  available, notably on older WebKit) instead of just focusing it
  wherever it already was, which used to silently swallow the deep link
  whenever the app was already open — the common case for an engaged
  user. This cron runs once daily (`vercel.json`), so there's no spam
  risk from either call site. `update-college.js`, `update-events.js`,
  `update-billboard.js`, `update-entertainment.js`, `update-stocks.js`,
  and `update-country.js` all now call the same `writeScoreEventsAndNotify()`
  too — each on its own `vercel.json` schedule (college/events daily
  like sports, stocks daily on weekdays, billboard weekly on Fridays,
  entertainment weekly on Mondays, country monthly), every one infrequent
  enough that the same "no spam risk" reasoning holds regardless of the
  exact cadence. `update-country.js`'s GDP and Olympics loops each push
  their own `scoreEvents` entries into one shared array before the single
  `writeScoreEventsAndNotify()` call at the end, so a run where both a
  member's GDP rank and their Olympic medal count move still sends that
  member exactly one push, not two — see the Activity feed section above
  for how `buildScoreDigest()` keeps that push's wording accurate.
- **Second caller, added for self-service draft picking**
  (`docs/live-draft-phase2.md`'s self-service section): `DraftTool.jsx`
  calls `notifyTurn()` (`src/utils/push.js`) after any pick lands, which
  hits a new `?action=notify-turn` case in `api/push.js` (no new
  Serverless Function — same flat-file-plus-query-param pattern as
  subscribe/unsubscribe/test, for the Vercel Hobby 12-function-cap
  reason explained above). Unlike every other action here, it takes NO
  `memberId` from the request body at all — the endpoint reads
  `draft_sessions` itself and derives who's on the clock from the
  server's own `current_pick`/`snake_order`, so a caller can trigger a
  check but never choose who gets pushed (an open "push this memberId"
  endpoint would let anyone who knows a member id — public, it's in the
  UI — spam that person's phone on demand). A staleness guard (skip
  unless `draft_sessions.updated_at` is within the last 15 seconds) caps
  how often even a repeated call can do anything.
- **Commissioner-facing test tool**: Settings → "🔔 Push Test"
  (`SeasonSettings.jsx`) lists every current-season member with a "Send
  test push" button, so the commissioner can confirm a given member will
  actually receive a push (device subscribed, permission granted) before
  relying on it live — same motivation as the Paywall tab it's modeled
  on, one row per member. Hits a new `?action=test-member` case in
  `api/push.js` (still no new Serverless Function). Unlike the existing
  `?action=test` (gated by `CRON_SECRET`, a server-only secret no
  browser could ever hold), this one is gated by asking Supabase whether
  the CALLER's own session is a commissioner — `sendTestPush()`
  (`src/utils/push.js`) sends the signed-in user's own access token as a
  Bearer header, and the endpoint builds a throwaway anon-key client
  scoped to that token and calls `is_commissioner()` with it, the same
  check every other commissioner-only write in this app already goes
  through, just asked from a Vercel function since sending a push has to
  happen server-side (`VAPID_PRIVATE_KEY`). Reports back `sent`/`failed`
  counts so "no active subscription for this member" is distinguishable
  from a real send failure.

## Governance

- No consent gate is implemented. This is a private ~12-person friend
  league, not a public product with known EU/California users — if that
  ever changes, add `opt_out_tracking_by_default: true` to `init()` in
  `analytics.js` and gate `opt_in_tracking()` behind explicit consent
  before shipping to a wider audience.
- Populate Lexicon descriptions for each event/property in the Mixpanel
  UI as they're reviewed — not yet done as of this file's creation.
