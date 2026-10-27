
const standingListEl = document.getElementById('standingList');


// A row of player chips on phones and a side panel on wide screens (see game-state.css).
// players: the ones in the round (lobby.js keeps them up to date from the server's room-state), each with their
// place - most points first, as the server works it out (see byStanding in index.js)
function loadLeaderboard(players) {
  // Clear existing standings
  standingListEl.innerHTML = '';
  // Until someone scores there's no order to show, so no ranks either
  const newGame = players.every(p => !p.points);
  if (newGame) {
    players.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } else {
    players.sort((a, b) => (a.place || 99) - (b.place || 99));
  }

  const total = currentWords.length || 10;

  // Populate standings
  players.forEach((player, i) => {
    const item = document.createElement('li');
    item.className = 'standing-item' + (player.id === myId ? ' you' : '');

    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = newGame ? '' : i + 1;

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = player.id === myId ? 'You' : player.name;

    const pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = `${player.points || 0} pts`;

    // How far along - the round ends when anyone gets to the last word
    const level = document.createElement('span');
    level.className = 'lv';
    level.textContent = `${player.level || 0}/${total}`;

    item.append(rank, avatarEl(player.name), name, pts, level);
    standingListEl.appendChild(item);
  });

}
