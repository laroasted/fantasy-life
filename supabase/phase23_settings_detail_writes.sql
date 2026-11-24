-- Phase 23: let the commissioner's Settings edits to breakdown rows
-- actually persist.
--
-- Before this, Settings → Scores & Bonus edits (base/bonus, bonus notes,
-- pick swaps, and every detail row: playoff rounds, films, songs,
-- Grammys, majors/GPs) only ever updated the browser's in-memory state and
-- localStorage cache. App.jsx's handleSettingsSave wrote locks and
-- paywalls to Supabase and nothing else, so the next live load quietly
-- replaced the edit with whatever the database still had.
--
-- picks edits go through the existing "commissioners can write picks"
-- policy (phase11), no change needed there. The five detail tables have
-- NO browser write policy on purpose (phase11 dropped the old open one).
-- Rather than reopen table-wide writes, this adds one narrow
-- security-definer function:
--
--   replace_pick_detail_rows(p_table, p_pick_id, p_rows, p_expected)
--
-- which, for one pick, deletes that pick's rows in one of the five tables
-- and inserts p_rows in their place, in a single transaction (a failed
-- insert rolls the delete back, so a bad save can never leave a pick with
-- no rows). p_expected is the set of rows the browser last read for that
-- pick; the function locks the pick's rows and refuses (SQLSTATE 40001)
-- if they no longer match, so a cron write that lands between the
-- browser's read and this call is never silently wiped. It checks is_commissioner() itself, accepts only the five
-- known table names, and inserts only each table's known columns, so
-- nothing about the table name or the JSON can steer it anywhere else.
-- The crons keep writing these tables with the service role key, as
-- before.
--
-- Column lists mirror what src/utils/storage.js reads back
-- (fetchSeasonFromSupabase) and what the crons insert. If a table has an
-- extra NOT NULL column without a default that isn't listed here, the
-- insert fails, the transaction rolls back, and Settings shows the error.
-- Nothing is lost.

create or replace function public.replace_pick_detail_rows(
  p_table text,
  p_pick_id text,
  p_rows jsonb,
  p_expected jsonb default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_count integer;
  v_cols text[];
  v_current jsonb;
begin
  if not public.is_commissioner() then
    raise exception 'Commissioner access required' using errcode = '42501';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;

  if not exists (select 1 from public.picks where id::text = p_pick_id) then
    raise exception 'Unknown pick %', p_pick_id;
  end if;

  -- Same column lists as the inserts below (and DETAIL_TABLES[...].cols
  -- in src/utils/seasonEdits.js). Constants only: never built from input.
  v_cols := case p_table
    when 'sport_rounds'  then array['round_name','opponent','result','series','pts','note','round_order']
    when 'film_entries'  then array['title','release_date','box_office','rotten_tom','score','note']
    when 'music_songs'   then array['title','weeks','num_one_weeks','note']
    when 'music_grammys' then array['category','result','entry','pts','note']
    when 'event_majors'  then array['event_name','result','opponent','score','pts','note','event_order']
  end;
  if v_cols is null then
    raise exception 'Unsupported table %', p_table;
  end if;

  if p_expected is not null then
    -- Lock this pick's rows, then compare them (as a multiset over the
    -- known columns) with what the browser last read.
    execute format('select 1 from public.%I where pick_id::text = $1 for update', p_table) using p_pick_id;
    execute format(
      'select coalesce(jsonb_agg(jsonb_build_object(%s)), ''[]''::jsonb) from public.%I where pick_id::text = $1',
      (select string_agg(format('%L, %I', c, c), ', ') from unnest(v_cols) c),
      p_table
    ) into v_current using p_pick_id;
    if not (jsonb_array_length(v_current) = jsonb_array_length(p_expected)
            and v_current @> p_expected and p_expected @> v_current) then
      raise exception 'These rows changed on the server since this page loaded' using errcode = '40001';
    end if;
  end if;

  -- Every inserted row is forced onto p_pick_id below, whatever pick_id
  -- the JSON carries, so one call can only ever touch one pick.
  if p_table = 'sport_rounds' then
    delete from public.sport_rounds where pick_id::text = p_pick_id;
    insert into public.sport_rounds (pick_id, round_name, opponent, result, series, pts, note, round_order)
    select pk.id, r.round_name, r.opponent, r.result, r.series, r.pts, r.note, r.round_order
    from jsonb_populate_recordset(null::public.sport_rounds, p_rows) r
    cross join (select id from public.picks where id::text = p_pick_id) pk;

  elsif p_table = 'film_entries' then
    delete from public.film_entries where pick_id::text = p_pick_id;
    insert into public.film_entries (pick_id, title, release_date, box_office, rotten_tom, score, note)
    select pk.id, r.title, r.release_date, r.box_office, r.rotten_tom, r.score, r.note
    from jsonb_populate_recordset(null::public.film_entries, p_rows) r
    cross join (select id from public.picks where id::text = p_pick_id) pk;

  elsif p_table = 'music_songs' then
    delete from public.music_songs where pick_id::text = p_pick_id;
    insert into public.music_songs (pick_id, title, weeks, num_one_weeks, note)
    select pk.id, r.title, r.weeks, r.num_one_weeks, r.note
    from jsonb_populate_recordset(null::public.music_songs, p_rows) r
    cross join (select id from public.picks where id::text = p_pick_id) pk;

  elsif p_table = 'music_grammys' then
    delete from public.music_grammys where pick_id::text = p_pick_id;
    insert into public.music_grammys (pick_id, category, result, entry, pts, note)
    select pk.id, r.category, r.result, r.entry, r.pts, r.note
    from jsonb_populate_recordset(null::public.music_grammys, p_rows) r
    cross join (select id from public.picks where id::text = p_pick_id) pk;

  elsif p_table = 'event_majors' then
    delete from public.event_majors where pick_id::text = p_pick_id;
    insert into public.event_majors (pick_id, event_name, result, opponent, score, pts, note, event_order)
    select pk.id, r.event_name, r.result, r.opponent, r.score, r.pts, r.note, r.event_order
    from jsonb_populate_recordset(null::public.event_majors, p_rows) r
    cross join (select id from public.picks where id::text = p_pick_id) pk;

  else
    raise exception 'Unsupported table %', p_table;
  end if;

  get diagnostics v_count = row_count;
  return v_count;
end;
$func$;

revoke all on function public.replace_pick_detail_rows(text, text, jsonb, jsonb) from public;
grant execute on function public.replace_pick_detail_rows(text, text, jsonb, jsonb) to authenticated;
