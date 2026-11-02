-- Phase 9: Web Push subscriptions
--
-- Stores one row per browser subscription (not per person — there's no
-- regular-member identity to key on, same reasoning as everything else in
-- this app's anonymous-visitor model). `endpoint` is the push service URL
-- the browser handed back from PushManager.subscribe(); it's effectively
-- an unguessable bearer token, so possession of it is the only
-- authorization check this needs.
--
-- Written only by api/push/subscribe.js / api/push/unsubscribe.js, both
-- using the service role key — same pattern as score_events
-- (phase7_score_events.sql). No anon/authenticated RLS policies at all:
-- nobody needs direct table access, frontend code only ever talks to
-- those two API routes, never to Supabase directly, for this table.

create table if not exists public.push_subscriptions (
  id bigint generated always as identity primary key,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;
-- (No policies created — RLS enabled with zero grants blocks anon/authenticated
-- entirely; only the service role, which bypasses RLS, can read or write.)
