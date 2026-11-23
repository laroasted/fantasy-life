-- Phase 23: Stock split adjustment tracking
--
-- Bug: update-stocks.js computed pctChange as (closePrice - openPrice) /
-- openPrice, where openPrice is a snapshot taken once at draft time and
-- never otherwise touched. A forward N-for-1 split divides the live
-- trading price by N with zero real change to anyone's position — SNDK's
-- 8-for-1 split (effective 2026-11-20) turned a flat stock into an
-- apparent ~-87.5% move purely because openPrice was still carrying the
-- pre-split price.
--
-- Fix (see api/cron/update-stocks.js's fetchPrice()): every run now also
-- asks Yahoo for any splits between the last one this pick already
-- applied (or its season's draft_date, if none yet) and today, and
-- rebases the stored open_price by the cumulative factor — the same
-- thing a brokerage does to your cost basis after a split. This is a
-- one-time fix for SNDK and an evergreen one for every future split on
-- any ticker, with no new cron, table, or manual step required.
--
-- This column exists so that fix is idempotent: Yahoo's split history for
-- a given date range never changes, so without recording how far a pick
-- has already been adjusted, every run would re-detect the same split and
-- divide open_price by its factor again.
alter table public.stock_prices
  add column if not exists split_adjusted_through bigint;

comment on column public.stock_prices.split_adjusted_through is
  'Unix seconds (Yahoo split event timestamp) of the most recent stock split already folded into open_price. Null = none applied yet; the next check starts from the season''s draft_date instead.';
