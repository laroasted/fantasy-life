-- Phase 17: public RPC exposing the database's current time.
--
-- Codex finding on the phase16 follow-up (clock-offset correction for
-- this device's own skew — see docs/live-draft-phase2.md): that fix
-- computed the offset from draft_sessions.updated_at, the timestamp of
-- the LAST WRITE, not the server's current time. Those only agree at
-- the instant of a fresh write. A viewer who opens (or refreshes) the
-- Draft tab mid-countdown, with no write happening right then, computes
-- an offset of roughly "(last write's timestamp) - (now)" — which is
-- approximately minus however long the timer's already been running,
-- not this device's small, genuine clock skew. That made
-- computeLiveRemaining() undercount elapsed time by the same amount,
-- so the timer visibly jumped back up to its value as of the last
-- write before correcting.
--
-- Fix: give the client a direct way to ask "what time is it, server?"
-- instead of inferring it from whenever draft_sessions last happened to
-- be written. select now() is the database's own clock — the same one
-- the phase16 trigger stamps timer_started_at/updated_at from — so a
-- round-trip through this RPC measures this device's actual skew
-- against it, regardless of when the row was last touched.
create or replace function public.server_now()
returns timestamptz
language sql
stable
as $$
  select now();
$$;

grant execute on function public.server_now() to anon, authenticated;
