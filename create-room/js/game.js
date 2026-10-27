
const levelList = document.querySelectorAll('.level-circle');
const tilesEl = document.getElementById('anagramDisplay');
const slotsEl = document.getElementById('answerSlots');
const currentLeaderEl = document.getElementById('currentLeader');
const gameTimerEl = document.getElementById('gameTimer');
const timerTextEl = document.getElementById('timerText');
const timerBarEl = document.getElementById('timerBar');
const pointsEl = document.getElementById('pointsDisplay');
const levelLabelEl = document.getElementById('levelLabel');
const feedbackEl = document.getElementById('feedback');
const shuffleBtn = document.getElementById('shuffleBtn');
const undoBtn = document.getElementById('undoBtn');

const LEVEL_SECONDS = 30;
const TIMER_RING = 2 * Math.PI * 21; // circumference of the timer ring in game.html

let currentLevel = 0;
let currentWords = [];
let points = 0;

let currentAnswer = "";

// The current word as tappable tiles
let tiles = [];      // { letter, used, el } in the order the server scrambled them
let order = [];      // display order of `tiles` (changes on shuffle)
let picked = [];     // indexes into `tiles`, in the order they were picked
let submitting = false;
let locked = false;  // celebrating a right answer or showing the answer - no input
let submitTimeout;


// True while a level is on screen - not in the lobby, and not after you've finished
function isPlaying() {
  return currentLevel < currentWords.length;
}

function canPick() {
  return isPlaying() && !submitting && !locked;
}


// Registered once - this used to sit inside the timer tick and add a new listener every second
socket.on('timeUpdate', (answer) => {
  currentAnswer = answer;
});

const timer = createCountdownTimer(
  LEVEL_SECONDS,
  (timeRemaining) => {
    timerTextEl.textContent = timeRemaining;
    timerBarEl.style.strokeDashoffset = TIMER_RING * (1 - timeRemaining / LEVEL_SECONDS);
    gameTimerEl.classList.toggle('urgent', timeRemaining <= 5);
    if (timeRemaining <= 5) {
      socket.emit('timeWarning', { id: myId, name: localStorage.getItem('name'), roomCode: state.roomCode, level: currentLevel } );
      if (timeRemaining > 0 && isPlaying() && !locked) sfx.tick();
    }

    if (timeRemaining == 1) {
      revealAnswer();
    }
  },
  () => {
    showAlert("Time's up! On to the next word.", 'warning');
    sfx.timeUp();
    advance(true);
  }
);


socket.on('gameWords', (wordData) => {
  hideCountdown();
  document.body.classList.replace('lobby', 'game');
  startGameAudio();

  loadLeaderboard(state.players, true);

  console.log('Received game words:', wordData);
  currentWords = wordData;
  const inGame = getInGame();
  currentLevel = (inGame && inGame.roomCode === state.roomCode && inGame.level) || 0;
  // After a reload the server hands back your points along with the player list
  const me = state.players.find(p => p.isYou);
  points = (me && me.points) || 0;
  pointsEl.textContent = `${points} pts`;
  state.started = true;
  document.getElementById('lobbyWrapper').style.display = "none";
  document.getElementById('gameState').classList.add("show");
  // When rejoining after a reload, fill in the levels already played
  for (let i = 0; i < Math.min(currentLevel, levelList.length); i++) levelList[i].classList.add('completed');
  loadLevel(currentLevel);
  currentLeaderEl.textContent = `First to ${currentWords.length} wins`;
});


function loadLevel(level, timerUp=false) {
  currentAnswer = "";
  submitting = false;
  locked = false;
  clearTimeout(submitTimeout);
  timer.reset();
  timer.start();
  localStorage.setItem('inGame', JSON.stringify({ roomCode: state.roomCode, level: currentLevel }));
  if (level > 0) {
    levelList[level - 1].classList.remove('active');
    levelList[level - 1].classList.add(timerUp ? 'skipped' : 'completed');
  }
  if (level >= currentWords.length) {
    console.log("Game Over you win!");
    timer.stop();
    tilesEl.replaceChildren();
    slotsEl.replaceChildren();
    levelLabelEl.textContent = 'You finished!';
    socket.emit('gameOver', { id: myId, name: localStorage.getItem('name'), roomCode: state.roomCode });
    return;
  }

  levelList[level].classList.add('active');
  levelLabelEl.textContent = `Word ${level + 1} of ${currentWords.length}`;
  showWord(currentWords[level]);
}


// Moves on after a right answer (timerUp = false) or when the clock runs out (timerUp = true).
// levelCompleted goes first so the server knows you reached the end before you claim the win.
function advance(timerUp) {
  currentLevel++;
  socket.emit('levelCompleted', { id: myId, name: localStorage.getItem('name'), roomCode: state.roomCode, level: currentLevel });
  loadLevel(currentLevel, timerUp);
}


// ---------- Tiles and answer slots ----------

function showWord(scramble) {
  tiles = [...scramble.toUpperCase()].map((letter, i) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'tile';
    el.textContent = letter;
    el.setAttribute('aria-label', `Letter ${letter}`);
    el.addEventListener('click', () => pickTile(i));
    return { letter, used: false, el };
  });
  order = tiles.map((_, i) => i);
  picked = [];
  tilesEl.replaceChildren(...tiles.map(t => t.el));
  slotsEl.className = 'answer-slots';
  renderSlots();
}

// text: letters to show instead of the picked ones (used to reveal the answer)
function renderSlots(text) {
  const letters = text ? [...text] : picked.map(i => tiles[i].letter);
  slotsEl.replaceChildren(...tiles.map((_, i) => {
    const slot = document.createElement('button');
    slot.type = 'button';
    slot.className = 'slot' + (letters[i] ? ' filled' : '');
    slot.textContent = letters[i] || '';
    slot.setAttribute('aria-label', letters[i] ? `Remove ${letters[i]}` : `Empty space ${i + 1}`);
    if (!text) slot.addEventListener('click', () => removeAt(i));
    return slot;
  }));
}

function pickTile(i) {
  if (!canPick() || tiles[i].used) return;
  tiles[i].used = true;
  tiles[i].el.classList.add('used');
  picked.push(i);
  renderSlots();
  slotsEl.children[picked.length - 1].classList.add('pop');
  sfx.tap();
  // Every answer uses all the letters, so a full row is ready to check
  if (picked.length === tiles.length) setTimeout(submitAnswer, 120);
}

// Typing picks the first unused tile with that letter
function typeLetter(letter) {
  if (!canPick()) return;
  const i = tiles.findIndex(t => !t.used && t.letter === letter);
  if (i !== -1) {
    pickTile(i);
  } else {
    tilesEl.classList.remove('nope');
    void tilesEl.offsetWidth;
    tilesEl.classList.add('nope');
  }
}

function removeAt(slotIndex) {
  if (!canPick() || slotIndex >= picked.length) return;
  const [i] = picked.splice(slotIndex, 1);
  tiles[i].used = false;
  tiles[i].el.classList.remove('used');
  renderSlots();
}

function undoLetter() {
  if (picked.length) removeAt(picked.length - 1);
}

function clearAnswer() {
  picked.forEach(i => {
    tiles[i].used = false;
    tiles[i].el.classList.remove('used');
  });
  picked = [];
  slotsEl.className = 'answer-slots';
  renderSlots();
}

function submitAnswer() {
  if (!canPick() || picked.length < tiles.length) return;
  submitting = true;
  // If the server never answers, don't leave the player stuck
  clearTimeout(submitTimeout);
  submitTimeout = setTimeout(() => { submitting = false; }, 3000);
  const answer = picked.map(i => tiles[i].letter).join('').toLowerCase();
  socket.emit('answerAttempt', { id: myId, name: localStorage.getItem('name'), roomCode: state.roomCode, level: currentLevel, answer: answer });
}

function revealAnswer() {
  if (!currentAnswer || !isPlaying() || locked) return;
  locked = true;
  tiles.forEach(t => t.el.classList.add('used'));
  slotsEl.className = 'answer-slots reveal';
  renderSlots(currentAnswer.toUpperCase());
}

function showFeedback(text) {
  feedbackEl.textContent = text;
  feedbackEl.classList.remove('show');
  void feedbackEl.offsetWidth;
  feedbackEl.classList.add('show');
}


socket.on('answerResult', (isCorrect, level, newPoints, gained) => {
  // Ignore results for a level you've already left (a double submit, or the timer ran out first).
  // Acting on them used to skip you ahead an extra level.
  if (level !== currentLevel) return;
  submitting = false;
  clearTimeout(submitTimeout);

  if (!isCorrect) {
    slotsEl.classList.add('wrong');
    sfx.wrong();
    sfx.buzz([60, 40, 60]);
    setTimeout(() => {
      if (level === currentLevel && !locked) clearAnswer();
    }, 450);
    return;
  }

  points = newPoints;
  pointsEl.textContent = `${points} pts`;
  // Stop the clock while the tiles celebrate, then move on
  timer.stop();
  locked = true;
  slotsEl.classList.add('win');
  showFeedback(gained === 1 ? '+1 · another word!' : `+${gained}`);
  sfx.correct();
  sfx.buzz(30);
  setTimeout(() => {
    if (level === currentLevel) advance(false);
  }, 650);
});


undoBtn.addEventListener('click', undoLetter);



// quiet: just catching up after a reload, so no "took the lead" toast
socket.on('newHighestPlayer', (id, name, level, quiet) => {
  const total = currentWords.length || 10;
  currentLeaderEl.textContent = `👑 ${id === myId ? 'You' : name} · ${Math.min(level, total)}/${total}`;
  if (quiet) {
    currentLeaderEl.dataset.id = id;
  } else if (currentLeaderEl.dataset.id != id) {
    currentLeaderEl.dataset.id = id;
    showAlert(id === myId ? "You took the lead!" : `${name} took the lead!`, id === myId ? 'success' : 'info');
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



function shuffleTiles() {
  if (!isPlaying() || locked) return;
  const current = order.map(i => tiles[i].letter).join('');
  let next = order;
  // Re-roll so the button never looks like it did nothing (happens a lot with 3-letter words)
  for (let tries = 0; tries < 10; tries++) {
    next = [...order].sort(() => 0.5 - Math.random());
    if (next.map(i => tiles[i].letter).join('') !== current) break;
  }
  order = next;
  tilesEl.replaceChildren(...order.map(i => tiles[i].el));
}

shuffleBtn.addEventListener('click', shuffleTiles);
