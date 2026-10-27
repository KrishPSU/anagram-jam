const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const wordExists = require('word-exists');
const WORDS = require('./words');
const { createStore } = require('./store');

require('dotenv').config();

// A rejected promise nobody handles would otherwise crash the server, ending every game on it
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));


const PORT = process.env.PORT || 3000;


const app = express();
const server = http.createServer(app);
const io = new Server(server);

// A room nobody is in is deleted after this long - enough to reload a page or move between screens
const EMPTY_ROOM_TTL = 30 * 1000;

// The Redis address. Connecting Upstash Redis to a Vercel project sets REDIS_URL and KV_URL (the same
// address) with whatever prefix was chosen - this project uses anagram_jam_ - so any name ending in either will do.
function redisUrlFromEnv() {
  const names = Object.keys(process.env).filter(name => /(^|_)(REDIS|KV)_URL$/i.test(name) && process.env[name].trim());
  const usable = names.filter(name => /^rediss?:\/\//.test(process.env[name].trim()));
  names.filter(name => !usable.includes(name)).forEach(name => console.error(`${name} isn't a redis:// or rediss:// address - ignoring it`));
  usable.sort((a, b) => /REDIS_URL$/i.test(b) - /REDIS_URL$/i.test(a));
  if (usable.length) console.log(`Redis address from ${usable[0]}`);
  return usable.length ? process.env[usable[0]].trim() : undefined;
}

// Rooms live in Redis when there is one (see store.js), otherwise in this process's memory
const store = createStore(redisUrlFromEnv(), { emptyRoomTtl: EMPTY_ROOM_TTL });
if (store.redis) {
  // Broadcasts reach players connected to other server instances too. Loaded only here, like ioredis in
  // store.js, so running without Redis never depends on these packages.
  const { createAdapter } = require('@socket.io/redis-adapter');
  const subClient = store.redis.duplicate();
  subClient.on('error', (err) => console.error('Redis (adapter):', err.message));
  guardRedis(store.redis, ['publish']);
  guardRedis(subClient, ['subscribe', 'psubscribe', 'unsubscribe', 'punsubscribe']);
  io.adapter(createAdapter(store.redis, subClient));
}
console.log(`Rooms are kept in ${store.redis ? 'Redis' : 'memory'}`);

// The adapter doesn't handle Redis refusing a command (Upstash refuses them all once the free plan is used up):
// a failed publish or subscribe would crash the server. Messages still reach the players on this instance
// either way, and while rooms are being kept in memory there's no point publishing at all.
function guardRedis(client, commands) {
  for (const command of commands) {
    const send = client[command].bind(client);
    client[command] = (...args) => {
      if (command === 'publish' && !store.usingRedis()) return Promise.resolve(0);
      return send(...args).catch((err) => {
        console.error(`Redis ${command} failed:`, err.message);
        return 0;
      });
    };
  }
}

// Start server
server.listen(PORT || 3000, () => {
  console.log(`Server running on port ${PORT || 3000}`)
});




// Serve static assets for home (if present) and for game pages
app.use(express.static(path.join(__dirname, 'create-room')));
app.use('/', express.static(path.join(__dirname, 'home')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.use('/solo', express.static(path.join(__dirname, 'solo')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));

// Serve PWA files (manifest.json and service worker)
app.get('/manifest.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'manifest.json'));
});

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'sw.js'));
});

// Serve the icon files (only these - serving the whole project root would expose the server code).
// Each filename is written out in full: Vercel only bundles files it can find named in the code, and the
// path that used to be built from req.path left both icons out, so they were a 404 there.
app.get('/icon-192.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'icon-192.png'));
});

app.get('/icon-512.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'icon-512.png'));
});

app.use('/game/:roomCode', express.static(path.join(__dirname, 'create-room')));
// app.use('/admin', express.static(path.join(__dirname, 'edit-menu-app')));


// Routes
// Optional home route (adjust if you have a home page)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'home', 'index.html'));
});

app.get('/solo', (req, res) => {
  res.sendFile(path.join(__dirname, 'solo', 'solo.html'));
});

app.get('/game/:roomCode', async (req, res) => {
  const room = await findRoom(req.params.roomCode);
  if (room) {
    res.sendFile(path.join(__dirname, 'create-room', 'game.html'));
  } else {
    res.redirect('/');
  }
});
// The results used to be a page of their own - they're a screen of the game page now
app.get('/game/:roomCode/end', (req, res) => {
  res.redirect(`/game/${encodeURIComponent(req.params.roomCode)}/`);
});

// Summary only - sending the full rooms would leak every game's answers
app.get('/rooms', async (req, res) => {
  const rooms = await liveRooms();
  res.send(rooms.map(r => ({ roomCode: r.roomCode, players: r.players.map(p => p.name), gameStarted: !!r.round })));
});





function generateJoinCode() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 5; i++) code += letters[Math.floor(Math.random() * letters.length)];
  return code;
}


// A room keeps everyone who's in it, whatever screen they're on: the lobby (ready or not), the round, or its
// results. Nobody is taken out between rounds - only when they leave, or when their connection has been gone
// for longer than AWAY_GRACE.
//
// { v, roomCode, emptySince,
//   players: [{ id, name, socketId, status: 'lobby' | 'game' | 'results', ready, awaySince }],
//   wins: { [player id]: count },
//   countdown: { token, roster } during the 3-2-1, roster being the ids of the players it's for,
//   round: { id, words: { regular, jumbled }, startedAt, solves, highest, progress: { [player id]: ... } } while one is played,
//   results: the last round's, for whoever is still reading them }
const ROOM_VERSION = 2; // rooms laid out any other way (made before this) count as gone

const LEVEL_SECONDS = 30; // per word, as in game.js
const MIN_PLAYERS = 2;
const COUNTDOWN_MS = 4000; // the lobby's 3-2-1-GO
// A dropped connection (a reload, a phone going to sleep, Vercel closing every WebSocket after about 5 minutes)
// keeps your place in the room this long
const AWAY_GRACE = 20 * 1000;
// Back in a round, you get at least this long to find your feet, whatever was left on the clock
const MIN_RESUME_SECONDS = 3;

// A player is known by a random token their browser keeps, so a reload, a dropped connection or leaving and
// coming back finds them in the same place. Everyone else only ever sees this hash of it, so nobody can copy
// a token out of the player list and play as someone else.
function playerIdFor(token) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}


function isEmpty(room) {
  return room.players.length === 0;
}

// Notes when the room went empty (null while someone is in it). Someone whose connection dropped is still in
// it until their grace runs out, so a room everyone dropped out of went empty when the last grace ran out.
// changeRoom does this after every change.
function trackEmpty(room) {
  if (isEmpty(room)) room.emptySince = room.emptySince || Date.now();
  else if (room.players.every(p => p.awaySince)) room.emptySince = Math.max(...room.players.map(p => p.awaySince)) + AWAY_GRACE;
  else room.emptySince = null;
}

// Judged by the clock rather than a timer per room: a serverless instance (Vercel) is suspended while it
// has nothing to do, and timers don't fire then
function isAbandoned(room) {
  return room.v !== ROOM_VERSION || (!!room.emptySince && Date.now() - room.emptySince >= EMPTY_ROOM_TTL);
}

// The room, or null if there's no such room. One nobody has been in for too long counts as gone (and is deleted).
async function findRoom(roomCode) {
  if (typeof roomCode !== 'string') return null;
  const room = await store.get(roomCode);
  if (room && isAbandoned(room)) {
    await tidyRoom(roomCode);
    return null;
  }
  return room;
}

// Applies change(room) as one step (see store.update), along with the room's own rules (see followRules).
// It runs again if another server instance changed the room at the same moment, so change must only edit
// the room - emit and log afterwards, using what it returns. Everyone in the room is sent the new
// room-state whenever something they can see has changed.
// Resolves to null if there's no such room, otherwise { result, deleted, state }.
async function changeRoom(roomCode, change) {
  if (typeof roomCode !== 'string') return null;
  let abandoned = false;
  let before, after, news;
  const outcome = await store.update(roomCode, (room) => {
    abandoned = isAbandoned(room);
    if (abandoned) return store.DELETE;
    before = JSON.stringify(publicState(room));
    const dropped = dropAway(room);
    const result = change(room);
    if (result === store.DELETE) return result;
    news = { dropped, ...followRules(room) };
    trackEmpty(room);
    after = publicState(room);
    return result;
  });
  if (abandoned) console.log(`Room ${roomCode} deleted - nobody was in it`);
  if (!outcome || abandoned) return null;
  if (outcome.deleted) return { result: outcome.result, deleted: true, state: null };

  if (JSON.stringify(after) !== before) io.to(roomCode).emit('room-state', after);
  news.dropped.forEach(name => announceLeft(roomCode, name));
  if (news.stoppedBy) io.to(roomCode).emit('start-canceled', news.stoppedBy.id, news.stoppedBy.name);
  if (news.countdown) beginCountdown(roomCode, news.countdown);
  return { result: outcome.result, deleted: false, state: after };
}

// What a room does on its own after any change: a round nobody is playing anymore is over (with no winner),
// the 3-2-1 stops if one of its players isn't ready anymore, and it starts once everyone in the room is ready.
// Returns what changeRoom has to tell everyone: { stoppedBy, countdown }.
function followRules(room) {
  if (room.round && !room.players.some(p => p.status === 'game')) room.round = null;

  let stoppedBy = null;
  if (room.countdown) {
    const roster = room.players.filter(p => room.countdown.roster.includes(p.id));
    const unready = roster.find(p => p.status !== 'lobby' || !p.ready);
    if (unready || roster.length < MIN_PLAYERS) {
      room.countdown = null;
      stoppedBy = unready ? { id: unready.id, name: unready.name } : { id: null, name: '' };
    }
  }

  // Everyone - someone still reading the last round's results isn't ready yet
  const everyoneReady = room.players.length >= MIN_PLAYERS && room.players.every(p => p.status === 'lobby' && p.ready);
  let countdown = null;
  if (everyoneReady && !room.countdown && !room.round) {
    countdown = room.countdown = { token: Math.random().toString(36).slice(2), roster: room.players.map(p => p.id) };
  }
  return { stoppedBy, countdown };
}

// Takes out the players whose connection dropped more than AWAY_GRACE ago, and returns their names. Their
// progress in a round stays, in case they come back to it (see enterRoom).
function dropAway(room) {
  const gone = room.players.filter(p => p.awaySince && Date.now() - p.awaySince >= AWAY_GRACE);
  room.players = room.players.filter(p => !gone.includes(p));
  return gone.map(p => p.name);
}

// Just the room's rules: deletes it if it's been abandoned, and takes out whoever dropped out too long ago
async function tidyRoom(roomCode) {
  await changeRoom(roomCode, () => {});
}

// Rooms in memory that nobody looks up again are cleaned up here: all of them without Redis, and with
// Redis the ones created while it wasn't answering. Redis expires its own rooms (see store.js), so this
// never spends any of the free plan's commands.
setInterval(async () => {
  try {
    for (const roomCode of await store.emptySince(Date.now() - EMPTY_ROOM_TTL)) await tidyRoom(roomCode);
  } catch (err) {
    console.error('Cleaning up rooms failed:', err.message);
  }
}, 5000);

async function liveRooms() {
  return (await store.list()).filter(room => !isAbandoned(room));
}

// For the admin page: where rooms are kept right now, and why when it isn't Redis. Kept vague on purpose -
// the page is public, and Redis errors can name the database's host.
function storageStatus() {
  const status = store.status();
  if (status.store === 'redis') return 'Redis';
  if (!status.reason) return 'Memory (no Redis set up)';
  const why = /max requests limit/i.test(status.reason) ? "the free plan's commands for the month are used up" : "Redis isn't answering";
  return `Memory since ${new Date(status.since).toUTCString().slice(17, 22)} UTC - ${why}`;
}

// The home page asks about once a minute per visitor, so a count up to a minute old will do - working
// it out reads every room from the store (2 Redis commands)
let liveStats = { at: 0, playing: 0 };
async function roomsPlaying() {
  if (Date.now() - liveStats.at > 60000) {
    const playing = (await liveRooms()).filter(r => r.round && r.players.length > 0).length;
    liveStats = { at: Date.now(), playing };
  }
  return liveStats.playing;
}


// What everyone in the room sees of it - no tokens, words or answers.
// status: in the lobby ('ready' or 'notReady'), or 'inGame' while playing the round or reading its results.
function publicState(room) {
  const round = room.round;
  return {
    players: room.players.map(p => {
      const progress = round && round.progress[p.id];
      return {
        id: p.id,
        name: p.name,
        status: p.status === 'lobby' ? (p.ready ? 'ready' : 'notReady') : 'inGame',
        away: !!p.awaySince,
        wins: room.wins[p.id] || 0,
        level: progress ? progress.level : null,
        points: progress ? progress.points : null,
      };
    }),
    countdown: room.countdown ? room.countdown.roster : null,
    playing: !!round,
    total: round ? round.words.regular.length : 10,
  };
}

function announceLeft(roomCode, name) {
  io.to(roomCode).emit('playerLeft', name);
  console.log(`Player ${name} left room ${roomCode}`);
}


// Each player's clock on their word. It stops while they're away, so they come back to the time they had left.
function secondsLeftOn(progress) {
  return LEVEL_SECONDS - Math.floor((Date.now() - progress.levelStartedAt) / 1000);
}

function pauseClock(room, playerId) {
  const progress = room.round && room.round.progress[playerId];
  if (progress && progress.secondsLeft === null) progress.secondsLeft = Math.min(LEVEL_SECONDS, Math.max(0, secondsLeftOn(progress)));
}

// Starts the clock again and returns the seconds left on it
function resumeClock(progress) {
  const left = Math.max(MIN_RESUME_SECONDS, progress.secondsLeft === null ? secondsLeftOn(progress) : progress.secondsLeft);
  progress.secondsLeft = null;
  progress.levelStartedAt = Date.now() - (LEVEL_SECONDS - left) * 1000;
  return left;
}


// Everyone in the room sees the 3-2-1 (the players it's for get the overlay). The words go out when it's
// done, unless it was stopped in the meantime (see followRules).
function beginCountdown(roomCode, countdown) {
  io.to(roomCode).emit('game-starting', countdown.roster);
  console.log(`Game starting in room: ${roomCode}`);
  setTimeout(() => {
    beginRound(roomCode, countdown.token).catch((err) => console.error(`Starting the game in room ${roomCode} failed:`, err.message));
  }, COUNTDOWN_MS);
}

async function beginRound(roomCode, token) {
  let tooFew;
  const begun = await changeRoom(roomCode, (room) => {
    tooFew = false;
    if (!room.countdown || room.countdown.token !== token) return; // stopped, or it's another countdown by now
    const roster = room.players.filter(p => room.countdown.roster.includes(p.id));
    room.countdown = null;
    if (roster.length < MIN_PLAYERS) {
      tooFew = true;
      return;
    }

    const words = getRandomWords(10);
    const now = Date.now();
    room.round = { id: token, words: { regular: words, jumbled: jumbleWords(words) }, startedAt: now, solves: words.map(() => null), highest: null, progress: {} };
    room.results = null;
    roster.forEach(p => {
      p.status = 'game';
      p.ready = false;
      // Someone whose connection dropped during the 3-2-1 starts with their clock stopped, like any time they're away
      room.round.progress[p.id] = { name: p.name, level: 0, points: 0, solved: 0, skipped: [], levelStartedAt: now, secondsLeft: p.awaySince ? LEVEL_SECONDS : null };
    });
    return { words: room.round.words, roster: roster.map(p => p.id) };
  });
  if (tooFew) io.to(roomCode).emit('start-canceled', null, '');
  if (!begun || !begun.result) return;

  const { words, roster } = begun.result;
  console.log(`Words for room ${roomCode}:`, words.regular);
  // Everyone gets it, but only the players in the round play it - the rest stay in the lobby
  io.to(roomCode).emit('gameWords', { round: token, roster, words: words.jumbled, level: 0, points: 0, skipped: [], secondsLeft: LEVEL_SECONDS, highest: null });
}

// Snapshot of a finished round for its results screen
function buildResults(room, winner) {
  const round = room.round;
  const inRoom = new Set(room.players.map(p => p.id));
  const players = Object.entries(round.progress)
    .map(([id, p]) => ({ id, name: p.name, points: p.points, solved: p.solved, level: p.level, left: !inRoom.has(id) }));
  players.sort((a, b) => (b.id === winner.id) - (a.id === winner.id) || b.level - a.level || b.points - a.points);
  return {
    round: round.id,
    winnerId: winner.id,
    winnerName: winner.name,
    players,
    words: round.words.regular.map((word, i) => ({ word, scramble: round.words.jumbled[i], first: round.solves[i] || null })),
  };
}


// Puts a game page's player in its room, or back in their place there: the same screen, and in a round
// that's still going, the same word with the time they had left. auth comes with the connection (see lobby.js).
async function enterRoom(socket, { roomCode, token, name }) {
  name = typeof name === 'string' ? name.trim().slice(0, 20) : '';
  if (typeof roomCode !== 'string' || typeof token !== 'string' || token.length < 16 || !name) {
    socket.emit('roomNotFound', roomCode);
    return;
  }
  const id = playerIdFor(token);
  // Into the socket room before the others can see this player, so no news about the room is missed
  await socket.join(roomCode);

  const entered = await changeRoom(roomCode, (room) => {
    let player = room.players.find(p => p.id === id);
    const back = !!player;
    // The same browser in another tab: this one takes over
    const replaced = back && player.socketId && player.socketId !== socket.id ? player.socketId : null;
    if (!player) {
      player = { id, name, socketId: null, status: 'lobby', ready: false, awaySince: null };
      room.players.push(player);
    }
    player.name = name;
    player.socketId = socket.id;
    player.awaySince = null;

    const you = { id };
    const progress = room.round && room.round.progress[id];
    if (progress) {
      // Still in the round, or back in it after leaving - unless it's over by now
      player.status = 'game';
      player.ready = false;
      you.round = { round: room.round.id, words: room.round.words.jumbled, level: progress.level, points: progress.points, skipped: progress.skipped, secondsLeft: resumeClock(progress), highest: room.round.highest };
    } else if (player.status === 'results') {
      you.results = room.results;
    }
    return { back, replaced, you };
  });
  if (!entered) {
    await socket.leave(roomCode);
    socket.emit('roomNotFound', roomCode);
    return;
  }

  socket.data.roomCode = roomCode;
  socket.data.playerId = id;
  const { back, replaced, you } = entered.result;
  if (replaced) io.to(replaced).emit('replaced');
  socket.emit('joined', { ...you, state: entered.state });
  if (!back) {
    socket.to(roomCode).emit('new-player', name);
    console.log(`Player ${name} (${id}) joined room ${roomCode}`);
  }
}

function isCreatable(s, t) {
  if(s.length!==t.length){
      return false;
  }
  let count = new Array(256).fill(0);
  for(let i=0; i<s.length; i++){
      count[s.charCodeAt(i)]++;
      count[t.charCodeAt(i)]--;
  }
  for(let i=0; i<count.length; i++){
      if(count[i]!==0){
          return false;
      }
  }
  return true;
}

// Handlers wait on the store now, so two events from one socket could finish out of order (say a gameOver
// and the disconnect right behind it). Each socket's handlers run one at a time, in the order they arrived.
const queues = new WeakMap();
function handle(socket, event, handler) {
  socket.on(event, (...args) => {
    const queued = (queues.get(socket) || Promise.resolve())
      .then(() => handler(...args))
      .catch((err) => console.error(`${event} failed:`, err.message));
    queues.set(socket, queued);
  });
}


io.on('connection', (socket) => {
  const on = (event, handler) => handle(socket, event, handler);
  // This socket's player in the room, as long as it's still theirs (another tab can take over - see enterRoom)
  const me = (room) => room.players.find(p => p.id === socket.data.playerId && p.socketId === socket.id);

  console.log("connection: ", socket.id);

  // A game page says which room it's in as it connects (see lobby.js), and that's handled before anything else
  // it sends - after a dropped connection, the answers and levels it held on to arrive right behind it
  if (socket.handshake.auth && socket.handshake.auth.roomCode) {
    queues.set(socket, enterRoom(socket, socket.handshake.auth).catch((err) => console.error('Joining a room failed:', err.message)));
  }


  // Counted from the rooms, which every instance shares: people in a lobby, a game or on a results screen.
  // (Asking the other instances via io.fetchSockets() doesn't work on Upstash - it can't tell the adapter
  // how many servers are listening, so each instance only ever counted its own connections.)
  on('adminConnected', async () => {
    const rooms = await liveRooms();
    const players = rooms.reduce((n, r) => n + r.players.length, 0);
    socket.emit('currentAliveConnections', players, rooms.filter(r => r.round).length, storageStatus());
  });

  // For the home page's "3 rooms playing now"
  on('getLiveStats', async () => {
    socket.emit('liveStats', { playing: await roomsPlaying() });
  });



  on('createRoom', async () => {
    const room = { v: ROOM_VERSION, roomCode: null, players: [], wins: {}, countdown: null, round: null, results: null, emptySince: null };
    trackEmpty(room); // starts empty - the creator's lobby page has to arrive within EMPTY_ROOM_TTL
    do {
      room.roomCode = generateJoinCode();
    } while (!(await store.create(room)));
    socket.emit('roomCreated', room.roomCode);
    console.log(`Room ${room.roomCode} created`);
  });



  on('joinRoom', async (data) => {
    if (!data) return;
    const roomCode = data.roomCode;
    const room = await findRoom(roomCode);
    if (!room) {
      socket.emit('roomNotFound', roomCode);
      return;
    }
    // Players are added when their game page connects (enterRoom). Adding this home page
    // socket too left a duplicate "ghost" player that later triggered a fake "left the room" alert.
    socket.emit('roomJoined', roomCode);
  });


  // Game pages from before players joined as they connect, still open when this was deployed: send them home
  on('join-socket-room', async () => socket.emit('roomNotFound'));



  // The lobby's Ready button. Once everyone in the room is ready, the round starts (see followRules).
  on('set-ready', async (ready) => {
    await changeRoom(socket.data.roomCode, (room) => {
      const player = me(room);
      if (player && player.status === 'lobby') player.ready = !!ready;
    });
  });

  // Play again on the results screen: back to the lobby, ready for the next round
  on('play-again', async (ack) => {
    await changeRoom(socket.data.roomCode, (room) => {
      const player = me(room);
      if (player && player.status === 'results') {
        player.status = 'lobby';
        player.ready = true;
      }
    });
    if (typeof ack === 'function') ack();
  });



  // Leaving on purpose (the home button). A round they were in waits for them in case they come back.
  on('leave-room', async (ack) => {
    const { roomCode, playerId } = socket.data;
    if (roomCode) {
      socket.data.roomCode = null;
      await socket.leave(roomCode);
      const left = await changeRoom(roomCode, (room) => {
        const player = room.players.find(p => p.id === playerId);
        if (!player) return;
        pauseClock(room, playerId);
        room.players = room.players.filter(p => p !== player);
        // Leaving on purpose doesn't wait out EMPTY_ROOM_TTL
        if (isEmpty(room)) return store.DELETE;
        return player.name;
      });
      if (left && left.deleted) console.log(`Room ${roomCode} deleted - the last player left`);
      else if (left && left.result) announceLeft(roomCode, left.result);
    }
    if (typeof ack === 'function') ack();
  });


  // A dropped connection keeps the player's place for AWAY_GRACE - long enough to reload or reconnect
  on('disconnect', async () => {
    console.log("disconnect: ", socket.id);
    const { roomCode, playerId } = socket.data;
    if (!roomCode) return;
    const away = await changeRoom(roomCode, (room) => {
      const player = room.players.find(p => p.id === playerId);
      // Already back on another connection
      if (!player || player.socketId !== socket.id) return false;
      player.socketId = null;
      player.awaySince = Date.now();
      pauseClock(room, playerId);
      return true;
    });
    // If nothing else happens in the room, this is when it notices they're gone for good
    if (away && away.result) {
      setTimeout(() => tidyRoom(roomCode).catch((err) => console.error(`Tidying room ${roomCode} failed:`, err.message)), AWAY_GRACE + 1000);
    }
  });




  on('answerAttempt', async (data) => {
    if (!data) return;
    const { roomCode } = socket.data;
    const answered = await changeRoom(roomCode, (room) => {
      const player = me(room);
      const progress = player && room.round && room.round.progress[player.id];
      if (!progress) return;
      // Ignore stray submits - these used to crash the whole server
      const word = Number.isInteger(data.level) && room.round.words.regular[data.level];
      if (!word || typeof data.answer !== 'string') return;
      // Already past this level (a duplicate submit) - don't score it twice
      if (data.level < progress.level) return;
      const correctAnswer = word.toLowerCase();
      // Points are kept here rather than trusting the browser's count
      let gained = 0;

      if (data.answer === correctAnswer) {
        gained = 2;
      } else if (wordExists(data.answer) && isCreatable(data.answer, correctAnswer)) {
        gained = 1;
      }

      if (gained) {
        progress.level = data.level + 1;
        progress.points += gained;
        progress.solved += 1;
        progress.levelStartedAt = Date.now();
        progress.secondsLeft = null;
        if (!room.round.solves[data.level]) {
          room.round.solves[data.level] = { name: player.name, seconds: Math.round((Date.now() - room.round.startedAt) / 1000) };
        }
      }
      return { name: player.name, gained, points: progress.points };
    });
    if (!answered || !answered.result) return;

    const { name, gained, points } = answered.result;
    console.log(`Player ${name} answered level ${data.level} in room ${roomCode}: ${data.answer}`);
    socket.emit('answerResult', gained > 0, data.level, points, gained);
  });




  // level: the one the player has moved on to. skipped: they got there because the clock ran out.
  on('levelCompleted', async (data) => {
    if (!data || !Number.isInteger(data.level)) return;
    const { roomCode } = socket.data;
    const completed = await changeRoom(roomCode, (room) => {
      const player = me(room);
      const round = room.round;
      const progress = player && round && round.progress[player.id];
      if (!progress) return;
      // A right answer has already moved them on (answerAttempt) - this is for the clock running out
      if (data.level > progress.level) {
        if (data.skipped) progress.skipped.push(data.level - 1);
        progress.level = Math.min(data.level, round.words.regular.length);
        progress.levelStartedAt = Date.now();
        progress.secondsLeft = null;
      }

      if (round.highest && round.highest.level >= progress.level) return;
      round.highest = { id: player.id, name: player.name, level: progress.level };
      return round.highest;
    });
    if (!completed || !completed.result) return;

    const { id, name, level } = completed.result;
    console.log(`Player ${name} completed level ${level} in room ${roomCode}`);
    io.to(roomCode).emit('newHighestPlayer', id, name, level);
  });



  on('gameOver', async () => {
    const { roomCode } = socket.data;
    const over = await changeRoom(roomCode, (room) => {
      const player = me(room);
      const round = room.round;
      // Only someone who has actually reached the last word wins - and only the first, since the
      // round is over (gone) by the time a near-simultaneous second finish arrives
      const progress = player && round && round.progress[player.id];
      if (!progress || progress.level < round.words.regular.length) return;
      room.results = buildResults(room, player);
      room.wins[player.id] = (room.wins[player.id] || 0) + 1;
      room.round = null;
      // Everyone who was playing moves on to the results (still in the game, as far as the lobby can tell,
      // until they press Play again)
      room.players.forEach(p => {
        if (p.status === 'game') p.status = 'results';
      });
      return room.results;
    });
    if (!over || !over.result) return;

    console.log(`Player ${over.result.winnerName} won the game in room ${roomCode}`);
    io.to(roomCode).emit('round-over', over.result);
  });





  on('timeWarning', async (data) => {
    if (!data) return;
    const room = await findRoom(socket.data.roomCode);
    const word = room && room.round && Number.isInteger(data.level) && room.round.words.regular[data.level];
    if (word) socket.emit('timeUpdate', word);
  });

});











const createPartitions = (count=10, divisions=3) => {
  const base = Math.floor(count / divisions);
  const remainder = count % divisions;

  // distribute remainder across the first few parts
  const parts = [base, base, base];
  for (let i = 0; i < remainder; i++) {
    parts[i]++;
  }

  return parts;
}

// Fisher-Yates shuffle (returns a new array)
function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}


// Words come from the local list in words.js. The old random-word API is shut down
// (it returns HTTP 402), which made every game start with zero words and end instantly.
const getRandomWords = (count=10, divisions=3) => {
  const partitions = createPartitions(count, divisions);
  console.log(partitions);

  let words = [];

  for (let i=0; i<partitions.length; i++) {
    if (partitions[i] <= 0) partitions[i] = 1;
    words.push(shuffle(WORDS[i+3]).slice(0, partitions[i]));
  }

  return words.flat();
}




// Function to generate an random disorganization of a given word
function jumbleWord(word) {
  // A word made of one repeated letter can never come out different (and would recurse forever)
  if (new Set(word).size < 2) return word;

  const jumbled = shuffle(word.split('')).join('');

  // Make sure the jumbled word is different from the original
  if (jumbled === word) {
    return jumbleWord(word);
  }

  return jumbled;
}

// Function to take the selected words and return an array of jumbled words
function jumbleWords(words) {
  return words.map(word => jumbleWord(word));
}
