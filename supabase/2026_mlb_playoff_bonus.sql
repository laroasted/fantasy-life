-- 2026 MLB playoff bonus points
--
-- Run in the Supabase SQL editor (service role, so the seasons.locks JSON
-- is NOT consulted, the same as any manual edit).
--
-- Scoring (CATEGORY_BONUS_RULES.MLB):
--   10 Win WS | 7 Lose WS | 5 Lose LCS | 3 Lose LDS | 2 Lose WC
--
-- 2026 postseason (final through the LCS; the World Series is Rays vs Brewers,
-- and neither team is owned, so every owned team's bonus is final):
--   Lost LCS (5): Guardians (2-4 vs TB), Dodgers (0-4 vs MIL)
--   Lost DS  (3): Yankees (0-3 vs TB), White Sox (2-3 vs CLE),
--                 Padres (1-3 vs MIL), Braves (1-3 vs LAD)
--   Lost WC  (2): Astros (0-2 vs CWS), Red Sox (0-2 vs NYY),
--                 Cubs (0-2 vs SD), Phillies (1-2 vs ATL)
--
-- Teams are matched by nickname (ILIKE), so "Dodgers" and
-- "Los Angeles Dodgers" both work. Picks that didn't make the playoffs are
-- left untouched.
--
-- Not covered: the 1-point "Most AS Noms" bonus. This script SETS bonus to
-- the playoff points, so if a playoff team already holds that point, add it
-- back afterwards.

-- ── 1. Preview (run first) ──────────────────────────────────────────────
-- Expect: the active season year, every MLB pick with its current bonus,
-- and zero rows owning the Rays or Brewers.
select s.year, m.name as owner, p.pick, p.base, p.bonus, p.total, p.bonus_note
from picks p
join seasons s on s.year = p.season_year and s.status = 'active'
left join members m on m.id = p.member_id
where p.category = 'MLB'
order by p.pick;

-- ── 2. Apply ────────────────────────────────────────────────────────────
begin;

create temp table mlb_2026_rounds (
  team_pattern text,
  round_order int,
  round_name text,
  opponent text,
  result text,
  series text,
  pts numeric,
  note text
) on commit drop;

insert into mlb_2026_rounds values
  -- Lost LCS: 5
  ('%Guardians%', 2, 'ALDS',      'd. White Sox', 'Won',  '3-2', 0, ''),
  ('%Guardians%', 3, 'ALCS',      'vs Rays',      'Lost', '2-4', 5, 'Lost ALCS'),
  ('%Dodgers%',   2, 'NLDS',      'd. Braves',    'Won',  '3-1', 0, ''),
  ('%Dodgers%',   3, 'NLCS',      'vs Brewers',   'Lost', '0-4', 5, 'Lost NLCS'),
  -- Lost DS: 3
  ('%Yankees%',   1, 'Wild Card', 'd. Red Sox',   'Won',  '2-0', 0, ''),
  ('%Yankees%',   2, 'ALDS',      'vs Rays',      'Lost', '0-3', 3, ''),
  ('%White Sox%', 1, 'Wild Card', 'd. Astros',    'Won',  '2-0', 0, ''),
  ('%White Sox%', 2, 'ALDS',      'vs Guardians', 'Lost', '2-3', 3, ''),
  ('%Padres%',    1, 'Wild Card', 'd. Cubs',      'Won',  '2-0', 0, ''),
  ('%Padres%',    2, 'NLDS',      'vs Brewers',   'Lost', '1-3', 3, ''),
  ('%Braves%',    1, 'Wild Card', 'd. Phillies',  'Won',  '2-1', 0, ''),
  ('%Braves%',    2, 'NLDS',      'vs Dodgers',   'Lost', '1-3', 3, ''),
  -- Lost WC: 2
  ('%Astros%',    1, 'Wild Card', 'vs White Sox', 'Lost', '0-2', 2, ''),
  ('%Red Sox%',   1, 'Wild Card', 'vs Yankees',   'Lost', '0-2', 2, ''),
  ('%Cubs%',      1, 'Wild Card', 'vs Padres',    'Lost', '0-2', 2, ''),
  ('%Phillies%',  1, 'Wild Card', 'vs Braves',    'Lost', '1-2', 2, '');

create temp table mlb_2026_picks on commit drop as
select distinct p.id as pick_id, r.team_pattern
from picks p
join seasons s on s.year = p.season_year and s.status = 'active'
join mlb_2026_rounds r on p.pick ilike r.team_pattern
where p.category = 'MLB';

-- Clear any rounds already entered for these picks so re-running is safe.
delete from sport_rounds
where pick_id in (select pick_id from mlb_2026_picks);

insert into sport_rounds (pick_id, round_order, round_name, opponent, result, series, pts, note)
select mp.pick_id, r.round_order, r.round_name, r.opponent, r.result, r.series, r.pts, r.note
from mlb_2026_picks mp
join mlb_2026_rounds r on r.team_pattern = mp.team_pattern;

-- picks.total isn't written here: the cron jobs only ever write base/bonus,
-- so total is derived. Step 3 checks that.
update picks p
set bonus = x.pts,
    bonus_note = x.bonus_note,
    updated_at = now()
from (
  select mp.pick_id,
         sum(r.pts) as pts,
         max(case when r.result = 'Lost'
                  then 'Lost ' || r.round_name || ' ' || r.opponent || ' (' || r.series || ')'
             end) as bonus_note
  from mlb_2026_picks mp
  join mlb_2026_rounds r on r.team_pattern = mp.team_pattern
  group by mp.pick_id
) x
where p.id = x.pick_id;

commit;

-- ── 3. Verify ───────────────────────────────────────────────────────────
-- total should equal base + bonus on every row. If it doesn't (i.e. total
-- is a plain column, not generated), run:
--   update picks set total = base + bonus
--   where category = 'MLB'
--     and season_year = (select year from seasons where status = 'active');
select m.name as owner, p.pick, p.base, p.bonus, p.total,
       p.base + p.bonus as expected_total, p.bonus_note
from picks p
join seasons s on s.year = p.season_year and s.status = 'active'
left join members m on m.id = p.member_id
where p.category = 'MLB'
order by p.bonus desc, p.pick;
