// Daily Jam's page (the rules are in daily.js at the project root). Today's words and the word being played are
// screens of this one page, like solo mode's. This file connects to the server, shows today's words and switches
// screens; tiles.js is the word on screen, play.js a word being played, and result.js the box after it.
//
// Today is the date where the player is, so the words change at their own midnight. A word that's on screen at
// midnight can still be finished - today's list moves on once it's done.

const socket = connectSocket();

const LEVEL_NAMES = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

const dayViewEl = document.getElementById('dayView');
const gameStateEl = document.getElementById('gameState');
const dayNumberEl = document.getElementById('dayNumber');
const dayDateEl = document.getElementById('dayDate');
const dayStatusEl = document.getElementById('dayStatus');
const dayStatusTextEl = document.getElementById('dayStatusText');
const dayRetryBtn = document.getElementById('dayRetry');
const levelListEl = document.getElementById('levelList');
const levelBtns = [...document.querySelectorAll('.daily-level')];
const dayStreakEl = document.getElementById('dayStreak');
const nextInEls = [...document.querySelectorAll('.next-in')];
const homeBtn = document.getElementById('homeBtn');
const leaveDialog = document.getElementById('leaveDialog');

let view = null;  // the screen: 'day' or 'game'. The music (/js/audio.js) follows it.
let day = null;   // the date being played, as the player has it ('2026-10-28')
let today = null; // the server's word on it (see today in daily.js at the project root): { number, levels, streak }
let loading = false;


// Same as playerToken in solo/js/solo.js: the random token this browser keeps - who you are here as in rooms and solo
function playerToken() {
  let token = localStorage.getItem('playerToken');
  if (!token) {
    token = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('playerToken', token);
  }
  return token;
}

// Same as request in solo/js/solo.js: sends something the server answers, and when no answer comes, replaces the
// connection and sends it again. Everything sent this way is safe for the server to get twice.
// Resolves to the server's reply; rejects once `tries` attempts have gone unanswered.
function request(event, data, { timeout = 4000, tries = 3 } = {}) {
  const args = data === undefined ? [] : [data];
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const send = () => {
      attempt++;
      socket.timeout(timeout).emit(event, ...args, (err, reply) => {
        if (!err) {
          resolve(reply);
        } else if (attempt >= tries) {
          reject(err);
        } else {
          freshConnection();
          whenConnected(send);
        }
      });
    };
    whenConnected(send);
  });
}

function whenConnected(callback) {
  if (socket.connected) callback();
  else socket.once('connect', callback);
}

// Swaps a connection that has stopped answering for a new one
function freshConnection() {
  if (socket.connected) socket.io.engine.close();
}


// Today's date where the player is
function localDay(at = new Date()) {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

// 0:41, or 1:02:41 past an hour
function formatTime(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds / 60) % 60;
  const s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// How many tries a finished go took (the wrong ones, and the one that got it)
const triesOf = (play) => play.guesses.length + (play.solved ? 1 : 0);

// A grey piece from /shared/skeleton.css, standing in for something on its way: `width` wide, and a bar in a line of
// text unless `kind` is another of its pieces
function skel(width, kind = 'skel-text') {
  const node = document.createElement('span');
  node.className = `skel ${kind}`;
  node.style.setProperty('--w', width);
  node.setAttribute('aria-hidden', 'true');
  return node;
}


function showView(next) {
  if (view === next) return;
  if (view === 'game') leaveWord();
  view = next;
  document.body.classList.toggle('daily', next === 'day');
  document.body.classList.toggle('game', next === 'game');
  dayViewEl.hidden = next !== 'day';
  gameStateEl.classList.toggle('show', next === 'game');
  // Home from today's words, and back to them from a word
  homeBtn.textContent = next === 'game' ? '←' : '🏠';
  homeBtn.setAttribute('aria-label', next === 'game' ? "Back to today's words" : 'Back to the home page');
  homeBtn.title = homeBtn.getAttribute('aria-label');
  syncMusic();
  window.scrollTo(0, 0);
}


// Today's words, and how you're doing on each. While they load, the list is up with grey bars in it (showLevelsWaiting)
// and the status line says what's happening to screen readers only - it's seen if they can't be got.
async function loadDay() {
  if (loading) return;
  loading = true;
  day = localDay();
  showLevelsWaiting();
  dayRetryBtn.hidden = true;
  dayStatusEl.hidden = false;
  dayStatusEl.classList.add('sr-only');
  dayStatusTextEl.textContent = "Getting today's words…";
  const reply = await request('daily-today', { day, token: playerToken() }).catch(() => null);
  loading = false;
  if (!reply || reply.status !== 'ok') {
    levelListEl.hidden = true;
    dayStatusEl.classList.remove('sr-only');
    dayStatusTextEl.textContent = !reply
      ? "Couldn't reach the game. Check your connection."
      : reply.status === 'not-today'
        ? "Daily Jam goes by your device's date, and yours looks off. Check your date and time, then try again."
        : "Daily Jam isn't available right now. Try again in a bit.";
    dayRetryBtn.hidden = false;
    return;
  }
  today = reply;
  showDay();
}

// Today's list while it loads: each word's level and length, which never change (LEVELS in daily.js at the project
// root), and a grey bar where how you're doing on it will go. None of them can be opened until that's there.
function showLevelsWaiting() {
  levelListEl.hidden = false;
  levelListEl.setAttribute('aria-busy', 'true');
  for (const btn of levelBtns) {
    btn.className = 'daily-level';
    btn.disabled = true;
    btn.querySelector('.level-state').replaceChildren(skel('5em'));
  }
}

function showDay() {
  dayNumberEl.textContent = `Daily Jam #${today.number}`;
  dayDateEl.textContent = new Date(`${day}T12:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  dayStatusEl.hidden = true;
  levelListEl.hidden = false;
  levelListEl.removeAttribute('aria-busy');
  for (const btn of levelBtns) {
    const { play } = levelOf(btn.dataset.level);
    const stateEl = btn.querySelector('.level-state');
    btn.className = 'daily-level';
    btn.disabled = false;
    if (!play) {
      btn.classList.add('new');
      stateEl.textContent = 'Play →';
    } else if (play.solved === null) {
      const left = TRIES - play.guesses.length;
      btn.classList.add('going');
      stateEl.textContent = `Continue · ${left} ${left === 1 ? 'try' : 'tries'} left`;
    } else if (play.solved) {
      btn.classList.add('got');
      stateEl.textContent = `✓ ${triesOf(play)}/${TRIES} · ${formatTime(play.ms)}`;
    } else {
      btn.classList.add('missed');
      stateEl.textContent = `✗ ${play.word.toUpperCase()}`;
    }
  }
  const { current, best } = today.streak;
  dayStreakEl.hidden = !best;
  dayStreakEl.textContent = current ? `🔥 ${current}-day streak` : `Best streak: ${best}`;
}

// { level, length, play } for one of today's words
function levelOf(level) {
  return today.levels.find(l => l.level === level);
}

// A go changed (play.js): today's list and the streak keep up with it
function setPlay(level, play, result) {
  if (!today) return;
  levelOf(level).play = play;
  if (result) today.streak = result.streak;
}

// A word from today's list: a new or unfinished one is played, a finished one shows how it went (with today's
// numbers as they are now)
levelBtns.forEach(btn => btn.addEventListener('click', () => {
  const { level, play } = levelOf(btn.dataset.level);
  if (play && play.solved !== null) showResult(level, play, null);
  else openWord(level, btn);
}));

dayRetryBtn.addEventListener('click', loadDay);


// Every second: the countdown to the next words - and at midnight, today's list moves on (unless a word is on screen,
// or its box is up: then once that's done)
function tickDay() {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const seconds = Math.ceil((midnight - now) / 1000);
  const left = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
  nextInEls.forEach(el => { el.textContent = left.map((n, i) => (i ? String(n).padStart(2, '0') : n)).join(':'); });
  if (day && localDay(now) !== day && view === 'day' && !resultDialog.open && !loading) loadDay();
}
setInterval(tickDay, 1000);


// Home from today's words. From a word, back to today's words - and while it's being played, that asks first.
homeBtn.addEventListener('click', () => {
  if (view !== 'game') {
    window.location.href = '/';
    return;
  }
  if (!onWord) {
    backToDay();
    return;
  }
  leaveDialog.returnValue = '';
  leaveDialog.showModal();
});

// Tapping outside the box is the same as Keep playing
leaveDialog.addEventListener('click', (event) => {
  if (event.target === leaveDialog) leaveDialog.close('stay');
});

leaveDialog.addEventListener('close', () => {
  if (leaveDialog.returnValue === 'leave') backToDay();
});

// Today's list again - a new one if it's past midnight
function backToDay() {
  showView('day');
  if (!today || localDay() !== day) loadDay();
  else showDay();
}


// Every script on the page has run by now, the music's included
document.addEventListener('DOMContentLoaded', () => {
  showView('day');
  tickDay();
  loadDay();
});


// For the admin page's "People on the site" (see /shared/presence.js): today's list, or which word you're on
window.presenceDetail = () => ({
  state: view === 'game' ? 'word' : 'day',
  level: view === 'game' && typeof current === 'object' && current ? current.level : '',
});
