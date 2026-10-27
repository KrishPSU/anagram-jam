// First-time visitors (e.g. someone opening a shared link) need to pick a name - keep the room code for them
if (!localStorage.getItem('name')) {
  const code = getRoomCodeFromUrl();
  window.location.replace(code ? '/?room=' + code : '/');
}


// Your place in every room: a random token this browser keeps, so a reload, a dropped connection or leaving
// and coming back finds you where you were. (The server only shows the other players a hash of it.)
function playerToken() {
  let token = localStorage.getItem('playerToken');
  if (!token) {
    token = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('playerToken', token);
  }
  return token;
}


let myId;          // your id in the room, from the server
let view = null;   // the screen you're on: 'lobby', 'game' or 'results' (see showView)
let countdownTimer;
let seenPlayers = new Set(); // ids already shown, so only new arrivals animate in


const state = {
  roomCode: getRoomCodeFromUrl(),
  players: [],     // { id, name, status: 'ready' | 'notReady' | 'inGame', away, wins, level, points, isYou }, you first
  countdown: null, // ids of the players a 3-2-1 is running for
  playing: false,  // a round is being played
  total: 10,       // words in a round
};


// The room code, your token and your name go with the connection itself, so the server has you in the room
// before it handles anything else you send - again after every dropped connection, too. It connects once
// every script on the page is ready for what the server sends.
const socket = connectSocket({
  autoConnect: false,
  auth: { roomCode: state.roomCode, token: playerToken(), name: localStorage.getItem('name') },
});
if (state.roomCode && localStorage.getItem('name')) {
  document.addEventListener('DOMContentLoaded', () => socket.connect());
}

socket.on('roomNotFound', () => {
  window.location.href = "/";
});



// DOM refs
const roomCodeEl = document.getElementById('roomCode');
const eyebrowEl = document.getElementById('lobbyEyebrow');
const waitingEl = document.getElementById('waiting');
const playersEl = document.getElementById('players');
const readyBtn = document.getElementById('readyBtn');
const inviteBtn = document.getElementById('inviteBtn');
const countdownEl = document.getElementById('countdown');
const countNumEl = document.getElementById('countNum');
const cancelStartBtn = document.getElementById('cancelStart');
const lobbyWrapperEl = document.getElementById('lobbyWrapper');
const gameStateEl = document.getElementById('gameState');
const resultsEl = document.getElementById('resultsView');
const homeBtn = document.getElementById('homeBtn');
const leaveDialog = document.getElementById('leaveDialog');
const leaveNoteEl = document.getElementById('leaveNote');
const elsewhereEl = document.getElementById('elsewhere');
const useHereBtn = document.getElementById('useHere');


// Lobby, game and results are screens of this one page, so you stay in the room the whole time
function showView(next) {
  if (view === next) return;
  if (view === 'game') stopRound();
  view = next;
  document.body.classList.remove('lobby', 'game', 'end');
  document.body.classList.add({ lobby: 'lobby', game: 'game', results: 'end' }[next]);
  lobbyWrapperEl.hidden = next !== 'lobby';
  gameStateEl.classList.toggle('show', next === 'game');
  resultsEl.hidden = next !== 'results';
  if (next === 'game') startGameAudio();
  else startLobbyAudio();
  window.scrollTo(0, 0);
}


// Render

const STATUS_TEXT = { ready: '✓ Ready', notReady: 'Not ready', inGame: 'In game' };

function render() {
  const count = state.players.length;
  eyebrowEl.textContent = `Lobby · ${count} ${count === 1 ? 'player' : 'players'}`;

  const me = state.players.find(p => p.isYou);
  const ready = !!me && me.status === 'ready';
  readyBtn.hidden = !me;
  readyBtn.textContent = ready ? 'Not ready' : "I'm ready";
  readyBtn.classList.toggle('btn-go', !ready);
  readyBtn.classList.toggle('btn-ghost', ready);
  readyBtn.setAttribute('aria-pressed', ready ? 'true' : 'false');
  waitingEl.textContent = statusText(me);

  playersEl.replaceChildren(...state.players.map(playerPill));
  // An open seat makes it obvious more people can join
  const empty = document.createElement('div');
  empty.className = 'player-pill empty';
  empty.textContent = 'Waiting for a player…';
  playersEl.appendChild(empty);
  seenPlayers = new Set(state.players.map(p => p.id));

  if (view === 'game') loadLeaderboard(state.players.filter(p => p.level !== null));
}

function playerPill(player) {
  const pill = document.createElement('div');
  pill.className = 'player-pill' + (player.isYou ? ' you' : '') + (player.away ? ' away' : '') + (seenPlayers.has(player.id) ? '' : ' join');
  if (player.away) pill.title = `${player.name} is reconnecting…`;

  pill.appendChild(avatarEl(player.name));

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

  const wins = document.createElement('span');
  wins.className = 'wins';
  wins.textContent = `🏆 ${player.wins}`;
  wins.title = `Wins in this lobby: ${player.wins}`;
  wins.setAttribute('aria-label', `${player.wins} ${player.wins === 1 ? 'win' : 'wins'}`);

  // Players in a round show how far along they are, so the lobby can tell how long they'll be
  const status = document.createElement('span');
  status.className = 'player-status ' + player.status;
  status.textContent = player.status === 'inGame' && player.level !== null ? `In game · ${player.level}/${state.total}` : STATUS_TEXT[player.status];

  pill.append(wins, status);
  return pill;
}

function statusText(me) {
  if (!me) return 'Connecting…';
  if (state.countdown && !state.countdown.includes(me.id)) return "A round is starting. You'll be in the next one.";
  if (state.players.length < 2) return 'Waiting for another player to join…';
  if (me.status !== 'ready') {
    return state.playing ? 'A round is being played. Get ready for the next one!' : "Tap I'm ready when you're set.";
  }
  const waitingOn = state.players.filter(p => p.status !== 'ready');
  if (!waitingOn.length) return "Everyone's ready!";
  const playing = waitingOn.filter(p => p.status === 'inGame').length;
  const doing = playing === waitingOn.length ? ' to finish' : playing === 0 ? ' to get ready' : '';
  return `Waiting for ${listNames(waitingOn)}${doing}…`;
}

function listNames(players) {
  if (players.length === 1) return players[0].name;
  if (players.length === 2) return `${players[0].name} and ${players[1].name}`;
  return `${players.length} players`;
}


// The server's copy of the room, with you first
function setState(roomState) {
  state.players = roomState.players.map(p => ({ ...p, isYou: p.id === myId }));
  state.players.sort((a, b) => b.isYou - a.isYou);
  state.countdown = roomState.countdown;
  state.playing = roomState.playing;
  state.total = roomState.total;
}


// In the room - on arriving, and again after every dropped connection. data says which screen you belong
// on: round (you're playing it), results (you haven't left them yet), or neither (the lobby).
socket.on('joined', (data) => {
  myId = data.id;
  setState(data.state);
  if (data.round) startRound(data.round);
  else if (data.results) showResults(data.results);
  else showView('lobby');
  render();
  // Back in the middle of a 3-2-1 that's for you
  if (view === 'lobby' && state.countdown && state.countdown.includes(myId) && countdownEl.hidden) showCountdown();
});

socket.on('room-state', (roomState) => {
  if (!myId) return; // 'joined' brings it as well
  setState(roomState);
  render();
});

socket.on('new-player', (name) => {
  showAlert(`${name} joined the room`, 'success');
  sfx.join();
});

socket.on('playerLeft', (name) => {
  showAlert(`${name} left the room`, 'warning');
});

// This browser opened the room in another tab, which has taken over your place
socket.on('replaced', () => {
  socket.disconnect();
  showView('lobby');
  elsewhereEl.hidden = false;
});

useHereBtn.addEventListener('click', () => {
  elsewhereEl.hidden = true;
  socket.connect();
});



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
  const me = state.players.find(p => p.isYou);
  if (!me || me.status === 'inGame') return;
  const ready = me.status !== 'ready';
  socket.emit('set-ready', ready);
  // Shown straight away - the server's room-state confirms it
  me.status = ready ? 'ready' : 'notReady';
  render();
});

// Not ready after all: the server stops the 3-2-1 for everyone
cancelStartBtn.addEventListener('click', () => {
  socket.emit('set-ready', false);
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


// The home button asks first. Leaving mid-round, your round waits for you if you come back before it ends.
homeBtn.addEventListener('click', () => {
  leaveNoteEl.textContent = view === 'game'
    ? "You're in the middle of a round. Come back before it ends and you'll pick up where you left off."
    : "You'll go back to the home page.";
  leaveDialog.returnValue = '';
  leaveDialog.showModal();
});

// Tapping outside the box is the same as Stay
leaveDialog.addEventListener('click', (event) => {
  if (event.target === leaveDialog) leaveDialog.close('stay');
});

leaveDialog.addEventListener('close', () => {
  if (leaveDialog.returnValue !== 'leave') return;
  // Waits (briefly) for the server to take you out, so the room doesn't think your connection just dropped
  socket.timeout(1500).emit('leave-room', () => {
    window.location.href = "/";
  });
});



function showCountdown() {
  closeHowToPlay(); // so it isn't covering the 3-2-1
  countdownEl.hidden = false;
  cancelStartBtn.hidden = false;

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



// Everyone in the room was ready. The server sends the words (see game.js 'gameWords') when this finishes.
socket.on('game-starting', (roster) => {
  if (roster.includes(myId)) showCountdown();
});

// Someone in it wasn't ready after all (id and name are theirs; no name if too few players were left)
socket.on('start-canceled', (id, name) => {
  if (countdownEl.hidden) return;
  hideCountdown();
  if (id !== myId) showAlert(name ? `${name} isn't ready - start canceled` : 'Game start canceled', 'warning');
});
