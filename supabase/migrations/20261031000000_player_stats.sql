-- Player stats (see profile.js): how each player has done in every mode, for the account box on the home page - and
-- the profile photo that box and its button show for a signed-in player.
--
-- Supabase's GitHub integration applies it on a push to main, and it can be pasted into the SQL Editor as well. Like
-- the other migrations, running it more than once is safe, and only the server can touch any of it (see the end).
--
-- Most of the stats are worked out from what's kept anyway - the solo leaderboard, Daily Jam's goes and streaks (see
-- player_profile). The rest are counted as they happen, in player_stats: solo runs (record_solo_play) and rounds played
-- in rooms (record_round). They're kept for everyone, signed in or not, under the same text id as the rest of a
-- player's things, so signing in adds what a browser had to the account's (link_account), as it does its scores.
-- Daily Jam's goes are deleted at 400 days; their numbers are folded into player_stats first (retire_daily_plays), so
-- a player's lifetime numbers stay whole.
--
-- The server that's live while this is being applied keeps working: everything it calls keeps its arguments, and
-- link_account's four-argument shape stays as a wrapper (see the end).


-- ---------- The profile photo ----------

-- The photo the provider gave, for the account button: Google's, an https address on a googleusercontent.com host
-- (account.js keeps nothing else), or '' for none - Apple gives none. Refreshed at each sign-in (see link_account).
alter table accounts add column if not exists avatar text not null default '';

-- The accounts from before this file get theirs from what Supabase Auth kept of the provider's reply - checked the way
-- account.js checks a new one. A Postgres that isn't Supabase's has no auth.users to read (or isn't allowed to): then
-- the photos come at each player's next sign-in instead, and this can't stop the rest of the file.
do $$
begin
  update accounts a set avatar = u.photo
  from (select id, coalesce(nullif(raw_user_meta_data->>'avatar_url', ''), raw_user_meta_data->>'picture') as photo
        from auth.users) u
  where u.id = a.id and a.avatar = ''
    and length(u.photo) <= 1000
    and u.photo ~* '^https://([a-z0-9-]+\.)*googleusercontent\.com/[^\s"''<>\\]*$';
exception when undefined_table or invalid_schema_name or insufficient_privilege then
  null;
end $$;

-- As in the accounts migration, now with the photo: { id, provider, name, avatar, devices }, or null if the browser
-- isn't signed in
create or replace function account_for_player(p_player_id text) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('id', a.id, 'provider', a.provider, 'name', a.name, 'avatar', a.avatar,
                            'devices', (select count(*) from player_links d where d.account_id = a.id))
  from player_links l join accounts a on a.id = l.account_id
  where l.player_id = p_player_id;
$$;


-- ---------- The stats ----------

-- One row per player id, as on solo_scores and daily_plays (an account's id as text, or the hash of a browser's
-- token), with what can't be worked out from anything else:
-- - first_at: when the row was made, or earlier if they're known to have played before that - their oldest Daily Jam
--   goes as they're folded in (see retire_daily_plays), or a leaderboard best from before this file (see the end)
-- - solo: runs, points, words and words got in under 3 seconds, counted from when this file went in; the longest answer
--   they've got (lowercase, '' for none); the highest place on the leaderboard they've reached (1 = top, null for
--   never); and their last 20 runs, oldest first, as [{ points, words, at (ms) }]
-- - rooms: rounds played, rounds won, top-3 finishes (see record_round), the most points in one round (null for none),
--   and words got
-- - daily_old: the Daily Jam numbers of their goes that are gone (see add_daily_old) - '{}' for none
-- - updated_at: when the player last added to it, for clearing out the rows of players long gone (see
--   clear_old_player_stats)
create table if not exists player_stats (
  player_id text primary key,
  first_at timestamptz not null default now(),
  solo_runs int not null default 0,
  solo_points int not null default 0,
  solo_words int not null default 0,
  solo_quick int not null default 0,
  solo_longest text not null default '',
  solo_best_rank int,
  solo_recent jsonb not null default '[]'::jsonb,
  room_rounds int not null default 0,
  room_wins int not null default 0,
  room_podiums int not null default 0,
  room_best int,
  room_words int not null default 0,
  daily_old jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists player_stats_by_updated on player_stats (updated_at);

-- A player's Daily Jam goes, all of them: their stats read them (daily_numbers, player_profile), and so does signing in
create index if not exists daily_plays_by_player on daily_plays (player_id, day);

-- Two lots of Daily Jam numbers added together - a player's live ones and the ones folded into daily_old, or two
-- players' as their rows are merged (see link_account). Each is
-- { days: days they finished at least one word, finished: words finished, got: words got, tries: how many they got on
--   try 1, 2 and 3, missed, perfect: days they got every word, hardFirstTry: hard words got on the first try, fastest:
--   { easy, medium, hard }: their fastest time to get each level's word (ms, null for none), bestFinish: their best
--   place on a day's board that's over (see player_profile), as { rank, day, players } (null for none) }
-- and anything missing counts as none ('{}' is no numbers at all). Counts are summed, each level's fastest is the
-- faster, and the best finish the better: the higher place, then the later day - a's on a tie.
create or replace function add_daily_old(a jsonb, b jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select (select jsonb_object_agg(k, coalesce((a->>k)::bigint, 0) + coalesce((b->>k)::bigint, 0))
          from unnest(array['days', 'finished', 'got', 'missed', 'perfect', 'hardFirstTry']) k)
    || jsonb_build_object(
      'tries', (select jsonb_agg(coalesce((a->'tries'->>i)::bigint, 0) + coalesce((b->'tries'->>i)::bigint, 0) order by i)
                from generate_series(0, 2) i),
      'fastest', (select jsonb_object_agg(l, least((a->'fastest'->>l)::bigint, (b->'fastest'->>l)::bigint))
                  from unnest(array['easy', 'medium', 'hard']) l),
      'bestFinish', (select f from (values (1, a->'bestFinish'), (2, b->'bestFinish')) v(i, f)
                     where jsonb_typeof(f) = 'object'
                     order by (f->>'rank')::int, f->>'day' desc, i limit 1));
$$;

-- A player's Daily Jam numbers over their finished goes from before p_before ('infinity' for all of them), as
-- add_daily_old has them - all but bestFinish, which takes everyone's goes (see player_profile and
-- retire_daily_plays). 3 tries a word, as daily.js has it.
create or replace function daily_numbers(p_player_id text, p_before date) returns jsonb
language sql stable set search_path = public as $$
  with plays as (
    select day, level, solved, ms, jsonb_array_length(guesses) + 1 as tries
    from daily_plays where player_id = p_player_id and day < p_before and solved is not null
  ), days as (
    select p.day, count(*) filter (where p.solved) as got,
           (select count(*) from daily_words w where w.day = p.day) as words
    from plays p group by p.day
  )
  select jsonb_build_object(
    'days', (select count(*) from days),
    'finished', (select count(*) from plays),
    'got', (select count(*) from plays where solved),
    'tries', (select jsonb_agg((select count(*) from plays where solved and tries = t) order by t)
              from generate_series(1, 3) t),
    'missed', (select count(*) from plays where not solved),
    'perfect', (select count(*) from days where got > 0 and got = words),
    'hardFirstTry', (select count(*) from plays where level = 'hard' and solved and tries = 1),
    'fastest', (select jsonb_object_agg(l, (select min(ms) from plays where level = l and solved))
                from unnest(array['easy', 'medium', 'hard']) l));
$$;

-- A row nobody has added to in 400 days goes, as their players row does (see touch_player) - unless it's an account's,
-- they're on the solo leaderboard, or they've been on the site since. Run by the functions that add to the table, so
-- nothing needs scheduling; it only looks at rows that old (player_stats_by_updated), so it costs next to nothing.
create or replace function clear_old_player_stats() returns void
language sql set search_path = public as $$
  delete from player_stats s
  where s.updated_at < now() - interval '400 days'
    and not exists (select 1 from solo_scores sc where sc.player_id = s.player_id)
    and not exists (select 1 from accounts a where a.id::text = s.player_id)
    and not exists (select 1 from players p where p.id = s.player_id and p.seen_at >= now() - interval '400 days');
$$;

-- A solo run, as it's scored: p_points and p_words (how many words it got), p_quick (how many in under 3 seconds),
-- p_longest (its longest answer, '' for none - kept if it's longer than their longest), and p_rank: their place on the
-- leaderboard after it (1 = top, null if they're not on it or it couldn't be had) - their best place is the higher of
-- that and the one before. The run joins their recent ones, the newest p_keep of which are kept.
create or replace function record_solo_play(p_player_id text, p_points int, p_words int, p_quick int, p_longest text,
                                            p_rank int, p_keep int) returns void
language plpgsql set search_path = public as $$
begin
  insert into player_stats (player_id) values (p_player_id) on conflict do nothing;
  update player_stats set
      solo_runs = solo_runs + 1,
      solo_points = solo_points + p_points,
      solo_words = solo_words + p_words,
      solo_quick = solo_quick + p_quick,
      solo_longest = case when length(coalesce(p_longest, '')) > length(solo_longest) then p_longest else solo_longest end,
      solo_best_rank = least(solo_best_rank, p_rank),
      solo_recent = (select coalesce(jsonb_agg(run order by i), '[]'::jsonb)
                     from (select run, i
                           from jsonb_array_elements(solo_recent || jsonb_build_array(jsonb_build_object(
                                  'points', p_points, 'words', p_words,
                                  'at', floor(extract(epoch from now()) * 1000)::bigint))) with ordinality e(run, i)
                           order by i desc limit greatest(p_keep, 0)) newest),
      updated_at = now()
    where player_id = p_player_id;
  perform clear_old_player_stats();
end $$;

-- A round played in a room, as it's over. p_players: [{ id, points, words, place, left }], one per player id, place
-- being where they finished (1 = won) and left whether they'd left the room by then. p_count: how many played it.
-- Everyone has played a round more; a win is a first place, and a top-3 finish (a podium) is a place from 1 to 3 that
-- isn't last - in a round of two only a win is one. Anyone who'd left gets neither.
create or replace function record_round(p_players jsonb, p_count int) returns void
language plpgsql set search_path = public as $$
begin
  insert into player_stats (player_id)
    select r.id from jsonb_to_recordset(p_players) as r(id text)
    on conflict do nothing;
  update player_stats s set
      room_rounds = s.room_rounds + 1,
      room_wins = s.room_wins + case when r.place = 1 and not coalesce(r."left", false) then 1 else 0 end,
      room_podiums = s.room_podiums
        + case when r.place <= 3 and r.place < p_count and not coalesce(r."left", false) then 1 else 0 end,
      room_best = greatest(s.room_best, r.points),
      room_words = s.room_words + coalesce(r.words, 0),
      updated_at = now()
    from jsonb_to_recordset(p_players) as r(id text, points int, words int, place int, "left" boolean)
    where s.player_id = r.id;
  perform clear_old_player_stats();
end $$;


-- ---------- Daily Jam's goes, as they go ----------

-- Daily Jam's goes from before p_before are deleted - but first each player's numbers from them (see daily_numbers),
-- and their best place on those days' boards (as daily_standings orders them), are folded into their daily_old, and
-- the earliest go into their first_at. A player with no row gets one, dated by those goes, so it's cleared out with the
-- rest of theirs if they're long gone (see clear_old_player_stats). One at a time, and never while a sign-in or an
-- account being deleted is moving or deleting goes (link_account and delete_account hold the same lock, shared): two
-- first goes of a new day folding the same goes at once would count them twice, and goes folded as they move would
-- end up under the wrong id - the browser's instead of its account's, or a deleted account's. The lock isn't waited
-- for: while it's held this fold is skipped, and a later new go makes it, so nobody's word is held up.
create or replace function retire_daily_plays(p_before date) returns void
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from daily_plays where day < p_before) then
    return;
  end if;
  if not pg_try_advisory_xact_lock(hashtext('retire daily_plays')) then
    return;
  end if;
  with places as (
    select d.day, s.player_id, s.rank, count(*) over (partition by d.day) as players
    from (select distinct day from daily_plays where day < p_before and solved is not null) d
    cross join lateral daily_standings(d.day) s
  ), finishes as (
    select distinct on (player_id) player_id, jsonb_build_object('rank', rank, 'day', day, 'players', players) as finish
    from places order by player_id, rank, day desc
  ), goes as (
    select player_id, min(opened_at) as first_at, max(opened_at) as last_at
    from daily_plays where day < p_before group by player_id
  )
  insert into player_stats (player_id, first_at, updated_at, daily_old)
    select g.player_id, g.first_at, g.last_at,
           add_daily_old(daily_numbers(g.player_id, p_before) || jsonb_build_object('bestFinish', f.finish), '{}'::jsonb)
    from goes g left join finishes f on f.player_id = g.player_id
    on conflict (player_id) do update set
      first_at = least(player_stats.first_at, excluded.first_at),
      daily_old = add_daily_old(player_stats.daily_old, excluded.daily_old);
  delete from daily_plays where day < p_before;
end $$;

-- As in the accounts migration, but the goes from over 400 days ago are folded into their players' stats as they go
-- (see retire_daily_plays)
create or replace function open_daily(p_day date, p_level text, p_player_id text, p_start boolean, p_name text) returns jsonb
language plpgsql set search_path = public as $$
declare
  p daily_plays;
begin
  if p_start then
    insert into daily_plays (day, level, player_id) values (p_day, p_level, p_player_id) on conflict do nothing;
    if found then
      perform retire_daily_plays(p_day - 400);
    end if;
    insert into players (id, name) values (p_player_id, coalesce(p_name, ''))
      on conflict (id) do update set name = excluded.name where excluded.name <> '';
  end if;
  select * into p from daily_plays where day = p_day and level = p_level and player_id = p_player_id;
  if not found then
    return null;
  end if;
  return daily_play_json(p);
end $$;


-- ---------- A player's stats ----------

-- Everything profile.js works a player's stats out from, as of p_day (their date):
-- { since: when they were first seen or first played (ms) - the earliest of their players row, their account, their
--     stats row and their Daily Jam goes - or null,
--   solo: { runs, points, words, quick, longest, bestRank, recent } as player_stats has them (0, '', null and [] with
--     no row), and standing: where they are on the leaderboard, as solo_standings has it (rank 0 = top), without top,
--   rooms: { rounds, wins, podiums, best, words }, likewise,
--   daily: their Daily Jam numbers, as add_daily_old has them - their goes' and daily_old's added together, the best
--     finish only from boards that are over (see finishes) - and calendar: every day they finished a word on, oldest
--     first, as [{ day, got, finished }], today: their place on p_day's board, as { rank (1 = top, null if they
--     haven't finished a word that day), players }, and streak: as daily_player_day has it }
create or replace function player_profile(p_player_id text, p_day date) returns jsonb
language sql stable set search_path = public as $$
  with mine as (
    select day, count(*) filter (where solved) as got, count(*) as finished
    from daily_plays where player_id = p_player_id and solved is not null group by day
  ), finishes as (
    -- Their place on each day's board that can't change any more, so a best finish (and the Daily champion award, see
    -- profile.js) isn't had and then lost as a board fills: a date is played somewhere in the world for about 50
    -- hours, a word opened then can still be finished for 24 hours once it's over everywhere (see isToday in daily.js),
    -- and p_day can be a day ahead of UTC's date (see dayFor in profile.js) - so the days more than 3 before p_day.
    -- today is the live place.
    -- Each board is ranked afresh on every ask, which costs the days they've played times each day's players; if that
    -- gets slow, rank each board once when it's over (from open_daily, as retire_daily_plays is run) and keep each
    -- player's best finish in player_stats for this to read.
    select m.day, b.rank, b.players
    from mine m cross join lateral (
      select d.player_id, d.rank, count(*) over () as players from daily_standings(m.day) d) b
    where b.player_id = p_player_id and m.day < p_day - 3
  )
  select jsonb_build_object(
    'since', (select floor(extract(epoch from min(t)) * 1000)::bigint
              from (select first_seen as t from players where id = p_player_id
                    union all select created_at from accounts where id::text = p_player_id
                    union all select first_at from player_stats where player_id = p_player_id
                    union all select opened_at from daily_plays where player_id = p_player_id) times),
    'solo', jsonb_build_object(
      'runs', coalesce(s.solo_runs, 0), 'points', coalesce(s.solo_points, 0), 'words', coalesce(s.solo_words, 0),
      'quick', coalesce(s.solo_quick, 0), 'longest', coalesce(s.solo_longest, ''), 'bestRank', s.solo_best_rank,
      'recent', coalesce(s.solo_recent, '[]'::jsonb),
      'standing', solo_standings(0, p_player_id, 0) - 'top'),
    'rooms', jsonb_build_object(
      'rounds', coalesce(s.room_rounds, 0), 'wins', coalesce(s.room_wins, 0), 'podiums', coalesce(s.room_podiums, 0),
      'best', s.room_best, 'words', coalesce(s.room_words, 0)),
    'daily', add_daily_old(
        daily_numbers(p_player_id, 'infinity')
          || jsonb_build_object('bestFinish', (select jsonb_build_object('rank', rank, 'day', day, 'players', players)
                                               from finishes order by rank, day desc limit 1)),
        coalesce(s.daily_old, '{}'::jsonb))
      || jsonb_build_object(
        'calendar', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'got', got, 'finished', finished)
                                               order by day)
                              from mine), '[]'::jsonb),
        'today', (select jsonb_build_object('rank', b->'rank', 'players', b->'total')
                  from daily_board(p_day, p_player_id, 0, 0) b),
        'streak', (select jsonb_build_object('lastDay', last_day, 'current', current, 'best', best)
                   from daily_streaks where player_id = p_player_id)))
  from (select 1) one left join player_stats s on s.player_id = p_player_id;
$$;


-- ---------- Accounts, with the photo and the stats ----------

-- As in the accounts migration, and also:
-- - p_avatar, the photo the provider gave (see account.js), replaces the account's - Google's addresses change - unless
--   it's '' (Apple gives none), which keeps it
-- - the browser's stats are added into the account's: counts summed, the higher best place, the longer longest word,
--   the higher best round, the earlier first_at, their 20 newest runs between them (RECENT_RUNS in profile.js) and
--   their Daily Jam numbers folded at 400 days together (see add_daily_old) - and the browser's row goes. Those are
--   totals, so a day both of them played that was folded before they were merged counts once for each - the goes
--   still kept are merged a word at a time instead, keeping the better go.
-- The four-argument one is made again at the end of this file, as a wrapper.
create or replace function link_account(p_player_id text, p_account_id uuid, p_provider text, p_name text,
                                        p_avatar text) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_acc text := p_account_id::text;
  v_name text;
  v_device solo_scores;
  v_mine solo_scores;
  v_play daily_plays;
  v_theirs daily_plays;
  v_device_streak daily_streaks;
  v_my_streak daily_streaks;
  v_last_day date;
  v_current int;
  v_longest int;
  v_device_player players;
  v_device_stats player_stats;
begin
  perform pg_advisory_xact_lock(hashtext('link ' || v_acc));
  -- And no 400-day fold of Daily Jam's goes while this moves them (see retire_daily_plays)
  perform pg_advisory_xact_lock_shared(hashtext('retire daily_plays'));

  insert into accounts (id, provider, name, avatar)
    values (p_account_id, p_provider, coalesce(p_name, ''), coalesce(p_avatar, ''))
    on conflict (id) do update set
      updated_at = now(),
      provider = excluded.provider,
      name = case when accounts.name = '' then excluded.name else accounts.name end,
      avatar = case when excluded.avatar <> '' then excluded.avatar else accounts.avatar end
    returning name into v_name;

  insert into player_links (player_id, account_id) values (p_player_id, p_account_id)
    on conflict (player_id) do update set account_id = excluded.account_id, linked_at = now();

  -- Nothing to move if the browser's id is the account's own (it can't be, but a merge of a row with itself would
  -- lose it)
  if p_player_id = v_acc then
    return account_for_player(p_player_id);
  end if;

  -- The solo leaderboard
  select * into v_device from solo_scores where player_id = p_player_id for update;
  if found then
    select * into v_mine from solo_scores where player_id = v_acc for update;
    if not found then
      update solo_scores set player_id = v_acc where player_id = p_player_id;
    else
      if v_device.score > v_mine.score then
        update solo_scores set score = v_device.score, words = v_device.words, updated_at = now() where player_id = v_acc;
      end if;
      delete from solo_scores where player_id = p_player_id;
    end if;
  end if;
  update solo_scores set name = v_name where player_id = v_acc and v_name <> '';

  -- Daily Jam's words, one at a time
  for v_play in select * from daily_plays where player_id = p_player_id loop
    select * into v_theirs from daily_plays
      where day = v_play.day and level = v_play.level and player_id = v_acc for update;
    if not found then
      update daily_plays set player_id = v_acc
        where day = v_play.day and level = v_play.level and player_id = p_player_id;
    elsif daily_play_beats(v_play, v_theirs) then
      delete from daily_plays where day = v_play.day and level = v_play.level and player_id = v_acc;
      update daily_plays set player_id = v_acc
        where day = v_play.day and level = v_play.level and player_id = p_player_id;
    else
      delete from daily_plays where day = v_play.day and level = v_play.level and player_id = p_player_id;
    end if;
  end loop;

  -- The streak, counted again from the days the account now has a finished word on: the run of days in a row ending
  -- at the latest of them is the current one, and the best is the longest run - or either row's old best, if that was
  -- higher (its days may be gone: plays are kept 400 days)
  select * into v_device_streak from daily_streaks where player_id = p_player_id;
  delete from daily_streaks where player_id = p_player_id;
  select * into v_my_streak from daily_streaks where player_id = v_acc for update;
  select max(last), max(len), (array_agg(len order by last desc))[1] into v_last_day, v_longest, v_current
  from (select count(*) as len, max(day) as last
        from (select day, day - (row_number() over (order by day))::int as run
              from (select distinct day from daily_plays where player_id = v_acc and solved is not null) days) runs
        group by run) lengths;
  if v_last_day is not null then
    insert into daily_streaks (player_id, last_day, current, best)
      values (v_acc, v_last_day, v_current,
              greatest(v_longest, coalesce(v_my_streak.best, 0), coalesce(v_device_streak.best, 0)))
      on conflict (player_id) do update set
        last_day = excluded.last_day, current = excluded.current, best = excluded.best;
  elsif v_my_streak.player_id is not null then
    -- No finished plays left, only the rows: the account's stands, with the best of both
    update daily_streaks set best = greatest(best, coalesce(v_device_streak.best, 0)) where player_id = v_acc;
  elsif v_device_streak.player_id is not null then
    insert into daily_streaks (player_id, last_day, current, best)
      values (v_acc, v_device_streak.last_day, v_device_streak.current, v_device_streak.best);
  end if;

  -- Who they are on the site: the browser's row becomes the account's if it has none, else they join
  select * into v_device_player from players where id = p_player_id;
  insert into players (id, name, mode, detail, since, seen_at, first_seen)
    values (v_acc, coalesce(nullif(v_name, ''), v_device_player.name, ''), v_device_player.mode,
            coalesce(v_device_player.detail, '{}'::jsonb), v_device_player.since,
            coalesce(v_device_player.seen_at, now()), coalesce(v_device_player.first_seen, now()))
    on conflict (id) do update set
      name = case when excluded.name <> '' then excluded.name else players.name end,
      first_seen = least(players.first_seen, excluded.first_seen);
  delete from players where id = p_player_id;

  -- Their stats: the browser's are added into the account's - into an empty row of its own if it has none yet, which
  -- comes out the same as the browser's
  select * into v_device_stats from player_stats where player_id = p_player_id for update;
  if found then
    insert into player_stats (player_id, first_at, updated_at)
      values (v_acc, v_device_stats.first_at, v_device_stats.updated_at)
      on conflict do nothing;
    update player_stats set
        first_at = least(first_at, v_device_stats.first_at),
        solo_runs = solo_runs + v_device_stats.solo_runs,
        solo_points = solo_points + v_device_stats.solo_points,
        solo_words = solo_words + v_device_stats.solo_words,
        solo_quick = solo_quick + v_device_stats.solo_quick,
        solo_longest = case when length(v_device_stats.solo_longest) > length(solo_longest)
                            then v_device_stats.solo_longest else solo_longest end,
        solo_best_rank = least(solo_best_rank, v_device_stats.solo_best_rank),
        -- Oldest first, by when they were played; two at the same moment go the account's first
        solo_recent = (select coalesce(jsonb_agg(run order by at, side, i), '[]'::jsonb)
                       from (select run, (run->>'at')::bigint as at, side, i
                             from (select run, 1 as side, i
                                   from jsonb_array_elements(player_stats.solo_recent) with ordinality e(run, i)
                                   union all
                                   select run, 2, i
                                   from jsonb_array_elements(v_device_stats.solo_recent) with ordinality e(run, i)) runs
                             order by at desc, side desc, i desc limit 20) newest),
        room_rounds = room_rounds + v_device_stats.room_rounds,
        room_wins = room_wins + v_device_stats.room_wins,
        room_podiums = room_podiums + v_device_stats.room_podiums,
        room_best = greatest(room_best, v_device_stats.room_best),
        room_words = room_words + v_device_stats.room_words,
        daily_old = add_daily_old(daily_old, v_device_stats.daily_old),
        updated_at = greatest(updated_at, v_device_stats.updated_at)
      where player_id = v_acc;
    delete from player_stats where player_id = p_player_id;
  end if;

  return account_for_player(p_player_id);
end $$;

-- As in the accounts migration, and the account's stats go too - with no 400-day fold of Daily Jam's goes meanwhile,
-- which could fold the account's goes into a stats row under its id again as they're deleted (see retire_daily_plays)
create or replace function delete_account(p_account_id uuid) returns void
language sql set search_path = public as $$
  select pg_advisory_xact_lock_shared(hashtext('retire daily_plays'));
  delete from solo_scores where player_id = p_account_id::text;
  delete from daily_plays where player_id = p_account_id::text;
  delete from daily_streaks where player_id = p_account_id::text;
  delete from player_stats where player_id = p_account_id::text;
  delete from players where id = p_account_id::text;
  delete from player_links where account_id = p_account_id;
  delete from accounts where id = p_account_id;
$$;


-- ---------- Stats from before this file ----------

-- Everyone on the solo leaderboard gets a row, with the place they hold now as the highest they've reached - from here
-- on record_solo_play keeps it - and first played no later than their best's run (its time is in the score, see
-- scoreKey in solo.js) or their row's last change, whichever was first
insert into player_stats (player_id, solo_best_rank, first_at)
  select player_id, row_number() over (order by score desc, player_id desc),
         least(updated_at, to_timestamp((9999999999999 - score % 10000000000000) / 1000.0))
  from solo_scores
  on conflict (player_id) do update set
    solo_best_rank = least(player_stats.solo_best_rank, excluded.solo_best_rank),
    first_at = least(player_stats.first_at, excluded.first_at);


-- ---------- The shapes from before this file ----------

-- Kept as a wrapper, as the accounts migration does with its own old shapes: the server that's live while this is
-- being applied (and any instance still up from before it) signs players in with the four-argument link_account, and
-- Supabase's API tells it apart from the five-argument one by its argument names, so both can stay for good. It merges
-- the stats too, and keeps the account's photo.
create or replace function link_account(p_player_id text, p_account_id uuid, p_provider text, p_name text) returns jsonb
language sql set search_path = public as $$
  select link_account(p_player_id, p_account_id, p_provider, p_name, '');
$$;


-- ---------- Who can touch it ----------

-- As in the other migrations: row level security on with no policies, and only the secret (service_role) key can
-- read, write or call anything
alter table player_stats enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
