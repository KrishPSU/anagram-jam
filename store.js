// Where rooms live.
//
// With a Redis URL (on Vercel: connect an Upstash Redis database to the project and it sets REDIS_URL),
// rooms are kept in Redis so every server instance sees the same rooms. Vercel runs this app as many
// short-lived instances, and connections that arrive at the same moment land on different ones - with
// rooms in memory, players on another instance got "room not found".
// Without one (local development), rooms stay in this process's memory, stored as JSON all the same so
// both kinds behave alike.
//
// Rooms are plain JSON objects. update() is the only way to change one: it reads the room, applies the
// change and writes it back only if nobody changed it in the meantime, retrying otherwise - so two players
// acting at the same moment on different instances can't overwrite each other.
//
// Upstash's free plan allows 500K commands a month and bills a Lua script as 1 command plus 1 for every
// call inside it, so the Redis side is kept lean: an update is a GET plus a 3-command script, and an empty
// room's key is set to expire when the room should go, so no polling is needed to clean up.
//
// If Redis stops answering (see fallbackStore), the game carries on with rooms in memory.
//
// Solo mode (see solo.js) keeps two things here as well: each run while it's being played (its words, so the
// answers sent at the end can be checked), and the leaderboard - every player's best score, and how many words it got.
// A leaderboard score is a single number, higher is better (solo.js packs the points and the time into it).
//
// And the admin page (see admin.js) keeps its own things here: counters that cap wrong passwords, two short logs (games,
// and sign-ins with what was done on the page), the site's settings (a banner, games paused), and stats - how many
// rooms, rounds and solo runs there were each hour, and who played (as HyperLogLogs, which count players without
// keeping their ids).

const DELETE = Symbol('delete room');

// The stats are kept by UTC hour, so the admin page can add them up into days in its own time zone.
// hourStamp: '2026-10-27T13' for 1pm UTC, as statsFor and uniquePlayers take them.
const hourStamp = (at) => new Date(at).toISOString().slice(0, 13);
const STATS_TTL = 400 * 24 * 60 * 60 * 1000;   // a year of rooms, rounds and runs
const PLAYERS_TTL = 35 * 24 * 60 * 60 * 1000;  // a month of who played (an hour's count is a key of its own)

// A room nobody touches for this long disappears from Redis even if something went wrong cleaning it up
const ROOM_TTL = 12 * 60 * 60 * 1000;

// A solo run is two minutes long - this leaves plenty of time to send it in after a dropped connection
const RUN_TTL = 15 * 60 * 1000;

// emptyRoomTtl: how long a room may stay empty (room.emptySince) before it's gone
function createStore(redisUrl, { emptyRoomTtl }) {
  return redisUrl ? fallbackStore(redisStore(redisUrl, emptyRoomTtl), memoryStore()) : memoryStore();
}

function memoryStore() {
  const rooms = new Map(); // roomCode -> JSON
  const runs = new Map();  // solo run id -> { raw: JSON, expiresAt }
  const scores = new Map(); // player id -> { score, name, words }: the solo leaderboard
  const counters = new Map(); // name -> { count, resetAt }
  const logs = new Map();     // log name -> entries, newest first
  const stats = new Map();    // UTC day -> { 'metric:hour': count }
  const players = new Map();  // hourStamp -> Set of player ids
  let settings = null;

  function liveRun(id) {
    const run = runs.get(id);
    if (run && run.expiresAt <= Date.now()) runs.delete(id);
    return runs.get(id);
  }

  // Where everyone stands, as the Redis version's scripts work it out. below: a score to count the players under.
  function standings(playerId, top, below) {
    const board = [...scores].map(([id, entry]) => ({ id, ...entry })).sort((a, b) => b.score - a.score);
    const rank = board.findIndex(entry => entry.id === playerId);
    return {
      total: board.length,
      lower: board.filter(entry => entry.score < below).length,
      rank: rank === -1 ? null : rank,
      best: rank === -1 ? null : board[rank].score,
      words: rank === -1 ? null : board[rank].words,
      top: board.slice(0, top),
    };
  }

  return {
    DELETE,
    redis: null,
    status: () => ({ store: 'memory', reason: null }),

    has: (roomCode) => rooms.has(roomCode),

    // false if the code is already taken
    async create(room) {
      if (rooms.has(room.roomCode)) return false;
      rooms.set(room.roomCode, JSON.stringify(room));
      return true;
    },

    async get(roomCode) {
      const raw = rooms.get(roomCode);
      return raw === undefined ? null : JSON.parse(raw);
    },

    // change(room) edits the room in place and returns what the caller needs afterwards (or DELETE).
    // Resolves to null if there's no such room, otherwise { result } or { deleted: true }.
    async update(roomCode, change) {
      const raw = rooms.get(roomCode);
      if (raw === undefined) return null;
      const room = JSON.parse(raw);
      const result = change(room);
      if (result === DELETE) {
        rooms.delete(roomCode);
        return { deleted: true };
      }
      rooms.set(roomCode, JSON.stringify(room));
      return { result };
    },

    async list() {
      return [...rooms.values()].map(raw => JSON.parse(raw));
    },

    // Codes of rooms that have been empty since `before` or earlier (room.emptySince)
    async emptySince(before) {
      return (await this.list()).filter(room => room.emptySince && room.emptySince <= before).map(room => room.roomCode);
    },

    hasRun: (id) => !!liveRun(id),

    // false if there's already a run with this id
    async createRun(run) {
      runs.forEach((_, id) => liveRun(id)); // clears out the expired ones
      if (runs.has(run.id)) return false;
      runs.set(run.id, { raw: JSON.stringify(run), expiresAt: Date.now() + RUN_TTL });
      return true;
    },

    async getRun(id) {
      const run = liveRun(id);
      return run ? JSON.parse(run.raw) : null;
    },

    async saveRun(run) {
      runs.set(run.id, { raw: JSON.stringify(run), expiresAt: Date.now() + RUN_TTL });
    },

    // Puts score (a run that got `words` words) on the leaderboard if it's the player's best, under the name given
    // (their latest), and says where everyone stands: { before (their best until now, or null), total, lower (players
    // with a score under `below`), rank (0 = top), best, words (their best's), top: the first `top` entries, as
    // { id, score, name, words } }
    async addScore(playerId, score, name, words, below, top) {
      const old = scores.get(playerId);
      const best = old && old.score >= score ? old : { score, words };
      scores.set(playerId, { score: best.score, name, words: best.words });
      return { before: old ? old.score : null, ...standings(playerId, top, below) };
    },

    // The first `top` entries and where playerId stands: { total, rank, best, words, top } as for addScore
    async leaderboard(top, playerId) {
      const { total, rank, best, words, top: entries } = standings(playerId, top, -Infinity);
      return { total, rank, best, words, top: entries };
    },

    // false if they weren't on it
    async removeScore(playerId) {
      return scores.delete(playerId);
    },

    // Counts one more against `name`, starting a window of windowMs if there isn't one. Resolves to { count, resetsIn }:
    // the count so far this window, and the ms until it starts again from nothing.
    async bump(name, windowMs) {
      const now = Date.now();
      let counter = counters.get(name);
      if (!counter || counter.resetAt <= now) counters.set(name, counter = { count: 0, resetAt: now + windowMs });
      counter.count++;
      return { count: counter.count, resetsIn: counter.resetAt - now };
    },

    // Where each of `names` stands, as bump has it ({ count: 0, resetsIn: 0 } for one with no window going)
    async peek(names) {
      const now = Date.now();
      return names.map((name) => {
        const counter = counters.get(name);
        return counter && counter.resetAt > now ? { count: counter.count, resetsIn: counter.resetAt - now } : { count: 0, resetsIn: 0 };
      });
    },

    // Adds an entry to the front of log `name`, keeping the newest `keep`
    async log(name, entry, keep) {
      logs.set(name, [entry, ...(logs.get(name) || [])].slice(0, keep));
    },

    async logs(name, count) {
      return (logs.get(name) || []).slice(0, count);
    },

    // One more of `metric` this hour, and the players (ids) who were in it
    async track(metric, playerIds, at) {
      const day = hourStamp(at).slice(0, 10);
      const field = `${metric}:${hourStamp(at).slice(11)}`;
      const counts = stats.get(day) || {};
      counts[field] = (counts[field] || 0) + 1;
      stats.set(day, counts);
      if (playerIds.length) {
        const hour = players.get(hourStamp(at)) || new Set();
        playerIds.forEach(id => hour.add(id));
        players.set(hourStamp(at), hour);
      }
    },

    // The counts for each UTC day ('2026-10-27'), as { 'metric:hour': count }
    async statsFor(days) {
      return days.map(day => ({ ...(stats.get(day) || {}) }));
    },

    // How many different players there were in each group of hours (hourStamps)
    async uniquePlayers(groups) {
      return groups.map(hours => new Set(hours.flatMap(hour => [...(players.get(hour) || [])])).size);
    },

    async getSettings() {
      return settings && JSON.parse(settings);
    },

    async saveSettings(value) {
      settings = JSON.stringify(value);
    },

    // Nothing to measure without Redis
    async health() {
      return null;
    },
  };
}

function redisStore(url, emptyRoomTtl) {
  const Redis = require('ioredis');
  const redis = new Redis(url, {
    // Give up on a command quickly while Redis is unreachable or slow, so the game can fall back to memory
    maxRetriesPerRequest: 3,
    connectTimeout: 3000,
    commandTimeout: 2000,
    // Skip the two CLIENT SETINFO commands ioredis sends on every connection - they'd count against the quota
    disableClientInfo: true,
  });
  redis.on('error', (err) => console.error('Redis:', err.message));

  const roomKey = (roomCode) => `anagram:room:${roomCode}`;
  const ROOMS = 'anagram:rooms'; // every room code

  // An empty room's key expires when the room should be deleted (a few seconds' grace on top - every read
  // already treats it as gone by then), an occupied room's after ROOM_TTL
  const ttlFor = (room) => (room.emptySince ? Math.max(1000, room.emptySince + emptyRoomTtl + 5000 - Date.now()) : ROOM_TTL);

  // KEYS: room, ROOMS. ARGV: room JSON, code, ttl
  redis.defineCommand('createRoom', {
    numberOfKeys: 2,
    lua: `
      if not redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[3]) then return 0 end
      redis.call('SADD', KEYS[2], ARGV[2])
      return 1`,
  });

  // Replaces the room only if it still holds what we read (ARGV[1]); a new JSON of '' deletes it.
  // KEYS: room, ROOMS. ARGV: JSON read, new JSON, code, ttl
  redis.defineCommand('replaceRoom', {
    numberOfKeys: 2,
    lua: `
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      if ARGV[2] == '' then
        redis.call('DEL', KEYS[1])
        redis.call('SREM', KEYS[2], ARGV[3])
        return 1
      end
      redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[4])
      return 1`,
  });

  // The codes of rooms whose keys have expired are still listed - drop them
  const forget = (roomCodes) => {
    if (roomCodes.length) redis.srem(ROOMS, ...roomCodes).catch(() => {});
  };

  // Marks an error that says nothing about Redis itself, so fallbackStore doesn't treat it as Redis failing
  const notRedis = (err) => Object.assign(err, { notRedis: true });

  const runKey = (id) => `anagram:solo:run:${id}`;
  const SCORES = 'anagram:solo:scores'; // sorted set: player id -> their best score
  const NAMES = 'anagram:solo:names';   // hash: player id -> their name
  // hash: player id -> how many words their best got. Bests from before this was kept (when runs were a minute long)
  // have none until they're beaten.
  const WORDS = 'anagram:solo:words';

  // Lua for both scripts below: the first ARGV[arg] entries of the leaderboard into `top` (a flat list: id, score,
  // id, score...), their names into `names` and their words into `words`. (Redis has Lua 5.1, whose unpack later
  // Luas keep in table.)
  const topLua = (arg) => `
    local unpack = unpack or table.unpack
    local count = tonumber(ARGV[${arg}])
    local top = {}
    if count > 0 then top = redis.call('ZREVRANGE', KEYS[1], 0, count - 1, 'WITHSCORES') end
    local ids = {}
    for i = 1, #top, 2 do ids[#ids + 1] = top[i] end
    local names, words = {}, {}
    if #ids > 0 then
      names = redis.call('HMGET', KEYS[2], unpack(ids))
      words = redis.call('HMGET', KEYS[3], unpack(ids))
    end`;

  // A player's score (and its words) goes in if it beats their best, and their name is updated either way. Then where
  // everyone stands.
  // KEYS: SCORES, NAMES, WORDS. ARGV: player id, score, name, words, score to count the players under, how many from
  // the top.
  redis.defineCommand('addSoloScore', {
    numberOfKeys: 3,
    lua: `
      local before = redis.call('ZSCORE', KEYS[1], ARGV[1])
      if not before or tonumber(ARGV[2]) > tonumber(before) then
        redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
        redis.call('HSET', KEYS[3], ARGV[1], ARGV[4])
      end
      redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
      ${topLua(6)}
      return { before, redis.call('ZCARD', KEYS[1]), redis.call('ZCOUNT', KEYS[1], '-inf', '(' .. ARGV[5]),
        redis.call('ZREVRANK', KEYS[1], ARGV[1]), redis.call('ZSCORE', KEYS[1], ARGV[1]),
        redis.call('HGET', KEYS[3], ARGV[1]), top, names, words }`,
  });

  // KEYS: SCORES, NAMES, WORDS. ARGV: how many from the top, player id ('' for nobody in particular).
  redis.defineCommand('soloLeaderboard', {
    numberOfKeys: 3,
    lua: `
      ${topLua(1)}
      local rank, best, bestWords = false, false, false
      if ARGV[2] ~= '' then
        rank = redis.call('ZREVRANK', KEYS[1], ARGV[2])
        best = redis.call('ZSCORE', KEYS[1], ARGV[2])
        bestWords = redis.call('HGET', KEYS[3], ARGV[2])
      end
      return { redis.call('ZCARD', KEYS[1]), rank, best, bestWords, top, names, words }`,
  });

  // A script's own error (one of the two above failing) isn't Redis failing, so it mustn't send the rooms to memory
  const scriptRun = (promise) => promise.catch((err) => {
    throw /script/i.test(err.message) ? notRedis(err) : err;
  });

  // The flat list from topLua as { id, score, name, words }
  const entries = (top, names, words) => names.map((name, i) => ({ id: top[i * 2], score: Number(top[i * 2 + 1]), name: name || '', words: number(words[i]) }));
  const number = (value) => (value === null ? null : Number(value));

  // The admin page's (see memoryStore for what each one is)
  const counterKey = (name) => `anagram:admin:count:${name}`;
  const logKey = (name) => `anagram:admin:log:${name}`;
  const SETTINGS = 'anagram:admin:settings';
  const statsKey = (day) => `anagram:stats:${day}`;
  const playersKey = (hour) => `anagram:stats:players:${hour}`;

  // KEYS: the counter. ARGV: its window in ms. Replies { count, ms until the window is over }.
  redis.defineCommand('bumpCounter', {
    numberOfKeys: 1,
    lua: `
      local count = redis.call('INCR', KEYS[1])
      if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
      local ttl = redis.call('PTTL', KEYS[1])
      if ttl < 0 then
        redis.call('PEXPIRE', KEYS[1], ARGV[1])
        ttl = tonumber(ARGV[1])
      end
      return { count, ttl }`,
  });

  // A pipeline's replies, failing like a single command would if any of its commands failed (Upstash bills each one)
  async function replies(pipeline) {
    const results = await pipeline.exec();
    const failed = results.find(([err]) => err);
    if (failed) throw failed[0];
    return results.map(([, reply]) => reply);
  }

  return {
    DELETE,
    redis, // the Socket.IO adapter publishes through this connection too

    async create(room) {
      const created = await redis.createRoom(roomKey(room.roomCode), ROOMS, JSON.stringify(room), room.roomCode, ttlFor(room));
      return created === 1;
    },

    async get(roomCode) {
      const raw = await redis.get(roomKey(roomCode));
      return raw === null ? null : JSON.parse(raw);
    },

    async update(roomCode, change) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const raw = await redis.get(roomKey(roomCode));
        if (raw === null) {
          forget([roomCode]);
          return null;
        }
        const room = JSON.parse(raw);
        let result;
        try {
          result = change(room);
        } catch (err) {
          throw notRedis(err);
        }
        const next = result === DELETE ? '' : JSON.stringify(room);
        if (next === raw) return { result }; // nothing changed, nothing to write
        const replaced = await redis.replaceRoom(roomKey(roomCode), ROOMS, raw, next, roomCode, ttlFor(room));
        if (replaced === 1) return result === DELETE ? { deleted: true } : { result };
        // Another instance changed the room since we read it - redo the change on the new version
        await new Promise(resolve => setTimeout(resolve, Math.random() * 20 * (attempt + 1)));
      }
      throw notRedis(new Error(`Room ${roomCode} kept changing under us`));
    },

    async list() {
      const roomCodes = await redis.smembers(ROOMS);
      if (!roomCodes.length) return [];
      const raws = await redis.mget(roomCodes.map(roomKey));
      forget(roomCodes.filter((roomCode, i) => raws[i] === null));
      return raws.filter(raw => raw !== null).map(raw => JSON.parse(raw));
    },

    async createRun(run) {
      return (await redis.set(runKey(run.id), JSON.stringify(run), 'PX', RUN_TTL, 'NX')) === 'OK';
    },

    async getRun(id) {
      const raw = await redis.get(runKey(id));
      return raw === null ? null : JSON.parse(raw);
    },

    async saveRun(run) {
      await redis.set(runKey(run.id), JSON.stringify(run), 'PX', RUN_TTL);
    },

    async addScore(playerId, score, name, words, below, top) {
      const [before, total, lower, rank, best, bestWords, list, names, wordsList] = await scriptRun(
        redis.addSoloScore(SCORES, NAMES, WORDS, playerId, String(score), name, String(words), String(below), top));
      return { before: number(before), total, lower, rank, best: number(best), words: number(bestWords), top: entries(list, names, wordsList) };
    },

    async leaderboard(top, playerId) {
      const [total, rank, best, bestWords, list, names, wordsList] =
        await scriptRun(redis.soloLeaderboard(SCORES, NAMES, WORDS, top, playerId || ''));
      return { total, rank, best: number(best), words: number(bestWords), top: entries(list, names, wordsList) };
    },

    async removeScore(playerId) {
      const removed = await redis.zrem(SCORES, playerId);
      await redis.hdel(NAMES, playerId);
      await redis.hdel(WORDS, playerId);
      return removed === 1;
    },

    async bump(name, windowMs) {
      const [count, resetsIn] = await scriptRun(redis.bumpCounter(counterKey(name), windowMs));
      return { count, resetsIn };
    },

    async peek(names) {
      const pipeline = redis.pipeline();
      names.forEach(name => pipeline.get(counterKey(name)).pttl(counterKey(name)));
      const results = await replies(pipeline);
      return names.map((_, i) => {
        const count = Number(results[i * 2]) || 0;
        return count ? { count, resetsIn: Math.max(0, results[i * 2 + 1]) } : { count: 0, resetsIn: 0 };
      });
    },

    async log(name, entry, keep) {
      await replies(redis.pipeline().lpush(logKey(name), JSON.stringify(entry)).ltrim(logKey(name), 0, keep - 1));
    },

    async logs(name, count) {
      return (await redis.lrange(logKey(name), 0, count - 1)).map(raw => JSON.parse(raw));
    },

    async track(metric, playerIds, at) {
      const hour = hourStamp(at);
      const pipeline = redis.pipeline()
        .hincrby(statsKey(hour.slice(0, 10)), `${metric}:${hour.slice(11)}`, 1)
        .pexpire(statsKey(hour.slice(0, 10)), STATS_TTL);
      if (playerIds.length) pipeline.pfadd(playersKey(hour), ...playerIds).pexpire(playersKey(hour), PLAYERS_TTL);
      await replies(pipeline);
    },

    async statsFor(days) {
      if (!days.length) return [];
      const pipeline = redis.pipeline();
      days.forEach(day => pipeline.hgetall(statsKey(day)));
      return (await replies(pipeline)).map(counts => Object.fromEntries(Object.entries(counts || {}).map(([field, n]) => [field, Number(n)])));
    },

    async uniquePlayers(groups) {
      const asked = groups.filter(hours => hours.length);
      if (!asked.length) return groups.map(() => 0);
      const pipeline = redis.pipeline();
      asked.forEach(hours => pipeline.pfcount(...hours.map(playersKey)));
      const counts = await replies(pipeline);
      return groups.map(hours => (hours.length ? counts.shift() : 0));
    },

    async getSettings() {
      const raw = await redis.get(SETTINGS);
      return raw === null ? null : JSON.parse(raw);
    },

    async saveSettings(value) {
      await redis.set(SETTINGS, JSON.stringify(value));
    },

    // How long a command takes to come back, and how many keys there are
    async health() {
      const started = Date.now();
      await redis.get('anagram:check');
      const latencyMs = Date.now() - started;
      return { latencyMs, keys: await redis.dbsize() };
    },
  };
}

// Redis with a safety net. If Redis stops answering - once the free plan's 500K commands for the month are
// used up Upstash refuses every command, and it can also just be unreachable - new rooms are kept in this
// process's memory instead (how the app worked before Redis: fine unless the players of one room land on
// different instances), and once a minute it checks whether Redis answers again.
// A room stays where it was created, so a game started during an outage carries on in memory after Redis is
// back. Rooms that were in Redis when it stopped answering can't be reached until it's back.
// The used-up quota is unmistakable, so that switches at once; anything else has to fail three times in a row,
// so one network hiccup doesn't cut this instance off from the rooms in Redis.
function fallbackStore(redis, memory) {
  let outage = null; // { since, reason } while Redis isn't answering
  let failures = 0;  // in a row

  async function attempt(operation, onFailure) {
    if (outage) return onFailure();
    try {
      const result = await operation();
      failures = 0;
      return result;
    } catch (err) {
      if (err.notRedis) throw err;
      redisFailed(err);
      return onFailure();
    }
  }

  function redisFailed(err) {
    failures++;
    if (outage) return; // several operations failed at once - the first one already switched
    if (!/max requests limit/i.test(err.message) && failures < 3) {
      console.error(`Redis error (${err.message})`);
      return;
    }
    outage = { since: Date.now(), reason: err.message };
    console.error(`Redis isn't answering (${err.message}) - keeping new rooms in memory until it does`);
    const check = setInterval(async () => {
      try {
        // A real command: PING doesn't count against the quota, so it might work while everything else is refused
        await redis.redis.get('anagram:check');
        outage = null;
        failures = 0;
        clearInterval(check);
        console.log('Redis is answering again - new rooms go back to Redis');
      } catch {}
    }, 30 * 1000);
    check.unref();
  }

  return {
    DELETE,
    redis: redis.redis,
    usingRedis: () => !outage,
    status: () => (outage ? { store: 'memory', reason: outage.reason, since: outage.since } : { store: 'redis' }),

    // If Redis can't take a new room it goes in memory, so creating a room always works
    async create(room) {
      if (memory.has(room.roomCode)) return false;
      return attempt(() => redis.create(room), () => memory.create(room));
    },

    // A room in Redis can't be reached while Redis isn't answering
    async get(roomCode) {
      if (memory.has(roomCode)) return memory.get(roomCode);
      return attempt(() => redis.get(roomCode), () => null);
    },

    async update(roomCode, change) {
      if (memory.has(roomCode)) return memory.update(roomCode, change);
      return attempt(() => redis.update(roomCode, change), () => null);
    },

    async list() {
      const local = await memory.list();
      return local.concat(await attempt(() => redis.list(), () => []));
    },

    // Only the rooms kept in memory need sweeping - Redis expires its own
    emptySince: (before) => memory.emptySince(before),

    // Solo runs go where rooms would: one started while Redis isn't answering is kept in memory and played from there
    async createRun(run) {
      if (memory.hasRun(run.id)) return false;
      return attempt(() => redis.createRun(run), () => memory.createRun(run));
    },

    async getRun(id) {
      if (memory.hasRun(id)) return memory.getRun(id);
      return attempt(() => redis.getRun(id), () => null);
    },

    async saveRun(run) {
      if (memory.hasRun(run.id)) return memory.saveRun(run);
      return attempt(() => redis.saveRun(run), () => {});
    },

    // The leaderboard is only ever the one in Redis - an instance's own in memory would be a different board on every
    // instance. While Redis isn't answering these resolve to null: the leaderboard can't be reached.
    addScore: (...args) => attempt(() => redis.addScore(...args), () => null),
    leaderboard: (...args) => attempt(() => redis.leaderboard(...args), () => null),
    removeScore: (...args) => attempt(() => redis.removeScore(...args), () => null),

    // The admin page's. While Redis isn't answering, this instance keeps its own in memory: its own count of wrong
    // passwords (so guessing is still capped), and its own log, stats and settings until Redis is back.
    bump: (...args) => attempt(() => redis.bump(...args), () => memory.bump(...args)),
    peek: (...args) => attempt(() => redis.peek(...args), () => memory.peek(...args)),
    log: (...args) => attempt(() => redis.log(...args), () => memory.log(...args)),
    logs: (...args) => attempt(() => redis.logs(...args), () => memory.logs(...args)),
    track: (...args) => attempt(() => redis.track(...args), () => memory.track(...args)),
    statsFor: (...args) => attempt(() => redis.statsFor(...args), () => memory.statsFor(...args)),
    uniquePlayers: (...args) => attempt(() => redis.uniquePlayers(...args), () => memory.uniquePlayers(...args)),
    getSettings: () => attempt(() => redis.getSettings(), () => memory.getSettings()),
    saveSettings: (value) => attempt(() => redis.saveSettings(value), () => memory.saveSettings(value)),
    health: () => attempt(() => redis.health(), () => null),
  };
}

module.exports = { createStore };
