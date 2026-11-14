-- Phase 22: 2026 fantasy-season calendar date audit (run in the Supabase SQL editor).
--
-- The live Calendar tab reads calendar_events, not the FALLBACK_EVENTS array in
-- src/components/Calendar.jsx, so fixing that array alone changes nothing users see.
-- This applies the same corrections to the table. Dates verified 2026-11-14
-- against league/tournament announcements (MLS, NBA, NHL, MLB, NFL, CFP, NCAA,
-- Tennis Australia, PGA TOUR, Recording Academy).
--
-- Updates match on season_year + the title the table was seeded with (same as
-- the fallback array). If your live titles differ, the matching UPDATE just
-- hits 0 rows. Run STEP 1 first to see what will match.

-- STEP 1 (preview): rows this script expects to touch
select id, event_date, title from calendar_events
where season_year = 2026 and title in (
  'NCAA Tournament — March Madness','MLS Season Opens','NCAA Championship — Final Four',
  'NHL Playoffs Begin','Stanley Cup Finals','NBA Finals Begin','Ryder Cup',
  'MLB Regular Season Ends','MLB Playoffs Begin','NHL Season Opens','MLB World Series',
  'MLS Playoffs Begin','NBA Season Opens','MLS Cup Final','College Football Playoff — First Round',
  'CFP Semifinal / NY6 Bowl Games','CFP National Championship','Australian Open',
  'Australian Open Final','NBA All-Star Weekend','NCAA Tournament 2027','98th Academy Awards (Oscars)')
order by event_date;

-- STEP 2: corrections
begin;

update calendar_events set title='NCAA Tournament — Selection Sunday', subtitle='Bracket revealed · First Four Mar 17–18 · First Round Mar 19–20'
  where season_year=2026 and title='NCAA Tournament — March Madness';
update calendar_events set event_date='2026-02-21'
  where season_year=2026 and title='MLS Season Opens';
update calendar_events set subtitle='Lucas Oil Stadium, Indianapolis · Semis Apr 4, Title Game Apr 6'
  where season_year=2026 and title='NCAA Championship — Final Four';
update calendar_events set event_date='2026-04-18'
  where season_year=2026 and title='NHL Playoffs Begin';
update calendar_events set event_date='2026-06-02', title='Stanley Cup Final'
  where season_year=2026 and title='Stanley Cup Finals';
update calendar_events set event_date='2026-06-03'
  where season_year=2026 and title='NBA Finals Begin';
update calendar_events set event_date='2026-09-24', title='Presidents Cup'
  where season_year=2026 and title='Ryder Cup';
update calendar_events set event_date='2026-09-27'
  where season_year=2026 and title='MLB Regular Season Ends';
update calendar_events set event_date='2026-09-29'
  where season_year=2026 and title='MLB Playoffs Begin';
update calendar_events set event_date='2026-09-29', subtitle='2026-27 NHL regular season begins (84 games)'
  where season_year=2026 and title='NHL Season Opens';
update calendar_events set event_date='2026-10-23'
  where season_year=2026 and title='MLB World Series';
update calendar_events set event_date='2026-11-19', subtitle='Wild Card matches · Round One (best-of-3) starts Nov 21'
  where season_year=2026 and title='MLS Playoffs Begin';
update calendar_events set event_date='2026-10-20'
  where season_year=2026 and title='NBA Season Opens';
update calendar_events set event_date='2026-12-18', subtitle='Friday primetime · hosted by finalist with the better record'
  where season_year=2026 and title='MLS Cup Final';
update calendar_events set event_date='2026-12-18'
  where season_year=2026 and title='College Football Playoff — First Round';
update calendar_events set title='CFP Quarterfinals (NY6)', subtitle='Fiesta Dec 30 · Cotton, Peach & Rose Jan 1'
  where season_year=2026 and title='CFP Semifinal / NY6 Bowl Games';
update calendar_events set event_date='2027-01-25', subtitle='Allegiant Stadium, Las Vegas, NV'
  where season_year=2026 and title='CFP National Championship';
update calendar_events set event_date='2027-01-17', subtitle='Melbourne Park, Melbourne, Australia · main draw (qualifying from Jan 11)'
  where season_year=2026 and title='Australian Open';
update calendar_events set event_date='2027-01-31', subtitle='Men''s final · tennis world ranking baseline freezes'
  where season_year=2026 and title='Australian Open Final';
update calendar_events set event_date='2027-02-19', subtitle='Phoenix, AZ · All-Star Game Feb 21'
  where season_year=2026 and title='NBA All-Star Weekend';
update calendar_events set event_date='2027-03-14', title='NCAA Tournament 2027 — Selection Sunday', subtitle='First 76-team field · counts for the 2027 season', is_bonus_eligible=false
  where season_year=2026 and title='NCAA Tournament 2027';
-- League rule: a season's Oscars are the NEXT calendar year's ceremony, so
-- the draft-day 98th Oscars belong to the 2025 season, not this one.
update calendar_events set subtitle='Dolby Theatre, Hollywood — counts for the 2025 season (2026 season scores the 99th, Mar 2027)', is_bonus_eligible=false
  where season_year=2026 and title='98th Academy Awards (Oscars)';

-- STEP 3: missing events (skipped if a row with the same title already exists)
insert into calendar_events (season_year, event_date, title, subtitle, category, event_type, is_bonus_eligible, sort_order)
select 2026, v.d::date, v.t, v.s, v.c, v.ty, v.b, 0
from (values
  ('2026-04-12','NBA Regular Season Ends','NBA win % baseline freezes','NBA','season_end',false),
  ('2026-04-16','NHL Regular Season Ends','NHL standings-points baseline freezes','NHL','season_end',false),
  ('2026-11-07','MLS Decision Day','Final day of MLS regular season · standings-points baseline freezes','MLS','season_end',false),
  ('2026-11-16','Grammy Nominations','2027 Grammy nominees announced — Musician bonus pts','Musician','awards_show',true),
  ('2026-12-06','CFP Selection Day','Day after conference title games · NCAAF AP baseline freezes','NCAAF','season_end',false),
  ('2027-01-14','CFP Semifinals','College Football Playoff Semifinals (Jan 14–15)','NCAAF','championship',true),
  ('2027-02-07','Grammy Awards','Crypto.com Arena, Los Angeles — Musician bonus pts','Musician','awards_show',true),
  ('2026-03-08','F1 Australian Grand Prix','Albert Park, Melbourne — featured GP (before draft day)','F1','major',true),
  ('2027-01-21','Oscar Nominations','99th Academy Awards nominees announced — Actor/Actress bonus pts','Film','awards_show',true),
  ('2027-03-14','99th Academy Awards (Oscars)','Dolby Theatre, Hollywood — last scored event of the 2026 fantasy year (Actor/Actress bonus)','Film','awards_show',true)
) as v(d,t,s,c,ty,b)
where not exists (select 1 from calendar_events e where e.season_year=2026 and e.title=v.t);

commit;
