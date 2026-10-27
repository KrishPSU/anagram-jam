const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
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
// app.use('/game/:roomCode/end', express.static(path.join(__dirname, 'end-screen')));  
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
app.get('/game/:roomCode/end', async (req, res) => {
  const room = await findRoom(req.params.roomCode);
  if (!room) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'end-screen', 'end.html'));
});

// Static assets for the end page (no params)
app.use('/end-screen', express.static(path.join(__dirname, 'end-screen'), { redirect: false }));

// Summary only - sending the full rooms would leak every game's answers
app.get('/rooms', async (req, res) => {
  const rooms = await liveRooms();
  res.send(rooms.map(r => ({ roomCode: r.roomCode, players: r.players.map(p => p.name), gameStarted: r.gameStarted })));
});





function generateJoinCode() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 5; i++) code += letters[Math.floor(Math.random() * letters.length)];
  return code;
}


// Nobody in the lobby or the game, and nobody reading the results. Play again on the results
// screen leads back to the room, so the people reading them count as being in it.
function isEmpty(room) {
  return room.players.length === 0 && room.viewers.length === 0;
}

// Notes when the room went empty (null while someone is in it). changeRoom does this after every change.
function trackEmpty(room) {
  room.emptySince = isEmpty(room) ? (room.emptySince || Date.now()) : null;
}

// Judged by the clock rather than a timer per room: a serverless instance (Vercel) is suspended while it
// has nothing to do, and timers don't fire then
function isAbandoned(room) {
  return !!room.emptySince && Date.now() - room.emptySince >= EMPTY_ROOM_TTL;
}

// The room, or null if there's no such room. One nobody has been in for too long counts as gone (and is deleted).
async function findRoom(roomCode) {
  if (typeof roomCode !== 'string') return null;
  const room = await store.get(roomCode);
  if (room && isAbandoned(room)) {
    await deleteIfAbandoned(roomCode);
    return null;
  }
  return room;
}

// Applies change(room) as one step (see store.update). It runs again if another server instance changed the
// room at the same moment, so it must only edit the room - emit and log afterwards, using what it returns.
// Resolves to null if there's no such room, otherwise { result, deleted }.
async function changeRoom(roomCode, change) {
  if (typeof roomCode !== 'string') return null;
  let abandoned = false;
  const outcome = await store.update(roomCode, (room) => {
    abandoned = isAbandoned(room);
    if (abandoned) return store.DELETE;
    const result = change(room);
    if (result !== store.DELETE) trackEmpty(room);
    return result;
  });
  if (abandoned) console.log(`Room ${roomCode} deleted - nobody was in it`);
  if (!outcome || abandoned) return null;
  return { result: outcome.result, deleted: !!outcome.deleted };
}

async function deleteIfAbandoned(roomCode) {
  await changeRoom(roomCode, () => {});
}

// Rooms in memory that nobody looks up again are cleaned up here: all of them without Redis, and with
// Redis the ones created while it wasn't answering. Redis expires its own rooms (see store.js), so this
// never spends any of the free plan's commands.
setInterval(async () => {
  try {
    for (const roomCode of await store.emptySince(Date.now() - EMPTY_ROOM_TTL)) await deleteIfAbandoned(roomCode);
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
    const playing = (await liveRooms()).filter(r => r.gameStarted && r.players.length > 0).length;
    liveStats = { at: Date.now(), playing };
  }
  return liveStats.playing;
}

// The room's creator leads whenever they're in it, otherwise whoever has been in the room longest
function pickLeader(room) {
  const leader = room.players.find(p => p.isHost) || room.players[0];
  return leader ? leader.id : null;
}

// Takes a player out of the room. Returns what to tell everyone (see announceLeft), or null if they weren't in it.
function removePlayer(room, playerId) {
  const leavingPlayer = room.players.find(p => p.id === playerId);
  if (!leavingPlayer) return null;
  // Keep their progress in case they're only reloading (restored in join-socket-room)
  if (room.gameStarted) {
    room.stash[leavingPlayer.name] = { name: leavingPlayer.name, level: leavingPlayer.level, points: leavingPlayer.points, solved: leavingPlayer.solved };
  }
  room.players = room.players.filter(p => p.id !== playerId);
  room.leaderId = pickLeader(room);

  if (room.players.length === 0) {
    // Nobody is left to finish a game that was in progress
    room.gameStarted = false;
    room.startToken = null;
  }
  return { id: playerId, name: leavingPlayer.name, players: room.players, leaderId: room.leaderId };
}

function announceLeft(roomCode, left) {
  io.to(roomCode).emit('playerLeft', left.name, left.players, left.leaderId);
  console.log(`Player ${left.name} (${left.id}) left room ${roomCode}`);
}

// Snapshot for the results screen - players leave the room as they move to that page
function buildResults(room, winnerId) {
  const players = room.players
    .map(p => ({ id: p.id, name: p.name, points: p.points, solved: p.solved, level: p.level }))
    .concat(Object.values(room.stash).map(p => ({ ...p, left: true })));
  players.sort((a, b) => (b.id === winnerId) - (a.id === winnerId) || b.level - a.level || b.points - a.points);
  return {
    winnerId,
    players,
    words: room.words.regular.map((word, i) => ({ word, scramble: room.words.jumbled[i], first: room.solves[i] || null })),
  };
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

  console.log("connection: ", socket.id);


  // Counted from the rooms, which every instance shares: people in a lobby, a game or on a results screen.
  // (Asking the other instances via io.fetchSockets() doesn't work on Upstash - it can't tell the adapter
  // how many servers are listening, so each instance only ever counted its own connections.)
  on('adminConnected', async () => {
    const rooms = await liveRooms();
    const players = rooms.reduce((n, r) => n + r.players.length + r.viewers.length, 0);
    socket.emit('currentAliveConnections', players, rooms.filter(r => r.gameStarted).length, storageStatus());
  });

  // For the home page's "3 rooms playing now"
  on('getLiveStats', async () => {
    socket.emit('liveStats', { playing: await roomsPlaying() });
  });



  on('createRoom', async () => {
    // hostToken is this (home page) socket's id - the creator's browser saves it as 'leaderId' to claim the host spot
    const room = { roomCode: null, players: [], viewers: [], emptySince: null, leaderId: null, hostToken: socket.id, gameStarted: false, startToken: null, words: { regular: [], jumbled: [] }, currentHighestLevel: 0, currentHighestLevelHolder: '', solves: [], stash: {}, results: null, startedAt: 0 };
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
    // Players are added when their game page connects (join-socket-room). Adding this home page
    // socket too left a duplicate "ghost" player that later triggered a fake "left the room" alert.
    // Send the room state to the joining player
    socket.emit('roomJoined', roomCode, room.players);
  });


  on('join-socket-room', async (roomCode, playerName, hostToken) => {
    if (typeof roomCode !== 'string') return socket.emit('roomNotFound', roomCode);
    // Into the socket room before the others can see this player, so no news about the room is missed
    await socket.join(roomCode);
    const joined = await changeRoom(roomCode, (room) => {
      const player = { id: socket.id, name: playerName, level: 0, points: 0, solved: 0, isHost: !!hostToken && hostToken === room.hostToken };
      // Back mid-game (e.g. after a reload) - pick up your progress again
      if (room.gameStarted && room.stash[playerName]) {
        Object.assign(player, room.stash[playerName]);
        delete room.stash[playerName];
        const holder = room.currentHighestLevelHolder;
        if (holder && holder.name === playerName) holder.id = socket.id;
      }
      room.players.push(player);
      room.leaderId = pickLeader(room);
      return { players: room.players, leaderId: room.leaderId, gameStarted: room.gameStarted };
    });
    if (!joined) {
      await socket.leave(roomCode);
      socket.emit('roomNotFound', roomCode);
      return;
    }
    socket.data.roomCode = roomCode;
    const { players, leaderId, gameStarted } = joined.result;
    console.log(`Player ${playerName} (${socket.id}) joined room ${roomCode}`);
    socket.to(roomCode).emit('new-player', roomCode, playerName, socket.id, players, leaderId);
    socket.emit('get-others-in-room', players, leaderId, gameStarted);
  });



  on('leave-room', async (roomCode, playerId) => {
    console.log(`Player: ${playerId} left room: ${roomCode}`);
    let left = null;
    if (typeof roomCode === 'string') await socket.leave(roomCode);
    const outcome = await changeRoom(roomCode, (room) => {
      left = removePlayer(room, socket.id);
      // Leaving on purpose doesn't wait out EMPTY_ROOM_TTL
      if (isEmpty(room)) return store.DELETE;
    });
    if (!outcome) return;
    socket.data.roomCode = null;
    if (left) announceLeft(roomCode, left);
    if (outcome.deleted) console.log(`Room ${roomCode} deleted - the last player left`);
  });


  on('disconnect', async () => {
    console.log("disconnect: ", socket.id);

    // The room this socket was playing in...
    const { roomCode, viewing } = socket.data;
    if (roomCode) {
      let left = null;
      await changeRoom(roomCode, (room) => {
        left = removePlayer(room, socket.id);
      });
      if (left) announceLeft(roomCode, left);
    }

    // ...or the room whose results it was reading
    if (viewing) {
      await changeRoom(viewing, (room) => {
        room.viewers = room.viewers.filter(id => id !== socket.id);
      });
    }
  });




  on('starting-game', async (roomCode) => {
    const starting = await changeRoom(roomCode, (room) => {
      if (room.gameStarted) return;
      if (room.leaderId !== socket.id) return;
      room.gameStarted = true;
      room.currentHighestLevel = 0;
      room.currentHighestLevelHolder = '';

      // Generate words for the game
      let levels = 10; // Default to 10 levels
      let words = getRandomWords(levels);
      room.words = { regular: words, jumbled: jumbleWords(words) };
      room.solves = words.map(() => null);
      room.stash = {};
      room.results = null;
      room.players.forEach(p => { p.level = 0; p.points = 0; p.solved = 0; });
      // Identifies this countdown, so a canceled one can't still send the words - the cancel may be
      // handled by another server instance than the one running the countdown
      room.startToken = Math.random().toString(36).slice(2);
      return { token: room.startToken, words };
    });
    if (!starting || !starting.result) return;
    console.log(`Words for room ${roomCode}:`, starting.result.words);
    io.to(roomCode).emit('game-starting');
    console.log(`Game starting in room: ${roomCode}`);

    // Send everyone the words at the same moment, once the lobby's 3-2-1 countdown is done
    setTimeout(async () => {
      try {
        const begun = await changeRoom(roomCode, (room) => {
          if (room.startToken !== starting.result.token) return; // canceled, or everyone left
          room.startToken = null;
          room.startedAt = Date.now();
          return room.words.jumbled;
        });
        if (begun && begun.result) io.to(roomCode).emit('gameWords', begun.result);
      } catch (err) {
        console.error(`Starting the game in room ${roomCode} failed:`, err.message);
      }
    }, 4000);
  });

  on('cancel-start', async (roomCode) => {
    const canceled = await changeRoom(roomCode, (room) => {
      // Only during the countdown - once the words are out the game can't be canceled
      if (room.leaderId !== socket.id || !room.startToken) return;
      room.startToken = null;
      room.gameStarted = false;
      return true;
    });
    if (!canceled || !canceled.result) return;
    io.to(roomCode).emit('start-canceled');
    console.log(`Game canceled in room: ${roomCode}`);
  });




  on('rejoin-game', async (roomCode, myId) => {
    const room = await findRoom(roomCode);
    if (!room) return;
    if (!room.gameStarted) return;
    console.log(`Player ${myId} rejoining game in room: ${roomCode}`);
    await socket.join(roomCode);
    socket.emit('gameWords', room.words.jumbled);
    // Catch the rejoining player up on who's leading (quietly - it's not a new lead)
    const holder = room.currentHighestLevelHolder;
    if (holder) socket.emit('newHighestPlayer', holder.id, holder.name, room.currentHighestLevel, true);
  });




  on('answerAttempt', async (data) => {
    if (!data) return;
    console.log(`Player ${data.name} answered level ${data.level} in room ${data.roomCode}: ${data.answer}`);
    const answered = await changeRoom(data.roomCode, (room) => {
      if (!room.gameStarted) return;
      // Ignore stray submits (e.g. Enter pressed in the lobby) - these used to crash the whole server
      const word = Number.isInteger(data.level) && room.words.regular[data.level];
      if (!word || typeof data.answer !== 'string') return;
      const player = room.players.find(p => p.id === socket.id);
      if (!player) return;
      // Already past this level (a duplicate submit) - don't score it twice
      if (data.level < player.level) return;
      const correctAnswer = word.toLowerCase();
      // Points are kept here rather than trusting the browser's count
      let gained = 0;

      if (data.answer === correctAnswer) {
        gained = 2;
      } else if (wordExists(data.answer) && isCreatable(data.answer, correctAnswer)) {
        gained = 1;
      }

      if (gained) {
        player.level = data.level + 1;
        player.points += gained;
        player.solved += 1;
        if (!room.solves[data.level]) {
          room.solves[data.level] = { name: player.name, seconds: Math.round((Date.now() - room.startedAt) / 1000) };
        }
      }
      return { gained, points: player.points, players: gained ? room.players : null };
    });
    if (!answered || !answered.result) return;

    const { gained, points, players } = answered.result;
    if (players) io.to(data.roomCode).emit('update-players', players);
    socket.emit('answerResult', gained > 0, data.level, points, gained);
  });




  on('levelCompleted', async (data) => {
    if (!data) return;
    console.log(`Player ${data.name} completed level ${data.level} in room ${data.roomCode}`);

    const completed = await changeRoom(data.roomCode, (room) => {
      // Track progress for the standings, including words skipped when the timer ran out
      let players = null;
      const player = room.players.find(p => p.id === socket.id);
      if (player && Number.isInteger(data.level) && data.level > player.level) {
        player.level = Math.min(data.level, room.words.regular.length);
        players = room.players;
      }

      if (room.currentHighestLevel >= data.level) return { players, newLeader: false };
      room.currentHighestLevel = data.level;
      room.currentHighestLevelHolder = { name: data.name, id: data.id};
      return { players, newLeader: true };
    });
    if (!completed || !completed.result) return;

    const { players, newLeader } = completed.result;
    if (players) io.to(data.roomCode).emit('update-players', players);
    if (newLeader) io.to(data.roomCode).emit('newHighestPlayer', data.id, data.name, data.level);
  });



  on('gameOver', async (data) => {
    if (!data) return;
    const over = await changeRoom(data.roomCode, (room) => {
      // Only the first player to finish wins - a second, near-simultaneous finish could otherwise change the winner
      if (!room.gameStarted) return;
      // ...and only someone who has actually reached the last word
      const winner = room.players.find(p => p.id === socket.id);
      if (!winner || winner.level < room.words.regular.length) return;
      room.gameStarted = false;
      room.results = buildResults(room, winner.id);
      return { id: winner.id, name: winner.name };
    });
    if (!over || !over.result) return;

    console.log(`Player ${over.result.name} won the game in room ${data.roomCode}`);
    io.to(data.roomCode).emit('playerFinished', over.result.id, over.result.name);
  });





  on('timeWarning', async (data) => {
    if (!data) return;
    const room = await findRoom(data.roomCode);
    if (!room) return;
    const correctAnswer = room.words.regular[data.level];
    socket.emit('timeUpdate', correctAnswer);
  });



  on('requestResults', async (roomCode) => {
    // Reading the results counts as being in the room - Play again leads back to it
    const reading = await changeRoom(roomCode, (room) => {
      if (!room.viewers.includes(socket.id)) room.viewers.push(socket.id);
      return room.results;
    });
    if (reading) socket.data.viewing = roomCode;
    socket.emit('results', reading && reading.result ? reading.result : null);
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
