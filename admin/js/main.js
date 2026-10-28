const socket = connectSocket();

const playerCountEl = document.getElementById('player_count_el');
const activeGameEl = document.getElementById('active_game_count_el');
const storageEl = document.getElementById('storage_el');

document.addEventListener('DOMContentLoaded', () => {
  socket.emit('adminConnected');
});

// storage: 'Redis', or memory and why - the server falls back to memory when Redis stops answering
socket.on('currentAliveConnections', (playerCount, activeGames, storage) => {
  console.log("Updating admin stats:", playerCount, activeGames, storage);

  playerCountEl.innerText = `${playerCount}`;
  activeGameEl.innerText = `${activeGames}`;
  storageEl.innerText = storage;
});


// ---------- Solo leaderboard ----------

// Everything here needs the admin password (ADMIN_PASSWORD on the server), remembered for this tab only
const soloForm = document.getElementById('solo_admin_form');
const passwordInput = document.getElementById('admin_password');
const soloStatusEl = document.getElementById('solo_admin_status');
const soloTable = document.getElementById('solo_admin_table');
const soloRowsEl = document.getElementById('solo_admin_rows');

let adminPassword = sessionStorage.getItem('adminPassword') || '';

const REFUSED = {
  unset: "There's no admin password yet. Add an environment variable called ADMIN_PASSWORD to the server (on Vercel: the project's Settings → Environment Variables), then redeploy.",
  wrong: 'Wrong password.',
  unavailable: "The leaderboard can't be reached right now. Try again in a bit.",
};

soloForm.addEventListener('submit', (e) => {
  e.preventDefault();
  adminPassword = passwordInput.value;
  sessionStorage.setItem('adminPassword', adminPassword);
  loadSoloBoard();
});

function loadSoloBoard() {
  soloStatusEl.textContent = 'Loading…';
  socket.timeout(8000).emit('admin-solo-board', { password: adminPassword }, (err, reply) => {
    if (err) {
      soloStatusEl.textContent = "Couldn't reach the server.";
      return;
    }
    if (reply.status !== 'ok') {
      soloStatusEl.textContent = REFUSED[reply.status] || 'Something went wrong.';
      soloTable.hidden = true;
      if (reply.status === 'wrong') sessionStorage.removeItem('adminPassword');
      return;
    }
    soloStatusEl.textContent = reply.players ? `${reply.players} on the board, top ${reply.top.length} below` : 'Nobody is on the board yet.';
    soloRowsEl.replaceChildren(...reply.top.map(soloRow));
    soloTable.hidden = !reply.top.length;
  });
}

function soloRow(entry) {
  const row = document.createElement('tr');
  const cell = (text) => {
    const td = document.createElement('td');
    td.textContent = text;
    row.appendChild(td);
    return td;
  };
  cell(entry.rank);
  const name = cell(entry.name);
  if (entry.hidden) {
    const note = document.createElement('span');
    note.className = 'hidden-note';
    note.textContent = ' (shows as Player)';
    name.appendChild(note);
  }
  cell(entry.words === null ? '' : entry.words);
  cell(entry.points);
  cell(new Date(entry.at).toLocaleString());

  // Two taps, so a slip can't take someone off
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => {
    if (!remove.classList.contains('sure')) {
      remove.classList.add('sure');
      remove.textContent = 'Sure?';
      return;
    }
    remove.disabled = true;
    socket.timeout(8000).emit('admin-solo-remove', { password: adminPassword, id: entry.id }, (err, reply) => {
      if (err || reply.status !== 'ok') {
        remove.disabled = false;
        soloStatusEl.textContent = err ? "Couldn't reach the server." : (REFUSED[reply.status] || 'Something went wrong.');
        return;
      }
      loadSoloBoard();
    });
  });
  cell('').appendChild(remove);
  return row;
}

if (adminPassword) {
  passwordInput.value = adminPassword;
  loadSoloBoard();
}