-- Daily Jam (see daily.js): every day's three words, how each player did on them, and their streaks.
--
-- Supabase's GitHub integration applies it on a push to main. Like the first migration, running it more than once is
-- safe, and only the server can touch any of it (see the end).
--
-- A day is a date as players have it where they are - the words change at their own midnight - so one day's words are
-- in play for about two days around the world. The times are all the database's own (now()), so every server instance
-- times players the same.


-- ---------- The words ----------

-- Every day's words, kept for good: they're the record that keeps a word from coming up again within a year.
-- level: 'easy', 'medium' or 'hard' (5, 7 and 9 letters). scramble: the letters as everyone gets them that day.
create table if not exists daily_words (
  day date not null,
  level text not null,
  word text not null,
  scramble text not null,
  primary key (day, level)
);
create index if not exists daily_words_by_word on daily_words (word, day);

-- A day's words as [{ level, word, scramble }] - none until the first player of the day asks for them
create or replace function daily_words_for(p_day date) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('level', level, 'word', word, 'scramble', scramble) order by level), '[]'::jsonb)
  from daily_words where day = p_day;
$$;

-- The words used fewer than p_gap days before or after p_day - the ones it can't have
create or replace function daily_words_near(p_day date, p_gap int) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(word), '[]'::jsonb) from daily_words where day > p_day - p_gap and day < p_day + p_gap;
$$;

-- Puts in the words daily.js picked for a day, p_words: [{ level, word, scramble }]. Each goes in only if that level of
-- the day has no word yet (another server instance may have just picked the day too), and if the word hasn't been used
-- fewer than p_gap days from it. Days are picked one at a time, so two days being picked at once can't both take the
-- same word. Returns the day's words, as daily_words_for has them - whichever were picked first.
create or replace function add_daily_words(p_day date, p_words jsonb, p_gap int) returns jsonb
language plpgsql set search_path = public as $$
declare
  v jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('daily_words'));
  for v in select * from jsonb_array_elements(p_words) loop
    insert into daily_words (day, level, word, scramble)
      select p_day, v->>'level', v->>'word', v->>'scramble'
      where not exists (select 1 from daily_words
                        where word = v->>'word' and day > p_day - p_gap and day < p_day + p_gap)
      on conflict (day, level) do nothing;
  end loop;
  return daily_words_for(p_day);
end $$;


-- ---------- How players did ----------

-- Each player's go at each of a day's words, from the moment they open it - their clock starts then, and opening it
-- again carries on from where they were. guesses: their wrong tries, in order. solved: null while they're still on it,
-- then whether they got it. answer: what they got it with (the word, or another real word with all its letters).
-- ms: how long from opening it to getting it, or to running out of tries. Kept for 400 days.
create table if not exists daily_plays (
  day date not null,
  level text not null,
  player_id text not null,  -- the hash of the player's browser token, as on the solo leaderboard
  opened_at timestamptz not null default now(),
  guesses jsonb not null default '[]'::jsonb,
  solved boolean,
  answer text,
  ms bigint,
  primary key (day, level, player_id)
);

-- A go as the server has it: { level, guesses, solved, answer, ms, elapsed: ms since they opened it, word: the day's
-- word for that level once they've finished (never before) }
create or replace function daily_play_json(p daily_plays) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'level', p.level, 'guesses', p.guesses, 'solved', p.solved, 'answer', p.answer, 'ms', p.ms,
    'elapsed', floor(extract(epoch from now() - p.opened_at) * 1000)::bigint,
    'word', case when p.solved is not null
                 then (select word from daily_words w where w.day = p.day and w.level = p.level) end);
$$;

-- Each player's streak: how many days in a row they've finished at least one of the day's words, and their longest.
-- last_day: the latest day they finished one. A streak whose last day is before the day before today is over
-- (daily.js shows it as 0).
create table if not exists daily_streaks (
  player_id text primary key,
  last_day date not null,
  current int not null,
  best int not null
);

-- Counts p_day toward the player's streak. A second word finished the same day changes nothing.
create or replace function count_daily_streak(p_player_id text, p_day date) returns void
language sql set search_path = public as $$
  insert into daily_streaks (player_id, last_day, current, best) values (p_player_id, p_day, 1, 1)
    on conflict (player_id) do update set
      current = case when daily_streaks.last_day >= p_day then daily_streaks.current
                     when daily_streaks.last_day = p_day - 1 then daily_streaks.current + 1
                     else 1 end,
      best = greatest(daily_streaks.best,
                      case when daily_streaks.last_day >= p_day then daily_streaks.current
                           when daily_streaks.last_day = p_day - 1 then daily_streaks.current + 1
                           else 1 end),
      last_day = greatest(daily_streaks.last_day, p_day);
$$;

-- Opens a level of the day for a player (starting their clock, unless it's going already) and returns their go, as
-- daily_play_json has it. p_start false only looks, for while new games are paused from the admin page: then it's null
-- if they hadn't opened it before.
create or replace function open_daily(p_day date, p_level text, p_player_id text, p_start boolean) returns jsonb
language plpgsql set search_path = public as $$
declare
  p daily_plays;
begin
  if p_start then
    insert into daily_plays (day, level, player_id) values (p_day, p_level, p_player_id) on conflict do nothing;
    if found then
      delete from daily_plays where day < p_day - 400;
    end if;
  end if;
  select * into p from daily_plays where day = p_day and level = p_level and player_id = p_player_id;
  if not found then
    return null;
  end if;
  return daily_play_json(p);
end $$;

-- A try at a level the player has opened. p_try: which try it is (1 for their first), so one sent twice (the reply got
-- lost) counts once. p_right: whether it's the word or another real word with all its letters (daily.js checks).
-- A wrong one they've tried already doesn't count again, and the p_tries-th wrong one is the end of it. Finishing
-- counts toward their streak.
-- Returns their go, as daily_play_json has it, or null if they haven't opened the level.
create or replace function guess_daily(p_day date, p_level text, p_player_id text, p_try int, p_guess text,
                                       p_right boolean, p_tries int) returns jsonb
language plpgsql set search_path = public as $$
declare
  p daily_plays;
  v_ms bigint;
begin
  select * into p from daily_plays where day = p_day and level = p_level and player_id = p_player_id for update;
  if not found then
    return null;
  end if;
  if p.solved is null and p_try = jsonb_array_length(p.guesses) + 1 and not (p.guesses ? p_guess) then
    v_ms := floor(extract(epoch from now() - p.opened_at) * 1000)::bigint;
    if p_right then
      update daily_plays set solved = true, answer = p_guess, ms = v_ms
        where day = p_day and level = p_level and player_id = p_player_id returning * into p;
    elsif p_try >= p_tries then
      update daily_plays set guesses = guesses || to_jsonb(p_guess), solved = false, ms = v_ms
        where day = p_day and level = p_level and player_id = p_player_id returning * into p;
    else
      update daily_plays set guesses = guesses || to_jsonb(p_guess)
        where day = p_day and level = p_level and player_id = p_player_id returning * into p;
    end if;
    if p.solved is not null then
      perform count_daily_streak(p_player_id, p_day);
    end if;
  end if;
  return daily_play_json(p);
end $$;

-- A player's day: their go at each level they've opened (as daily_play_json has it), and their streak as
-- { lastDay, current, best } (null if they've never finished one)
create or replace function daily_player_day(p_day date, p_player_id text) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'plays', coalesce((select jsonb_agg(daily_play_json(p)) from daily_plays p
                       where p.day = p_day and p.player_id = p_player_id), '[]'::jsonb),
    'streak', (select jsonb_build_object('lastDay', last_day, 'current', current, 'best', best)
               from daily_streaks where player_id = p_player_id));
$$;

-- How everyone who has finished a level of the day did, and where p_player_id's go puts them:
-- { players: how many have finished it, got: how many got it on try 1, 2, ... p_tries, missed: how many ran out of
--   tries, median: the middle time of those who got it (ms, null if nobody has), solved: whether p_player_id got it
--   (null if they haven't finished it), behind: how many of the others did worse than them - fewer tries is better,
--   then a faster time (0 unless they got it), streak: theirs, as daily_player_day has it }
create or replace function daily_stats(p_day date, p_level text, p_player_id text, p_tries int) returns jsonb
language sql stable set search_path = public as $$
  with done as (
    select player_id, solved, ms, jsonb_array_length(guesses) + 1 as tries from daily_plays
    where day = p_day and level = p_level and solved is not null
  ), me as (
    select * from done where player_id = p_player_id and solved
  )
  select jsonb_build_object(
    'players', (select count(*) from done),
    'got', (select jsonb_agg((select count(*) from done where solved and tries = t) order by t)
            from generate_series(1, p_tries) t),
    'missed', (select count(*) from done where not solved),
    'median', (select round(percentile_cont(0.5) within group (order by ms))::bigint from done where solved),
    'solved', (select solved from done where player_id = p_player_id),
    'behind', (select count(*) from done d, me
               where d.player_id <> me.player_id
                 and (not d.solved or d.tries > me.tries or (d.tries = me.tries and d.ms > me.ms))),
    'streak', (select jsonb_build_object('lastDay', last_day, 'current', current, 'best', best)
               from daily_streaks where player_id = p_player_id));
$$;


-- ---------- Who can touch it ----------

-- As in the first migration: row level security on with no policies, and only the secret (service_role) key can
-- read, write or call anything
alter table daily_words enable row level security;
alter table daily_plays enable row level security;
alter table daily_streaks enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
