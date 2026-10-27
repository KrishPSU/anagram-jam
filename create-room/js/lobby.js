// First-time visitors (e.g. someone opening a shared link) need to pick a name - keep the room code for them
if (!localStorage.getItem('name')) {
  const code = getRoomCodeFromUrl();
  window.location.replace(code ? '/?room=' + code : '/');
}

const socket = connectSocket();


let isLeader = false;
let myId;
let countdownTimer;
let seenPlayers = new Set(); // ids already shown, so only new arrivals animate in


const state = {
  roomCode: getRoomCodeFromUrl(),
  started: false,
  inProgress: false, // a round was already running when you arrived
  players: [
    // { id: myId, name: localStorage.getItem('name'), isYou: true, isLeader, level, points },
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
const eyebrowEl = document.getElementById('lobbyEyebrow');
const waitingEl = document.getElementById('waiting');
const playersEl = document.getElementById('players');
const readyBtn = document.getElementById('readyBtn');
const leaveBtn = document.getElementById('leave');
const inviteBtn = document.getElementById('inviteBtn');
const countdownEl = document.getElementById('countdown');
const countNumEl = document.getElementById('countNum');
const cancelStartBtn = document.getElementById('cancelStart');

// Render
function render() {
  readyBtn.hidden = !isLeader;

  const count = state.players.length;
  eyebrowEl.textContent = `Lobby · ${count} ${count === 1 ? 'player' : 'players'}`;

  // During the countdown the overlay does the talking
  if (!state.started) {
    const leader = state.players.find(p => p.isLeader);
    if (state.inProgress) {
      waitingEl.textContent = "A game is in progress. You'll join the next round.";
    } else if (count < 2) {
      waitingEl.textContent = isLeader ? "Waiting for players to join…" : "Waiting for others…";
    } else if (isLeader) {
      waitingEl.textContent = "Everyone in? Press Start.";
    } else {
      waitingEl.textContent = `Waiting for ${leader ? leader.name : 'the leader'} to start…`;
    }
  }

  playersEl.innerHTML = '';
  console.log('state.players', state.players);
  state.players.forEach(player => {
    const pill = document.createElement('div');
    pill.className = 'player-pill' + (player.isYou ? ' you' : '') + (seenPlayers.has(player.id) ? '' : ' join');

    pill.appendChild(avatarEl(player.name));

    const name = document.createElement('div');
    name.className = 'player-name';
    name.textContent = `${player.name}`;
    pill.appendChild(name);

    if (player.isLeader) {
      const crown = document.createElement('span');
      crown.className = 'crown';
      crown.textContent = '👑';
      crown.title = 'Leader - starts the game';
      crown.setAttribute('aria-label', 'Leader');
      pill.appendChild(crown);
    }

    if (player.isYou) {
      const badge = document.createElement('div');
      badge.className = 'you-badge';
      badge.textContent = 'YOU';
      pill.appendChild(badge);
    }

    playersEl.appendChild(pill);
  });

  // An open seat makes it obvious more people can join
  if (!state.inProgress) {
    const empty = document.createElement('div');
    empty.className = 'player-pill empty';
    empty.textContent = 'Waiting for a player…';
    playersEl.appendChild(empty);
  }

  seenPlayers = new Set(state.players.map(p => p.id));
}


// Rebuild the player list from the server's copy (you first). Appending to the old list
// duplicated everyone after a reconnect.
function setPlayers(players, leaderId) {
  isLeader = leaderId === myId;
  state.players = players.map(p => ({ id: p.id, name: p.name, isYou: p.id === myId, isLeader: p.id === leaderId, level: p.level, points: p.points }));
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
  [...roomCode].forEach(letter => {
    const tile = document.createElement('span');
    tile.className = 'tile';
    tile.textContent = letter;
    roomCodeEl.appendChild(tile);
  });
  roomCodeEl.setAttribute('aria-label', `Room code ${roomCode}`);
} else {
  window.location.href = "/";
}



// Interactions
readyBtn.addEventListener('click', () => {
  if (!isLeader) return;

  if (state.players.length < 2) {
    waitingEl.textContent = "You need at least 2 players to start.";
    waitingEl.classList.remove('shake');
    void waitingEl.offsetWidth;
    waitingEl.classList.add('shake');
    return;
  }

  readyBtn.disabled = true;
  socket.emit('starting-game', state.roomCode);
  // If the server didn't start it (e.g. you stopped being leader), let the button work again
  setTimeout(() => { if (!state.started) readyBtn.disabled = false; }, 2000);
});

cancelStartBtn.addEventListener('click', () => {
  socket.emit('cancel-start', state.roomCode);
});

// Phones get the share sheet; everywhere else the link is copied
inviteBtn.addEventListener('click', async () => {
  const url = `${window.location.origin}/game/${state.roomCode}/`; // the slash saves a redirect for whoever opens it
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title: 'Anagram Jam', text: `Join my Anagram Jam room: ${state.roomCode}`, url });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // closed the share sheet
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    showAlert('Invite link copied. Send it to your friends!', 'success');
  } catch {
    showAlert(`Share this link: ${url}`, 'info');
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
  sfx.join();

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
    waitingEl.textContent = "Game in progress, joining…";
    socket.emit('rejoin-game', state.roomCode, myId);
  } else {
    state.inProgress = gameStarted;
    localStorage.removeItem('inGame');
  }
  render();
});



function showCountdown() {
  countdownEl.hidden = false;
  cancelStartBtn.hidden = !isLeader;

  const show = (text) => {
    countNumEl.textContent = text;
    countNumEl.classList.remove('tick');
    void countNumEl.offsetWidth; // restart the animation
    countNumEl.classList.add('tick');
  };

  let count = 3;
  show(count);
  sfx.beep();
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    count--;
    if (count > 0) {
      show(count);
      sfx.beep();
    } else {
      show('GO!');
      sfx.go();
      cancelStartBtn.hidden = true; // too late to cancel now
      clearInterval(countdownTimer);
    }
  }, 1000);
}

function hideCountdown() {
  clearInterval(countdownTimer);
  countdownEl.hidden = true;
}



// The server sends the words (see game.js 'gameWords') when this countdown finishes
socket.on('game-starting', () => {
  leaveBtn.disabled = true;
  readyBtn.disabled = true;

  state.started = true;
  showCountdown();
});



socket.on('start-canceled', () => {
  leaveBtn.disabled = false;
  readyBtn.disabled = false;
  hideCountdown();
  showAlert("Game start canceled", 'warning');

  state.started = false;
  render();
});
