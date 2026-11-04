-- Reminders (see push.js): the devices that asked for push notifications, and the job that sends them every hour.
--
-- It can be pasted into the SQL Editor. Like the other migrations, running it more than once is safe, and only the
-- server can touch any of it (see the end). The live server keeps working while it's applied, and a server that's
-- ahead of it only finds it can't save a device yet.
--
-- The job needs one thing this file can't hold, because it's a secret and this file is in git. Once, in the SQL Editor,
-- with the same value as PUSH_SEND_SECRET on the server (see SETUP-PUSH.md):
--   select vault.create_secret('<the secret>', 'push_send_secret');
-- Until then the job runs and the site turns it away.


-- ---------- The devices ----------

-- One row for each browser or app that has reminders on, by its device id (the hash of its token, as in player_links).
-- Whose plays count for it goes by that link when it's sent, so signing in or out doesn't need to touch this.
-- kind: 'apns' (the iPhone app) or 'web'. address: its device token, or its web push address. keys: a web push address's
-- { p256dh, auth }, and nothing for the app. time_zone: where the device is, by name, so the clocks changing is handled.
-- hour: when it wants reminding there (24-hour clock). daily, solo: which reminders it wants.
-- last_day: the last day, where it is, that it was sent one - never more than one a day. last_solo_day: and solo's.
-- seen_at: when it last opened the game - it stops getting them after two weeks without (see QUIET_AFTER_DAYS in push.js).
create table if not exists push_devices (
  device_id text primary key,
  kind text not null,
  address text not null unique,
  keys jsonb not null default '{}'::jsonb,
  time_zone text not null,
  hour int not null,
  daily boolean not null,
  solo boolean not null,
  last_day date,
  last_solo_day date,
  seen_at timestamptz not null default now()
);

-- A device turning reminders on, changing them, or saying it's still around. An address is only one device's: a browser
-- that lost its token and made a new one is still the same phone, and shouldn't be reminded twice. Devices gone for
-- 400 days are cleared out here, as the other tables' old rows are by what adds to them.
create or replace function save_push_device(p_device_id text, p_kind text, p_address text, p_keys jsonb, p_time_zone text,
                                            p_hour int, p_daily boolean, p_solo boolean) returns void
language plpgsql set search_path = public as $$
begin
  delete from push_devices where seen_at < now() - interval '400 days';
  delete from push_devices where address = p_address and device_id <> p_device_id;
  insert into push_devices (device_id, kind, address, keys, time_zone, hour, daily, solo)
    values (p_device_id, p_kind, p_address, p_keys, p_time_zone, p_hour, p_daily, p_solo)
    on conflict (device_id) do update set
      kind = excluded.kind, address = excluded.address, keys = excluded.keys, time_zone = excluded.time_zone,
      hour = excluded.hour, daily = excluded.daily, solo = excluded.solo, seen_at = now();
end $$;

create or replace function remove_push_device(p_device_id text) returns void
language sql set search_path = public as $$
  delete from push_devices where device_id = p_device_id;
$$;

-- An address the push service says is gone (the app was deleted, say)
create or replace function remove_push_address(p_address text) returns void
language sql set search_path = public as $$
  delete from push_devices where address = p_address;
$$;


-- ---------- Sending ----------

-- The devices seen since p_since that want any reminder, as [{ deviceId, playerId, kind, address, keys, timeZone, hour,
-- daily, solo, lastDay, lastSoloDay }] - playerId being who their plays are under: their account, or the device itself
create or replace function push_devices_since(p_since timestamptz) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'deviceId', d.device_id, 'playerId', coalesce(l.account_id::text, d.device_id), 'kind', d.kind, 'address', d.address,
    'keys', d.keys, 'timeZone', d.time_zone, 'hour', d.hour, 'daily', d.daily, 'solo', d.solo, 'lastDay', d.last_day,
    'lastSoloDay', d.last_solo_day)), '[]'::jsonb)
  from push_devices d left join player_links l on l.player_id = d.device_id
  where d.seen_at >= p_since and (d.daily or d.solo);
$$;

-- What a reminder goes by, for each of p_players: [{ id, day }], as [{ id, day, played: they've opened a word of that
-- day's Daily Jam, streak: { lastDay, current, best } or null, soloBest: their leaderboard score or null, soloAt: their
-- last solo run (ms) or null }]
create or replace function push_players(p_players jsonb) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', w.id,
    'day', w.day,
    'played', exists (select 1 from daily_plays p where p.day = w.day and p.player_id = w.id),
    'streak', (select jsonb_build_object('lastDay', s.last_day, 'current', s.current, 'best', s.best)
               from daily_streaks s where s.player_id = w.id),
    'soloBest', (select s.score from solo_scores s where s.player_id = w.id),
    'soloAt', (select (s.solo_recent->-1->>'at')::bigint from player_stats s where s.player_id = w.id))), '[]'::jsonb)
  from jsonb_to_recordset(p_players) as w(id text, day date);
$$;

-- Marks each of p_claims: [{ deviceId, day, solo }] as reminded on its day, unless it has been already, and returns the
-- ids of those it did - the ones to send to. Two runs at once can't both get the same device.
create or replace function claim_push(p_claims jsonb) returns jsonb
language sql set search_path = public as $$
  with claimed as (
    update push_devices d set
        last_day = c.day,
        last_solo_day = case when c.solo then c.day else d.last_solo_day end
      from jsonb_to_recordset(p_claims) as c("deviceId" text, day date, solo boolean)
      where d.device_id = c."deviceId" and (d.last_day is null or d.last_day < c.day)
      returning d.device_id
  )
  select coalesce(jsonb_agg(device_id), '[]'::jsonb) from claimed;
$$;


-- ---------- The job ----------

-- On the hour, every hour (push.js works out who it's the hour for), the database calls the site. Scheduling it twice
-- only replaces it. A run can take a while with a lot of devices, and the site carries on with it either way.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule('send-push-reminders', '0 * * * *', $job$
  select net.http_post(
    url := 'https://www.anagramjam.com/push/send',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_send_secret'), '')),
    timeout_milliseconds := 120000);
$job$);


-- ---------- Who can touch it ----------

-- As in the first migration: row level security on with no policies, and only the secret (service_role) key can
-- read, write or call anything
alter table push_devices enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
