const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const wordExists = require('word-exists');

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
app.use('/', express.static(path.join(__dirname, 'home')));
app.use('/game/:roomCode', express.static(path.join(__dirname, 'create-room')));
// app.use('/game/:roomCode/end', express.static(path.join(__dirname, 'end-screen')));  
// app.use('/admin', express.static(path.join(__dirname, 'edit-menu-app')));


// Routes
// Optional home route (adjust if you have a home page)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'home', 'index.html'));
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

app.get('/rooms', (req, res) => {
  res.send(rooms);
});





function generateJoinCode() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 5; i++) code += letters[Math.floor(Math.random() * letters.length)];
  return code;
}


let rooms = [];


io.on('connection', (socket) => {

  console.log("connection: ", socket.id);


  socket.on('createRoom', (data) => {
    const roomCode = generateJoinCode();

    const roomAlreadyExists = rooms.find(room => room.roomCode === roomCode);
    while (roomAlreadyExists) {
      roomCode = generateJoinCode();
      roomAlreadyExists = rooms.find(room => room.roomCode === roomCode);
    }
    rooms.push({ roomCode: roomCode, players: [], leaderId: socket.id, gameStarted: false, words: [], currentHighestLevel: 0, currentHighestLevelHolder: '' });
    socket.emit('roomCreated', roomCode);

    console.log(rooms);
  });



  socket.on('joinRoom', (data) => {
    const roomCode = data.roomCode;
    const room = rooms.find(room => room.roomCode === roomCode);
    if (!room) {
      socket.emit('roomNotFound', roomCode);
      return;
    }
    room.players.push({ id: socket.id, name: data.name});
    // Send the room state to the joining player
    socket.emit('roomJoined', roomCode, room.players);
    // console.log(socket.rooms);
    console.log(room);
  });

  

  socket.on('join-socket-room', (roomCode, playerName, playerId) => {
    socket.join(roomCode);
    io.to(roomCode).emit('new-player', roomCode, playerName, socket.id);
    const room = rooms.find(room => room.roomCode === roomCode);
    if (!room) return;
    room.players.push({ id: playerId, name: playerName });
    console.log(`Join-socket-room`)
    console.log(room);
    console.log(room.players); 
    socket.emit('get-others-in-room', room.players, room.leaderId); 
  });



  socket.on('leave-room', (roomCode, playerId) => {
    console.log(`Player: ${playerId} left room: ${roomCode}`);
    const room = rooms.find(room => room.roomCode === roomCode);
    if (room) {
      socket.leave(roomCode);
      const playerIndex = room.players.findIndex(p => p.id === playerId);
      if (playerIndex !== -1) {
        const leavingPlayer = room.players[playerIndex];
        room.players.splice(playerIndex, 1);
        
        // Notify other players in the room
        io.to(roomCode).emit('playerLeft', leavingPlayer.name, room.players, room.leaderId);
      }
      console.log(room);
      if (room.players.length === 0) {
        const roomIndex = rooms.findIndex(r => r.roomCode === roomCode);
        if (roomIndex !== -1) {
          rooms.splice(roomIndex, 1);
          console.log(`Room ${roomCode} deleted - no players left`);
        }
      }
    }
  });


  socket.on('disconnect', () => {
    // Find the room that contains this player
    const room = rooms.find(room => 
      room.players.some(player => player.id === socket.id)
    );
    
    if (room) {
      // Find the specific player
      const player = room.players.find(p => p.id === socket.id);
      
      // Remove the player from the array
      room.players = room.players.filter(p => p.id !== socket.id);
      
      // Notify other players
      io.to(room.roomCode).emit('playerLeft', player.name, room.players);
      
      console.log(`Player ${player.name} (${socket.id}) left room ${room.roomCode}`);
    }
  });

  socket.on('left', (roomCode, playerId) => {
    console.log(`${playerId} LEFT: ${roomCode}`);

    const room = rooms.find(room => room.roomCode === roomCode);
    if (room) {
      const playerIndex = room.players.findIndex(p => p.id === playerId);
      if (playerIndex !== -1) {
        const leavingPlayer = room.players[playerIndex];
        room.players.splice(playerIndex, 1);
        io.to(roomCode).emit('playerLeft', leavingPlayer.name, room.players);
      }
      console.log(room);
      if (room.players.length === 0) {
        const roomIndex = rooms.findIndex(r => r.roomCode === roomCode);
        if (roomIndex !== -1) {
          rooms.splice(roomIndex, 1);
          console.log(`Room ${roomCode} deleted - no players left`);
        }
      }
    }
  });




  socket.on('starting-game', async (roomCode) => {
    const room = rooms.find(room => room.roomCode === roomCode);
    if (!room) return;
    room.gameStarted = true;
    room.currentHighestLevel = 0;
    room.currentHighestLevelHolder = '';
    console.log(`Game started in room: ${roomCode}`);

    // Generate words for the game
    let levels = 10; // Default to 10 levels
    let words = await getRandomWords(levels);
    console.log(words);
    room.words = { regular: words, jumbled: jumbleWords(words) };
    console.log(`Words for room ${roomCode}:`, words);
    io.to(roomCode).emit('game-starting');
    console.log(`Game starting in room: ${roomCode}`);
  });

  socket.on('cancel-start', (roomCode) => {
    const room = rooms.find(room => room.roomCode === roomCode);
    if (!room) return;
    room.gameStarted = false;
    io.to(roomCode).emit('start-canceled');
    console.log(`Game canceled in room: ${roomCode}`);
  });


  socket.on('startGame', async (roomCode) => {
    const room = rooms.find(room => room.roomCode === roomCode);
    if (!room) return;
    socket.emit('gameWords', room.words.jumbled);
  });




  socket.on('rejoin-game', (roomCode, myId) => {
    const room = rooms.find(room => room.roomCode === roomCode);
    if (!room) return;
    if (!room.gameStarted) return;
    console.log(`Player ${myId} rejoining game in room: ${roomCode}`);
    socket.join(roomCode);
    socket.emit('gameWords', room.words.jumbled);
  });




  socket.on('answerAttempt', (data) => {
    console.log(`Player ${data.name} answered level ${data.level} in room ${data.roomCode}: ${data.answer}`);
    const room = rooms.find(room => room.roomCode === data.roomCode);
    if (!room) return;
    const correctAnswer = room.words.regular[data.level].toLowerCase();
    let isCorrect = false;
    let points = data.points || 0;

    if (data.answer === correctAnswer) {
      isCorrect = true;
      points += 2;
    } else if (wordExists(data.answer) && isCreatable(data.answer, correctAnswer)) { 
      isCorrect = true;
      points += 1;
    }

    socket.emit('answerResult', isCorrect, data.level, points);
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
    console.log(`Player ${data.name} completed level ${data.level} in room ${data.roomCode}`);
    // You can add more logic here if needed

    const room = rooms.find(room => room.roomCode === data.roomCode);
    if (!room) return;

    if (room.currentHighestLevel >= data.level) return;
    room.currentHighestLevel = data.level;

    // if (room.currentHighestLevelHolder && room.currentHighestLevelHolder.id === data.id) return;

    room.currentHighestLevelHolder = { name: data.name, id: data.id};
    io.to(data.roomCode).emit('newHighestPlayer', data.id, data.name, data.level);
  });



  socket.on('gameOver', (data) => {
    console.log(`Player ${data.name} won the game in room ${data.roomCode}`);
    const room = rooms.find(room => room.roomCode === data.roomCode);
    if (!room) return;
    io.to(data.roomCode).emit('playerFinished', data.id, data.name);
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

async function fetchWords(difficulty, count) {
  const url = `https://random-word-api.vercel.app/api?words=${count}&length=${difficulty}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const words = await response.json(); // returns an array
    console.log(`Fetched words | C:${count} | D:${difficulty}:`, words);
    return words;

  } catch (error) {
    console.error("Error fetching words:", error);
    return [];
  }
}


const getRandomWords = async (count=10, divisions=3) => {
  const partitions = createPartitions(count, divisions);
  console.log(partitions);
  
  let words = [];

  for (let i=0; i<partitions.length; i++) {
    if (partitions[i] <= 0) partitions[i] = 1;
    words.push(await fetchWords(i+3, partitions[i]));
  }

  return words.flat();
}




// Function to generate an random disorganization of a given word
function jumbleWord(word) {
  const letters = word.split('');
  
  // Fisher-Yates shuffle
  for (let i = letters.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [letters[i], letters[j]] = [letters[j], letters[i]];
  }
  
  const jumbled = letters.join('');
  
  // Make sure the jumbled word is different from the original
  // If it's the same, try shuffling again (only for words with 2+ letters)
  if (jumbled === word && word.length > 1) {
    return jumbleWord(word);
  }
  
  return jumbled;
}

// Function to take the selected words and return an array of jumbled words
function jumbleWords(words) {
  return words.map(word => jumbleWord(word));
}