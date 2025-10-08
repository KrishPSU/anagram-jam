
const levelList = document.querySelectorAll('.level-circle');
const anagramDisplay = document.getElementById('anagramDisplay');
const inputAnswer = document.getElementById('answerInput');
const submitButton = document.querySelector('.answer-submit');
const currentLeaderEl = document.getElementById('currentLeader');
const gameTimerEl = document.getElementById('gameTimer');
const pointsEl = document.getElementById('pointsDisplay');

let currentLevel = 0;
let currentWords = [];
let points = 0;


const timer = createCountdownTimer(
    30,
    (timeRemaining) => {
      gameTimerEl.textContent = `00:${timeRemaining}`;
      // console.log(`Time remaining: ${timeRemaining} seconds`);
    },
    () => {
      // console.log('Timer complete!');
      showAlert("Time's up! Moving to next level.", 'warning');
      currentLevel++;
      loadLevel(currentLevel, true);
    }
  );


socket.on('gameWords', (wordData) => {
  console.log('Received game words:', wordData);
  currentWords = wordData;
  currentLevel = localStorage.getItem('inGame')?.level || 0;
  if (state.started === true) {
    document.getElementById('lobbyWrapper').style.display = "none";
    document.getElementById('gameState').classList.add("show");
  }
  loadLevel(currentLevel);
  currentLeaderEl.textContent = `No leader yet`;
});


function loadLevel(level, timerUp=false) {
  timer.reset();
  timer.start();
  localStorage.setItem('inGame', { roomCode: state.roomCode, level: currentLevel });
  if (level >= currentWords.length) {
    showAlert("Congratulations! You've completed all levels!", 'success');
    console.log("Game Over you win!");
    timer.stop();
    anagramDisplay.textContent = "You win!";
    inputAnswer.disabled = true;
    submitButton.disabled = true;
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
  anagramDisplay.textContent = currentWords[level];
  inputAnswer.value = "";
  inputAnswer.focus();
}


submitButton.addEventListener('click', () => {
  const userAnswer = inputAnswer.value.trim().toLowerCase();
  socket.emit('answerAttempt', { id: myId, name: localStorage.getItem('name'), roomCode: state.roomCode, level: currentLevel, answer: userAnswer, points: points });
});


socket.on('answerResult', (isCorrect, level, points) => {
  if (!isCorrect) {
    showAlert("Wrong answer. Try again!");
    return; 
  }
  pointsEl.innerText = `Points: ${points}`;
  showAlert("Correct answer!", "success");
  currentLevel++;
  loadLevel(currentLevel);
  socket.emit('levelCompleted', { id: myId, name: localStorage.getItem('name'), roomCode: state.roomCode, level: currentLevel });
});


inputAnswer.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    submitButton.click();
  }
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
  if (myId === id) {
    currentLeaderEl.textContent = `You have finished the game!`;
    inputAnswer.disabled = true;
    submitButton.disabled = true;
    timer.stop();

    setTimeout(() => {
      window.location.reload();
    }, 5000);

    return;
  }

  anagramDisplay.textContent = `${name} won!`;
  timer.stop();
  inputAnswer.disabled = true;
  submitButton.disabled = true;
  currentLeaderEl.textContent = `${name} has finished the game!`;

  setTimeout(() => {
    window.location.reload();
  }, 5000);

  showAlert(`${name} has finished the game!`, 'success');
});