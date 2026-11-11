// Solo mode's page (the rules are in solo.js at the project root). The rules, the run and its results are screens of
// this one page, like a room's lobby, round and results are of the game page. This file connects to the server and
// switches screens; tiles.js is the word on screen, run.js the run, and results.js what comes after it.

// The leaderboard needs a name - first-time visitors pick one on the home page
const playerName = localStorage.getItem('name');
if (!playerName) window.location.replace('/');

const socket = connectSocket();

const introEl = document.getElementById('introView');
const gameStateEl = document.getElementById('gameState');
const resultsEl = document.getElementById('resultsView');
const soloBestEl = document.getElementById('soloBest');
const homeBtn = document.getElementById('homeBtn');
const leaveDialog = document.getElementById('leaveDialog');

let view = null; // the screen you're on: 'intro', 'game' or 'results'. The music (/js/audio.js) follows it.
const roundMusic = 'solo'; // the run's track


// Same as playerToken in create-room/js/lobby.js: the random token this browser keeps. It's who you are on the
// leaderboard as well as in rooms, so your best stays yours whatever name you go by.
function playerToken() {
  let token = localStorage.getItem('playerToken');
  if (!token) {
    token = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('playerToken', token);
  }
  return token;
}

// Same as request in create-room/js/lobby.js: sends something the server answers, and makes sure it gets there. A
// phone's connection can die without the page noticing for a while, so when no answer comes, the connection is
// replaced and it's sent again. Everything sent this way is safe for the server to get twice.
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


function showView(next) {
  if (view === next) return;
  if (view === 'game') stopRun();
  view = next;
  document.body.classList.remove('solo', 'game', 'end');
  document.body.classList.add({ intro: 'solo', game: 'game', results: 'end' }[next]);
  introEl.hidden = next !== 'intro';
  gameStateEl.classList.toggle('show', next === 'game');
  resultsEl.hidden = next !== 'results';
  syncMusic();
  window.scrollTo(0, 0);
}


// Under the Start button: who you're playing as, and your best once the leaderboard says what it is - with a grey bar
// where it will go meanwhile (/shared/skeleton.css), which goes without a trace if you haven't got one yet
function showBest() {
  soloBestEl.textContent = `Playing as ${playerName}`;
  const bar = document.createElement('span');
  bar.className = 'skel skel-text';
  bar.setAttribute('aria-hidden', 'true');
  soloBestEl.append(bar);
  soloBestEl.setAttribute('aria-busy', 'true');
  request('solo-board', { token: playerToken(), count: 0 })
    .then((reply) => {
      if (reply.status !== 'ok' || !reply.you) return;
      soloBestEl.textContent = `Playing as ${playerName} · Your best: ${reply.you.points} (#${reply.you.rank} of ${reply.players})`;
    })
    .catch(() => {})
    .finally(() => {
      bar.remove();
      soloBestEl.removeAttribute('aria-busy');
    });
}


// Home right away, except in the middle of a run - that asks first, and the clock doesn't stop while it does
homeBtn.addEventListener('click', () => {
  if (view !== 'game' || !running) {
    goTo('/', 'back');
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
  if (leaveDialog.returnValue === 'leave') goTo('/', 'back');
});


// Every script on the page has run by now, the music's included
document.addEventListener('DOMContentLoaded', () => {
  if (!playerName) return; // on the way to the home page
  showView('intro');
  showBest();
});


// For the admin page's "People on the site" (see /shared/presence.js): which screen you're on, and the run so far
window.presenceDetail = () => ({
  state: view === 'game' ? 'run' : view === 'results' ? 'results' : 'intro',
  points: typeof points === 'number' ? points : 0,
  level: typeof level === 'number' ? level : 0,
});
