const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

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
app.use('/join/:roomCode', express.static(path.join(__dirname, 'join-room')));
app.use('/game/:roomCode', express.static(path.join(__dirname, 'create-room')));
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




  socket.on('starting-game', (roomCode) => {
    const room = rooms.find(room => room.roomCode === roomCode);
    if (!room) return;
    room.gameStarted = true;
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


  socket.on('startGame', (roomCode) => {
    const room = rooms.find(room => room.roomCode === roomCode);
    if (!room) return;
    room.gameStarted = true;
    console.log(`Game started in room: ${roomCode}`);

    // Generate words for the game
    let levels = 10; // Default to 10 levels
    let words = getRandomElements(wordsDB, levels);
    console.log(words);
    room.words = words;
    console.log(`Words for room ${roomCode}:`, words);
    io.to(roomCode).emit('gameWords', jumbleWords(words));
  });




  socket.on('answerAttempt', (data) => {
    console.log(`Player ${data.name} answered level ${data.level} in room ${data.roomCode}: ${data.answer}`);
    const room = rooms.find(room => room.roomCode === data.roomCode);
    if (!room) return;
    const correctAnswer = room.words[data.level].toLowerCase();
    const isCorrect = data.answer === correctAnswer;
    socket.emit('answerResult', isCorrect, data.level);
  });




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











// Word database organized by length
const wordsDB = [
  "the","and","for","you","are","but","not","all","any","can","her","his","our","was","one","out","use","how","why","now","too","new","old",
  "man","boy","girl","dog","cat","sun","sky","air","day","end","run","car","bus","toy","job","fun","top","big","red","hot","ice","sea","art",
  "book","home","work","love","life","food","good","kind","easy","hard","fast","slow","cool","warm","cold","blue","gray","green","gold","pink",
  "rock","song","game","time","city","town","road","park","farm","shop","bank","mall","door","wall","room","yard","fish","bird","tree","seed",
  "hand","face","hair","nose","eyes","ears","legs","arms","feet","head","neck","skin","back","wind","rain","snow","fire","star","moon","lake",
  "boat","ship","sand","wave","desk","pen","page","word","line","test","quiz","math","code","data","plan","idea","goal","hope","fear","risk",
  "play","walk","talk","read","cook","make","move","ride","draw","sing","jump","help","open","look","hear","feel","send","find","give","take",
  "keep","need","wish","wait","stay","join","call","push","pull","turn","spin","lift","drop","show","hide","grow","fall","hurt","heal","rest",
  "care","calm","mean","nice","rich","poor","wise","lazy","busy","fair","just","true","fake","real","sure","only","ever","also","very","over",
  "soon","late","long","short","wide","thin","deep","high","down","left","right","north","south","east","west","above","below","after","under",
  "apple","bread","fruit","grass","house","chair","table","light","music","water","smile","dream","world","heart","happy","sweet","laugh","thank",
  "peace","watch","drink","clean","green","plant","start","begin","learn","teach","write","dance","drive","sleep","speak","paint","stand","think",
  "bring","break","clear","build","serve","close","share","visit","taste","touch","enjoy","agree","argue","prove","raise","throw","carry","smell",
  "guess","count","study","order","avoid","check","focus","match","offer","save","spend","trust","value","honor","piano","queen","tiger","zebra",
  "vivid","quiet","brave","quick","happy","sunny","funny","angry","silly","crazy","smart","sharp","ready","early","lucky","sweet","fresh","clean",
  "glow","buzz","wave","nest","drop","wink","quiz","yawn","jump","flip","clap","drip","grip","trip","bend","fold","grin","slam","snap","kick",
  "spin","swim","soar","flow","burn","melt","boil","cool","glow","bake","wash","iron","pack","mail","film","draw","edit","text","zoom","save"
]


const getRandomElements = (arr, count=10) => {
  let newArr = [];
  if (count >= arr.length) {
    return arr;
  }
  for (let i = 0; i < count; i++) {
    let newElem = arr[Math.floor(Math.random() * arr.length)];
    while (newArr.includes(newElem)) {
      newElem = arr[Math.floor(Math.random() * arr.length)];
    }
    newArr.push(newElem);
  }
  return newArr;
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