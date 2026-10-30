-- Phase 6: human-readable projection notes
--
-- Adds a plain-English explanation alongside each projected bonus — e.g.
-- "Projected to win the Super Bowl", "Projected Best Actor nominee",
-- "Won the NBA Finals (last season)". `source_detail` already carries
-- this same reasoning, but as an internal diagnostic string
-- (bonus_tier_ladder(10/7/5/3/2)|odds_lookup:matched) meant for
-- debugging a live run, not for a league member reading the Scoreboard.
-- `note` is the human-facing version of the same underlying tier the
-- bonus engine already computed — see api/cron/update-projections.js's
-- rankIntoTierBonus/addTierBonus/combinedAwardTierBonus for where it's
-- set, and docs/projections-feature-plan.md's twelfth iteration for the
-- full writeup.
--
-- Nullable and additive only — a pick with no applicable tier (no bonus
-- mechanism modeled for its category, or no live match found) simply
-- has note = null, same degradation behavior as every other projected
-- field in this table.

alter table public.projections
  add column if not exists note text;
