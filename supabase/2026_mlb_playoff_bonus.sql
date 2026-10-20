-- 2026 MLB bonus points (playoffs + All-Stars)
--
-- Run in the Supabase SQL editor (service role, so the seasons.locks JSON
-- is NOT consulted, the same as any manual edit).
--
-- Scoring (CATEGORY_BONUS_RULES.MLB):
--   10 Win WS | 7 Lose WS | 5 Lose LCS | 3 Lose LDS | 2 Lose WC | 1 Most AS Noms
--
-- 2026 postseason (final through the LCS; the World Series is Rays vs Brewers,
-- and neither team is owned, so every owned team's bonus is final):
--   Lost LCS (5): Guardians (2-4 vs TB), Dodgers (0-4 vs MIL)
--   Lost DS  (3): Yankees (0-3 vs TB), White Sox (2-3 vs CLE),
--                 Padres (1-3 vs MIL), Braves (1-3 vs LAD)
--   Lost WC  (2): Astros (0-2 vs CWS), Red Sox (0-2 vs NYY),
--                 Cubs (0-2 vs SD), Phillies (1-2 vs ATL)
--
-- Most All-Stars (1): Dodgers and Phillies, tied at 6 on the final rosters
-- (replacements included: Wrobleski for LAD, Luzardo for PHI). Each tied
-- team gets the full point.
--
-- What shows in the MLB expanded view:
--   * sport_rounds -> one row per series (round, opponent, Won/Lost + series
--     score, +pts) with a green note on the round that ended the run, plus
--     an "All-Stars" row for LAD/PHI.
--   * picks.bonus_note -> one-line summary under the Total line, e.g.
--     "Out in NLCS (+5) · Most All-Stars (+1) = 6 bonus pts".
--   * Teams that missed the playoffs get no rounds (the view then shows
--     "Missed Playoffs"), bonus 0 and a "Missed playoffs" note.
--
-- Teams are matched by nickname (ILIKE), so "Dodgers" and
-- "Los Angeles Dodgers" both work. Every MLB pick in the active season is
-- rewritten, so re-running is safe.

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
  ('%Guardians%', 3, 'ALCS',      'vs Rays',      'Lost', '2-4', 5, 'Eliminated in ALCS (+5)'),
  ('%Dodgers%',   2, 'NLDS',      'd. Braves',    'Won',  '3-1', 0, ''),
  ('%Dodgers%',   3, 'NLCS',      'vs Brewers',   'Lost', '0-4', 5, 'Eliminated in NLCS (+5)'),
  -- Lost DS: 3
  ('%Yankees%',   1, 'Wild Card', 'd. Red Sox',   'Won',  '2-0', 0, ''),
  ('%Yankees%',   2, 'ALDS',      'vs Rays',      'Lost', '0-3', 3, 'Eliminated in ALDS (+3)'),
  ('%White Sox%', 1, 'Wild Card', 'd. Astros',    'Won',  '2-0', 0, ''),
  ('%White Sox%', 2, 'ALDS',      'vs Guardians', 'Lost', '2-3', 3, 'Eliminated in ALDS (+3)'),
  ('%Padres%',    1, 'Wild Card', 'd. Cubs',      'Won',  '2-0', 0, ''),
  ('%Padres%',    2, 'NLDS',      'vs Brewers',   'Lost', '1-3', 3, 'Eliminated in NLDS (+3)'),
  ('%Braves%',    1, 'Wild Card', 'd. Phillies',  'Won',  '2-1', 0, ''),
  ('%Braves%',    2, 'NLDS',      'vs Dodgers',   'Lost', '1-3', 3, 'Eliminated in NLDS (+3)'),
  -- Lost WC: 2
  ('%Astros%',    1, 'Wild Card', 'vs White Sox', 'Lost', '0-2', 2, 'Eliminated in Wild Card (+2)'),
  ('%Red Sox%',   1, 'Wild Card', 'vs Yankees',   'Lost', '0-2', 2, 'Eliminated in Wild Card (+2)'),
  ('%Cubs%',      1, 'Wild Card', 'vs Padres',    'Lost', '0-2', 2, 'Eliminated in Wild Card (+2)'),
  ('%Phillies%',  1, 'Wild Card', 'vs Braves',    'Lost', '1-2', 2, 'Eliminated in Wild Card (+2)'),
  -- Most All-Stars: 1 (result '—' renders as a neutral badge)
  ('%Dodgers%',   9, 'All-Stars', '6 (tied most w/ PHI)', '—', '—', 1, 'Most All-Stars (+1)'),
  ('%Phillies%',  9, 'All-Stars', '6 (tied most w/ LAD)', '—', '—', 1, 'Most All-Stars (+1)');

-- Every MLB pick this season, with its matched team pattern (null = no
-- playoff/All-Star bonus).
create temp table mlb_2026_picks on commit drop as
select p.id as pick_id,
       (select r.team_pattern from mlb_2026_rounds r
        where p.pick ilike r.team_pattern limit 1) as team_pattern
from picks p
join seasons s on s.year = p.season_year and s.status = 'active'
where p.category = 'MLB';

-- Clear existing rounds for all MLB picks so re-running is safe and
-- non-playoff teams fall through to "Missed Playoffs".
delete from sport_rounds
where pick_id in (select pick_id from mlb_2026_picks);

insert into sport_rounds (pick_id, round_order, round_name, opponent, result, series, pts, note)
select mp.pick_id, r.round_order, r.round_name, r.opponent, r.result, r.series, r.pts, r.note
from mlb_2026_picks mp
join mlb_2026_rounds r on r.team_pattern = mp.team_pattern;

-- picks.total isn't written here: the cron jobs only ever write base/bonus,
-- so total is derived. Step 3 checks that.
update picks p
set bonus = coalesce(x.pts, 0),
    bonus_note = coalesce(x.bonus_note, 'Missed playoffs'),
    updated_at = now()
from (
  select mp.pick_id,
         sum(r.pts) as pts,
         string_agg(
           case when r.round_name = 'All-Stars' then 'Most All-Stars (+1)'
                else 'Out in ' || r.round_name || ' (+' || r.pts || ')' end,
           ' · ' order by r.round_order
         ) filter (where r.pts > 0)
         || ' = ' || sum(r.pts) || ' bonus pts' as bonus_note
  from mlb_2026_picks mp
  left join mlb_2026_rounds r on r.team_pattern = mp.team_pattern
  group by mp.pick_id
) x
where p.id = x.pick_id;

commit;

-- ── 3. Verify ───────────────────────────────────────────────────────────
-- Expected bonuses: Dodgers 6, Guardians 5, Yankees/White Sox/Padres/Braves 3,
-- Phillies 3, Astros/Red Sox/Cubs 2, everyone else 0.
-- total should equal base + bonus on every row. If it doesn't (i.e. total
-- is a plain column, not generated), run:
--   update picks set total = base + bonus
--   where category = 'MLB'
--     and season_year = (select year from seasons where status = 'active');
select m.name as owner, p.pick, p.base, p.bonus, p.total,
       p.base + p.bonus as expected_total, p.bonus_note,
       (select string_agg(sr.round_name || ': ' || sr.result || ' ' || sr.series
                          || ' (+' || sr.pts || ')', ' | ' order by sr.round_order)
        from sport_rounds sr where sr.pick_id = p.id) as rounds
from picks p
join seasons s on s.year = p.season_year and s.status = 'active'
left join members m on m.id = p.member_id
where p.category = 'MLB'
order by p.bonus desc, p.pick;
