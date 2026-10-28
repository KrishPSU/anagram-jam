const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const WORDS = require('./words');
const { createStore } = require('./store');
const { createSolo, answersFor } = require('./solo');

require('dotenv').config();

// A rejected promise nobody handles would otherwise crash the server, ending every game on it
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));


const PORT = process.env.PORT || 3000;


const app = express();
const server = http.createServer(app);
// A ping every 10 seconds, and a connection that misses one is closed: a phone that dropped off the network
// (or got locked) is noticed within 20 seconds instead of 45, so its page reconnects and its clock is paused sooner
const io = new Server(server, { pingInterval: 10000, pingTimeout: 10000 });

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

// Solo mode's runs and leaderboard, kept in the same store (see solo.js)
const solo = createSolo({ store, playerIdFor });

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
//   countdown: { token, roster, at } during the 3-2-1, roster being the ids of the players it's for,
//   round: { id, words: { regular, jumbled }, startedAt, solves, progress: { [player id]: ... } } while one is played,
//   results: the last round's, for whoever is still reading them }
// (Rooms from before 'at', gains and scoredAt were added still work: those count as missing.)
const ROOM_VERSION = 2; // rooms laid out any other way (made before this) count as gone

// Game pages say which version they are as they connect. One from another version (still open from before a
// deploy) can't play with this server, so it's sent home or told to reload - see 'connection'.
const PAGE_VERSION = 4;

const LEVEL_SECONDS = 30; // per word, as in game.js
const MIN_PLAYERS = 2;
const COUNTDOWN_MS = 4000; // the lobby's 3-2-1-GO
// A page asking for the round as its 3-2-1 ends (see beginRound) may be this early, by its own clock
const COUNTDOWN_SLACK = 500;
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
  if (news.roundOver) {
    console.log(`Round over in room ${roomCode}: ${news.roundOver.finisherName} finished, ${news.roundOver.winnerName} won`);
    io.to(roomCode).emit('round-over', news.roundOver);
  }
  if (news.countdown) beginCountdown(roomCode, news.countdown);
  return { result: outcome.result, deleted: false, state: after };
}

// What a room does on its own after any change: the round ends the moment anyone gets through every word, a
// round nobody is playing anymore is over (with no winner), the 3-2-1 stops if one of its players isn't ready
// anymore, and it starts once everyone in the room is ready.
// Returns what changeRoom has to tell everyone: { stoppedBy, countdown, roundOver }.
function followRules(room) {
  // Judged here, on every change, rather than when the finisher's page says so - that message could get lost
  let roundOver = null;
  const round = room.round;
  if (round) {
    const finisher = room.players.find(p => p.status === 'game' && round.progress[p.id] && round.progress[p.id].level >= round.words.regular.length);
    if (finisher) roundOver = endRound(room, finisher);
  }

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
    countdown = room.countdown = { token: Math.random().toString(36).slice(2), roster: room.players.map(p => p.id), at: Date.now() };
  }
  return { stoppedBy, countdown, roundOver };
}

// Ends the round. Everyone who was playing it moves on to its results (still in the game, as far as the lobby
// can tell, until they press Play again or Back to lobby), and its winner gets a win.
function endRound(room, finisher) {
  const results = buildResults(room, finisher);
  room.wins[results.winnerId] = (room.wins[results.winnerId] || 0) + 1;
  room.results = results;
  room.round = null;
  room.players.forEach(p => {
    if (p.status === 'game') p.status = 'results';
  });
  return results;
}

// Most points first. Level on points, whoever got to their score sooner is ahead; then whoever is further along.
// a and b are players' progress in a round (see beginRound).
function byStanding(a, b) {
  return b.points - a.points || (a.scoredAt || Infinity) - (b.scoredAt || Infinity) || b.level - a.level;
}

// Each player's place in the round so far (1 = ahead), for everyone in the room who's in it
function placesIn(room) {
  const ranked = room.players.filter(p => room.round.progress[p.id]).map(p => ({ id: p.id, ...room.round.progress[p.id] }));
  ranked.sort(byStanding);
  return Object.fromEntries(ranked.map((p, i) => [p.id, i + 1]));
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


// What everyone in the room sees of it - no player tokens, words or answers.
// status: in the lobby ('ready' or 'notReady'), or 'inGame' while playing the round or reading its results.
// place: where they stand in the round (see byStanding). countdown: the 3-2-1's token (the round's id to be),
// and who it's for.
function publicState(room) {
  const round = room.round;
  const places = round ? placesIn(room) : {};
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
        place: places[p.id] || null,
      };
    }),
    countdown: room.countdown ? { token: room.countdown.token, roster: room.countdown.roster } : null,
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

// The round as one player's page needs it: their words, where they are, and the seconds left on their clock
// (as it stands, unless given)
function roundFor(room, progress, secondsLeft) {
  if (secondsLeft === undefined) secondsLeft = progress.secondsLeft === null ? secondsLeftOn(progress) : progress.secondsLeft;
  return {
    round: room.round.id,
    words: room.round.words.jumbled,
    ...answerHashes(room.round.words.regular),
    level: progress.level,
    points: progress.points,
    skipped: progress.skipped,
    secondsLeft: Math.min(LEVEL_SECONDS, Math.max(1, secondsLeft)),
  };
}

// Which screen a player belongs on, and what it needs: { round } they're playing, { results } they haven't left
// yet, or {} for the lobby - with { countdown } (its token) if a 3-2-1 there is for them.
// secondsLeft: for the round, if their clock has just been started again (see enterRoom).
function placeOf(room, player, secondsLeft) {
  const progress = player.status === 'game' && room.round && room.round.progress[player.id];
  if (progress) return { round: roundFor(room, progress, secondsLeft) };
  if (player.status === 'results' && room.results) return { results: room.results };
  if (room.countdown && room.countdown.roster.includes(player.id)) return { countdown: room.countdown.token };
  return {};
}

// This socket's player in the room, as long as it's still theirs (another tab can take over - see enterRoom)
function playerOf(room, socket) {
  return room.players.find(p => p.id === socket.data.playerId && p.socketId === socket.id);
}


// Everyone in the room sees the 3-2-1 (the players it's for get the overlay). The round starts when it's
// done (see beginRound), unless it was stopped in the meantime (see followRules).
function beginCountdown(roomCode, countdown) {
  io.to(roomCode).emit('game-starting', countdown.roster, countdown.token);
  console.log(`Game starting in room: ${roomCode}`);
  // The players' pages ask for the round as their 3-2-1 ends ('start-round'). This is in case none of them do.
  setTimeout(() => {
    beginRound(roomCode, countdown.token).catch((err) => console.error(`Starting the game in room ${roomCode} failed:`, err.message));
  }, COUNTDOWN_MS);
}

// Starts the round a 3-2-1 was for, once it has run out: when the timer above goes off, or when one of its
// players' pages asks - whichever comes first. The timer alone isn't enough on Vercel: it runs on the instance that
// started the 3-2-1, and an instance whose last connection has closed (the player who tapped Ready, say, then left)
// is frozen, timers and all. Everyone stuck on GO! was that.
// socket: the asking page's. Resolves to what it should do: { round } (theirs, to play), { wait } (ms, too early),
// or { canceled: true } (the 3-2-1 was stopped, or the round isn't theirs).
async function beginRound(roomCode, token, socket) {
  let tooFew;
  const begun = await changeRoom(roomCode, (room) => {
    tooFew = false;
    const player = socket && playerOf(room, socket);
    const theirs = () => {
      const progress = player && room.round.progress[player.id];
      return progress ? { round: roundFor(room, progress) } : { canceled: true };
    };
    // Already started by the timer or another page
    if (room.round && room.round.id === token) return { reply: theirs() };
    // Stopped, or it's another countdown by now
    if (!room.countdown || room.countdown.token !== token) return { reply: { canceled: true } };
    const wait = (room.countdown.at || 0) + COUNTDOWN_MS - COUNTDOWN_SLACK - Date.now();
    if (wait > 0) return { reply: { wait } };

    const roster = room.players.filter(p => room.countdown.roster.includes(p.id));
    room.countdown = null;
    if (roster.length < MIN_PLAYERS) {
      tooFew = true;
      return { reply: { canceled: true } };
    }

    const words = getRandomWords(10);
    const now = Date.now();
    room.round = { id: token, words: { regular: words, jumbled: jumbleWords(words) }, startedAt: now, solves: words.map(() => null), progress: {} };
    room.results = null;
    roster.forEach(p => {
      p.status = 'game';
      p.ready = false;
      // gains: points for each word solved, by its level. scoredAt: when they got their latest points (ties go to
      // whoever got to their score first). Someone whose connection dropped during the 3-2-1 starts with their
      // clock stopped, like any time they're away.
      room.round.progress[p.id] = { name: p.name, level: 0, points: 0, solved: 0, skipped: [], gains: [], scoredAt: null, levelStartedAt: now, secondsLeft: p.awaySince ? LEVEL_SECONDS : null };
    });
    return { started: { words: room.round.words, roster: roster.map(p => p.id) }, reply: theirs() };
  });
  if (tooFew) io.to(roomCode).emit('start-canceled', null, '');
  if (!begun) return { canceled: true };

  const { started, reply } = begun.result;
  if (started) {
    console.log(`Words for room ${roomCode}:`, started.words.regular);
    // Everyone gets it, but only the players in the round play it - the rest stay in the lobby
    io.to(roomCode).emit('gameWords', { round: token, roster: started.roster, words: started.words.jumbled, ...answerHashes(started.words.regular), level: 0, points: 0, skipped: [], secondsLeft: LEVEL_SECONDS });
  }
  return reply;
}

// Snapshot of a finished round for its results screen. finisher got through every word first, which ended it;
// the winner is whoever has the most points (see byStanding) out of the players still in the room.
function buildResults(room, finisher) {
  const round = room.round;
  const inRoom = new Set(room.players.map(p => p.id));
  const ranked = Object.entries(round.progress).map(([id, p]) => ({ id, ...p, left: !inRoom.has(id) }));
  // Someone who left can't win, so they go below everyone still here
  ranked.sort((a, b) => a.left - b.left || byStanding(a, b));
  const [winner, runnerUp] = ranked;
  return {
    round: round.id,
    winnerId: winner.id,
    winnerName: winner.name,
    finisherId: finisher.id,
    finisherName: finisher.name,
    // Level on points with the next player, and won by getting there first
    tied: !!runnerUp && !runnerUp.left && runnerUp.points === winner.points,
    // seconds: into the round when they reached their score
    players: ranked.map(p => ({ id: p.id, name: p.name, points: p.points, solved: p.solved, level: p.level, left: p.left, seconds: p.scoredAt ? Math.round((p.scoredAt - round.startedAt) / 1000) : null })),
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

    const progress = room.round && room.round.progress[id];
    let secondsLeft;
    if (progress) {
      // Still in the round, or back in it after leaving - unless it's over by now
      player.status = 'game';
      player.ready = false;
      secondsLeft = resumeClock(progress);
    }
    return { back, replaced, you: { id, ...placeOf(room, player, secondsLeft) } };
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

// Handlers wait on the store now, so two events from one socket could finish out of order (say an answer
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


// The ack a page sent with an event, or a stand-in if it didn't send one
const replier = (ack) => (typeof ack === 'function' ? ack : () => {});


io.on('connection', (socket) => {
  const on = (event, handler) => handle(socket, event, handler);
  const me = (room) => playerOf(room, socket);

  console.log("connection: ", socket.id);

  // A game page says which room it's in as it connects (see lobby.js), and that's handled before anything else
  // it sends - after a dropped connection, the answers and levels it held on to arrive right behind it
  const auth = socket.handshake.auth || {};
  if (auth.roomCode) {
    if (auth.version === PAGE_VERSION) {
      queues.set(socket, enterRoom(socket, auth).catch((err) => console.error('Joining a room failed:', err.message)));
    } else {
      // Open from before a deploy. Pages from before versions existed only know to go home; later ones reload.
      socket.emit(auth.version ? 'outdated' : 'roomNotFound', auth.roomCode);
    }
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



  // Everything a game page asks for below answers with an ack, and is safe to ask for twice: the page asks again
  // when an answer doesn't come (see request in lobby.js), because on a phone a message can simply get lost.

  // The lobby's Ready button. Once everyone in the room is ready, the round starts (see followRules).
  on('set-ready', async (ready, ack) => {
    await changeRoom(socket.data.roomCode, (room) => {
      const player = me(room);
      if (player && player.status === 'lobby') player.ready = !!ready;
    });
    replier(ack)();
  });

  // From the results screen: Play again goes back to the lobby ready for the next round, Back to lobby doesn't
  const toLobby = (ready) => async (ack) => {
    await changeRoom(socket.data.roomCode, (room) => {
      const player = me(room);
      if (player && player.status === 'results') {
        player.status = 'lobby';
        player.ready = ready;
      }
    });
    replier(ack)();
  };
  on('play-again', toLobby(true));
  on('back-to-lobby', toLobby(false));

  // This page's 3-2-1 has run out: the round, started now if the timer hasn't already (see beginRound)
  on('start-round', async (token, ack) => {
    const reply = replier(ack);
    if (typeof token !== 'string') return reply({ canceled: true });
    reply(await beginRound(socket.data.roomCode, token, socket));
  });

  // Where this page should be. It asks when it may have missed something: a message that should have come by
  // now, or the page coming back after the phone was locked. Replies like 'joined' (see enterRoom) - or with
  // { replaced: true } if another tab has taken over, or { gone: true } if this connection isn't in the room.
  on('sync', async (ack) => {
    const reply = replier(ack);
    const synced = await changeRoom(socket.data.roomCode, (room) => {
      const player = room.players.find(p => p.id === socket.data.playerId);
      if (!player) return { gone: true };
      if (player.socketId !== socket.id) return { replaced: true };
      return { id: player.id, ...placeOf(room, player) };
    });
    if (!synced) return reply({ gone: true });
    reply({ ...synced.result, state: synced.state });
  });

  // Someone in the room has been away longer than AWAY_GRACE. The other pages send this then, since the timer
  // in 'disconnect' may never go off on Vercel (see beginRound) and their seat would hold everyone up.
  on('tidy', async () => {
    if (socket.data.roomCode) await tidyRoom(socket.data.roomCode);
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




  // An answer to word `level` of round `round`. The page checks answers itself (see submitAnswer in game.js) and reports
  // the right ones here, in order, to be checked again and scored. Replies { status: 'right' | 'wrong', level, points,
  // gained } - level being the word they're on now - or { status: 'over' } if there's no such round anymore (it ended),
  // or 'gone' if this connection isn't in the room. Reporting a word again - the reply got lost - gets the same reply,
  // scored once (or 'skipped', if the clock ran out on it instead).
  on('answerAttempt', async (data, ack) => {
    const reply = replier(ack);
    if (!data || !Number.isInteger(data.level) || typeof data.answer !== 'string') return reply({ status: 'over' });
    const { roomCode } = socket.data;
    const answered = await changeRoom(roomCode, (room) => {
      const player = me(room);
      if (!player) return { status: 'gone' };
      const round = room.round;
      const progress = round && round.id === data.round && round.progress[player.id];
      const word = progress && round.words.regular[data.level];
      if (!word) return { status: 'over' };
      if (!progress.gains) progress.gains = [];
      if (data.level < progress.level) {
        const gained = progress.gains[data.level] || 0;
        return { status: gained ? 'right' : 'skipped', level: progress.level, points: progress.points, gained };
      }
      const answer = data.answer.toLowerCase();
      const correctAnswer = word.toLowerCase();
      // Points are kept here rather than trusting the browser's count - judged on the same words as the page's (see
      // answerHashes)
      let gained = 0;

      if (answer === correctAnswer) {
        gained = 2;
      } else if (answersFor(correctAnswer).includes(answer)) {
        gained = 1;
      }

      if (gained) {
        // Words before this one that the server didn't hear the clock run out on (that message got lost)
        for (let level = progress.level; level < data.level; level++) progress.skipped.push(level);
        progress.level = data.level + 1;
        progress.points += gained;
        progress.solved += 1;
        progress.gains[data.level] = gained;
        progress.scoredAt = Date.now();
        progress.levelStartedAt = Date.now();
        progress.secondsLeft = null;
        if (!round.solves[data.level]) {
          round.solves[data.level] = { name: player.name, seconds: Math.round((Date.now() - round.startedAt) / 1000) };
        }
      }
      return { status: gained ? 'right' : 'wrong', level: progress.level, points: progress.points, gained, name: player.name };
    });
    reply(answered ? answered.result : { status: 'over' });
    if (answered && answered.result.name) {
      console.log(`Player ${answered.result.name} answered level ${data.level} in room ${roomCode}: ${data.answer} (+${answered.result.gained})`);
    }
  });

  // The clock ran out on word `level` of round `round`: on to the next one. Replies { status: 'ok', level, points } with
  // the level they're on now, or 'over' / 'gone' as for answerAttempt. Getting through the last word this way
  // ends the round too (see followRules).
  on('time-up', async (data, ack) => {
    const reply = replier(ack);
    if (!data || !Number.isInteger(data.level)) return reply({ status: 'over' });
    const done = await changeRoom(socket.data.roomCode, (room) => {
      const player = me(room);
      if (!player) return { status: 'gone' };
      const round = room.round;
      const progress = round && round.id === data.round && round.progress[player.id];
      if (!progress || data.level >= round.words.regular.length) return { status: 'over' };
      // A right answer has already moved them on (answerAttempt) - this is for the clock running out. It can be
      // more than one word on, if the page's earlier time-ups got lost.
      if (data.level >= progress.level) {
        for (let level = progress.level; level <= data.level; level++) progress.skipped.push(level);
        progress.level = data.level + 1;
        progress.levelStartedAt = Date.now();
        progress.secondsLeft = null;
      }
      return { status: 'ok', level: progress.level, points: progress.points };
    });
    reply(done ? done.result : { status: 'over' });
  });

  // The answer to word `level` of round `round`, shown when the clock is about to run out on it
  on('reveal', async (data, ack) => {
    const reply = replier(ack);
    const room = data && await findRoom(socket.data.roomCode);
    const word = room && room.round && room.round.id === data.round && Number.isInteger(data.level) && room.round.words.regular[data.level];
    reply(word || null);
  });


  // Solo mode (see solo.js). Like the game page's requests, each one always replies and is safe to ask for twice.
  on('solo-start', async (data, ack) => replier(ack)(await solo.start(data || undefined)));
  on('solo-finish', async (data, ack) => replier(ack)(await solo.finish(data || undefined)));
  on('solo-board', async (data, ack) => replier(ack)(await solo.board(data || undefined)));
  // The admin page's, which need the admin password
  on('admin-solo-board', async (data, ack) => replier(ack)(await solo.adminBoard(data || undefined)));
  on('admin-solo-remove', async (data, ack) => replier(ack)(await solo.adminRemove(data || undefined)));

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

// A stand-in for a word, so the page can check answers (and keep its shuffle button from laying the tiles out as the
// answer) without being sent the answers themselves. Same as wordHash in create-room/js/game.js (32-bit FNV-1a).
function wordHash(word) {
  let hash = 0x811c9dc5;
  for (const letter of word.toLowerCase()) hash = Math.imul(hash ^ letter.charCodeAt(0), 0x01000193);
  return hash >>> 0;
}

// The answers as a page gets them, in hashes: each word's own (2 points), and the other real words its letters make (1
// point). The page checks answers against these itself, so it never waits on the network to know if one is right (see
// submitAnswer in game.js); each is checked again here as it's reported ('answerAttempt').
function answerHashes(words) {
  return {
    hashes: words.map(wordHash),
    others: words.map(word => answersFor(word).filter(answer => answer !== word).map(wordHash)),
  };
}

// Function to take the selected words and return an array of jumbled words
function jumbleWords(words) {
  return words.map(word => jumbleWord(word));
}
