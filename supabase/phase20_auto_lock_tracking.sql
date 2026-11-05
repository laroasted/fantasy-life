-- Phase 20: auto-lock firing tracker
--
-- api/cron/update-sports.js can now lock base/bonus fields itself once a
-- league's season is decided (championship game complete, or — for
-- NBA/NHL base — the regular season ending), instead of waiting on the
-- commissioner. The actual lock entries still live in seasons.locks,
-- in the exact same `category|owner|field` shape a manual lock uses
-- (see src/components/SeasonSettings.jsx's toggleLock) — so the commissioner
-- can still unlock and fix one, same as always.
--
-- What needed a separate column: a bookkeeping marker that an auto-lock
-- has already fired once this season, so a commissioner who manually
-- unlocks something afterward to fix a mistake doesn't get fought by the
-- very next cron run re-locking it right back. That marker can't live
-- inside seasons.locks itself — SeasonSettings.jsx's Locks tab renders
-- "Locks (" + Object.keys(locks).length + ")" from the raw key count
-- (line ~765) and lists every `editCat|...` entry verbatim, so anything
-- stuffed into that same object shows up in the commissioner's lock
-- count/list whether it's a real lock or not.
--
-- Shape: { "NFL|bonus": true, "NHL|base": true, ... } — one entry per
-- league+field the first time its trigger condition fires, independent
-- of locks.jsonb's own owner-scoped entries.

alter table public.seasons
  add column if not exists auto_lock_fired jsonb not null default '{}'::jsonb;
