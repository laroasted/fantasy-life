-- Phase 14: Live draft room (roadmap step 1 of 2 — see
-- docs/commissioner-auth-phase1.md's "Next phases" section, written back
-- in phase 1: "move draft state from local component state into Supabase
-- draft session tables, let everyone view the same live draft room, keep
-- commissioner as the only one who submits picks at first").
--
-- Before this, DraftTool.jsx's entire draft — order, picks, timer,
-- history — lived in that one component's useState calls. That's why ANY
-- visitor, commissioner or not, could run through a full draft: it was
-- always a private, disconnected simulation, never shared with anyone
-- else's browser, and never survived a refresh. This table makes an
-- in-progress draft real, shared state instead: one row, written only by
-- the commissioner's actions, read by everyone (including the
-- commissioner's own browser, which now renders from this row too,
-- instead of a separate local copy that could drift from it).
--
-- Deliberately a SINGLETON table (id is always 1, enforced by the check
-- constraint below) — this league runs one draft at a time, and that
-- keeps "is a draft currently live" a trivial `select … where id = 1`
-- instead of a status filter that has to stay correct across every write
-- path. The row is deleted entirely once the commissioner finalizes (see
-- DraftTool.jsx's handleFinalize) or explicitly cancels a draft gone
-- sideways — "no row" IS "no live draft", not a status value to drift out
-- of sync with reality.
--
-- Everything that was previously float-free local state (picks,
-- pick_history, draft_order, snake_order) is stored as JSONB in the exact
-- shape DraftTool.jsx already builds in memory (see its useState
-- initializers and generateSnakeOrder() in src/utils/helpers.js) — this
-- is an incremental step that makes existing state SHARED, not a
-- redesign of the draft data model itself.

create table if not exists public.draft_sessions (
  id int primary key default 1,
  status text not null default 'drafting', -- 'drafting' | 'complete' (all picks made, awaiting finalize)

  season_name text not null,
  draft_order jsonb not null,              -- [{id, name, full, guess}, ...] — snake order's base sequence
  snake_order jsonb not null,              -- [{round, pick, memberId}, ...] — generateSnakeOrder()'s output
  picks jsonb not null default '{}'::jsonb,        -- {"<memberId>-<categoryId>": "<selection>"}
  pick_history jsonb not null default '[]'::jsonb, -- [{pick, memberId, categoryId, selection}, ...]
  current_pick int not null default 0,

  -- Timer: NOT a live per-second countdown written to the DB — that would
  -- mean one write a second from the commissioner's browser, replicated
  -- to every spectator, for no reason. Instead, each client computes its
  -- own display countdown from these three fields, re-deriving "remaining"
  -- locally: `timer_active ? max(0, timer_remaining - (now - timer_started_at)) : timer_remaining`.
  -- A write only happens on start/pause/reset/pick-made — state
  -- transitions, not ticks.
  timer_duration int not null default 120,    -- seconds a fresh clock starts from (reset target)
  timer_remaining int not null default 120,   -- seconds left as of timer_started_at, or frozen value while paused
  timer_active boolean not null default false,
  timer_started_at timestamptz,                -- set when (re)started, cleared (null) while paused

  started_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint draft_sessions_singleton check (id = 1)
);

alter table public.draft_sessions enable row level security;

-- Public read — same "no login required to view" policy shape as
-- seasons/members/picks in phase1_commissioner_auth.sql. A spectator
-- never needs to be signed in to watch the draft.
create policy "public can read draft_sessions"
on public.draft_sessions
for select
to public
using (true);

-- Commissioner-only write — same is_commissioner() check phase11 already
-- uses for seasons/members/picks. Any signed-in commissioner can control
-- the live session; this app treats "commissioner" as one shared role,
-- not a per-draft owner, same as every other commissioner-gated action.
create policy "commissioners can write draft_sessions"
on public.draft_sessions
for all
to authenticated
using (public.is_commissioner())
with check (public.is_commissioner());

-- Realtime — so a spectator's browser hears about the next pick the
-- moment the commissioner makes it, not on their next manual refresh.
-- Same additive-to-RLS behavior noted in phase8_realtime.sql: this only
-- lets rows already readable under the public-read policy above push to
-- subscribers, it doesn't widen access.
alter publication supabase_realtime add table public.draft_sessions;
