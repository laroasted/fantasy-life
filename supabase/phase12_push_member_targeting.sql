-- Phase 12: per-member push targeting
--
-- Adds member_id to push_subscriptions so a claimed member's device(s)
-- can get a push about their OWN score change instead of the broad
-- "N score updates" digest every anonymous/unclaimed subscriber still
-- gets — see api/cron/update-sports.js and AGENTS.md's push section for
-- the targeted-replaces-broad behavior this enables.
--
-- No RLS changes needed: push_subscriptions already has zero
-- anon/authenticated policies (RLS enabled, no grants — phase9's own
-- design), so this column is only ever written by api/push.js using the
-- service role key, same as every other write to this table.

alter table public.push_subscriptions
  add column if not exists member_id text references public.members (id) on delete set null;
