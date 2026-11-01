-- The admin page's Activity tab (see admin.js): its two logs a day at a time, and how many entries each day has, for
-- the tab's calendar. The logs are kept for 90 days now (and to their newest 90,000 entries each, see
-- add_admin_log_for) - each one kept only its newest 300 entries before, about three days of games.
--
-- Supabase's GitHub integration applies it on a push to main, and it can be pasted into the SQL Editor as well. Like
-- the other migrations, running it more than once is safe, and only the server can call any of it (see the end).
--
-- The server that's live while this is being applied keeps working: add_admin_log keeps its arguments, and only stops
-- cutting the log back to the newest entries it asks for (see the end). A server that goes out before this is applied
-- falls back to the functions from before (see the log functions in data.js).
--
-- The logs' index from the first migration, admin_logs_by_log (log, at desc, id desc), serves all of these: each one
-- reads or deletes a log's entries between two times, or from its newest down.


-- ---------- Adding to a log ----------

-- Adds an entry to log p_log at its own time (entry.at, in ms), and deletes the entries from more than p_keep_days ago -
-- of both logs, not just this one: the sign-ins log can go months with nothing added to it, and what it holds (where
-- each sign-in came from) mustn't be kept longer than the privacy page says. The days are 24 hours each, as data.js
-- counts them: an interval of days would go by the calendar of the session's time zone, 23 or 25 hours across a clock
-- change.
-- Now and then (about one write in a hundred - finding where to cut walks the log's index, too slow for every write)
-- the log is also cut back to its newest 90,000 entries, the most the Activity tab can show of 90 days (ACTIVITY_MAX a
-- day, see admin.js): every solo run is logged, and a script playing them as fast as it can mustn't grow it without end.
create or replace function add_admin_log_for(p_log text, p_entry jsonb, p_keep_days int) returns void
language plpgsql set search_path = public as $$
begin
  insert into admin_logs (log, at, entry)
    values (p_log, coalesce(to_timestamp((p_entry->>'at')::double precision / 1000), now()), p_entry);
  delete from admin_logs
    where log in (p_log, 'game', 'security') and at < now() - greatest(p_keep_days, 1) * interval '24 hours';
  if random() < 0.01 then
    delete from admin_logs where log = p_log and (at, id) <= (
      select at, id from admin_logs where log = p_log order by at desc, id desc offset 90000 limit 1);
  end if;
end $$;


-- ---------- Reading a log ----------

-- Log p_log's entries from p_from up to (not including) p_to, newest first: { entries: at most p_limit of them, more:
-- whether there were more }. The Activity tab asks for a day at a time.
create or replace function admin_log_between(p_log text, p_from timestamptz, p_to timestamptz, p_limit int)
returns jsonb
language sql stable set search_path = public as $$
  -- One more than asked for, to tell whether there were more
  with t as (
    select id, at, entry from admin_logs
    where log = p_log and at >= p_from and at < p_to
    order by at desc, id desc limit greatest(p_limit, 0)::bigint + 1
  )
  select jsonb_build_object(
    'entries', coalesce((select jsonb_agg(entry order by at desc, id desc)
                         from (select * from t order by at desc, id desc limit greatest(p_limit, 0)) e),
                        '[]'::jsonb),
    'more', (select count(*) > greatest(p_limit, 0) from t));
$$;

-- How many entries log p_log has on each day from p_from up to (not including) p_to, days being dates in time zone
-- p_tz (the admin's, 'America/New_York'): { '2026-10-25': 18, ... }, days with none left out. For the calendar's dots.
create or replace function admin_log_days(p_log text, p_from timestamptz, p_to timestamptz, p_tz text) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_object_agg(day, n), '{}'::jsonb)
  from (select to_char(at at time zone p_tz, 'YYYY-MM-DD') as day, count(*) as n
        from admin_logs where log = p_log and at >= p_from and at < p_to
        group by 1) d;
$$;


-- ---------- The shape from before this file ----------

-- As in the first migration, but keeping 90 days of the log, as add_admin_log_for does, rather than its newest p_keep
-- entries: the server that's live while this is being applied (and any instance still up from before it) adds its
-- entries through this one, asking for 300, and the log mustn't be cut back to those
create or replace function add_admin_log(p_log text, p_entry jsonb, p_keep int) returns void
language sql set search_path = public as $$
  select add_admin_log_for(p_log, p_entry, 90);
$$;


-- ---------- Who can touch it ----------

-- As in the other migrations: only the secret (service_role) key can read, write or call anything
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
