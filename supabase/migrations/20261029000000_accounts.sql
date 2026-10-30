-- Accounts (see account.js): a player can sign in with Google or Apple, and then their scores, Daily Jam records and
-- streaks are kept under the account instead of under the browser they're in - so the 35 from the laptop and the 38 from
-- the phone are one row of 38 under their name. And who's on the site right now, for the admin page.
--
-- Supabase's GitHub integration applies it on a push to main. Like the other migrations, running it more than once is
-- safe, and only the server can touch any of it (see the end).
--
-- Who a row belongs to is the same text id everywhere (solo_scores, daily_plays, daily_streaks, stats_players, players):
-- the hash of the browser's token, as before, or the account's id as text once the browser is linked to one. Linking
-- is where the two meet: link_account moves the browser's history under the account, keeping the better of anything
-- they both have. Nothing else changes shape - a signed-in player is just one whose id happens to be a uuid.


-- ---------- Accounts ----------

-- One row per Supabase Auth user who has signed in. name: what they go by on the site - from the provider the first
-- time, then theirs to change ('' until they pick one, if the provider didn't say).
create table if not exists accounts (
  id uuid primary key,  -- the Supabase Auth user's id
  provider text not null,  -- 'google' or 'apple'
  name text not null default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
-- The ids come as text everywhere else (solo_scores.player_id and the like), so that's how they're looked up
create index if not exists accounts_by_text_id on accounts ((id::text));

-- Which browsers are signed in to which account. A browser is in at most one; signing out there just takes it off.
create table if not exists player_links (
  player_id text primary key,  -- the hash of the browser's token
  account_id uuid not null references accounts(id) on delete cascade,
  linked_at timestamptz default now()
);
create index if not exists player_links_by_account on player_links (account_id);

-- Everyone the site has seen lately, under the id their things are kept by, with the name to show for them (the
-- account's, else the last nickname they typed) and what they're doing right now - the pages send a heartbeat (see
-- touch_player). A row is kept while they have a score or an account, else about a year past their last visit.
create table if not exists players (
  id text primary key,  -- the account's id as text, or the hash of the browser's token
  name text not null default '',
  mode text,  -- 'home', 'solo', 'daily' or 'practice', null once they've left
  detail jsonb not null default '{}'::jsonb,  -- what the page said they're up to, as account.js keeps it small
  since timestamptz,  -- when they came onto this mode
  seen_at timestamptz not null default now(),
  first_seen timestamptz not null default now()
);
create index if not exists players_by_seen on players (seen_at);

-- The account a browser is signed in to, as { id, provider, name, devices: how many browsers are signed in to it },
-- or null if it isn't
create or replace function account_for_player(p_player_id text) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('id', a.id, 'provider', a.provider, 'name', a.name,
                            'devices', (select count(*) from player_links d where d.account_id = a.id))
  from player_links l join accounts a on a.id = l.account_id
  where l.player_id = p_player_id;
$$;

-- Whether go a at a Daily Jam word is the better of two by the same person (from two browsers, see link_account): a
-- finished one beats one still going, getting it beats missing it, then fewer tries, then faster. Equal goes aren't.
create or replace function daily_play_beats(a daily_plays, b daily_plays) returns boolean
language sql immutable set search_path = public as $$
  select (a.solved is not null, coalesce(a.solved, false), -jsonb_array_length(a.guesses), -coalesce(a.ms, 0))
       > (b.solved is not null, coalesce(b.solved, false), -jsonb_array_length(b.guesses), -coalesce(b.ms, 0));
$$;

-- Signs browser p_player_id in to account p_account_id (a Supabase Auth user, with the provider it came through and the
-- name the provider gave, '' if none), and moves the browser's history under the account:
-- - the solo leaderboard keeps the higher of the two bests (with its words), under the account's name if it has one
-- - each Daily Jam word keeps the better go (see daily_play_beats) - ties keep the account's
-- - the streak is counted again from the account's finished days, its best never lower than either was
-- - the players row keeps the earlier first visit, and the account's name (else the browser's last nickname)
-- A browser already signed in to another account moves to this one; its history is with the old account and stays
-- there. Two browsers of one account linking at once wait for each other. Returns account_for_player(p_player_id).
create or replace function link_account(p_player_id text, p_account_id uuid, p_provider text, p_name text) returns jsonb
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
begin
  perform pg_advisory_xact_lock(hashtext('link ' || v_acc));

  insert into accounts (id, provider, name) values (p_account_id, p_provider, coalesce(p_name, ''))
    on conflict (id) do update set
      updated_at = now(),
      provider = excluded.provider,
      name = case when accounts.name = '' then excluded.name else accounts.name end
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

  return account_for_player(p_player_id);
end $$;

-- Signs browser p_player_id out: it starts fresh, and the account keeps everything. Returns whether it was signed in.
create or replace function unlink_account(p_player_id text) returns boolean
language plpgsql set search_path = public as $$
begin
  delete from player_links where player_id = p_player_id;
  return found;
end $$;

-- The account's new name, everywhere it shows: the leaderboard and the players list keep their own copy
create or replace function rename_account(p_account_id uuid, p_name text) returns void
language sql set search_path = public as $$
  update accounts set name = p_name, updated_at = now() where id = p_account_id;
  update solo_scores set name = p_name where player_id = p_account_id::text;
  update players set name = p_name where id = p_account_id::text;
$$;

-- Deletes an account and everything kept under it (its browsers are signed out by the cascade). The server then deletes
-- the Supabase Auth user (see account.js).
create or replace function delete_account(p_account_id uuid) returns void
language sql set search_path = public as $$
  delete from solo_scores where player_id = p_account_id::text;
  delete from daily_plays where player_id = p_account_id::text;
  delete from daily_streaks where player_id = p_account_id::text;
  delete from players where id = p_account_id::text;
  delete from player_links where account_id = p_account_id;
  delete from accounts where id = p_account_id;
$$;


-- ---------- Who's on the site ----------

-- A page's heartbeat: player p_id is on p_mode ('home', 'solo', 'daily' or 'practice') doing p_detail, under p_name
-- (kept if '' - the account's name or the nickname, see account.js). 'gone' is the page being left: their mode is
-- cleared and they're dated a day back, so live_players drops them at once but the row stays. since only moves when
-- the mode changes, so the admin page can say how long they've been at it.
-- Rows nobody's touched in 400 days go, unless they're on the leaderboard or an account's.
create or replace function touch_player(p_id text, p_name text, p_mode text, p_detail jsonb) returns void
language plpgsql set search_path = public as $$
begin
  if p_mode = 'gone' then
    -- Leaving makes no row: someone never heard from (a made-up token) has nothing to mark as gone
    update players set
        name = case when coalesce(p_name, '') <> '' then p_name else name end,
        mode = null,
        seen_at = now() - interval '1 day'
      where id = p_id;
  else
    insert into players (id, name, mode, detail, since, seen_at)
      values (p_id, coalesce(p_name, ''), p_mode, coalesce(p_detail, '{}'::jsonb), now(), now())
      on conflict (id) do update set
        name = case when excluded.name <> '' then excluded.name else players.name end,
        mode = excluded.mode,
        detail = excluded.detail,
        since = case when players.mode is distinct from excluded.mode then now() else players.since end,
        seen_at = now();
  end if;
  delete from players p where p.seen_at < now() - interval '400 days'
    and not exists (select 1 from solo_scores s where s.player_id = p.id)
    and not exists (select 1 from accounts a where a.id::text = p.id);
end $$;

-- Everyone heard from in the last p_within_ms milliseconds who hasn't left, by mode and then by who came first:
-- [{ id, name, mode, detail, since, seenAt, account: the provider they signed in with, or null }] - at most 500 of them
-- (LIVE_MAX in data.js), so a script making up tokens can't make the admin page's list endless
create or replace function live_players(p_within_ms bigint) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'mode', p.mode, 'detail', p.detail, 'since', p.since, 'seenAt', p.seen_at,
      'account', a.provider) order by p.mode, p.since), '[]'::jsonb)
  from (select * from players
        where mode is not null and seen_at > now() - p_within_ms * interval '1 millisecond'
        order by mode, since limit 500) p
  left join accounts a on a.id::text = p.id;
$$;


-- ---------- Solo: the leaderboard, with accounts ----------

-- As before, but top is rows p_offset onward (the box shows the first ten, then more on request), and each row says
-- whether it's a signed-in player's (account: the provider, or null) - the box marks those.
-- The two-argument one is made again at the end of this file, as a wrapper, for the server that's live while this is
-- being applied; add_solo_score called it, and is made again below.
drop function if exists solo_standings(int, text);
create or replace function solo_standings(p_top int, p_player_id text, p_offset int) returns jsonb
language sql stable set search_path = public as $$
  with me as (select score, words from solo_scores where player_id = p_player_id)
  select jsonb_build_object(
    'total', (select count(*) from solo_scores),
    'rank', (select (select count(*) from solo_scores s
                     where s.score > me.score or (s.score = me.score and s.player_id > p_player_id)) from me),
    'best', (select score from me),
    'words', (select words from me),
    'top', coalesce((select jsonb_agg(jsonb_build_object('id', t.player_id, 'score', t.score, 'name', t.name,
                                                         'words', t.words, 'account', a.provider)
                                      order by t.score desc, t.player_id desc)
                     from (select * from solo_scores order by score desc, player_id desc
                           limit greatest(p_top, 0) offset greatest(p_offset, 0)) t
                     left join accounts a on a.id::text = t.player_id),
                    '[]'::jsonb));
$$;

-- As in the first migration, now also noting the player's name for the players list (only the name: their heartbeat
-- says what they're doing)
create or replace function add_solo_score(p_player_id text, p_score bigint, p_name text, p_words int, p_below bigint, p_top int)
returns jsonb
language plpgsql set search_path = public as $$
declare
  v_before bigint;
begin
  select score into v_before from solo_scores where player_id = p_player_id for update;
  insert into solo_scores (player_id, score, name, words) values (p_player_id, p_score, p_name, p_words)
    on conflict (player_id) do update set
      name = excluded.name,
      score = greatest(solo_scores.score, excluded.score),
      words = case when excluded.score > solo_scores.score then excluded.words else solo_scores.words end,
      updated_at = now();
  insert into players (id, name) values (p_player_id, coalesce(p_name, ''))
    on conflict (id) do update set name = excluded.name where excluded.name <> '';
  return solo_standings(p_top, p_player_id, 0)
    || jsonb_build_object('before', v_before, 'lower', (select count(*) from solo_scores where score < p_below));
end $$;


-- ---------- Daily Jam, with names ----------

-- As in the Daily Jam migration, now also noting the player's name (p_name, the account's or their nickname) for the
-- day's board and the players list when they start a word. The four-argument one is made again at the end of this
-- file, as a wrapper.
drop function if exists open_daily(date, text, text, boolean);
create or replace function open_daily(p_day date, p_level text, p_player_id text, p_start boolean, p_name text) returns jsonb
language plpgsql set search_path = public as $$
declare
  p daily_plays;
begin
  if p_start then
    insert into daily_plays (day, level, player_id) values (p_day, p_level, p_player_id) on conflict do nothing;
    if found then
      delete from daily_plays where day < p_day - 400;
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

-- How everyone who has finished a word of day p_day did, over all of its words: got (how many they got), tries and ms
-- (over the words they got), finished (how many they finished, got or not). Most got first, then fewest tries, then
-- fastest, then by id - someone who missed every word is on it, at the end.
create or replace function daily_standings(p_day date)
returns table (rank bigint, player_id text, got bigint, tries bigint, ms bigint, finished bigint)
language sql stable set search_path = public as $$
  select row_number() over (order by got desc, tries asc nulls last, ms asc nulls last, player_id), *
  from (select player_id,
               count(*) filter (where solved) as got,
               sum(jsonb_array_length(guesses) + 1) filter (where solved) as tries,
               sum(ms) filter (where solved)::bigint as ms,
               count(*) as finished
        from daily_plays where day = p_day and solved is not null group by player_id) done;
$$;

-- The day's board (see daily_standings): { total, rank (1 = top, null if p_player_id hasn't finished a word), you:
-- their row or null, top: rows p_offset to p_offset + p_top }, each row { rank, id, name, got, tries, ms, finished,
-- account } - name from players ('' if they've never been noted), account the provider or null.
create or replace function daily_board(p_day date, p_player_id text, p_top int, p_offset int) returns jsonb
language sql stable set search_path = public as $$
  with standings as (select * from daily_standings(p_day)),
  named as (
    select s.*, coalesce(p.name, '') as name, a.provider as account
    from standings s left join players p on p.id = s.player_id left join accounts a on a.id::text = s.player_id
  )
  select jsonb_build_object(
    'total', (select count(*) from standings),
    'rank', (select rank from standings where player_id = p_player_id),
    'you', (select jsonb_build_object('rank', rank, 'id', player_id, 'name', name, 'got', got, 'tries', tries, 'ms', ms,
                                      'finished', finished, 'account', account)
            from named where player_id = p_player_id),
    'top', coalesce((select jsonb_agg(jsonb_build_object('rank', rank, 'id', player_id, 'name', name, 'got', got,
                                                         'tries', tries, 'ms', ms, 'finished', finished, 'account', account)
                                      order by rank)
                     from (select * from named order by rank limit greatest(p_top, 0) offset greatest(p_offset, 0)) t),
                    '[]'::jsonb));
$$;

-- For the admin page: everyone who opened a word of day p_day, as [{ id, name, account, streak: { current, best,
-- lastDay } or null if they've never finished one, levels: { easy: { solved, tries, ms }, medium, hard } }] - a level
-- missing wasn't opened, solved null is still going. In the board's order, with those who've finished nothing last.
create or replace function daily_admin_players(p_day date) returns jsonb
language sql stable set search_path = public as $$
  with people as (
    select player_id,
           count(*) filter (where solved) as got,
           sum(jsonb_array_length(guesses) + 1) filter (where solved) as tries,
           sum(ms) filter (where solved)::bigint as ms,
           count(*) filter (where solved is not null) as finished
    from daily_plays where day = p_day group by player_id)
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', pe.player_id,
      'name', coalesce(pl.name, ''),
      'account', a.provider,
      'streak', (select jsonb_build_object('current', current, 'best', best, 'lastDay', last_day)
                 from daily_streaks s where s.player_id = pe.player_id),
      -- tries: the wrong ones and, if they got it, the one that did - so a missed word shows its 3, as the page counts them
      'levels', (select jsonb_object_agg(level, jsonb_build_object('solved', solved, 'tries', jsonb_array_length(guesses) + case when solved then 1 else 0 end, 'ms', ms))
                 from daily_plays d where d.day = p_day and d.player_id = pe.player_id)
    ) order by pe.finished > 0 desc, pe.got desc, pe.tries asc nulls last, pe.ms asc nulls last, pe.player_id), '[]'::jsonb)
  from people pe left join players pl on pl.id = pe.player_id left join accounts a on a.id::text = pe.player_id;
$$;


-- ---------- The shapes from before this file ----------

-- Kept as wrappers, so the server that's live while this is being applied (and any instance still up from before it)
-- keeps answering: solo_standings without an offset, and open_daily without a name. Supabase's API tells them apart
-- from the ones above by their argument names, so both can stay for good.
create or replace function solo_standings(p_top int, p_player_id text) returns jsonb
language sql stable set search_path = public as $$
  select solo_standings(p_top, p_player_id, 0);
$$;

create or replace function open_daily(p_day date, p_level text, p_player_id text, p_start boolean) returns jsonb
language sql set search_path = public as $$
  select open_daily(p_day, p_level, p_player_id, p_start, '');
$$;


-- ---------- Who can touch it ----------

-- As in the other migrations: row level security on with no policies, and only the secret (service_role) key can
-- read, write or call anything
alter table accounts enable row level security;
alter table player_links enable row level security;
alter table players enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
