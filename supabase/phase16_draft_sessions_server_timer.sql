-- Phase 16: Server-authoritative timer start time.
--
-- Reported live: the countdown would sometimes start above 2:00 — 2:02,
-- sometimes 2:11 — varying pick to pick, not a fixed offset. Cause:
-- `timer_started_at` was a CLIENT-generated timestamp (`new Date()
-- .toISOString()` in DraftTool.jsx, written whenever the commissioner's
-- browser started/resumed the clock), and every other viewer's
-- `computeLiveRemaining()` compares THEIR OWN device's clock against that
-- value. Two independently-drifting device clocks compared against each
-- other is exactly the kind of thing that produces inconsistent few-
-- second-to-several-second errors in either direction — a commissioner's
-- clock running even slightly fast makes `timer_started_at` look like
-- it's in the future to a correctly-synced viewer, which makes
-- `elapsed = now - timer_started_at` negative, which (since remaining =
-- duration - elapsed) shows MORE than the real duration. The amount
-- varies because it tracks whatever that specific pair of devices'
-- clocks happen to disagree by, not a stable number.
--
-- Fix: never trust a client-supplied timer_started_at. This trigger
-- overwrites it with the DATABASE's own clock (`now()`) every time a
-- write leaves the row with timer_active = true — a fresh start, a
-- resume from pause, or the next pick's auto-restart all go through this
-- same path uniformly. That leaves exactly ONE authoritative clock
-- (Postgres's) that every viewer's `computeLiveRemaining()` measures
-- against, instead of N independently-drifting device clocks. The
-- remaining clock-skew exposure — one viewer's own device clock vs. the
-- database's — is far smaller and far more consistent in practice than
-- comparing two arbitrary client clocks to each other.
--
-- Also takes over updated_at the same way (a generic "touch" trigger),
-- for the same reason: no column meant to reflect "when did the server
-- see this write" should be sourced from a client's own clock.
create or replace function public.draft_sessions_touch()
returns trigger
language plpgsql
as $func$
begin
  new.updated_at := now();
  if new.timer_active then
    new.timer_started_at := now();
  end if;
  return new;
end;
$func$;

drop trigger if exists draft_sessions_touch on public.draft_sessions;
create trigger draft_sessions_touch
before insert or update on public.draft_sessions
for each row
execute function public.draft_sessions_touch();
