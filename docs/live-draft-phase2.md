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
