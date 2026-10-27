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

const DELETE = Symbol('delete room');

// A room nobody touches for this long disappears from Redis even if something went wrong cleaning it up
const ROOM_TTL = 12 * 60 * 60 * 1000;

// emptyRoomTtl: how long a room may stay empty (room.emptySince) before it's gone
function createStore(redisUrl, { emptyRoomTtl }) {
  return redisUrl ? fallbackStore(redisStore(redisUrl, emptyRoomTtl), memoryStore()) : memoryStore();
}

function memoryStore() {
  const rooms = new Map(); // roomCode -> JSON

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
  };
}

module.exports = { createStore };
