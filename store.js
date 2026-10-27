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

const DELETE = Symbol('delete room');

// A room nobody touches for this long disappears from Redis even if something went wrong cleaning it up
const ROOM_TTL = 12 * 60 * 60 * 1000;

function createStore(redisUrl) {
  return redisUrl ? redisStore(redisUrl) : memoryStore();
}

function memoryStore() {
  const rooms = new Map(); // roomCode -> JSON

  return {
    DELETE,
    redis: null,

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

function redisStore(url) {
  const Redis = require('ioredis');
  // Fail a command after a few reconnect attempts instead of queueing it forever while Redis is unreachable
  const redis = new Redis(url, { maxRetriesPerRequest: 3 });
  redis.on('error', (err) => console.error('Redis:', err.message));

  const roomKey = (roomCode) => `anagram:room:${roomCode}`;
  const ROOMS = 'anagram:rooms'; // every room code
  const EMPTY = 'anagram:empty'; // codes of empty rooms, scored by when they went empty

  // KEYS: room, ROOMS, EMPTY. ARGV: room JSON, code, emptySince ('' if someone is in it), ttl
  redis.defineCommand('createRoom', {
    numberOfKeys: 3,
    lua: `
      if not redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[4]) then return 0 end
      redis.call('SADD', KEYS[2], ARGV[2])
      if ARGV[3] ~= '' then redis.call('ZADD', KEYS[3], ARGV[3], ARGV[2]) end
      return 1`,
  });

  // Replaces the room only if it still holds what we read (ARGV[1]); a new JSON of '' deletes it.
  // KEYS: room, ROOMS, EMPTY. ARGV: JSON read, new JSON, code, emptySince ('' if someone is in it), ttl
  redis.defineCommand('replaceRoom', {
    numberOfKeys: 3,
    lua: `
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      if ARGV[2] == '' then
        redis.call('DEL', KEYS[1])
        redis.call('SREM', KEYS[2], ARGV[3])
        redis.call('ZREM', KEYS[3], ARGV[3])
        return 1
      end
      redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[5])
      if ARGV[4] ~= '' then
        redis.call('ZADD', KEYS[3], ARGV[4], ARGV[3])
      else
        redis.call('ZREM', KEYS[3], ARGV[3])
      end
      return 1`,
  });

  // A code whose room expired by ROOM_TTL is still listed - drop it
  const forget = (roomCodes) => {
    if (roomCodes.length) redis.multi().srem(ROOMS, ...roomCodes).zrem(EMPTY, ...roomCodes).exec().catch(() => {});
  };

  return {
    DELETE,
    redis, // the Socket.IO adapter publishes through this connection too

    async create(room) {
      const created = await redis.createRoom(roomKey(room.roomCode), ROOMS, EMPTY, JSON.stringify(room), room.roomCode, room.emptySince || '', ROOM_TTL);
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
        const result = change(room);
        const next = result === DELETE ? '' : JSON.stringify(room);
        if (next === raw) return { result }; // nothing changed, nothing to write
        const replaced = await redis.replaceRoom(roomKey(roomCode), ROOMS, EMPTY, raw, next, roomCode, room.emptySince || '', ROOM_TTL);
        if (replaced === 1) return result === DELETE ? { deleted: true } : { result };
        // Another instance changed the room since we read it - redo the change on the new version
        await new Promise(resolve => setTimeout(resolve, Math.random() * 20 * (attempt + 1)));
      }
      throw new Error(`Room ${roomCode} kept changing under us`);
    },

    async list() {
      const roomCodes = await redis.smembers(ROOMS);
      if (!roomCodes.length) return [];
      const raws = await redis.mget(roomCodes.map(roomKey));
      forget(roomCodes.filter((roomCode, i) => raws[i] === null));
      return raws.filter(raw => raw !== null).map(raw => JSON.parse(raw));
    },

    async emptySince(before) {
      return redis.zrangebyscore(EMPTY, '-inf', before);
    },
  };
}

module.exports = { createStore };
