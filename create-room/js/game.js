
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

let roundId = null; // the round on screen
let currentLevel = 0;
let currentWords = [];
let points = 0;

let currentAnswer = "";

// The current word as tappable tiles
let tiles = [];      // { letter, used, el } in the order the server scrambled them
let order = [];      // display order of `tiles` (changes on shuffle)
let picked = [];     // indexes into `tiles`, in the order they were picked
let slots = [];      // the answer row's spaces, kept for the whole word so their animations aren't cut off
let flights = new Set(); // tiles still flying to the answer row - each entry lands its tile right away
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
      // Fetch the answer (shown at 1 second left) once per word - each ask is a database read on the server
      if (!currentAnswer) socket.emit('timeWarning', { level: currentLevel });
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


// Sent to the whole room when a round starts - roster says who's playing it, and everyone else stays in
// the lobby. (Coming back to a round arrives with 'joined' instead - see lobby.js.)
socket.on('gameWords', (round) => {
  if (round.roster.includes(myId)) startRound(round);
});

// A round on screen: a new one, or one you're coming back to. level, points, skipped and secondsLeft say
// where you were in it; highest is who's furthest along.
function startRound(round) {
  // Already playing it - the connection only dropped for a moment, so carry on
  if (view === 'game' && roundId === round.round) return;
  console.log('Received game words:', round.words);
  hideCountdown();
  roundId = round.round;
  currentWords = round.words;
  currentLevel = round.level;
  points = round.points;
  pointsEl.textContent = `${points} pts`;
  // The words already played, if you're coming back
  levelList.forEach((circle, i) => {
    circle.classList.remove('active', 'completed', 'skipped');
    if (i < currentLevel) circle.classList.add(round.skipped.includes(i) ? 'skipped' : 'completed');
  });
  currentLeaderEl.textContent = `First to ${currentWords.length} wins`;
  delete currentLeaderEl.dataset.id;
  if (round.highest) showLeader(round.highest.id, round.highest.name, round.highest.level, true);
  showView('game');
  loadLeaderboard(state.players.filter(p => p.level !== null));
  loadLevel(currentLevel, round.secondsLeft);
}

// Off the game screen: nothing left to play or type into
function stopRound() {
  timer.stop();
  landAll();
  clearTimeout(submitTimeout);
  roundId = null;
  currentWords = [];
  currentLevel = 0;
  tilesEl.replaceChildren();
  slotsEl.replaceChildren();
}


// seconds: on the clock for this word - less than a whole word's if you're coming back to it
function loadLevel(level, seconds = LEVEL_SECONDS) {
  currentAnswer = "";
  submitting = false;
  locked = false;
  clearTimeout(submitTimeout);
  timer.reset(seconds);
  timer.start();
  if (level >= currentWords.length) {
    console.log("Game Over you win!");
    timer.stop();
    landAll();
    tilesEl.replaceChildren();
    slotsEl.replaceChildren();
    levelLabelEl.textContent = 'You finished!';
    socket.emit('gameOver');
    return;
  }

  levelList[level].classList.add('active');
  levelLabelEl.textContent = `Word ${level + 1} of ${currentWords.length}`;
  showWord(currentWords[level]);
}


// Moves on after a right answer (timerUp = false) or when the clock runs out (timerUp = true).
// levelCompleted goes first so the server knows you reached the end before you claim the win.
function advance(timerUp) {
  levelList[currentLevel].classList.remove('active');
  levelList[currentLevel].classList.add(timerUp ? 'skipped' : 'completed');
  currentLevel++;
  socket.emit('levelCompleted', { level: currentLevel, skipped: timerUp });
  loadLevel(currentLevel);
}


// ---------- Tiles and answer slots ----------

function showWord(scramble) {
  landAll();
  tiles = [...scramble.toUpperCase()].map((letter, i) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'tile';
    el.textContent = letter;
    el.setAttribute('aria-label', `Letter ${letter}`);
    // Picked the moment a finger touches it. A click waits for the finger to lift, and phones drop
    // the click when another finger is already down, so quick two-thumb tapping used to lose letters.
    let pressed = false;
    el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      pressed = true;
      pickTile(i);
    });
    // Screen readers press buttons with a click and no pointerdown
    el.addEventListener('click', () => {
      if (!pressed) pickTile(i);
      pressed = false;
    });
    return { letter, used: false, el };
  });
  order = tiles.map((_, i) => i);
  picked = [];
  tilesEl.replaceChildren(...tiles.map(t => t.el));
  slots = tiles.map((_, i) => {
    const slot = document.createElement('button');
    slot.type = 'button';
    slot.addEventListener('click', () => removeAt(i));
    return slot;
  });
  slotsEl.replaceChildren(...slots);
  slotsEl.className = 'answer-slots';
  renderSlots();
}

// text: letters to show instead of the picked ones (used to reveal the answer)
function renderSlots(text) {
  const letters = text ? [...text] : picked.map(i => tiles[i].letter);
  slots.forEach((slot, i) => {
    // toggle rather than reset the class, so a slot still waiting on its flying tile keeps 'landing'
    slot.classList.add('slot');
    slot.classList.toggle('filled', !!letters[i]);
    slot.textContent = letters[i] || '';
    slot.setAttribute('aria-label', letters[i] ? `Remove ${letters[i]}` : `Empty space ${i + 1}`);
  });
}

const calmMotion = matchMedia('(prefers-reduced-motion: reduce)');

// A copy of the tapped tile glides into its space. Every copy flies on its own, so the next tap never
// waits for the last one to land. The space's letter stays hidden ('landing') until its copy arrives.
function flyTile(tileEl, slot) {
  if (calmMotion.matches) return;
  const from = tileEl.getBoundingClientRect();
  const to = slot.getBoundingClientRect();
  const ghost = tileEl.cloneNode(true);
  ghost.className = 'tile flying';
  ghost.setAttribute('aria-hidden', 'true');
  // Slot-sized and centered on the tile: the tile may still be growing back from an earlier pick
  const left = from.left + (from.width - to.width) / 2;
  const top = from.top + (from.height - to.height) / 2;
  ghost.style.setProperty('--tile-size', `${to.width}px`);
  ghost.style.left = `${left}px`;
  ghost.style.top = `${top}px`;
  document.body.append(ghost);
  slot.classList.add('landing');

  // Ends as just the white letter, so swapping it for the slot's own letter can't be seen
  const flight = ghost.animate([
    { transform: 'none' },
    { transform: `translate(${to.left - left}px, ${to.top - top}px)`, background: 'rgba(255, 255, 255, 0)', color: '#fff', boxShadow: 'none' },
  ], { duration: 160, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'forwards' });

  const land = () => {
    flights.delete(land);
    flight.cancel();
    ghost.remove();
    slot.classList.remove('landing');
  };
  flights.add(land);
  flight.onfinish = land;
}

// Before the answer row changes under them (a letter removed, a new word, a result)
function landAll() {
  flights.forEach(land => land());
}

function pickTile(i) {
  if (!canPick() || tiles[i].used) return;
  // Measured before 'used' starts shrinking the tile
  flyTile(tiles[i].el, slots[picked.length]);
  tiles[i].used = true;
  tiles[i].el.classList.add('used');
  picked.push(i);
  renderSlots();
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
  landAll();
  const [i] = picked.splice(slotIndex, 1);
  tiles[i].used = false;
  tiles[i].el.classList.remove('used');
  renderSlots();
}

function undoLetter() {
  if (picked.length) removeAt(picked.length - 1);
}

function clearAnswer() {
  landAll();
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
  socket.emit('answerAttempt', { level: currentLevel, answer: answer });
}

function revealAnswer() {
  if (!currentAnswer || !isPlaying() || locked) return;
  locked = true;
  landAll();
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
  landAll();

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
  const round = roundId;
  setTimeout(() => {
    // Still on this word - the round may have ended in the meantime
    if (roundId === round && level === currentLevel) advance(false);
  }, 650);
});


undoBtn.addEventListener('click', undoLetter);



// quiet: just catching up after coming back, so no "took the lead" toast
function showLeader(id, name, level, quiet) {
  const total = currentWords.length || 10;
  currentLeaderEl.textContent = `👑 ${id === myId ? 'You' : name} · ${Math.min(level, total)}/${total}`;
  if (quiet) {
    currentLeaderEl.dataset.id = id;
  } else if (currentLeaderEl.dataset.id != id) {
    currentLeaderEl.dataset.id = id;
    showAlert(id === myId ? "You took the lead!" : `${name} took the lead!`, id === myId ? 'success' : 'info');
  }
}

socket.on('newHighestPlayer', (id, name, level) => {
  // Only for the players in the round
  if (view === 'game') showLeader(id, name, level, false);
});



// Someone got through every word. The players in the round see the results; anyone waiting in the lobby
// just hears who won.
socket.on('round-over', (results) => {
  if (view === 'game') {
    showResults(results);
  } else if (view === 'lobby') {
    showAlert(`${results.winnerId === myId ? 'You' : results.winnerName} won the round!`, 'info');
  }
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
