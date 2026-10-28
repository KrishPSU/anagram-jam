-- Anagram Jam's Supabase database: solo mode (runs being played and the leaderboard) and the admin page (settings,
-- logs, sign-in counters and stats). Rooms stay in Redis.
--
-- Supabase's GitHub integration applies it on a push to main. It can also be pasted into the project's SQL editor:
-- running it more than once is safe - it only adds what isn't there yet, and replaces the functions with these versions.
--
-- Only the server reads and writes any of this, with the project's secret (service_role) key. Every table has row level
-- security on and no policies, and the functions can only be called with that key, so the public (anon) key - which
-- is never used - can't read or change anything.
--
-- Things that have to happen in one step (a score going in only if it's the player's best, a sign-in try being
-- counted) are functions, called through the API's /rpc. Old rows are cleared out by the functions that add new ones,
-- so nothing needs scheduling.


-- ---------- Solo: runs ----------

-- A run while it's being played: its words, so the answers sent at the end can be checked, and then its result, so
-- asking again gets the same reply. Gone 15 minutes after it was last saved (see RUN_TTL in data.js).
create table if not exists solo_runs (
  id text primary key,
  run jsonb not null,
  expires_at timestamptz not null
);
create index if not exists solo_runs_expires_at on solo_runs (expires_at);

-- Puts a new run in unless there's already one with its id (the page asked twice). Returns whether it did.
create or replace function create_solo_run(p_id text, p_run jsonb, p_ttl_ms bigint) returns boolean
language plpgsql set search_path = public as $$
begin
  delete from solo_runs where expires_at <= now();
  insert into solo_runs (id, run, expires_at) values (p_id, p_run, now() + p_ttl_ms * interval '1 millisecond')
    on conflict (id) do nothing;
  return found;
end $$;

-- The run, unless it's expired
create or replace function get_solo_run(p_id text) returns jsonb
language sql stable set search_path = public as $$
  select run from solo_runs where id = p_id and expires_at > now();
$$;

create or replace function save_solo_run(p_id text, p_run jsonb, p_ttl_ms bigint) returns void
language sql set search_path = public as $$
  insert into solo_runs (id, run, expires_at) values (p_id, p_run, now() + p_ttl_ms * interval '1 millisecond')
    on conflict (id) do update set run = excluded.run, expires_at = excluded.expires_at;
$$;


-- ---------- Solo: the leaderboard ----------

-- Every player's best. score is one number, higher is better: solo.js packs the points and the time into it (see
-- scoreKey there), at most about 1.2e15, so it's exact both here and in JavaScript.
create table if not exists solo_scores (
  player_id text primary key,  -- the hash of the player's browser token
  score bigint not null,
  name text not null default '',  -- their name as typed, the latest one
  words int,                      -- how many words their best got (none for bests from when runs were a minute long)
  updated_at timestamptz not null default now()
);
create index if not exists solo_scores_by_score on solo_scores (score desc, player_id desc);

-- The first p_top players and where p_player_id stands, as
-- { total, rank (0 = top, null if they're not on it), best, words, top: [{ id, score, name, words }] }.
-- Equal scores go in the same order Redis kept them (player id, last first).
create or replace function solo_standings(p_top int, p_player_id text) returns jsonb
language sql stable set search_path = public as $$
  with me as (select score, words from solo_scores where player_id = p_player_id)
  select jsonb_build_object(
    'total', (select count(*) from solo_scores),
    'rank', (select (select count(*) from solo_scores s
                     where s.score > me.score or (s.score = me.score and s.player_id > p_player_id)) from me),
    'best', (select score from me),
    'words', (select words from me),
    'top', coalesce((select jsonb_agg(jsonb_build_object('id', player_id, 'score', score, 'name', name, 'words', words)
                                      order by score desc, player_id desc)
                     from (select * from solo_scores order by score desc, player_id desc limit greatest(p_top, 0)) t),
                    '[]'::jsonb));
$$;

-- A player's score goes in (with its words) if it beats their best, and their name is updated either way. Returns
-- where everyone stands, as solo_standings, plus before (their best until now, or null) and lower (how many players
-- have a score under p_below).
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
  return solo_standings(p_top, p_player_id)
    || jsonb_build_object('before', v_before, 'lower', (select count(*) from solo_scores where score < p_below));
end $$;

-- Takes a player off the leaderboard. Returns whether they were on it.
create or replace function remove_solo_score(p_player_id text) returns boolean
language plpgsql set search_path = public as $$
begin
  delete from solo_scores where player_id = p_player_id;
  return found;
end $$;


-- ---------- Admin: settings ----------

-- One row: the home page's banner, whether new games are paused, and since when sessions count (sign out everywhere)
create table if not exists admin_settings (
  id boolean primary key default true check (id),
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create or replace function get_admin_settings() returns jsonb
language sql stable set search_path = public as $$
  select value from admin_settings where id;
$$;

create or replace function save_admin_settings(p_value jsonb) returns void
language sql set search_path = public as $$
  insert into admin_settings (id, value) values (true, p_value)
    on conflict (id) do update set value = excluded.value, updated_at = now();
$$;


-- ---------- Admin: logs ----------

-- Two logs: 'game' (rounds and solo runs) and 'security' (sign-ins, and what was done on the dashboard). entry is what
-- admin.js logged, and at is its time (entry.at, in ms) - the order the logs are read in, so entries brought over from
-- Redis later still go where they happened.
create table if not exists admin_logs (
  id bigint generated always as identity primary key,
  log text not null,
  at timestamptz not null default now(),
  entry jsonb not null
);
create index if not exists admin_logs_by_log on admin_logs (log, at desc, id desc);

-- Adds an entry to log p_log, keeping its newest p_keep
create or replace function add_admin_log(p_log text, p_entry jsonb, p_keep int) returns void
language plpgsql set search_path = public as $$
begin
  insert into admin_logs (log, at, entry)
    values (p_log, coalesce(to_timestamp((p_entry->>'at')::double precision / 1000), now()), p_entry);
  delete from admin_logs where log = p_log and (at, id) <= (
    select at, id from admin_logs where log = p_log order by at desc, id desc offset greatest(p_keep, 1) limit 1);
end $$;

-- The newest p_count entries of log p_log, newest first
create or replace function admin_log_entries(p_log text, p_count int) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(entry order by at desc, id desc), '[]'::jsonb)
  from (select id, at, entry from admin_logs where log = p_log order by at desc, id desc limit greatest(p_count, 0)) t;
$$;


-- ---------- Admin: sign-in counters ----------

-- Tries at signing in, counted per address and for everyone together, each over a window that starts with its first try
create table if not exists admin_counters (
  name text primary key,
  tries int not null,
  resets_at timestamptz not null
);

-- One more try against p_name, starting a window of p_window_ms if there isn't one going.
-- Returns { count: the tries so far this window, resetsIn: ms until it starts again from nothing }.
create or replace function bump_admin_counter(p_name text, p_window_ms bigint) returns jsonb
language plpgsql set search_path = public as $$
declare
  v admin_counters;
begin
  delete from admin_counters where resets_at <= now();
  insert into admin_counters (name, tries, resets_at) values (p_name, 1, now() + p_window_ms * interval '1 millisecond')
    on conflict (name) do update set tries = admin_counters.tries + 1
    returning * into v;
  return jsonb_build_object('count', v.tries,
                            'resetsIn', greatest(0, floor(extract(epoch from v.resets_at - now()) * 1000))::bigint);
end $$;

-- Where each of p_names stands, as bump_admin_counter returns it ({ count: 0, resetsIn: 0 } for one with no window going),
-- in the same order
create or replace function peek_admin_counters(p_names text[]) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(
    case when c.name is null then jsonb_build_object('count', 0, 'resetsIn', 0)
         else jsonb_build_object('count', c.tries,
                                 'resetsIn', greatest(0, floor(extract(epoch from c.resets_at - now()) * 1000))::bigint)
    end order by n.i), '[]'::jsonb)
  from unnest(p_names) with ordinality n(name, i)
  left join admin_counters c on c.name = n.name and c.resets_at > now();
$$;


-- ---------- Stats ----------

-- How many rooms were made, rounds started and solo runs played each UTC hour (the admin page adds them up into days in
-- its own time zone). Kept for about a year.
create table if not exists stats_hourly (
  hour timestamptz not null,  -- the start of the UTC hour
  metric text not null,       -- 'rooms', 'rounds' or 'solo'
  count int not null default 0,
  primary key (hour, metric)
);

-- Who played each hour, to count different players over a day or a month. Kept for 35 days.
create table if not exists stats_players (
  hour timestamptz not null,
  player_id text not null,  -- the hash of the player's browser token, as on the leaderboard
  primary key (hour, player_id)
);

-- One more of p_metric in the hour of p_at, and the players who were in it
create or replace function track_stat(p_metric text, p_player_ids text[], p_at timestamptz) returns void
language plpgsql set search_path = public as $$
begin
  insert into stats_hourly (hour, metric, count) values (date_trunc('hour', p_at, 'UTC'), p_metric, 1)
    on conflict (hour, metric) do update set count = stats_hourly.count + 1;
  insert into stats_players (hour, player_id)
    select distinct date_trunc('hour', p_at, 'UTC'), id from unnest(coalesce(p_player_ids, '{}')) id
    on conflict do nothing;
  delete from stats_hourly where hour < now() - interval '400 days';
  delete from stats_players where hour < now() - interval '35 days';
end $$;

-- The counts from p_from up to (not including) p_to, as [{ hour, metric, count }]
create or replace function stats_between(p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('hour', hour, 'metric', metric, 'count', count) order by hour), '[]'::jsonb)
  from stats_hourly where hour >= p_from and hour < p_to;
$$;

-- How many different players there were in each group of hours. p_groups: a list of lists of hours (timestamps).
-- Returns the counts in the same order.
create or replace function unique_players(p_groups jsonb) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(c.n order by g.i), '[]'::jsonb)
  from jsonb_array_elements(p_groups) with ordinality g(hours, i)
  cross join lateral (
    select count(distinct p.player_id) as n from stats_players p
    where p.hour in (select h::timestamptz from jsonb_array_elements_text(g.hours) h)
  ) c;
$$;


-- ---------- Who can touch it ----------

alter table solo_runs enable row level security;
alter table solo_scores enable row level security;
alter table admin_settings enable row level security;
alter table admin_logs enable row level security;
alter table admin_counters enable row level security;
alter table stats_hourly enable row level security;
alter table stats_players enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
