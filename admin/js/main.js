const socket = io();

const playerCountEl = document.getElementById('player_count_el');
const activeGameEl = document.getElementById('active_game_count_el');

document.addEventListener('DOMContentLoaded', () => {
  socket.emit('adminConnected');
});

socket.on('currentAliveConnections', (playerCount, activeGames) => {
  console.log("Updating admin stats:", playerCount, activeGames);

  playerCountEl.innerText = `${playerCount}`;
  activeGameEl.innerText = `${activeGames}`;
});