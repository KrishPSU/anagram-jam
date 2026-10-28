// The solo leaderboard's box, shared by the home page and the solo page: any button with data-solo-leaderboard opens
// it. It's fetched fresh every time it opens, over the page's own connection (`socket` - home/script.js and
// solo/js/solo.js each have one). Names and avatars as everywhere else (/shared/players.js).

(() => {
  const TOP = 50; // as many rows as the server sends (BOARD_TOP in solo.js)
  const MEDALS = ['🥇', '🥈', '🥉'];

  const dialog = document.createElement('dialog');
  dialog.className = 'board-dialog';
  dialog.setAttribute('aria-labelledby', 'boardTitle');
  dialog.innerHTML = `
    <form class="board-card card" method="dialog">
      <div class="board-head">
        <h2 id="boardTitle">🏆 Solo leaderboard</h2>
        <button class="board-close" aria-label="Close">×</button>
      </div>
      <p class="board-note">Everyone's best score in one minute.</p>
      <div class="board-status" role="status"></div>
      <ol class="board-list"></ol>
      <p class="board-count"></p>
      <button class="btn btn-ghost">Close</button>
    </form>
  `;
  document.body.appendChild(dialog);

  const statusEl = dialog.querySelector('.board-status');
  const listEl = dialog.querySelector('.board-list');
  const countEl = dialog.querySelector('.board-count');
  let asked = 0; // the latest ask - a slow reply to an earlier one is ignored

  function setStatus(content) {
    statusEl.replaceChildren(...content);
    statusEl.hidden = !content.length;
  }

  function load() {
    const ask = ++asked;
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    setStatus([spinner, 'Loading…']);
    listEl.replaceChildren();
    countEl.textContent = '';
    // The token says which row is yours. Someone who has never played anything doesn't have one yet.
    const token = localStorage.getItem('playerToken') || '';
    socket.timeout(8000).emit('solo-board', { token, count: TOP }, (err, reply) => {
      if (ask !== asked || !dialog.open) return;
      if (err || !reply || reply.status !== 'ok') showError();
      else show(reply);
    });
  }

  function showError() {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-ghost btn-sm';
    retry.textContent = 'Try again';
    retry.addEventListener('click', load);
    setStatus(["Couldn't load the leaderboard.", retry]);
  }

  function show(reply) {
    if (!reply.players) {
      setStatus(["Nobody's played solo yet. Be the first!"]);
      return;
    }
    setStatus([]);
    const rows = reply.top.map(row);
    // Your best, if it's further down than the top
    if (reply.you && !reply.top.some(r => r.you)) {
      const gap = document.createElement('li');
      gap.className = 'board-gap';
      gap.textContent = '…';
      rows.push(gap, row({ rank: reply.you.rank, name: localStorage.getItem('name') || 'You', points: reply.you.points, you: true }));
    }
    listEl.replaceChildren(...rows);
    countEl.textContent = `${reply.players} ${reply.players === 1 ? 'player' : 'players'}`;
  }

  function row({ rank, name, points, you }) {
    const item = document.createElement('li');
    item.className = 'board-row' + (you ? ' you' : '');
    const place = document.createElement('span');
    place.className = 'place';
    place.textContent = MEDALS[rank - 1] || String(rank);
    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = you ? `${name} (you)` : name;
    const pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = `${points} pts`;
    item.append(place, avatarEl(name), label, pts);
    return item;
  }

  document.querySelectorAll('[data-solo-leaderboard]').forEach(btn => btn.addEventListener('click', () => {
    dialog.showModal();
    dialog.querySelector('.board-card').scrollTop = 0;
    load();
  }));

  // Tapping outside the box closes it
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
})();
