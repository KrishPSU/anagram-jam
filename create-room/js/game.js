
const levelList = document.querySelectorAll('.level-circle');
const anagramDisplay = document.getElementById('anagramDisplay');
const inputAnswer = document.getElementById('answerInput');
const currentLeaderEl = document.getElementById('currentLeader');
const gameTimerEl = document.getElementById('gameTimer');
const pointsEl = document.getElementById('pointsDisplay');
const shuffleBtn = document.getElementById('shuffleBtn');

let currentLevel = 0;
let currentWords = [];
let points = 0;

let currentAnswer = "";


// True while a level is on screen - not in the lobby, and not after you've finished
function isPlaying() {
  return currentLevel < currentWords.length;
}


// Registered once - this used to sit inside the timer tick and add a new listener every second
socket.on('timeUpdate', (answer) => {
  currentAnswer = answer;
});

const timer = createCountdownTimer(
  30,
  (timeRemaining) => {
    gameTimerEl.textContent = `00:${String(timeRemaining).padStart(2, '0')}`;
    if (timeRemaining <= 5) {
      socket.emit('timeWarning', { id: myId, name: localStorage.getItem('name'), roomCode: state.roomCode, level: currentLevel } );
    }

    if (timeRemaining == 1) {
      anagramDisplay.classList.add('reveal');
      anagramDisplay.textContent = currentAnswer;
      inputAnswer.value = "";
    }
  },
  () => {
    showAlert("Time's up! Moving to next level.", 'warning');
    currentLevel++;
    loadLevel(currentLevel, true);
    socket.emit('levelCompleted', { id: myId, name: localStorage.getItem('name'), roomCode: state.roomCode, level: currentLevel } );
  }
);


socket.on('gameWords', (wordData) => {
  startGameAudio();

  loadLeaderboard(state.players, true);

  console.log('Received game words:', wordData);
  currentWords = wordData;
  const inGame = getInGame();
  currentLevel = (inGame && inGame.roomCode === state.roomCode && inGame.level) || 0;
  state.started = true;
  document.getElementById('lobbyWrapper').style.display = "none";
  document.getElementById('gameState').classList.add("show");
  // When rejoining after a reload, fill in the levels already played
  for (let i = 0; i < Math.min(currentLevel, levelList.length); i++) levelList[i].classList.add('completed');
  loadLevel(currentLevel);
  currentLeaderEl.textContent = `No leader yet`;
});


function loadLevel(level, timerUp=false) {
  anagramDisplay.classList.remove('reveal');
  currentAnswer = "";
  timer.reset();
  timer.start();
  localStorage.setItem('inGame', JSON.stringify({ roomCode: state.roomCode, level: currentLevel }));
  if (level >= currentWords.length) {
    showAlert("Congratulations! You've completed all levels!", 'success');
    console.log("Game Over you win!");
    timer.stop();
    anagramDisplay.textContent = "You win!";
    inputAnswer.disabled = true;
    // submitButton.disabled = true;
    socket.emit('gameOver', { id: myId, name: localStorage.getItem('name'), roomCode: state.roomCode });
    return;
  }

  const levelData = currentWords[level];
  levelList[level].classList.add('active');
  if (level > 0) {
    if (timerUp) {
      levelList[level - 1].classList.remove('active');
      levelList[level - 1].classList.add('skipped');
    } else {
      levelList[level - 1].classList.remove('active');
      levelList[level - 1].classList.add('completed');
    }
  }
  anagramDisplay.textContent = currentWords[level].toUpperCase();
  inputAnswer.value = "";
  inputAnswer.focus();
}


// submitButton.addEventListener('click', () => {
//   const userAnswer = inputAnswer.value.trim().toLowerCase();
//   socket.emit('answerAttempt', { id: myId, name: localStorage.getItem('name'), roomCode: state.roomCode, level: currentLevel, answer: userAnswer, points: points });
// });


socket.on('answerResult', (isCorrect, level, newPoints) => {
  // Ignore results for a level you've already left (a double submit, or the timer ran out first).
  // Acting on them used to skip you ahead an extra level.
  if (level !== currentLevel) return;
  if (!isCorrect) {
    inputAnswer.value = "";
    showAlert("Wrong answer. Try again!");
    return;
  }
  // Keep the running total - the old parameter name shadowed `points`, so it was always sent back as 0
  points = newPoints;
  pointsEl.innerText = `Points: ${points}`;
  showAlert("Correct answer!", "success");
  currentLevel++;
  loadLevel(currentLevel);
  socket.emit('levelCompleted', { id: myId, name: localStorage.getItem('name'), roomCode: state.roomCode, level: currentLevel });
});



socket.on('newHighestPlayer', (id, name, level) => {
  if (currentLeaderEl.dataset.id == id) {
    currentLeaderEl.textContent = `${name} - Level ${level+1}`;
  } else {
    currentLeaderEl.dataset.id = id;
    currentLeaderEl.textContent = `${name} - Level ${level+1}`;
    showAlert(`${name} is now the level leader!`, 'success');
  }
});



socket.on('playerFinished', (id, name) => {
  timer.stop();
  localStorage.removeItem('inGame');
  // encodeURIComponent instead of btoa: btoa throws on emoji/non-Latin names, which froze everyone on the last level
  if (myId === id) {
    currentLeaderEl.textContent = `You have won the game!`;
    window.location.href = `/game/${state.roomCode}/end?winnerId=${myId}&winnerName=${encodeURIComponent(name)}&roomCode=${state.roomCode}`;
    return;
  }

  window.location.href = `/game/${state.roomCode}/end?winnerId=${id}&winnerName=${encodeURIComponent(name)}&roomCode=${state.roomCode}`;

  currentLeaderEl.textContent = `${name} has won the game!`;
});



shuffleBtn.addEventListener('click', () => {
  if (!isPlaying()) return;
  const current = anagramDisplay.textContent;
  let shuffled = current;
  // Re-roll so the button never looks like it did nothing (happens a lot with 3-letter words)
  for (let tries = 0; tries < 10 && shuffled === current; tries++) {
    shuffled = currentWords[currentLevel].split('')
      .sort(() => 0.5 - Math.random())
      .join('')
      .toUpperCase();
  }
  anagramDisplay.textContent = shuffled;
});