// First-time visitors (e.g. someone opening a shared link) need to pick a name - keep the room code for them
if (!localStorage.getItem('name')) {
  const code = getRoomCodeFromUrl();
  window.location.replace(code ? '/?room=' + code : '/');
}

const socket = io();


let isLeader = false;
let myId;
let countdownTimer;


const state = {
  roomCode: getRoomCodeFromUrl(),
  started: false,
  inProgress: false, // a round was already running when you arrived
  players: [
    // { id: myId, name: localStorage.getItem('name'), ready: false, isYou: true, isLeader },
  ]
};



socket.on('connect', () => {
  if (!localStorage.getItem('name')) return;
  myId = socket.id;
  sessionStorage.setItem('myId', myId); // the end screen uses this to know if you won
  socket.emit('join-socket-room', state.roomCode, localStorage.getItem('name'), localStorage.getItem('leaderId'));
});

socket.on('roomNotFound', () => {
  window.location.href = "/";
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
  }

  // During the countdown the waiting text shows the countdown instead
  if (!state.started) {
    if (state.inProgress) {
      waitingEl.innerText = "Game in progress, you'll join the next round";
    } else if (state.players.length < 2) {
      waitingEl.innerText = isLeader ? "Waiting for players to join" : "Waiting for others";
    } else {
      waitingEl.innerText = "Waiting for leader to start";
    }
    // The leader shouldn't be told to wait for the leader - their Start button is the prompt
    waitingEl.style.display = (isLeader && state.players.length >= 2 && !state.inProgress) ? "none" : "block";
  }

  roomCodeEl.textContent = state.roomCode;
  playersEl.innerHTML = '';
  console.log('state.players', state.players);
  state.players.forEach(player => {
    const pill = document.createElement('div');
    pill.className = 'player-pill' + (player.isYou ? ' you' : '');

    const indicator = document.createElement('div');
    indicator.className = 'ready-indicator' + (player.ready ? ' ready' : '');
    pill.appendChild(indicator);

    const name = document.createElement('div');
    name.className = 'player-name';
    name.textContent = `${player.name}`;
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


// Rebuild the player list from the server's copy (you first). Appending to the old list
// duplicated everyone after a reconnect.
function setPlayers(players, leaderId) {
  isLeader = leaderId === myId;
  state.players = players.map(p => ({ id: p.id, name: p.name, isYou: p.id === myId, isLeader: p.id === leaderId, level: p.level }));
  state.players.sort((a, b) => b.isYou - a.isYou);
}


// The room/level you're in mid-game, so a reload can rejoin. Stored as JSON because
// localStorage only holds strings (objects used to be saved as "[object Object]").
function getInGame() {
  try {
    return JSON.parse(localStorage.getItem('inGame'));
  } catch {
    return null;
  }
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
  if (!isLeader) return;

  if (state.players.length < 2) {
    waitingEl.innerText = "Waiting for players to join";
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
});





leaveBtn.addEventListener('click', () => {
  socket.emit('leave-room', state.roomCode, myId);
  window.location.href = "/";
});



socket.on('playerLeft', (leavingPlayer, remainingPlayers, leaderId) => {
  console.log(`${leavingPlayer} left`);
  const wasLeader = isLeader;
  setPlayers(remainingPlayers, leaderId);

  showAlert(`${leavingPlayer} left the room` + (isLeader && !wasLeader ? " - you're the leader now" : ''), 'warning');
  if (state.started) loadLeaderboard(state.players);

  render();
});




socket.on('new-player', (roomCode, playerName, playerId, all_players, leaderId) => {

  if (roomCode !== state.roomCode) return; // Ignore if not for this room

  console.log('New player joined: ', playerName, playerId);
  setPlayers(all_players, leaderId);

  showAlert(`${playerName} joined the room`, 'success');

  console.log(state.players);
  render();
});



socket.on('get-others-in-room', (others, leaderId, gameStarted) => {
  console.log(others);
  setPlayers(others, leaderId);

  const inGame = getInGame();
  if (gameStarted && inGame && inGame.roomCode === state.roomCode) {
    // Reloaded or reconnected mid-game - pick up where you left off
    state.started = true;
    waitingEl.innerText = "Game in progress, joining...";
    waitingEl.style.display = "block";
    socket.emit('rejoin-game', state.roomCode, myId);
  } else {
    state.inProgress = gameStarted;
    localStorage.removeItem('inGame');
  }
  render();
});






// The server sends the words (see game.js 'gameWords') when this countdown finishes
socket.on('game-starting', () => {
  leaveBtn.disabled = true;
  showAlert("Game is starting!", 'success');

  state.started = true;

  let count = 3;
  waitingEl.innerText = "Starting game in 3";
  waitingEl.style.display = "block";
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    count--;
    waitingEl.innerText = count > 0 ? `Starting game in ${count}` : "Starting game now!";
    if (count === 0) clearInterval(countdownTimer);
  }, 1000);
});



socket.on('start-canceled', () => {
  leaveBtn.disabled = false;
  showAlert("Game start canceled", 'warning');

  state.started = false;
  clearInterval(countdownTimer);

  readyBtn.textContent = "Start";
  readyBtn.classList.remove('ready');
  render();
});
