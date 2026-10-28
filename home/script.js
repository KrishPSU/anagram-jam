const socket = connectSocket();

const playerNameInput = document.getElementById('playerName');
const startForm = document.getElementById('startForm');
const chooseModeEl = document.getElementById('chooseMode');
const joinModeEl = document.getElementById('joinMode');
const codeBoxesEl = document.getElementById('codeBoxes');
const codeBoxes = [...document.querySelectorAll('.code-box')];
const createBtn = document.getElementById('createBtn');
const showJoinBtn = document.getElementById('showJoinBtn');
const joinBtn = document.getElementById('joinBtn');
const backBtn = document.getElementById('backBtn');
const soloBtn = document.getElementById('soloBtn');
const busyStatusEl = document.getElementById('busyStatus');

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let mode = 'choose'; // 'choose' (Create is the main action) or 'join' (code boxes showing)
let pending = null; // 'create' or 'join' while waiting on the server
let busyTimeout;

// A healthy server answers in well under a second; past this it isn't going to
const REQUEST_TIMEOUT = 10000;

// Everything in the form is locked while a request is out, so nothing can change under it
const formControls = [playerNameInput, ...codeBoxes, createBtn, showJoinBtn, joinBtn, backBtn, soloBtn];

const REQUESTS = {
  create: { button: createBtn, idle: 'Create a room', busy: 'Creating room…' },
  join: { button: joinBtn, idle: 'Join room', busy: 'Joining room…' },
};

playerNameInput.value = localStorage.getItem('name') || '';

function showError(message) {
  showAlert(message, 'error');
}

function shake(el) {
  el.classList.remove('shake');
  void el.offsetWidth; // restart the animation
  el.classList.add('shake');
}


// ---------- Create or join ----------

function setMode(next) {
  mode = next;
  chooseModeEl.hidden = next !== 'choose';
  joinModeEl.hidden = next !== 'join';
}

function getCode() {
  return codeBoxes.map(box => box.value).join('');
}

function setCode(text) {
  const letters = String(text).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
  codeBoxes.forEach((box, i) => { box.value = letters[i] || ''; });
}

function focusFirstEmptyBox() {
  (codeBoxes.find(box => !box.value) || codeBoxes[codeBoxes.length - 1]).focus();
}

// Waiting on the server: the button that was pressed spins, and the locked form stops double
// clicks from creating two rooms. setBusy(null) puts everything back.
function setBusy(kind) {
  pending = kind;
  clearTimeout(busyTimeout);

  formControls.forEach(el => { el.disabled = !!kind; });
  Object.entries(REQUESTS).forEach(([name, { button, idle, busy }]) => {
    button.classList.toggle('is-loading', name === kind);
    button.querySelector('.btn-label').textContent = name === kind ? busy : idle;
  });
  busyStatusEl.textContent = kind ? REQUESTS[kind].busy : '';

  if (kind) busyTimeout = setTimeout(giveUp, REQUEST_TIMEOUT);
}

function giveUp() {
  const { button } = REQUESTS[pending];
  setBusy(null);
  showError("Couldn't reach the server. Please try again.");
  button.focus(); // the button was disabled, so keyboard focus was dropped
}

// Going Back from the lobby can restore this page exactly as it was left, spinner and all
window.addEventListener('pageshow', (e) => {
  if (e.persisted) setBusy(null);
});

// Shared game links send first-time players here with the room code filled in
const roomFromLink = new URLSearchParams(window.location.search).get('room');
if (roomFromLink) {
  setMode('join');
  setCode(roomFromLink);
}

showJoinBtn.addEventListener('click', () => {
  setMode('join');
  focusFirstEmptyBox();
});

backBtn.addEventListener('click', () => {
  setMode('choose');
  createBtn.focus();
});

codeBoxes.forEach((box, i) => {
  box.addEventListener('focus', () => box.select());

  box.addEventListener('input', () => {
    const letters = box.value.toUpperCase().replace(/[^A-Z]/g, '');
    if (letters.length > 1) {
      // Several letters at once (paste, autofill) - spread them across the boxes
      setCode(codeBoxes.slice(0, i).map(b => b.value).join('') + letters);
      focusFirstEmptyBox();
      return;
    }
    box.value = letters;
    if (letters && i < codeBoxes.length - 1) codeBoxes[i + 1].focus();
  });

  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && i > 0) {
      e.preventDefault();
      codeBoxes[i - 1].value = '';
      codeBoxes[i - 1].focus();
    } else if (e.key === 'ArrowLeft' && i > 0) {
      codeBoxes[i - 1].focus();
    } else if (e.key === 'ArrowRight' && i < codeBoxes.length - 1) {
      codeBoxes[i + 1].focus();
    }
  });

  box.addEventListener('paste', (e) => {
    e.preventDefault();
    setCode(e.clipboardData.getData('text'));
    focusFirstEmptyBox();
  });
});

// The name in the box, kept for the pages that come next - or null, after asking for one
function takeName() {
  const name = playerNameInput.value.trim();
  if (!name) {
    showError("Please enter your name first");
    playerNameInput.focus();
    shake(playerNameInput);
    return null;
  }
  localStorage.setItem('name', name);
  return name;
}

// Enter in any field submits: it creates a room, or joins one when the code boxes are showing
startForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (pending) return;
  const name = takeName();
  if (!name) return;

  if (mode === 'join') {
    const code = getCode();
    if (code.length < 5) {
      showError("Enter the 5-letter room code");
      shake(codeBoxesEl);
      focusFirstEmptyBox();
      return;
    }
    setBusy('join');
    socket.emit('joinRoom', { name: name, roomCode: code });
  } else {
    setBusy('create');
    socket.emit('createRoom');
  }
});

// Solo mode is a page of its own, and needs a name for its leaderboard just as a room does
soloBtn.addEventListener('click', () => {
  if (pending || !takeName()) return;
  // The slash saves a redirect, as for the game page
  document.location.href = '/solo/';
});



// Answers that show up after we gave up waiting (see giveUp) are ignored
socket.on('roomCreated', (roomCode) => {
  if (pending !== 'create') return;
  openGamePage(roomCode);
});

socket.on('roomJoined', (roomCode) => {
  if (pending !== 'join') return;
  openGamePage(roomCode);
});

socket.on('roomNotFound', (roomCode) => {
  if (pending !== 'join') return;
  setBusy(null);
  showError("No room found with the code " + roomCode);
  shake(codeBoxesEl);
  focusFirstEmptyBox();
});

function openGamePage(roomCode) {
  // The spinner keeps going until the lobby replaces this page - just stop the timeout
  clearTimeout(busyTimeout);
  localStorage.setItem('name', playerNameInput.value.trim());
  // Ending the URL in a slash skips the redirect the server would otherwise add
  document.location.href = "/game/" + roomCode + "/";
}


// ---------- Live room count ----------

const liveStatsEl = document.getElementById('liveStats');
const liveTextEl = document.getElementById('liveText');

function requestLiveStats() {
  socket.emit('getLiveStats');
}

// Once a minute, and only while the page is on screen - each check reads every room from the database,
// and a tab left open in the background would otherwise keep spending the free plan's commands
socket.on('connect', requestLiveStats);
setInterval(() => { if (!document.hidden) requestLiveStats(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) requestLiveStats(); });

// Hidden when nobody is playing, so it never says "0 rooms"
socket.on('liveStats', ({ playing }) => {
  liveStatsEl.hidden = !playing;
  liveTextEl.textContent = playing === 1 ? '1 room playing now' : `${playing} rooms playing now`;
});


// ---------- Title tiles that scramble and solve themselves ----------

const GAP = 6;

function derange(n) {
  let order;
  do {
    order = [...Array(n).keys()].sort(() => Math.random() - 0.5);
  } while (order.every((v, i) => v === i));
  return order;
}

function makeTileRow(rowEl) {
  const tiles = [...rowEl.dataset.word].map(letter => {
    const tile = document.createElement('span');
    tile.className = 'tile' + (rowEl.classList.contains('jam') ? ' jam' : '');
    tile.textContent = letter;
    rowEl.appendChild(tile);
    return tile;
  });
  let order = tiles.map((_, i) => i);

  function layout(tilt) {
    const step = tiles[0].offsetWidth + GAP;
    rowEl.style.width = (tiles.length * step - GAP) + 'px';
    order.forEach((slot, i) => {
      const rotate = tilt ? ` rotate(${(Math.random() * 12 - 6).toFixed(1)}deg)` : '';
      tiles[i].style.transitionDelay = (i * 45) + 'ms';
      tiles[i].style.transform = `translateX(${slot * step}px)${rotate}`;
    });
  }

  layout(false);
  window.addEventListener('resize', () => layout(false));

  return {
    scramble() {
      order = derange(tiles.length);
      layout(true);
    },
    solve() {
      order = tiles.map((_, i) => i);
      layout(false);
      rowEl.classList.remove('pop');
      void rowEl.offsetWidth;
      rowEl.classList.add('pop');
    },
  };
}

const titleRows = [...document.querySelectorAll('.tile-row')].map(makeTileRow);

async function scrambleTitle() {
  if (reduceMotion) return;
  for (;;) {
    await wait(5500);
    if (document.hidden) continue;
    titleRows.forEach(row => row.scramble());
    await wait(1400);
    titleRows.forEach(row => row.solve());
  }
}

// Wait for the font so the tiles are measured at their real size
(document.fonts ? document.fonts.ready : Promise.resolve()).then(() => {
  titleRows.forEach(row => row.solve());
  scrambleTitle();
});


// ---------- Drifting letters ----------

(() => {
  const drift = document.getElementById('drift');
  const letters = 'ANAGRAMJAMWORDPLAYTRAINSMILE';
  const count = window.innerWidth < 600 ? 12 : 18;
  for (let i = 0; i < count; i++) {
    const tile = document.createElement('span');
    tile.className = 'tile';
    tile.textContent = letters[Math.floor(Math.random() * letters.length)];
    const size = 18 + Math.random() * 24;
    const far = size < 28;
    tile.style.cssText =
      `left:${(Math.random() * 94).toFixed(1)}%;` +
      `--s:${size.toFixed(0)}px;--o:${far ? 0.12 : 0.24};--b:${far ? 1.5 : 0}px;` +
      `--d:${(14 + Math.random() * 12).toFixed(1)}s;--delay:${(-Math.random() * 26).toFixed(1)}s;` +
      `--r1:${(Math.random() * 30 - 15).toFixed(0)}deg;--r2:${(Math.random() * 60 - 30).toFixed(0)}deg`;
    drift.appendChild(tile);
  }
})();


// ---------- Demo round ----------

const DEMO_ROUNDS = [
  ['RTNAI', 'TRAIN', 'Sam', '3.2s'],
  ['OPNAI', 'PIANO', 'Ava', '4.8s'],
  ['MISLE', 'SMILE', 'Leo', '2.9s'],
  ['NAECO', 'OCEAN', 'Mia', '5.1s'],
  ['YENOH', 'HONEY', 'Sam', '3.7s'],
];

(() => {
  const tilesEl = document.getElementById('demoTiles');
  const slotsEl = document.getElementById('demoSlots');
  const resultEl = document.getElementById('demoResult');
  const whoEl = document.getElementById('demoWho');

  function setUp(scramble) {
    tilesEl.innerHTML = '';
    slotsEl.innerHTML = '';
    [...scramble].forEach(letter => {
      const tile = document.createElement('span');
      tile.className = 'tile';
      tile.textContent = letter;
      tilesEl.appendChild(tile);
      const slot = document.createElement('span');
      slot.className = 'demo-slot';
      slotsEl.appendChild(slot);
    });
    resultEl.classList.remove('show');
  }

  function showResult(name, time) {
    resultEl.textContent = `${name} solved it in ${time} `;
    const pts = document.createElement('b');
    pts.textContent = '+2';
    resultEl.appendChild(pts);
    resultEl.classList.add('show');
  }

  async function play() {
    for (let round = 0; ; round++) {
      const [scramble, answer, name, time] = DEMO_ROUNDS[round % DEMO_ROUNDS.length];
      setUp(scramble);

      if (reduceMotion) {
        [...answer].forEach((letter, i) => {
          slotsEl.children[i].textContent = letter;
          slotsEl.children[i].classList.add('filled', 'win');
        });
        showResult(name, time);
        return;
      }

      whoEl.textContent = `${name} is solving`;
      await wait(700);
      const used = new Set();
      for (let i = 0; i < answer.length; i++) {
        while (document.hidden) await wait(500);
        const index = [...scramble].findIndex((letter, j) => letter === answer[i] && !used.has(j));
        used.add(index);
        tilesEl.children[index].classList.add('used');
        slotsEl.children[i].textContent = answer[i];
        slotsEl.children[i].classList.add('filled');
        await wait(260 + Math.random() * 160);
      }
      await wait(200);
      [...slotsEl.children].forEach((slot, i) => setTimeout(() => slot.classList.add('win'), i * 70));
      showResult(name, time);
      whoEl.textContent = 'Demo round';
      await wait(2000);
    }
  }

  play();
})();
