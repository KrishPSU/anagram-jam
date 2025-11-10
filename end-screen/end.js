const socket = io();


const gameOverScreen = document.getElementById('gameOverScreen');
const winnerNameEl = document.getElementById('winnerName');
const winnerTagEl = document.getElementById('winner-tag');
const backToLobbyBtn = document.getElementById('backToLobby');
const gameWordsEl = document.getElementById('words');


function displayEndScreen(winnerName, won) {
  winnerNameEl.textContent = winnerName;

  if (won) {
    // winnerTagEl.classList.add('won');
    // winnerTagEl.classList.remove('lost');
    winnerTagEl.textContent = "Congrats on the win!";
  } else {
    winnerTagEl.textContent = `${winnerName} won the game!`;
    // winnerTagEl.classList.remove('won');
    // winnerTagEl.classList.add('lost');
  }

  socket.emit('requestGameWords', roomCode);
}


console.log("End screen loaded");

// Get winner info from URL parameters
const urlParams = new URLSearchParams(window.location.search);
const winnerId = urlParams.get('winnerId');
const winnerNameEncoded = urlParams.get('winnerName');
const roomCode = urlParams.get('roomCode');
const winnerName = atob(winnerNameEncoded); // Decode the base64 encoded name
const myId = localStorage.getItem('myId');

console.log("Winner ID:", winnerId);
console.log("My ID:", myId);

displayEndScreen(winnerName, winnerId === myId);


backToLobbyBtn.addEventListener('click', () => {
  window.location.href = "/game/" + roomCode;  // Redirect to lobby page
});



socket.on('final_game_words', (words) => {
  console.log("Received game words:", words);
  showGameWords(words);
});

function showGameWords(words) {
  words.forEach(word => {
    const wordEl = document.createElement('div');
    wordEl.classList.add('word');
    const wordElText = document.createElement('p');
    wordElText.textContent = word;
    wordEl.appendChild(wordElText);
    gameWordsEl.appendChild(wordEl);
  });
}