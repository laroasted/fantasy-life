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

## What's still step 2

- Each member submitting their own pick, gated to whoever's actually on
  the clock — needs a server-side guard (e.g. a security-definer RPC that
  only accepts a pick from the current drafter), not just a UI check,
  since multiple people's clients will be live at once.
- A server-authoritative timer, or at least reconciliation — right now
  only the commissioner's client ever writes a timer state change; once
  picks (and therefore timer resets) can come from many different
  people's clients, clock drift and double-submits become real failure
  modes this phase's design doesn't need to handle yet.
- Reconnect handling for a member whose device drops mid-draft.
