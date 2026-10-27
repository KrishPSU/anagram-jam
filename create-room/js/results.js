// The results screen, shown to the players of a round when it ends (see game.js 'round-over'). They stay in the
// room the whole time: the lobby shows them as still in the game until they press Play again or Back to lobby.

const winnerNameEl = document.getElementById('winnerName');
const winnerTitleEl = document.getElementById('winnerTitle');
const winnerTagEl = document.getElementById('winner-tag');
const roomLabelEl = document.getElementById('roomLabel');
const playAgainBtn = document.getElementById('playAgain');
const backToLobbyBtn = document.getElementById('backToLobby');
const rankingEl = document.getElementById('ranking');
const gameWordsEl = document.getElementById('words');

let shownRound = null; // the round whose results are on screen


// results: the server's (see buildResults in index.js) - the winner has the most points, and the finisher got
// through every word first, which ended the round
function showResults(results) {
  // Already showing them - the connection only dropped for a moment
  if (view === 'results' && shownRound === results.round) return;
  shownRound = results.round;
  showView('results');

  const won = results.winnerId === myId;
  const winner = results.players.find(p => p.id === results.winnerId) || { points: 0 };
  roomLabelEl.textContent = `Results · Room ${state.roomCode}`;
  winnerNameEl.textContent = results.winnerName;
  winnerTitleEl.textContent = won ? 'You win!' : `${results.winnerName} wins!`;
  winnerTagEl.textContent = winnerTagline(results, winner);
  showRanking(results);
  showGameWords(results.words);

  if (won) {
    sfx.win();
    confetti();
  }
}

// What won it: the most points, or the same points but sooner - and who finished first, if that was someone else
function winnerTagline(results, winner) {
  const pts = `${winner.points} ${winner.points === 1 ? 'point' : 'points'}`;
  if (!winner.points) return 'Nobody scored, so it went to whoever got furthest.';
  if (results.tied) return `Tied on ${pts}, but got there first.`;
  if (!results.finisherId || results.finisherId === results.winnerId) return `Most points (${pts}), and first through every word.`;
  return `Most points (${pts}). ${results.finisherId === myId ? 'You' : results.finisherName} finished first.`;
}


// Back to the lobby: Play again is ready for the next round (it starts once everyone is), Back to lobby isn't yet
function toLobby(button, ready) {
  [playAgainBtn, backToLobbyBtn].forEach(b => { b.disabled = true; });
  button.classList.add('is-loading');
  request(ready ? 'play-again' : 'back-to-lobby')
    .then(() => {
      // Shown straight away - the server's room-state confirms it
      const me = state.players.find(p => p.isYou);
      if (me) me.status = ready ? 'ready' : 'notReady';
      showView('lobby');
      render();
    })
    .catch(() => showAlert("Couldn't reach the game. Try again."))
    .finally(() => {
      [playAgainBtn, backToLobbyBtn].forEach(b => { b.disabled = false; });
      button.classList.remove('is-loading');
    });
}

playAgainBtn.addEventListener('click', () => toLobby(playAgainBtn, true));
backToLobbyBtn.addEventListener('click', () => toLobby(backToLobbyBtn, false));



function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

// Most points first (the server's order). Anyone who left mid-round is at the bottom - they can't win.
function showRanking(results) {
  const total = results.words.length;
  rankingEl.innerHTML = '';
  results.players.forEach((player, i) => {
    const row = el('li', 'rank-row' + (player.id === myId ? ' you' : ''), '');
    const name = player.name + (player.id === myId ? ' (you)' : '') + (player.left ? ' · left' : '');
    row.append(
      el('span', 'place', player.id === results.winnerId ? '🏆' : String(i + 1)),
      avatarEl(player.name),
      el('span', 'name', name),
    );
    if (player.id === results.finisherId) {
      const flag = el('span', 'finished', '🏁');
      flag.title = 'Finished first';
      flag.setAttribute('aria-label', 'Finished first');
      row.append(flag);
    }
    row.append(el('span', 'stats', `${player.points} pts · ${player.solved}/${total} solved`));
    rankingEl.appendChild(row);
  });
}

function formatTime(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function showGameWords(words) {
  gameWordsEl.innerHTML = '';
  words.forEach(({ word, scramble, first }) => {
    const row = el('li', 'word-row', '');
    row.append(
      el('span', 'word', word.toUpperCase()),
      el('span', 'first' + (first ? '' : ' none'), first ? `${first.name} · ${formatTime(first.seconds)}` : 'Nobody got it'),
      el('span', 'scramble', `from ${scramble.toUpperCase()}`),
    );
    gameWordsEl.appendChild(row);
  });
}


// A few seconds of confetti for the winner
function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.getElementById('confetti');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;

  const colors = ['#ff5fa8', '#fbbf24', '#34d399', '#7c6cf0', '#22b8cf', '#ffffff'];
  const pieces = Array.from({ length: 140 }, () => ({
    x: Math.random() * canvas.width,
    y: -Math.random() * canvas.height * 0.6,
    w: (6 + Math.random() * 6) * dpr,
    h: (8 + Math.random() * 8) * dpr,
    vx: (Math.random() - 0.5) * 2.4 * dpr,
    vy: (2 + Math.random() * 3) * dpr,
    rotation: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 0.2,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));

  const start = performance.now();
  function frame(now) {
    const elapsed = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = elapsed > 3000 ? Math.max(0, 1 - (elapsed - 3000) / 1000) : 1;
    pieces.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.rotation += p.spin;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
    if (elapsed < 4000) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  requestAnimationFrame(frame);
}
