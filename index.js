const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const wordExists = require('word-exists');
const WORDS = require('./words');

require('dotenv').config();


const PORT = process.env.PORT || 3000;


const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

app.get('/game/:roomCode', (req, res) => {
  const roomCode = req.params.roomCode;
  const roomExists = rooms.find(room => room.roomCode === roomCode);
  if (roomExists) {
    res.sendFile(path.join(__dirname, 'create-room', 'game.html'));
  } else {
    res.redirect('/');
  }
});
app.get('/game/:roomCode/end', (req, res) => {
  const { roomCode } = req.params;
  const roomExists = rooms.find(r => r.roomCode === roomCode);
  if (!roomExists) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'end-screen', 'end.html'));
});

// Static assets for the end page (no params)
app.use('/end-screen', express.static(path.join(__dirname, 'end-screen'), { redirect: false }));

// Summary only - sending the full rooms would leak every game's answers
app.get('/rooms', (req, res) => {
  res.send(rooms.map(r => ({ roomCode: r.roomCode, players: r.players.map(p => p.name), gameStarted: r.gameStarted })));
});





function generateJoinCode() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 5; i++) code += letters[Math.floor(Math.random() * letters.length)];
  return code;
}


let rooms = [];
let clients = [];

// Empty rooms stick around for a while so players can reload or come back from the end screen
const EMPTY_ROOM_TTL = 10 * 60 * 1000;
const cleanupTimers = new Map();
const startTimers = new Map();

function scheduleRoomCleanup(room) {
  clearTimeout(cleanupTimers.get(room.roomCode));
  cleanupTimers.set(room.roomCode, setTimeout(() => {
    cleanupTimers.delete(room.roomCode);
    if (room.players.length === 0) deleteRoom(room);
  }, EMPTY_ROOM_TTL));
}

function deleteRoom(room) {
  clearTimeout(cleanupTimers.get(room.roomCode));
  cleanupTimers.delete(room.roomCode);
  clearTimeout(startTimers.get(room.roomCode));
  startTimers.delete(room.roomCode);
  rooms = rooms.filter(r => r !== room);
  console.log(`Room ${room.roomCode} deleted - no players left`);
}

// The room's creator leads whenever they're in it, otherwise whoever has been in the room longest
function pickLeader(room) {
  const leader = room.players.find(p => p.isHost) || room.players[0];
  return leader ? leader.id : null;
}

function removePlayer(room, playerId) {
  const leavingPlayer = room.players.find(p => p.id === playerId);
  if (!leavingPlayer) return;
  // Keep their progress in case they're only reloading (restored in join-socket-room)
  if (room.gameStarted) {
    room.stash[leavingPlayer.name] = { name: leavingPlayer.name, level: leavingPlayer.level, points: leavingPlayer.points, solved: leavingPlayer.solved };
  }
  room.players = room.players.filter(p => p.id !== playerId);
  room.leaderId = pickLeader(room);
  io.to(room.roomCode).emit('playerLeft', leavingPlayer.name, room.players, room.leaderId);
  console.log(`Player ${leavingPlayer.name} (${playerId}) left room ${room.roomCode}`);

  if (room.players.length === 0) {
    // Nobody is left to finish a game that was in progress
    room.gameStarted = false;
    clearTimeout(startTimers.get(room.roomCode));
    startTimers.delete(room.roomCode);
    scheduleRoomCleanup(room);
  }
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


io.on('connection', (socket) => {

  clients.push(socket.id);

  console.log("connection: ", socket.id);


  socket.on('adminConnected', () => {
    socket.emit('currentAliveConnections', clients.length, rooms.filter(r => r.gameStarted).length);
  });

  // For the home page's "3 rooms playing now"
  socket.on('getLiveStats', () => {
    socket.emit('liveStats', { playing: rooms.filter(r => r.gameStarted && r.players.length > 0).length });
  });



  socket.on('createRoom', () => {
    let roomCode = generateJoinCode();
    while (rooms.some(room => room.roomCode === roomCode)) {
      roomCode = generateJoinCode();
    }
    // hostToken is this (home page) socket's id - the creator's browser saves it as 'leaderId' to claim the host spot
    const room = { roomCode: roomCode, players: [], leaderId: null, hostToken: socket.id, gameStarted: false, words: { regular: [], jumbled: [] }, currentHighestLevel: 0, currentHighestLevelHolder: '', solves: [], stash: {}, results: null, startedAt: 0 };
    rooms.push(room);
    scheduleRoomCleanup(room);
    socket.emit('roomCreated', roomCode);

    console.log(rooms);
  });



   socket.on('joinRoom', (data) => {
    if (!data) return;
    const roomCode = data.roomCode;
    const room = rooms.find(room => room.roomCode === roomCode);
    if (!room) {
      socket.emit('roomNotFound', roomCode);
      return;
    }
    // Players are added when their game page connects (join-socket-room). Adding this home page
    // socket too left a duplicate "ghost" player that later triggered a fake "left the room" alert.
    // Send the room state to the joining player
    socket.emit('roomJoined', roomCode, room.players);
    // console.log(socket.rooms);
    console.log(room);
  });
  

  socket.on('join-socket-room', (roomCode, playerName, hostToken) => {
    const room = rooms.find(room => room.roomCode === roomCode);
    if (!room) {
      socket.emit('roomNotFound', roomCode);
      return;
    }
    socket.join(roomCode);
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
    console.log(`Join-socket-room`)
    console.log(room);
    socket.to(roomCode).emit('new-player', roomCode, playerName, socket.id, room.players, room.leaderId);
    socket.emit('get-others-in-room', room.players, room.leaderId, room.gameStarted);
  });



  socket.on('leave-room', (roomCode, playerId) => {
    console.log(`Player: ${playerId} left room: ${roomCode}`);
    const room = rooms.find(room => room.roomCode === roomCode);
    if (room) {
      socket.leave(roomCode);
      removePlayer(room, socket.id);
      if (room.players.length === 0) deleteRoom(room);
    }
  });


  socket.on('disconnect', () => {

    clients = clients.filter(id => id !== socket.id);
    console.log("disconnect: ", socket.id);


    // Find the room that contains this player
    const room = rooms.find(room =>
      room.players.some(player => player.id === socket.id)
    );

    if (room) removePlayer(room, socket.id);
  });




  socket.on('starting-game', (roomCode) => {
    const room = rooms.find(room => room.roomCode === roomCode);
    if (!room) return;
    if (room.gameStarted) return;
    if (room.leaderId !== socket.id) return;
    room.gameStarted = true;
    room.currentHighestLevel = 0;
    room.currentHighestLevelHolder = '';
    console.log(`Game started in room: ${roomCode}`);

    // Generate words for the game
    let levels = 10; // Default to 10 levels
    let words = getRandomWords(levels);
    room.words = { regular: words, jumbled: jumbleWords(words) };
    room.solves = words.map(() => null);
    room.stash = {};
    room.results = null;
    room.players.forEach(p => { p.level = 0; p.points = 0; p.solved = 0; });
    console.log(`Words for room ${roomCode}:`, words);
    io.to(roomCode).emit('game-starting');
    console.log(`Game starting in room: ${roomCode}`);

    // Send everyone the words at the same moment, once the lobby's 3-2-1 countdown is done
    startTimers.set(roomCode, setTimeout(() => {
      startTimers.delete(roomCode);
      room.startedAt = Date.now();
      io.to(roomCode).emit('gameWords', room.words.jumbled);
    }, 4000));
  });

  socket.on('cancel-start', (roomCode) => {
    const room = rooms.find(room => room.roomCode === roomCode);
    if (!room) return;
    // Only during the countdown - once the words are out the game can't be canceled
    if (room.leaderId !== socket.id || !startTimers.has(roomCode)) return;
    clearTimeout(startTimers.get(roomCode));
    startTimers.delete(roomCode);
    room.gameStarted = false;
    io.to(roomCode).emit('start-canceled');
    console.log(`Game canceled in room: ${roomCode}`);
  });




  socket.on('rejoin-game', (roomCode, myId) => {
    const room = rooms.find(room => room.roomCode === roomCode);
    if (!room) return;
    if (!room.gameStarted) return;
    console.log(`Player ${myId} rejoining game in room: ${roomCode}`);
    socket.join(roomCode);
    socket.emit('gameWords', room.words.jumbled);
    // Catch the rejoining player up on who's leading (quietly - it's not a new lead)
    const holder = room.currentHighestLevelHolder;
    if (holder) socket.emit('newHighestPlayer', holder.id, holder.name, room.currentHighestLevel, true);
  });




  socket.on('answerAttempt', (data) => {
    if (!data) return;
    console.log(`Player ${data.name} answered level ${data.level} in room ${data.roomCode}: ${data.answer}`);
    const room = rooms.find(room => room.roomCode === data.roomCode);
    if (!room || !room.gameStarted) return;
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
      io.to(data.roomCode).emit('update-players', room.players);
    }

    socket.emit('answerResult', gained > 0, data.level, player.points, gained);
  });


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




  socket.on('levelCompleted', (data) => {
    if (!data) return;
    console.log(`Player ${data.name} completed level ${data.level} in room ${data.roomCode}`);
    // You can add more logic here if needed

    const room = rooms.find(room => room.roomCode === data.roomCode);
    if (!room) return;

    // Track progress for the standings, including words skipped when the timer ran out
    const player = room.players.find(p => p.id === socket.id);
    if (player && Number.isInteger(data.level) && data.level > player.level) {
      player.level = Math.min(data.level, room.words.regular.length);
      io.to(data.roomCode).emit('update-players', room.players);
    }

    if (room.currentHighestLevel >= data.level) return;
    room.currentHighestLevel = data.level;

    // if (room.currentHighestLevelHolder && room.currentHighestLevelHolder.id === data.id) return;

    room.currentHighestLevelHolder = { name: data.name, id: data.id};
    io.to(data.roomCode).emit('newHighestPlayer', data.id, data.name, data.level);
  });



  socket.on('gameOver', (data) => {
    if (!data) return;
    const room = rooms.find(room => room.roomCode === data.roomCode);
    // Only the first player to finish wins - a second, near-simultaneous finish could otherwise change the winner
    if (!room || !room.gameStarted) return;
    // ...and only someone who has actually reached the last word
    const winner = room.players.find(p => p.id === socket.id);
    if (!winner || winner.level < room.words.regular.length) return;
    console.log(`Player ${winner.name} won the game in room ${data.roomCode}`);
    room.gameStarted = false;
    room.results = buildResults(room, winner.id);
    io.to(data.roomCode).emit('playerFinished', winner.id, winner.name);
  });





  socket.on('timeWarning', (data) => {
    if (!data) return;
    const room = rooms.find(room => room.roomCode === data.roomCode);
    if (!room) return;
    const correctAnswer = room.words.regular[data.level];
    socket.emit('timeUpdate', correctAnswer);
  });



  socket.on('requestResults', (roomCode) => {
    const room = rooms.find(room => room.roomCode === roomCode);
    socket.emit('results', room && room.results ? room.results : null);
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