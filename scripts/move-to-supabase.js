// Brings solo mode's and the admin page's things over from Redis, where they were kept before data.js, into Supabase.
// Run it from this folder's parent right after the deploy that moved them, and again a few minutes later for any
// solo runs the old instances (still up for a few minutes) put on Redis's leaderboard:
//
//   node scripts/move-to-supabase.js        shows what it would bring over, and changes nothing
//   node scripts/move-to-supabase.js --go   brings it over
//
// It only reads from Redis. Anything already in Supabase from after the deploy is kept: a player's best stays the
// higher of the two (under their latest name), log entries go in by when they happened, and hourly counts are added
// together. Who played each hour can't come over - Redis only kept counts of them (HyperLogLogs), not the ids - so the
// Stats tab's player counts start from the deploy. Runs being played and sign-in counters are short-lived and stay
// behind. Once it's done, the security log has an entry saying so, and running it again only brings over the
// leaderboard (a best is the higher of the two either way, so that's safe to repeat).
//
// Reads the Redis address and Supabase's from .env, as the server does.

require('dotenv').config();
const Redis = require('ioredis');

const go = process.argv.includes('--go');
const DONE = 'Brought the leaderboard, logs, settings and stats over from Redis';

const redisName = Object.keys(process.env).find(name => /(^|_)REDIS_URL$/i.test(name) && /^rediss?:\/\//.test(process.env[name].trim()));
const supabaseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const supabaseKey = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
if (!redisName || !supabaseUrl || !supabaseKey) {
  console.error('Needs a Redis address and SUPABASE_URL and SUPABASE_SECRET_KEY in .env');
  process.exit(1);
}

// Supabase's API: path under /rest/v1/, with a JSON body for anything but a GET
async function supabase(method, path, body, prefer) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const rpc = (name, args) => supabase('POST', `rpc/${name}`, args);

const hourOf = (day, hh) => `${day}T${hh}:00:00.000Z`;
const iso = (at) => new Date(at).toISOString();

async function main() {
  const redis = new Redis(process.env[redisName].trim(), { maxRetriesPerRequest: 3, connectTimeout: 5000, disableClientInfo: true });
  try {
    const security = await rpc('admin_log_entries', { p_log: 'security', p_count: 1000 });
    const done = security.some(entry => entry.what === DONE);
    if (done) console.log('The logs, settings and stats were brought over already (the security log says so) - this time just the leaderboard.\n');

    // ---- What's in Redis ----
    const flat = await redis.zrange('anagram:solo:scores', 0, -1, 'WITHSCORES');
    const names = await redis.hgetall('anagram:solo:names');
    const words = await redis.hgetall('anagram:solo:words');
    const scores = [];
    for (let i = 0; i < flat.length; i += 2) {
      const id = flat[i];
      scores.push({ player_id: id, score: Number(flat[i + 1]), name: names[id] || '', words: words[id] === undefined ? null : Number(words[id]) });
    }
    const logs = {};
    for (const log of ['game', 'security']) {
      logs[log] = (await redis.lrange(`anagram:admin:log:${log}`, 0, -1)).map(raw => JSON.parse(raw));
    }
    const settingsRaw = await redis.get('anagram:admin:settings');
    const settings = settingsRaw && JSON.parse(settingsRaw);
    const dayKeys = [];
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'anagram:stats:2*', 'COUNT', 1000);
      cursor = next;
      dayKeys.push(...keys.filter(key => /^anagram:stats:\d{4}-\d{2}-\d{2}$/.test(key)));
    } while (cursor !== '0');
    const counts = new Map(); // `${hour}|${metric}` -> count
    for (const key of dayKeys.sort()) {
      const day = key.slice('anagram:stats:'.length);
      for (const [field, n] of Object.entries(await redis.hgetall(key))) {
        const [metric, hh] = field.split(':');
        counts.set(`${hourOf(day, hh)}|${metric}`, Number(n));
      }
    }

    console.log(`In Redis: ${scores.length} on the leaderboard, ${logs.game.length} game log entries, ${logs.security.length} security log entries, `
      + `${settings ? 'settings' : 'no settings'}, ${counts.size} hourly counts over ${dayKeys.length} days`);
    for (const s of scores) console.log(`  ${s.name || '(no name)'}: ${Math.floor(s.score / 1e13)} points, ${s.words === null ? 'words not kept' : `${s.words} words`}`);
    if (!go) {
      console.log('\nNothing changed. Run it again with --go to bring all that over.');
      return;
    }

    // ---- Into Supabase ----
    // The leaderboard: anyone not on it yet goes in as they were; anyone who's played since keeps the higher best
    const current = new Map((await supabase('GET', 'solo_scores?select=player_id,score')).map(row => [row.player_id, row.score]));
    const fresh = scores.filter(s => !current.has(s.player_id));
    if (fresh.length) await supabase('POST', 'solo_scores', fresh, 'return=minimal');
    const beaten = scores.filter(s => current.has(s.player_id) && s.score > current.get(s.player_id));
    for (const s of beaten) {
      await supabase('PATCH', `solo_scores?player_id=eq.${encodeURIComponent(s.player_id)}`, { score: s.score, words: s.words }, 'return=minimal');
    }
    console.log(`Leaderboard: ${fresh.length} added, ${beaten.length} raised to their best in Redis`);
    if (done) return;

    // The logs, each entry at when it happened
    for (const log of ['game', 'security']) {
      const rows = logs[log].map(entry => ({ log, at: iso(Number.isFinite(entry.at) ? entry.at : Date.now()), entry }));
      if (rows.length) await supabase('POST', 'admin_logs', rows, 'return=minimal');
    }

    // The settings, unless they've been changed since the deploy (but a sign-out-everywhere from before still holds)
    if (settings) {
      const now = await rpc('get_admin_settings', {});
      await rpc('save_admin_settings', { p_value: now ? { ...now, sessionsFrom: Math.max(now.sessionsFrom || 0, settings.sessionsFrom || 0) } : settings });
    }

    // The hourly counts, added to any since the deploy
    if (counts.size) {
      const hours = [...counts.keys()].map(key => key.split('|')[0]).sort();
      const to = iso(Date.parse(hours[hours.length - 1]) + 60 * 60 * 1000);
      for (const row of await rpc('stats_between', { p_from: hours[0], p_to: to })) {
        const key = `${iso(row.hour)}|${row.metric}`;
        if (counts.has(key)) counts.set(key, counts.get(key) + row.count);
      }
      const rows = [...counts].map(([key, count]) => ({ hour: key.split('|')[0], metric: key.split('|')[1], count }));
      await supabase('POST', 'stats_hourly?on_conflict=hour,metric', rows, 'resolution=merge-duplicates,return=minimal');
    }

    // Says it's done (which also trims the security log back to its usual length)
    await rpc('add_admin_log', { p_log: 'security', p_entry: { at: Date.now(), type: 'action', what: DONE, device: 'scripts/move-to-supabase.js' }, p_keep: 300 });
    const board = await rpc('solo_standings', { p_top: 0, p_player_id: '' });
    console.log(`\nDone. Supabase's leaderboard has ${board.total} players.`);
  } finally {
    redis.disconnect();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
