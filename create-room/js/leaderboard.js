
const standingListEl = document.getElementById('standingList');


// A row of player chips on phones and a side panel on wide screens (see game-state.css).
// players: the ones in the round (lobby.js keeps them up to date from the server's room-state)
function loadLeaderboard(players) {
  // Clear existing standings
  standingListEl.innerHTML = '';
  // Until someone gets past the first word there's no order to show, so no ranks either
  const newGame = players.every(p => !p.level);
  if (newGame) {
    players.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } else {
    // Furthest along first, then most points
    players.sort((a, b) => (b.level || 0) - (a.level || 0) || (b.points || 0) - (a.points || 0));
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

    const level = document.createElement('span');
    level.className = 'lv';
    level.textContent = `${player.level || 0}/${total}`;

    item.append(rank, avatarEl(player.name), name, level);
    standingListEl.appendChild(item);
  });

}
