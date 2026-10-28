-- The admin page's Daily Jam tab (see admin.js and daily.js): how each day's words went, and players' streaks. It only
-- reads what Daily Jam keeps (20261028120000_daily_jam.sql).
--
-- Supabase's GitHub integration applies it on a push to main. Like the other migrations, running it more than once is
-- safe, and only the server can call it (see the end).


-- How day p_day went: players (who opened at least one of its words), finished (who finished at least one), allDone
-- (who finished every one), allGot (who got every one), and each word as
-- { level, word, scramble, opened, playing: opened but not finished, got: how many got it on try 1, 2, ... p_tries,
--   missed, median and fastest: times of those who got it (ms, null if nobody has), wrong: the p_top wrong tries made
--   most, as [{ guess, count }], others: the real words other than the day's that people got it with, as
--   [{ answer, count }] }
-- Its words are only picked when the first player opens the day, so until then levels is empty.
create or replace function daily_admin_day(p_day date, p_tries int, p_top int) returns jsonb
language sql stable set search_path = public as $$
  with plays as (
    select level, player_id, solved, ms, guesses, answer, jsonb_array_length(guesses) + 1 as tries
    from daily_plays where day = p_day
  ), words as (
    select * from daily_words where day = p_day
  ), people as (
    select player_id, count(*) filter (where solved is not null) as done, count(*) filter (where solved) as got
    from plays group by player_id
  )
  select jsonb_build_object(
    'players', (select count(*) from people),
    'finished', (select count(*) from people where done > 0),
    'allDone', (select count(*) from people where done = (select count(*) from words)),
    'allGot', (select count(*) from people where got = (select count(*) from words)),
    'levels', coalesce((select jsonb_agg(jsonb_build_object(
        'level', w.level,
        'word', w.word,
        'scramble', w.scramble,
        'opened', (select count(*) from plays p where p.level = w.level),
        'playing', (select count(*) from plays p where p.level = w.level and p.solved is null),
        'got', (select jsonb_agg((select count(*) from plays p where p.level = w.level and p.solved and p.tries = t)
                                 order by t)
                from generate_series(1, p_tries) t),
        'missed', (select count(*) from plays p where p.level = w.level and not p.solved),
        'median', (select round(percentile_cont(0.5) within group (order by ms))::bigint
                   from plays p where p.level = w.level and p.solved),
        'fastest', (select min(ms) from plays p where p.level = w.level and p.solved),
        'wrong', coalesce((select jsonb_agg(jsonb_build_object('guess', guess, 'count', n) order by n desc, guess)
                           from (select g as guess, count(*) as n
                                 from plays p, jsonb_array_elements_text(p.guesses) g
                                 where p.level = w.level
                                 group by g order by n desc, g limit greatest(p_top, 0)) t), '[]'::jsonb),
        'others', coalesce((select jsonb_agg(jsonb_build_object('answer', answer, 'count', n) order by n desc, answer)
                            from (select answer, count(*) as n from plays p
                                  where p.level = w.level and p.solved and p.answer <> w.word
                                  group by answer) t), '[]'::jsonb)
      ) order by length(w.word)) from words w), '[]'::jsonb));
$$;

-- Each day from p_from to p_to, newest first, that has words: { day, players (who opened at least one word),
-- levels: [{ level, word, opened, finished, got }] }. And streaks as of p_to: going (players whose streak is still on:
-- they finished a word on p_to or the day before), longest (the longest of those), best (the longest anyone's ever
-- had) and ever (players who've ever finished a word).
create or replace function daily_admin_days(p_from date, p_to date) returns jsonb
language sql stable set search_path = public as $$
  with counts as (
    select day, level, count(*) as opened, count(*) filter (where solved is not null) as finished,
           count(*) filter (where solved) as got
    from daily_plays where day between p_from and p_to group by day, level
  ), players as (
    select day, count(distinct player_id) as n from daily_plays where day between p_from and p_to group by day
  )
  select jsonb_build_object(
    'days', coalesce((select jsonb_agg(jsonb_build_object(
        'day', d.day,
        'players', coalesce((select n from players where players.day = d.day), 0),
        'levels', (select jsonb_agg(jsonb_build_object(
                       'level', w.level, 'word', w.word,
                       'opened', coalesce(c.opened, 0), 'finished', coalesce(c.finished, 0), 'got', coalesce(c.got, 0))
                     order by length(w.word))
                   from daily_words w left join counts c on c.day = w.day and c.level = w.level
                   where w.day = d.day)
      ) order by d.day desc)
      from (select distinct day from daily_words where day between p_from and p_to) d), '[]'::jsonb),
    'streaks', (select jsonb_build_object(
        'going', count(*) filter (where last_day >= p_to - 1),
        'longest', coalesce(max(current) filter (where last_day >= p_to - 1), 0),
        'best', coalesce(max(best), 0),
        'ever', count(*))
      from daily_streaks));
$$;


-- ---------- Who can touch it ----------

-- As in the other migrations: only the secret (service_role) key can call these
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
