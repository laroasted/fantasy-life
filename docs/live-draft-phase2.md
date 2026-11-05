# Live draft room (roadmap step 1 of 2)

This is "Phase 2" from `docs/commissioner-auth-phase1.md`'s own "Next
phases" section, written when that file shipped: *"move draft state from
local component state into Supabase draft session tables, let everyone
view the same live draft room, keep commissioner as the only one who
submits picks at first."* Player accounts (originally planned as its
Phase 3 prerequisite) already exist as of the member-accounts work — see
AGENTS.md's Identity section — so this phase didn't need to build that
part.

## What changed

Before this, `DraftTool.jsx`'s entire draft — member list, order, picks,
timer, history — lived in that one component's `useState` calls. Every
visitor, commissioner or not, got their own private, disconnected
simulation: nothing was shared between browsers, and nothing survived a
refresh. The explicit, user-facing warning for a non-commissioner was
*"none of it will be saved."*

Now, the moment the commissioner clicks **Start Draft!**, a real session
is created in Supabase (`draft_sessions` — see
`supabase/phase14_live_draft.sql`) and every other open Draft tab picks
it up live via Supabase Realtime, the same mechanism the Scoreboard
already uses for score updates. The commissioner's own browser renders
from this same synced row too, not a separate local copy — so refreshing
mid-draft, or opening a second tab, resumes the live draft exactly where
it left off instead of starting a fresh local one.

**Commissioner still submits every pick.** This phase is deliberately
scoped to that — self-service picking (each member submitting their own)
is "step 2" on the roadmap, not done here. It needs real concurrency
handling (two members' clients both thinking it's their turn, a
server-authoritative timer, etc.) that this phase's single-writer design
doesn't need to solve yet.

**Non-commissioners can still run a private local mock draft** when no
real draft is live — unchanged, existing behavior, kept deliberately (see
the scope discussion that decided this before building it). The moment a
real draft actually starts, though, every Draft tab — including one
mid-mock-draft — switches to showing that live draft instead.

## Data model

One singleton row (`id` is always `1`, enforced by a check constraint) —
this league runs one draft at a time, so "is a draft live" is just
`select … where id = 1` returning a row or not. The row is deleted
entirely on finalize or on the commissioner's explicit "Cancel Draft" —
no row *is* no live draft, not a status value that has to stay in sync
with reality.

Every JSONB column mirrors the exact in-memory shape `DraftTool.jsx`
already used before this (`draft_order`, `snake_order` from
`generateSnakeOrder()`, `picks`, `pick_history`) — this is an incremental
step that makes existing state *shared*, not a redesign of the draft data
model.

## Timer

Not a live per-second countdown written to the database — that would be
one write a second from the commissioner's browser, replicated to every
spectator, for a value nobody but the UI needs synced that tightly.
Instead, three fields (`timer_duration`, `timer_remaining`,
`timer_active`, `timer_started_at`) describe the clock's *state*, and
every viewer — commissioner included — derives the current display value
locally:

```
remaining = timer_active
  ? max(0, timer_remaining - (now - timer_started_at))
  : timer_remaining
```

A write only happens on start / pause / reset / pick-made (state
transitions), not on ticks. See `computeLiveRemaining()` in
`DraftTool.jsx`.

**Keeps running across picks** — the clock auto-restarts at a fresh 2:00
the moment a pick lands (and when the draft itself starts), rather than
stopping and waiting for the commissioner to click Start again every
single time. Pause still works, for whenever it's actually needed.

**`timer_started_at` is server-set, never client-set** (phase 16) — see
below. Every write that leaves the row with `timer_active = true` gets
that field overwritten by the database's own `now()`, regardless of what
value the client sent.

## Realtime payloads and REPLICA IDENTITY (phase 15)

Hit live, confirmed from the actual browser console error, not guessed:
every pick tripped the Draft tab's error boundary on
`effective.snakeOrder.length` — `snake_order` was simply missing
(`undefined`, not `[]`) from the Realtime payload. Cause: Postgres
logical replication omits an `UPDATE`'s unchanged large (TOASTed)
columns from the replication stream unless the table's
`REPLICA IDENTITY` is `FULL`. `saveDraftSession()` never touches
`snake_order`/`draft_order` after the initial insert (only
`picks`/`pick_history`/`current_pick`/`status`/`timer_*`), so once those
two columns grew past Postgres's TOAST threshold — easy, one entry per
member per category — every subsequent Realtime `UPDATE` arrived missing
them.

Fixed two ways, deliberately both:
- `phase15_draft_sessions_replica_identity.sql` sets
  `REPLICA IDENTITY FULL` on the table — Postgres's/Supabase's own
  documented fix, so the payload is complete again at the source.
- `subscribeDraftSession()` (`storage.js`) no longer trusts
  `payload.new` directly — it re-fetches the row on any INSERT/UPDATE
  notification instead, the same pattern the scoreboard's own realtime
  effect in `App.jsx` already uses. Belt and suspenders: a correct render
  then doesn't depend on every future write remembering to touch every
  column, or on nothing else about Realtime's payload shape changing.

## Server-authoritative timer start (phase 16)

Reported live: the countdown would sometimes start above 2:00 —
inconsistently, 2:02 one pick, 2:11 another. Cause: `timer_started_at`
was a client-generated timestamp, and every viewer's
`computeLiveRemaining()` measures elapsed time against THEIR OWN device
clock. Two independently-drifting client clocks compared to each other
produce exactly this kind of inconsistent, direction-either-way error —
and specifically, a start time that looks like it's in the future to a
correctly-synced viewer makes the computed remaining time exceed the
real duration.

Fixed with a database trigger (`draft_sessions_touch`,
`phase16_draft_sessions_server_timer.sql`) that overwrites
`timer_started_at` with Postgres's own `now()` on any write that leaves
`timer_active = true`, regardless of what the client sent. That leaves
exactly one authoritative clock every viewer measures against, instead
of N arbitrary device clocks. The same trigger also takes over
`updated_at` for the same reason — `saveDraftSession()` no longer sets
either field itself.

**Follow-up, same root cause**: the fix above still had the client
optimistically guessing its own `timer_started_at` for the brief window
before the server-confirmed row arrives — which visibly glitched (a
report of "counts up 2 seconds, then jumps to 2:00 and counts down").
The server's stamped value is always a little LATER than the client's
own guess (the trigger fires once the write actually commits, not when
the browser started sending it), so replacing one with the other made
the displayed time visibly jump forward before resuming its countdown.
Fixed by leaving `timer_started_at` `null` in every optimistic patch
(`makePick`/`handleTimerStart`/`handleTimerReset`) instead of guessing —
`computeLiveRemaining()` already falls back to the flat, correct
`timer_remaining` (not ticking) whenever `timer_started_at` is unset, so
there's one clean transition into the countdown once the real server
timestamp lands, not a tick-then-correct glitch.

**Second follow-up, smaller residual version of the same root cause**:
after the fix above, a smaller ~2-second version of the exact same
symptom (briefly over 2:00, then settling) was still reported. Cause:
once the server-confirmed row lands, `computeLiveRemaining()` measures
elapsed time as `Date.now() - timer_started_at` using *this device's
own* clock — and this device's clock doesn't have to agree with the
database server's by more than a second or two for that to show up as
exactly this kind of brief overshoot. This is the smaller, residual
skew source called out as a known remaining risk when phase16 shipped
(directly above: "the remaining clock-skew exposure — one viewer's own
device clock vs. the database's — is far smaller and far more
consistent in practice than comparing two arbitrary client clocks to
each other").

Fixed with an NTP-style clock-offset correction, client-side plus one
tiny new RPC (`server_now()`, `phase17_server_time_rpc.sql`) that just
returns the database's `now()`.

**First attempt, and why it was wrong**: the first version of this fix
computed the offset from `draft_sessions.updated_at` — reasoning that
since the phase16 trigger stamps it with the server's `now()` on every
write, it's a free, already-available server timestamp. Codex caught
the real bug in that: `updated_at` is only the time of the *last
write*, not "now". A viewer who opens or refreshes the Draft tab
mid-countdown, with no write happening right then, computed an offset
of roughly *(last write's timestamp) − (now)* — which is approximately
*minus how long the timer's already been running*, not this device's
small genuine clock skew. That made `computeLiveRemaining()`
drastically undercount elapsed time, so the countdown visibly jumped
*backward* to its value as of the last write before correcting —
exactly the kind of regression this whole section exists to prevent.

**Fix**: ask the server directly instead of inferring its clock from
whenever a row happened to last be written. `server_now()` is a plain
`select now()` RPC, callable by anyone (same public-read posture as the
rest of this table). `fetchServerClockOffset()` (`storage.js`) calls it,
splitting the round-trip evenly — the reply is treated as simultaneous
with the midpoint between when the request was sent and the response
was seen, a better estimate than either endpoint alone — and returns
`server time − local time`. `DraftTool.jsx` calibrates
`clockOffsetRef.current` from this once on mount and every 60 seconds
after, for as long as the Draft tab stays open (a ref, not state,
since updating it should never itself trigger a render — it only needs
to be current by the next tick). Every place that feeds a raw
`Date.now()`/`liveNow` into `computeLiveRemaining()` adds this offset
first, so elapsed time is measured against an estimate of the server's
actual clock, independent of whenever the row itself was last touched.

## Access

- **Read**: public, same as `seasons`/`members`/`picks` — no login
  required to watch, matching this app's whole "login is for identity,
  not access" model (AGENTS.md).
- **Write**: `is_commissioner()`-gated, same check phase11 already
  established for `seasons`/`members`/`picks`. Any signed-in commissioner
  can control the live session — this app treats "commissioner" as one
  shared role, not a per-draft owner.

`DraftTool.jsx` reads through `supabasePublic` (the session-less client —
see `src/utils/storage.js`'s own comment on why) and writes through the
regular session-bearing `supabase` client.

## Self-service picking (phases 18/19 — step 2)

Each member now submits their own pick directly, gated to whoever's
actually on the clock — the three items this file used to list under
"What's still step 2" are all addressed below. The commissioner retains
a standing override (can always force the current pick for whoever's on
the clock) and sole control of the timer and undo — see the decisions
recorded in this section for why those stayed narrower than picking
itself.

**The core problem, and why the existing write pattern couldn't survive
it.** Every write through phase17 assumed exactly one writer. The
pattern was: client reads state, decides the new state, pushes a full
JSON patch. The moment multiple members' own browsers can submit a
pick, that's a real corruption race — two clients can both read "it's
Adam's turn, Lakers is open," both decide to write, and the second write
clobbers or corrupts the first. Fixed the way ESPN/Sleeper-grade draft
rooms actually handle this: the client sends *intent* ("I want Lakers
for NBA"); one locked, server-side transaction decides whether that's
legal and, if so, applies it. The client never computes `current_pick`,
`picks`, or `pick_history` itself for a live pick anymore.

**`submit_draft_pick` / `undo_last_draft_pick`**
(`phase19_draft_pick_rpcs.sql`) — two deliberately redundant correctness
mechanisms on both:
- `select ... for update` takes a row lock the instant the transaction
  starts reading `draft_sessions`. Two picks landing within milliseconds
  of each other are serialized by Postgres itself — there is no window
  where both read the same stale state. This is what actually prevents
  corruption.
- A `current_pick != p_expected_pick` version check is redundant with
  the lock for correctness, but gives a specific, nameable error
  (`stale_pick`) instead of a confusing partial failure. That distinction
  is what lets the client react correctly: silently refetch, because this
  is usually just this client's view being one Realtime tick behind, not
  an actual simultaneous collision.

`submit_draft_pick` always derives *who* is on the clock from the
authoritative `snake_order[p_expected_pick]` — never from a client-
supplied member id. A non-commissioner caller must additionally resolve
to that same member via `profiles.member_id` AND have `claim_method =
'auto'` (see phase18 below) — a manually-claimed identity (the open
self-claim fallback) is blocked from self-service picking with a
`claim_not_verified` error; the commissioner can still pick on their
behalf. It also re-validates `selection_already_taken` inside the same
locked transaction — the client-side "already picked" filter
(`!Object.values(picks).includes(opt)`) is necessarily advisory only
once multiple people can submit at once, since it can be stale by the
time of submit.

`undo_last_draft_pick` stays commissioner-only, but is now routed
through the same locked-row pattern instead of a plain client `UPDATE` —
not because concurrent undos are possible (only one role can call it),
but because a plain client-constructed patch could race a *member's*
pick landing between the commissioner's last render and their Undo
click. The version check catches exactly that.

Both functions pin `search_path` and have a 3-second `statement_timeout`
set on them (same `security definer` pattern as `claim_member_identity`/
`unlock_paywall`) — the latter specifically so one stuck connection can
never hold this lock, and therefore the whole draft room, hostage.

**`claim_method` (`phase18_profile_claim_method.sql`)** — a real gap
found while designing this, flagged in advance by phase10's own
migration comment ("revisit before Phase C (live draft) ever lets
member_id gate who's allowed to make a pick"). Whether a member was
claimed through the trusted, email-verified path (phase13's
`auto_claim_member_identity`) or the open manual fallback
(`claim_member_identity`) existed ONLY as a property on the
`member_claimed` Mixpanel event — never persisted, so there was nothing
in the database for `submit_draft_pick` to check. This adds the column
and has both claim functions stamp it (`'auto'` / `'manual'`), including
a retroactive backfill: on sign-in, if an already-claimed profile's
`claim_method` is still null and its existing `member_id` matches
exactly what the email map says it should be, it gets backstamped
`'auto'` — safe, since it only ever confirms a claim the map already
agreed with, never changes which member_id is claimed. No blind bulk-SQL
guess needed; every real league member signs in again naturally before
a draft.

**Follow-up, found testing against the real league's existing profiles**:
the backfill above was unreachable in practice for anyone already
claimed before this phase shipped. `App.jsx`'s auth-state listener only
ever called `auto_claim_member_identity()` (the RPC the backfill logic
lives in) when `profiles.member_id` was still null — an already-claimed
profile took an early-return branch that skipped the call entirely, so
the "self-heals on next sign-in" claim above was simply false for every
real member (all already claimed). Confirmed live: querying `profiles`
for this league's four members immediately after running phase18 showed
`claim_method: null` across the board. Fixed by also firing the same
RPC call (fire-and-forget — it's idempotent, already swallows its own
errors, and nothing on this path needs its result) from the early-return
branch, not just the "no identity yet" one. The four existing profiles
were unblocked immediately with a direct one-time backfill UPDATE
(same `email_member_map`-agreement condition the RPC's own backfill
uses) rather than waiting on a redeploy.

**Reconnect handling.** `postgres_changes` does not replay events missed
while a socket was disconnected (a phone locking mid-draft, a wifi
blip) — `subscribeDraftSession()` (`storage.js`) now takes a second
`onReconnect` callback, fired when the channel's own status returns to
`SUBSCRIBED` after dropping, which forces an immediate refetch instead
of waiting for luck. On top of that, `DraftTool.jsx` runs an independent
backstop: a forced `fetchDraftSession()` on `visibilitychange` (tab/phone
coming back to foreground), on the browser's `online` event, and
unconditionally every 45 seconds — insurance behind Realtime, not a
replacement for it, for the one failure mode nothing else here can
detect: Realtime silently not delivering while the REST API is fine.
Cheap at this scale (~12 people, one query).

**Client-side error handling (`makePick`/`undoPick`, `DraftTool.jsx`)** —
`submitDraftPick()`/`undoLastDraftPick()` (`storage.js`) return `{ row,
code }` rather than throwing. `stale_pick` is handled silently (refetch,
no error shown — it's the expected cost of losing a race or lagging a
tick, not a bug). A `network_error` (the request itself never got a
response) is resolved by checking ground truth after the fact — refetch,
then check whether `pick_history` at the attempted pick's index actually
matches what was just submitted; if so, it was this client's own
successful write and nothing is shown, rather than alarming the user
over a response that simply didn't arrive. Every other code
(`not_your_turn`, `claim_not_verified`, `selection_already_taken`,
`draft_already_complete`) surfaces a specific, non-alarming message via
a new `pickError` banner.

**`canPick` vs. `canControlTimer`.** The old single `canAct` flag now
splits in two: `canControlTimer` (`!liveSession || isCommissioner`,
unchanged) still gates Start/Pause/Reset/Undo — those stay commissioner-
only even now, since they're still only ever written by one role, so
there's no concurrency to guard and no reason to invite collisions over
who's allowed to pause whose turn. `canPick` (`!liveSession ||
isCommissioner || isMyTurn`) additionally opens the category/selection UI
to whoever's actually on the clock. `isMyTurn` is a UX convenience only —
it decides whether to show the buttons, not whether the pick is allowed;
the real authorization (including the `claim_method` check) lives
entirely server-side in `submit_draft_pick`. A manually-claimed member
who's on the clock still sees the pick buttons (this file doesn't plumb
`claim_method` into client state) and gets a clear, specific error on
submit instead — simpler than a pre-emptive check, and no less correct,
since the server is what actually enforces it either way.

**Push on your turn.** Reuses the exact `sendPushToMember()` primitive
already built for score alerts (AGENTS.md's push section) — no new
infrastructure. `notifyTurn()` (`src/utils/push.js`) is called after any
successful pick and hits a new `?action=notify-turn` case in the
existing `api/push.js` (no new Serverless Function — see that file's own
comment on the Vercel Hobby 12-function cap). Deliberately takes no
`memberId` or anything else from the request body: unlike subscribe/
unsubscribe (which only ever touch the caller's own endpoint), an open
"push this memberId" endpoint would let anyone who knows a member id
(public — it's in the app's own UI) spam that person's phone on demand.
Instead the endpoint reads `draft_sessions` itself and derives the
target from the server's own `current_pick`/`snake_order` — the caller
can only trigger a check, never choose who gets pushed — and a staleness
guard (skip unless `updated_at` is within the last 15 seconds) caps how
often even a repeated call can do anything at all.

**Deliberately not built, and why:**
- **Auto-pick on timer expiry.** Considered and rejected — keeping this
  manual (the clock just sits at 0:00 until someone acts) avoids an
  entire class of "what's the default pick for this category" edge cases
  outright. The commissioner's standing override is the intended
  mitigation for an AFK member stalling the room, not an automatic pick.
- **Rate limiting / abuse resistance** on the new RPCs or the push
  endpoint. ESPN has to defend against the general public; this is 12
  people who know each other. Solving a threat model that doesn't exist
  here would be effort spent on the wrong thing.
- **A "backup commissioner" failover role**, for if the commissioner's
  own device drops mid-draft. A real gap — the override mechanism has no
  fallback referee — but not worth building for a once-a-year draft with
  one reliably-present commissioner.

### Verifying the lock actually works

A normal click-through test can't surface a race condition — by
definition it never races anything. Before trusting this on a real
draft, prove the lock does what the SQL claims with a sequential,
single-tab test in the Supabase SQL Editor (two back-to-back calls
against the SAME `expected_pick`, from two different claimed
identities, look identical to the function whether they're genuinely
simultaneous or just pasted one after the other — which is exactly why
this test doesn't need real timing precision to be meaningful):

```sql
-- Look up two real, already-claimed members' profile UUIDs first:
select p.id as profile_uuid, p.member_id, m.name
from profiles p join members m on m.id = p.member_id
order by m.name;
```

Start a disposable test draft, note who's actually on the clock, then
(same SQL Editor tab, run as one block):

```sql
-- Call 1 — simulating whoever is ACTUALLY on the clock, should succeed
select set_config('request.jwt.claims', json_build_object('sub', '<their-profile-uuid>')::text, true);
select public.submit_draft_pick(5, 'NBA', 'Lakers', false);  -- use the real current_pick number

-- Call 2 — simulating anyone else, SAME expected_pick — should be rejected
select set_config('request.jwt.claims', json_build_object('sub', '<any-other-profile-uuid>')::text, true);
select public.submit_draft_pick(5, 'NFL', 'Chiefs', false);
```

Call 2 should raise `stale_pick`. Then confirm the end state is clean,
not corrupted:

```sql
select current_pick, picks, pick_history from draft_sessions where id = 1;
```

`current_pick` should have advanced by exactly 1 (not 2), `picks` should
contain Lakers and not Chiefs, and `pick_history` should have exactly
one new entry. Cancel the test draft afterward — never run this against
a draft you actually care about keeping.
