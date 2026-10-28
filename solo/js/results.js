// After a run: the score, where it puts you on the leaderboard, and your words. If the server couldn't be told about
// the run, this shows what the page has, with a button to try sending it again.

const finalPointsEl = document.getElementById('finalPoints');
const finalUnitEl = document.getElementById('finalUnit');
const standingEl = document.getElementById('standing');
const summaryEl = document.getElementById('summary');
const saveNoteEl = document.getElementById('saveNote');
const saveTextEl = document.getElementById('saveText');
const saveRetryBtn = document.getElementById('saveRetry');
const playAgainBtn = document.getElementById('playAgain');
const topPanelEl = document.getElementById('topPanel');
const topListEl = document.getElementById('topList');
const wordListEl = document.getElementById('wordList');


// reply: the server's (see finish in solo.js at the project root), or null if it couldn't be reached
function showResults(reply) {
  showView('results');
  const saved = !!reply && reply.status === 'ok';
  const total = saved ? reply.points : points;
  finalPointsEl.textContent = total;
  finalUnitEl.textContent = total === 1 ? 'point' : 'points';

  const solved = saved ? reply.solved : answers.map((a, i) => ({ ...a, scramble: run.words[i] }));
  const quick = solved.filter(s => s.quick).length;
  const hints = solved.reduce((sum, s) => sum + (s.hints || 0), 0);
  summaryEl.textContent = solved.length ? `${solved.length} ${solved.length === 1 ? 'word' : 'words'} · ${quick} under 3 seconds` : '';
  if (hints) summaryEl.textContent += ` · ${hints} ${hints === 1 ? 'hint' : 'hints'}`;

  showStanding(reply, total);
  showTop(saved ? reply.board : null);
  showWords(solved, saved ? reply.stuck : null);

  // A new best, the top of the leaderboard, or the very first score on it
  const board = saved && reply.board;
  if (board && total && (board.newBest || board.first || (board.rank === 1 && board.best === total))) {
    sfx.win();
    confetti();
  }
}

// The line under the score: what share of players it beats, and your best. Or why it isn't on the leaderboard.
function showStanding(reply, total) {
  saveNoteEl.hidden = true;
  standingEl.className = 'solo-standing';
  if (!reply) {
    standingEl.textContent = '';
    saveTextEl.textContent = "Couldn't reach the leaderboard to save this run.";
    saveRetryBtn.hidden = false;
    saveNoteEl.hidden = false;
    return;
  }
  if (reply.status !== 'ok' || !reply.board) {
    standingEl.textContent = '';
    saveTextEl.textContent = reply.status === 'late'
      ? 'This run got to the server too late to count.'
      : "The leaderboard isn't available right now, so this run wasn't saved.";
    saveRetryBtn.hidden = true;
    saveNoteEl.hidden = false;
    return;
  }

  const board = reply.board;
  if (!total) {
    standingEl.textContent = 'No words this time. Give it another go!';
    return;
  }
  // Nobody else has played yet, so there's nobody to compare with
  let text = board.first ? "You're the first one on the leaderboard!" : `Better than ${board.better}% of players`;
  if (board.newBest) text += ` · New best!`;
  standingEl.textContent = text;
  standingEl.classList.toggle('great', board.first || board.newBest || board.better >= 50);
  if (!board.first && board.rank) {
    const best = board.best === total ? 'This is your best' : `Your best: ${board.best}`;
    summaryEl.textContent += ` · ${best} (#${board.rank} of ${board.players})`;
  }
}

// The top of the leaderboard, with your best on the end if it's further down
function showTop(board) {
  topPanelEl.hidden = !board || !board.top.length;
  if (topPanelEl.hidden) return;
  topListEl.replaceChildren(...board.top.map(rankRow));
  if (board.rank && !board.top.some(row => row.you)) {
    topListEl.append(el('li', 'rank-row gap', '…'), rankRow({ rank: board.rank, name: playerName, words: board.bestWords, points: board.best, you: true }));
  }
}

function rankRow(row) {
  const item = el('li', 'rank-row' + (row.you ? ' you' : ''), '');
  item.append(
    el('span', 'place', row.rank <= 3 ? ['🥇', '🥈', '🥉'][row.rank - 1] : String(row.rank)),
    avatarEl(row.name),
    el('span', 'name', row.you ? `${row.name} (you)` : row.name),
    el('span', 'stats', (row.words === null ? '' : `${row.words} ${row.words === 1 ? 'word' : 'words'} · `) + `${row.points} pts`),
  );
  return item;
}

// Each word you got, what it was worth and how long it took - then the one the time ran out on
function showWords(solved, stuck) {
  const rows = solved.map((s) => {
    const row = el('li', 'word-row', '');
    const note = `from ${s.scramble.toUpperCase()}` + (s.word && s.answer !== s.word ? ` · the hidden word was ${s.word.toUpperCase()}` : '');
    row.append(
      el('span', 'word', s.answer.toUpperCase()),
      el('span', 'first', `+${s.points}${s.quick ? ' ⚡' : ''}${s.hints ? ' 💡' : ''} · ${(s.ms / 1000).toFixed(1)}s`),
      el('span', 'scramble', note),
    );
    return row;
  });
  if (stuck) {
    const row = el('li', 'word-row stuck', '');
    row.append(
      el('span', 'word', stuck.word.toUpperCase()),
      el('span', 'first none', 'Time ran out'),
      el('span', 'scramble', `from ${stuck.scramble.toUpperCase()}`),
    );
    rows.push(row);
  }
  if (!rows.length) rows.push(el('li', 'empty-note', 'No words this time.'));
  wordListEl.replaceChildren(...rows);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}


saveRetryBtn.addEventListener('click', async () => {
  saveRetryBtn.disabled = true;
  saveRetryBtn.classList.add('is-loading');
  const reply = await sendRun();
  saveRetryBtn.disabled = false;
  saveRetryBtn.classList.remove('is-loading');
  if (!reply) showAlert("Still couldn't reach the leaderboard. Check your connection and try again.");
  else showResults(reply);
});

playAgainBtn.addEventListener('click', startRun);


// Same as confetti in create-room/js/results.js: a few seconds of it, for a new best
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
