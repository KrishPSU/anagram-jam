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