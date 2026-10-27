const socket = connectSocket();


const winnerNameEl = document.getElementById('winnerName');
const winnerTitleEl = document.getElementById('winnerTitle');
const winnerTagEl = document.getElementById('winner-tag');
const roomLabelEl = document.getElementById('roomLabel');
const backToLobbyBtn = document.getElementById('backToLobby');
const rankingEl = document.getElementById('ranking');
const gameWordsEl = document.getElementById('words');


console.log("End screen loaded");

// Get winner info from URL parameters
const urlParams = new URLSearchParams(window.location.search);
const winnerId = urlParams.get('winnerId');
const winnerName = urlParams.get('winnerName') || 'Someone'; // URLSearchParams already decodes it
const roomCode = urlParams.get('roomCode');
const myId = sessionStorage.getItem('myId'); // set by the game page; the old localStorage id was the home page's

console.log("Winner ID:", winnerId);
console.log("My ID:", myId);


function displayEndScreen(winnerName, won) {
  roomLabelEl.textContent = roomCode ? `Results · Room ${roomCode}` : 'Results';
  winnerNameEl.textContent = winnerName;
  winnerTitleEl.textContent = won ? 'You win!' : `${winnerName} wins!`;
  // "Got through" rather than "solved" - skipped words count toward finishing
  winnerTagEl.textContent = won ? 'You got through every word first.' : 'First to get through every word.';

  if (won) {
    sfx.win();
    confetti();
  }

  socket.emit('requestResults', roomCode);
}

displayEndScreen(winnerName, winnerId === myId);


backToLobbyBtn.addEventListener('click', () => {
  window.location.href = "/game/" + roomCode + "/";  // Redirect to lobby page
});



socket.on('results', (results) => {
  console.log("Received results:", results);
  if (!results) {
    showEmpty(rankingEl, "Results for this game aren't available anymore.");
    showEmpty(gameWordsEl, "The words for this game aren't available anymore.");
    return;
  }
  showRanking(results.players, results.words.length);
  showGameWords(results.words);
});

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function showEmpty(listEl, message) {
  listEl.replaceChildren(el('li', 'empty-note', message));
}

function showRanking(players, total) {
  rankingEl.innerHTML = '';
  players.forEach((player, i) => {
    const row = el('li', 'rank-row' + (player.id === myId ? ' you' : ''), '');
    const name = player.name + (player.id === myId ? ' (you)' : '') + (player.left ? ' · left' : '');
    row.append(
      el('span', 'place', i === 0 ? '🏆' : String(i + 1)),
      avatarEl(player.name),
      el('span', 'name', name),
      el('span', 'stats', `${player.points} pts · ${player.solved}/${total} solved`),
    );
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
