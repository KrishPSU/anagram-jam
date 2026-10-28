
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
// The answers as hashes (see wordHash): each word's own, worth 2 points, and the other real words its letters make,
// worth 1. Answers are checked against these right here, so nothing waits on the network (see submitAnswer).
let currentHashes = [];
let currentOthers = [];
// What you did on each word, by level: { answer, gained } if you solved it, { timeUp: true } if the clock ran out.
// The server hears about it in the background (see report). serverLevel is the word it last said you're on, and
// serverPoints your points by its count.
let moves = [];
let serverLevel = 0;
let serverPoints = 0;
let roundEnding = false; // someone got through every word: the round stops for everyone (see 'round-over')
let finishWatch;         // after you get through every word, until the round's results arrive

let currentAnswer = "";
let askedAnswer = -1; // the level whose answer has been asked for (see askAnswer)

// The current word as tappable tiles
let tiles = [];      // { letter, used, el } in the order the server scrambled them
let order = [];      // display order of `tiles` (changes on shuffle)
let picked = [];     // indexes into `tiles`, in the order they were picked
let slots = [];      // the answer row's spaces, kept for the whole word so their animations aren't cut off
let flights = new Set(); // tiles still flying to the answer row - each entry lands its tile right away
let locked = false;  // celebrating a right answer or showing the answer - no input


// True while a level is on screen - not in the lobby, not after you've finished, and not once the round is over
function isPlaying() {
  return currentLevel < currentWords.length && !roundEnding;
}

function canPick() {
  return isPlaying() && !locked;
}


const timer = createCountdownTimer(
  LEVEL_SECONDS,
  (timeRemaining) => {
    timerTextEl.textContent = timeRemaining;
    timerBarEl.style.strokeDashoffset = TIMER_RING * (1 - timeRemaining / LEVEL_SECONDS);
    gameTimerEl.classList.toggle('urgent', timeRemaining <= 5);
    if (timeRemaining <= 5) {
      // Fetch the answer (shown at 1 second left) once per word - each ask is a database read on the server
      if (askedAnswer !== currentLevel && isPlaying()) askAnswer();
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

// The answer to the word on screen, for showing as its time runs out. Missing it only means it isn't shown,
// so it's asked once (again on the next tick if that went unanswered) rather than with request().
function askAnswer() {
  const round = roundId, level = currentLevel;
  askedAnswer = level;
  socket.timeout(3000).emit('reveal', { round, level }, (err, word) => {
    if (round !== roundId || level !== currentLevel) return;
    if (err) askedAnswer = -1;
    else if (word) currentAnswer = word;
  });
}


// Sent to the whole room when a round starts - roster says who's playing it, and everyone else stays in
// the lobby. (Coming back to a round arrives with 'joined' instead - see lobby.js.)
socket.on('gameWords', (round) => {
  if (round.roster.includes(myId)) startRound(round);
});

// A round on screen: a new one, or one you're coming back to. level, points, skipped and secondsLeft say
// where you were in it.
function startRound(round) {
  if (view === 'game' && roundId === round.round) {
    catchUp(round);
    return;
  }
  console.log('Received game words:', round.words);
  if (view === 'game') stopRound(); // still on an older round, somehow
  hideCountdown();
  roundId = round.round;
  currentWords = round.words;
  currentHashes = round.hashes || [];
  currentOthers = round.others || [];
  roundEnding = false;
  showProgress(round);
  showView('game');
  showLeader(true);
  loadLeaderboard(state.players.filter(p => p.level !== null));
  loadLevel(currentLevel, round.secondsLeft);
}

// Already playing this round - the connection only dropped for a moment, or the page asked where it should be.
// The server may not have heard about every word you've done yet (carry on telling it), or - if this page lost
// track somehow - be ahead of it (catch up with it).
function catchUp(round) {
  if (roundEnding) return;
  // The word on screen counts as done once it's solved
  const done = moves[currentLevel] ? currentLevel + 1 : currentLevel;
  if (round.level > done) {
    showProgress(round);
    loadLevel(currentLevel, round.secondsLeft);
  } else {
    heardFrom(round.level, round.points);
    report();
  }
}

// The words done so far (circles), the word you're on, and your points, as the server has them
function showProgress(round) {
  currentLevel = round.level;
  moves = [];
  serverLevel = round.level;
  serverPoints = round.points;
  showPoints();
  levelList.forEach((circle, i) => {
    circle.classList.remove('active', 'completed', 'skipped');
    if (i < currentLevel) circle.classList.add(round.skipped.includes(i) ? 'skipped' : 'completed');
  });
}

// By the server's count you're on word `level`, with `points`. A reply can come in after newer news, so older news is ignored.
function heardFrom(level, points) {
  if (level < serverLevel) return;
  serverLevel = level;
  serverPoints = points;
  showPoints();
}

// Your points: the server's count, plus whatever the words it hasn't heard about yet are worth
function showPoints() {
  const unheard = moves.slice(serverLevel).reduce((sum, move) => sum + (move.gained || 0), 0);
  pointsEl.textContent = `${serverPoints + unheard} pts`;
}

// Off the game screen: nothing left to play or type into
function stopRound() {
  timer.stop();
  landAll();
  clearInterval(finishWatch);
  roundId = null;
  currentWords = [];
  currentHashes = [];
  currentOthers = [];
  currentLevel = 0;
  moves = [];
  serverLevel = 0;
  serverPoints = 0;
  roundEnding = false;
  locked = false;
  tilesEl.replaceChildren();
  slotsEl.replaceChildren();
}


// seconds: on the clock for this word - less than a whole word's if you're coming back to it
function loadLevel(level, seconds = LEVEL_SECONDS) {
  currentAnswer = "";
  askedAnswer = -1;
  locked = false;
  clearInterval(finishWatch);
  if (level >= currentWords.length) {
    // Through every word, which ends the round for everyone - the server sends 'round-over'. Until it gets here,
    // keep asking where things stand, in case it never does.
    timer.stop();
    landAll();
    tilesEl.replaceChildren();
    slotsEl.replaceChildren();
    levelLabelEl.textContent = 'You finished!';
    finishWatch = setInterval(sync, 3000);
    return;
  }

  timer.reset(seconds);
  timer.start();
  levelList[level].classList.add('active');
  levelLabelEl.textContent = `Word ${level + 1} of ${currentWords.length}`;
  showWord(currentWords[level]);
}


// Moves on after a right answer (timerUp = false) or when the clock runs out (timerUp = true). The server is told
// about a right answer as soon as it's found (see submitAnswer), and about the clock running out here.
function advance(timerUp) {
  if (roundEnding) return;
  if (timerUp) {
    moves[currentLevel] = { timeUp: true };
    report();
  }
  levelList[currentLevel].classList.remove('active');
  levelList[currentLevel].classList.add(moves[currentLevel].timeUp ? 'skipped' : 'completed');
  currentLevel++;
  loadLevel(currentLevel);
}

// Tells the server about every word you're done with - your answer, which it checks again and scores itself, or that
// the clock ran out - one at a time and in order, since hearing about a word means the ones before it were skipped.
// One that doesn't get through is sent again until it does, so a dropped connection never costs you a word or its points.
let reporting = null; // the round of the report on its way, if one is
function report() {
  const round = roundId, level = serverLevel, move = moves[level];
  if (!move || reporting === round || roundEnding) return;
  reporting = round;
  const sent = move.timeUp
    ? request('time-up', { round, level })
    : request('answerAttempt', { round, level, answer: move.answer });
  sent.then((reply) => {
    if (reporting === round) reporting = null;
    if (round !== roundId) return;
    if (reply.status === 'over' || reply.status === 'gone') return sync();
    // No points after all (it can't really happen - the server checks the same words): the word counts as skipped
    if (reply.status === 'wrong' || reply.status === 'skipped') {
      moves[level] = { timeUp: true };
      levelList[level].classList.replace('completed', 'skipped');
    }
    heardFrom(reply.level, reply.points);
    report();
  }, () => {
    if (reporting === round) reporting = null;
    // Still not through after a few tries: again in a moment, or as soon as there's a new connection (see below)
    if (round === roundId) setTimeout(report, 2000);
  });
}

// A new connection, after one dropped: whatever the server hasn't heard yet goes out on it
socket.on('connect', report);


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

// A full answer row, checked right here against the round's hashes: right (celebrate, then on to the next word) or
// wrong (shake, try again). Nothing waits on the network - the server is told about a right answer in the background
// (see report), checks it again and keeps the score.
function submitAnswer() {
  if (!canPick() || picked.length < tiles.length) return;
  landAll();
  const level = currentLevel;
  const answer = picked.map(i => tiles[i].letter).join('').toLowerCase();
  const hash = wordHash(answer);
  const gained = hash === currentHashes[level] ? 2 : (currentOthers[level] || []).includes(hash) ? 1 : 0;

  if (!gained) {
    slotsEl.classList.add('wrong');
    sfx.wrong();
    sfx.buzz([60, 40, 60]);
    setTimeout(() => {
      if (level === currentLevel && !locked) clearAnswer();
    }, 450);
    return;
  }

  moves[level] = { answer, gained };
  report();
  showPoints();
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


undoBtn.addEventListener('click', undoLetter);



// The 👑 pill: who's ahead on points (the server works out everyone's place - see byStanding in index.js).
// quiet: just catching up (a round starting, or coming back to one), so no "took the lead" toast.
function showLeader(quiet) {
  const leader = state.players.find(p => p.place === 1 && p.points > 0);
  if (!leader) {
    currentLeaderEl.textContent = 'Most points wins';
    delete currentLeaderEl.dataset.id;
    return;
  }
  currentLeaderEl.textContent = `👑 ${leader.isYou ? 'You' : leader.name} · ${leader.points} pts`;
  if (!quiet && currentLeaderEl.dataset.id !== leader.id) {
    showAlert(leader.isYou ? 'You took the lead!' : `${leader.name} took the lead!`, leader.isYou ? 'success' : 'info');
  }
  currentLeaderEl.dataset.id = leader.id;
}



// Someone got through every word, which ends the round for everyone. Its players get a moment to see that
// happen, then the results; anyone waiting in the lobby just hears who won.
socket.on('round-over', (results) => {
  if (view === 'game' && results.round === roundId) {
    roundOver(results);
  } else if (view === 'lobby') {
    showAlert(`${results.winnerId === myId ? 'You' : results.winnerName} won the round!`, 'info');
  }
});

function roundOver(results) {
  if (roundEnding) return;
  roundEnding = true;
  timer.stop();
  clearInterval(finishWatch);
  // Whoever finished has just seen their last word land; everyone else is stopped mid-word
  const byYou = results.finisherId === myId;
  if (!byYou) {
    showFeedback('Round over!');
    if (results.finisherName) showAlert(`${results.finisherName} got through all ${currentWords.length} words!`, 'info');
  }
  setTimeout(() => showResults(results), byYou ? 900 : 1800);
}



// Same as wordHash in index.js (32-bit FNV-1a)
function wordHash(word) {
  let hash = 0x811c9dc5;
  for (const letter of word.toLowerCase()) hash = Math.imul(hash ^ letter.charCodeAt(0), 0x01000193);
  return hash >>> 0;
}

function shuffleTiles() {
  if (!isPlaying() || locked) return;
  const spell = (o) => o.map(i => tiles[i].letter).join('');
  const current = spell(order);
  const answer = currentHashes[currentLevel];
  const isAnswer = (o) => answer !== undefined && wordHash(spell(o)) === answer;
  let next = order;
  // Re-roll so the button never looks like it did nothing (happens a lot with 3-letter words),
  // and never hands over the answer
  for (let tries = 0; tries < 20; tries++) {
    next = [...order].sort(() => 0.5 - Math.random());
    if (spell(next) !== current && !isAnswer(next)) break;
  }
  // Out of tries: staying put is better than showing the answer (the order on screen never spells it)
  if (isAnswer(next)) next = order;
  order = next;
  tilesEl.replaceChildren(...order.map(i => tiles[i].el));
}

shuffleBtn.addEventListener('click', shuffleTiles);
