// A word being played: its letters (tiles.js), its clock and its tries. A try only counts once it's checked (✓ or
// Enter), so a slip of the finger doesn't use one up. Each one goes to the server, which checks it and keeps it (see
// guess in daily.js at the project root) - so leaving or reloading carries on with the tries that are left, and the
// clock where it was. The page never has the word itself until the word is done.

const TRIES = 3; // as in daily.js at the project root

const levelPillEl = document.getElementById('levelPill');
const clockEl = document.getElementById('clock');
const playNumberEl = document.getElementById('playNumber');
const lengthLabelEl = document.getElementById('lengthLabel');
const triesEl = document.getElementById('tries');
const triesEls = [...triesEl.querySelectorAll('li')];
const feedbackEl = document.getElementById('feedback');
const checkBtn = document.getElementById('checkBtn');
const missedListEl = document.getElementById('missedList');

let current = null;   // the word on screen: { level, hashes, guesses (the wrong tries so far), startedAt (by Date.now()) }
let onWord = false;   // it's being played - not done yet ("playing" is taken: it's the music's, in /js/audio.js)
let checking = false; // a try is on its way to the server
let clock = null;

function canPick() {
  return onWord && !checking;
}

// Typing goes to the word (tiles.js) while it's being played - and not behind a box
function canType() {
  return view === 'game' && onWord && !leaveDialog.open && !resultDialog.open;
}

// No hints in Daily Jam: ? on a keyboard does nothing (tiles.js)
function helpKey() {}

// The word's hash and the other real words' (tiles.js shuffles clear of them)
function answerHashes() {
  return current ? current.hashes : [];
}

// The answer row is full (tiles.js) - it's up to the player to check it, and the ✓ lights up (slotsChanged)
function answerReady() {}

// The answer row changed (tiles.js): the ✓ is lit while every letter is in it
function slotsChanged() {
  checkBtn.classList.toggle('ready', canPick() && tiles.length > 0 && picked.length === tiles.length);
}


// A word from today's list, new or carried on with. btn: the list's button for it, which waits with a spinner.
async function openWord(level, btn) {
  levelBtns.forEach(b => { b.disabled = true; });
  btn.classList.add('opening');
  // The nickname from the home page goes along, for today's leaderboard and the admin page (an account's name wins over it)
  const reply = await request('daily-open', { day, level, token: playerToken(), name: localStorage.getItem('name') || '' }).catch(() => null);
  levelBtns.forEach(b => { b.disabled = false; });
  btn.classList.remove('opening');
  if (!reply) {
    showAlert("Couldn't reach the game. Check your connection and try again.");
    return;
  }
  if (reply.status === 'paused') {
    showAlert(reply.message, 'info', 6000);
    return;
  }
  if (reply.status === 'not-today') {
    // Past midnight since the list came up
    loadDay();
    return;
  }
  if (reply.status !== 'ok') {
    showAlert("Daily Jam isn't available right now. Try again in a bit.");
    return;
  }
  setPlay(level, reply.play, reply.result);
  // Done already (on another tab, say)
  if (reply.play.solved !== null) {
    showDay();
    showResult(level, reply.play, reply.result);
    return;
  }
  beginWord(level, reply);
}

function beginWord(level, reply) {
  current = { level, hashes: reply.hashes, guesses: [...reply.play.guesses], startedAt: Date.now() - reply.play.elapsed };
  checking = false;
  showView('game');
  levelPillEl.textContent = LEVEL_NAMES[level];
  playNumberEl.textContent = `Daily Jam #${today.number}`;
  lengthLabelEl.textContent = `${reply.scramble.length} letters`;
  feedbackEl.classList.remove('show');
  onWord = true;
  showWord(reply.scramble);
  showTries();
  clearInterval(clock);
  clock = setInterval(tick, 250);
  tick();
}

// The clock is worked out from when the word was opened each time rather than counted, so it can't fall behind - a
// hidden tab's timers are slowed down, and a locked phone's stop
function tick() {
  if (onWord) clockEl.textContent = formatTime(Date.now() - current.startedAt);
}

// The tries used, and the wrong ones below the buttons
function showTries() {
  const used = current.guesses.length;
  triesEls.forEach((el, i) => el.classList.toggle('used', i < used));
  triesEl.setAttribute('aria-label', `${TRIES - used} ${TRIES - used === 1 ? 'try' : 'tries'} left`);
  missedListEl.replaceChildren(...current.guesses.map((guess) => {
    const item = document.createElement('li');
    item.textContent = guess.toUpperCase();
    return item;
  }));
}

// Restarts a CSS animation that runs while the element has `className`
function restart(el, className) {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

// note: a smaller line, for a few words of explanation
function showFeedback(text, note = false) {
  feedbackEl.textContent = text;
  feedbackEl.classList.toggle('note', note);
  restart(feedbackEl, 'show');
}


// ✓ or Enter: the try goes to the server to be checked. It's only sent with every letter in, and one they've tried
// already isn't sent at all - it wouldn't count.
async function check() {
  if (!canPick()) return;
  if (picked.length < tiles.length) {
    restart(checkBtn, 'nope');
    showFeedback('Use every letter first', true);
    return;
  }
  const answer = currentAnswer();
  if (current.guesses.includes(answer)) {
    showFeedback('You tried that one already', true);
    shakeAnswer();
    return;
  }

  const word = current;
  checking = true;
  landAll();
  slotsChanged();
  slotsEl.classList.add('checking');
  const reply = await request('daily-guess', { day, level: word.level, token: playerToken(), try: word.guesses.length + 1, guess: answer }, { tries: 4 })
    .catch(() => null);
  if (current !== word) return; // left the word meanwhile
  checking = false;
  slotsEl.classList.remove('checking');

  if (!reply) {
    showAlert("Couldn't reach the game to check that. Check your connection, then tap ✓ again.");
    slotsChanged();
    return;
  }
  if (reply.status !== 'ok') {
    showAlert(reply.status === 'unavailable' ? "Daily Jam isn't available right now. Try again in a bit." : "That word can't be played any more.");
    onWord = false;
    backToDay();
    return;
  }

  const play = reply.play;
  setPlay(word.level, play, reply.result);
  if (play.solved === true) {
    gotIt(play, reply.result);
    return;
  }
  const counted = play.guesses.length > word.guesses.length;
  word.guesses = [...play.guesses];
  showTries();
  if (play.solved === false) {
    outOfTries(play, reply.result);
  } else if (counted) {
    const left = TRIES - play.guesses.length;
    showFeedback(`Not it · ${left} ${left === 1 ? 'try' : 'tries'} left`, true);
    shakeAnswer();
  } else {
    // Counted already (on another tab, say)
    showFeedback('You tried that one already', true);
    shakeAnswer();
  }
}

// Wrong: shake, and the letters come back to go again - unless one's been taken out meanwhile, to fix it by hand
function shakeAnswer() {
  slotsEl.classList.add('wrong');
  sfx.wrong();
  sfx.buzz([60, 40, 60]);
  const word = current;
  setTimeout(() => {
    if (current === word && canPick() && picked.length === tiles.length) clearAnswer();
  }, 450);
}

function gotIt(play, result) {
  const level = current.level;
  finishWord(play);
  slotsEl.classList.add('win');
  showFeedback(play.answer === play.word ? 'Got it!' : 'Another word!');
  sfx.correct();
  sfx.buzz(30);
  setTimeout(() => {
    sfx.win();
    confetti();
    showResult(level, play, result);
  }, 900);
}

// The last try was wrong: after its shake, the word is shown in the answer row, then how it went
function outOfTries(play, result) {
  const word = current;
  const level = word.level;
  finishWord(play);
  slotsEl.classList.add('wrong');
  sfx.wrong();
  sfx.buzz([60, 40, 60]);
  setTimeout(() => {
    if (current !== word) return; // left meanwhile
    revealAnswer(play.word);
    showFeedback('Out of tries', true);
    sfx.timeUp();
  }, 600);
  setTimeout(() => showResult(level, play, result), 2200);
}

// Done, got or not: the clock stops at the server's time for it
function finishWord(play) {
  onWord = false;
  justFinished = true;
  clearInterval(clock);
  clockEl.textContent = formatTime(play.ms);
  landAll();
  slotsChanged();
  if (leaveDialog.open) leaveDialog.close('stay');
}

// Off the word screen (see showView)
function leaveWord() {
  onWord = false;
  checking = false;
  current = null;
  clearInterval(clock);
  clearWord();
  missedListEl.replaceChildren();
}


checkBtn.addEventListener('click', check);

// Enter checks (tiles.js leaves it alone)
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || !canType()) return;
  event.preventDefault();
  check();
});
