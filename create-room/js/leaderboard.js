
const standingListEl = document.getElementById('standingList');


function loadLeaderboard(players, newGame=false) {
  standingListEl.innerHTML = '';
  // Clear existing standings
  if (newGame) {
    players.sort((a, b) => a.name - b.name);
  } else {
    // Sort players by level (descending)
    players.sort((a, b) => b.level - a.level);
  }

  // Populate standings
  players.forEach((player) => {
    let playerEl = document.getElementById(`player-${player.id}`);
    if (!playerEl) {
      playerEl = document.createElement('div');
      playerEl.id = `player-${player.id}`;
      playerEl.classList.add('player');
      standingListEl.appendChild(playerEl);
    }
    playerEl.textContent = `${player.name} | LV: ${player.level}`;
  });

  console.log("updated-players", players);
}



socket.on('update-players', (players) => {
  loadLeaderboard(players, false);
});