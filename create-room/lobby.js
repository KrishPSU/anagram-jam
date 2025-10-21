const socket = io();


let isLeader = false;
let myId;


const state = {
  roomCode: getRoomCodeFromUrl(),
  started: false,
  players: [
    // { id: myId, name: localStorage.getItem('name'), ready: false, isYou: true, isLeader },
  ]
};



socket.on('connect', () => {
  myId = socket.id;
  socket.emit('join-socket-room', state.roomCode, localStorage.getItem('name'), myId);
});

socket.on('disconnect', () => {
  socket.emit('left', state.roomCode, myId);
});



// DOM refs
const roomCodeEl = document.getElementById('roomCode');
const waitingEl = document.getElementById('waiting');
const playersEl = document.getElementById('players');
const readyBtn = document.getElementById('readyBtn');
const leaveBtn = document.getElementById('leave');

// Render
function render() {

  if (isLeader) {
    readyBtn.style.opacity = "1";
    readyBtn.style.display = "block";
    readyBtn.style.cursor = "pointer";
  } else {
    readyBtn.style.opacity = "0";
    readyBtn.style.display = "none";
    readyBtn.style.cursor = "default";
    if (state.players.length < 2) {
      waitingEl.innerText = "Waiting for others";
    } else {
      waitingEl.innerText = "Waiting for leader to start";
    }
    waitingEl.style.display = "block";
  }
  
  roomCodeEl.textContent = state.roomCode;
  playersEl.innerHTML = '';
  state.players.forEach(player => {
    const pill = document.createElement('div');
    pill.className = 'player-pill' + (player.isYou ? ' you' : '');

    const indicator = document.createElement('div');
    indicator.className = 'ready-indicator' + (player.ready ? ' ready' : '');
    pill.appendChild(indicator);

    const name = document.createElement('div');
    name.className = 'player-name';
    name.textContent = player.name;
    pill.appendChild(name);

    if (player.isYou) {
      const badge = document.createElement('div');
      badge.className = 'you-badge';
      badge.textContent = 'YOU';
      pill.appendChild(badge);
    }

    playersEl.appendChild(pill);
  });
}



function getRoomCodeFromUrl() {
  const path = window.location.pathname;
  const segments = path.split('/').filter(segment => segment.length > 0);
  
  // Handle routes like /game/ABC123 or /join/ABC123
  if (segments.length >= 2) {
    const roomCode = segments[1];
    // Validate that it's a 5-character uppercase string
    if (/^[A-Z]{5}$/.test(roomCode)) {
      return roomCode;
    }
  }
  
  return null;
}


const roomCode = getRoomCodeFromUrl();
if (roomCode) {
  roomCodeEl.innerText = roomCode;
} else {
  window.location.href = "/";
}



// Interactions
readyBtn.addEventListener('click', () => {
  const you = state.players.find(p => p.isYou);
  if (!you.isLeader) return;

  if (state.players.length < 2) {
    waitingEl.innerText = "Waiting for others";
    waitingEl.style.display = "block";
    readyBtn.textContent = "Start";
    readyBtn.classList.remove('ready');
  } else {
    if (readyBtn.classList.contains('ready')) {
      readyBtn.textContent = 'Start';
      waitingEl.style.display = "none";
      readyBtn.classList.remove('ready');
      socket.emit('cancel-start', state.roomCode);
    } else {
      readyBtn.textContent = 'Starting.. ✔';
      readyBtn.classList.add('ready');
      waitingEl.innerText = "Starting game";
      waitingEl.style.display = "block";
      socket.emit('starting-game', state.roomCode);
    }
  }

  render();
});





leaveBtn.addEventListener('click', () => {
  socket.emit('leave-room', state.roomCode, myId);
  window.location.href = "/";
});



socket.on('playerLeft', (leavingPlayer, remainingPlayers, leaderId) => {
  console.log(`${leavingPlayer} left`);
  state.players = [];
  for (let i=0; i<remainingPlayers.length; i++) {
    if (remainingPlayers[i].id != myId) {
      console.log(remainingPlayers[i].id != myId)
      state.players.push({ id: remainingPlayers[i].id, name: remainingPlayers[i].name, isYou: false, isLeader: isLeader });
    } else {
      // let isLeader = false;
      if (localStorage.getItem('leaderId') === leaderId) {
        isLeader = true;
      }
      state.players.unshift({ id: remainingPlayers[i].id, name: remainingPlayers[i].name, isYou: true, isLeader: isLeader });
    }
  }

  showAlert(`${leavingPlayer} left the room`, 'warning');
  if (state.players.length < 2) {
    waitingEl.style.display = "block";
  } else {
    waitingEl.style.display = "none";
  }

  render();
});




socket.on('new-player', (roomCode, playerName, playerId) => {

  if (roomCode !== state.roomCode) return; // Ignore if not for this room
  if (playerId == myId) {
    const inGame = localStorage.getItem('inGame');
    console.log(state);
    if (inGame && inGame.roomCode === state.roomCode) {
      state.started = true;
      waitingEl.innerText = "Game in progress, joining...";
      socket.emit('rejoin-game', state.roomCode, myId);
    } else {
      state.started = false;
      waitingEl.innerText = "Waiting for leader to start";
      waitingEl.style.display = "block";
      localStorage.removeItem('inGame');
    }
    return;
  }

  console.log('New player joined: ', playerName, playerId);
  state.players.push({ 
    id: playerId, 
    name: playerName, 
    isYou: false 
  });

  showAlert(`${playerName} joined the room`, 'success');
  waitingEl.style.display = "none";

  console.log(state.players);
  render();
});



socket.on('get-others-in-room', (others, leaderId) => {
  console.log(others);
  for (let i=0; i<others.length; i++) {
    if (others[i].id != myId) {
      console.log(others[i].id != myId)
      state.players.push({ id: others[i].id, name: others[i].name, isYou: false, isLeader: isLeader });
    } else {
      // let isLeader = false;
      if (localStorage.getItem('leaderId') === leaderId) {
        isLeader = true;
      }
      state.players.unshift({ id: others[i].id, name: others[i].name, isYou: true, isLeader: isLeader });
    }
  }
  render();
});






socket.on('game-starting', () => {
  leaveBtn.disabled = true;
  showAlert("Game is starting!", 'success');

  state.started = true;

  socket.emit('startGame', roomCode);
});



socket.on('start-canceled', () => {
  leaveBtn.disabled = false;
  showAlert("Game start canceled", 'warning');

  state.started = false;

  waitingEl.innerText = "Waiting for leader to start";
  waitingEl.style.display = "block";
  readyBtn.textContent = "Start";
  readyBtn.classList.remove('ready');
});





function startGame(roomCode) {
  document.getElementById('lobbyWrapper').style.display = "none";
  document.getElementById('gameState').classList.add("show");
  localStorage.setItem('inGame', { roomCode: state.roomCode, level: currentLevel });
}