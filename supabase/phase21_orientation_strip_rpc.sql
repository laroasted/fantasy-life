-- Phase 21: biggest_score_movers RPC for the "This Week" orientation strip
--
-- App.jsx's orientation strip (biggest riser/faller over the last ~7
-- days) used to compute this with three sequential client round-trips:
-- find the latest snapshot_date, find the baseline snapshot_date (the
-- latest one <= 7 days before that, or the season's earliest if there
-- isn't one that far back), then fetch both dates' rows and sum/diff them
-- in JS. Each step depends on the last, so that's three full network
-- round-trips of real latency stacked up before a best-effort banner
-- (not core data) can even appear. Moving the date-finding and per-member
-- summing into one query collapses that to one round-trip.
--
-- Mirrors the original JS logic exactly: baseline is the latest date on
-- or before (latest_date - 7), falling back to the season's earliest
-- date; returns no rows at all when there isn't yet a second distinct
-- date to compare against (a season with only one snapshot so far) —
-- same bail-out as the old "baselineDate === latestDate" check. Finding
-- which member is the biggest riser/faller from the returned per-member
-- deltas stays a client-side reduce, same as before — this RPC just
-- supplies the numbers, not the "which one counts as a mover" judgment.
create or replace function public.biggest_score_movers(p_season_year integer)
returns table (member_id text, delta numeric)
language sql
stable
as $$
  with latest as (
    select snapshot_date as latest_date
    from public.score_history
    where season_year = p_season_year
    order by snapshot_date desc
    limit 1
  ),
  baseline as (
    select coalesce(
      (
        select snapshot_date
        from public.score_history, latest
        where season_year = p_season_year
          and snapshot_date <= latest.latest_date - 7
        order by snapshot_date desc
        limit 1
      ),
      (
        select snapshot_date
        from public.score_history
        where season_year = p_season_year
        order by snapshot_date asc
        limit 1
      )
    ) as baseline_date
  ),
  totals as (
    select
      sh.member_id,
      sum(sh.total) filter (where sh.snapshot_date = l.latest_date) as latest_total,
      sum(sh.total) filter (where sh.snapshot_date = b.baseline_date) as baseline_total
    from public.score_history sh
    cross join latest l
    cross join baseline b
    where sh.season_year = p_season_year
      and sh.snapshot_date in (l.latest_date, b.baseline_date)
    group by sh.member_id
  )
  select
    t.member_id,
    round(coalesce(t.latest_total, 0) - coalesce(t.baseline_total, 0), 2) as delta
  from totals t, latest l, baseline b
  where l.latest_date is not null
    and b.baseline_date is not null
    and l.latest_date is distinct from b.baseline_date
$$;

grant execute on function public.biggest_score_movers(integer) to anon, authenticated;
