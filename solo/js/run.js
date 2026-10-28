// The minute: its clock, the words one after another, and the points. The page checks each answer itself against the
// hashes the run came with (see start in solo.js at the project root), so the next word is up straight away - nothing
// waits on the network until the time is up. Then the server checks every answer again and scores the run itself.

const SECONDS = 60;          // as in solo.js at the project root
const WORDS_PER_LENGTH = 5;  // as in solo.js
const QUICK_MS = 3000;       // as in solo.js
const TIMER_RING = 2 * Math.PI * 21; // circumference of the timer ring in solo.html

const startBtn = document.getElementById('startBtn');
const countdownEl = document.getElementById('countdown');
const countNumEl = document.getElementById('countNum');
const countWaitEl = document.getElementById('countWait');
const scorePillEl = document.getElementById('scorePill');
const gameTimerEl = document.getElementById('gameTimer');
const timerTextEl = document.getElementById('timerText');
const timerBarEl = document.getElementById('timerBar');
const levelLabelEl = document.getElementById('levelLabel');
const lengthLabelEl = document.getElementById('lengthLabel');
const quickEl = document.getElementById('quick');
const feedbackEl = document.getElementById('feedback');
const tierEls = [...document.querySelectorAll('#tier li')];

let run = null;        // the server's: { run (its id), words (scrambled), hashes, others (see start in solo.js) }
let level = 0;         // the word on screen
let points = 0;
let answers = [];      // { answer, ms, points, quick } for each word solved, in order - the server scores answer and ms
let endsAt = 0;        // when the minute is up, by Date.now() - which keeps going while the phone is locked
let shownAt = 0;       // when the word on screen came up
let clock = null;
let shownSeconds = null;
let running = false;   // the minute is going ("playing" is taken: it's the music's, in /js/audio.js)
let locked = false;    // celebrating a right answer - no input
let starting = false;  // waiting on the 3-2-1 and the words

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function canPick() {
  return running && !locked;
}

// The hidden word's hash and the other real words', for the word on screen (tiles.js shuffles clear of them)
function answerHashes() {
  return run ? [run.hashes[level], ...run.others[level]] : [];
}


// Start, or Play again: the 3-2-1 runs while the words are on their way, so the minute starts right after GO
async function startRun() {
  if (starting) return;
  starting = true;
  setStarting(true);
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  const asking = request('solo-start', { run: id, token: playerToken(), name: playerName }).catch(() => null);
  await countdown();
  // Only seen if the words still aren't here
  countWaitEl.hidden = false;
  const reply = await asking;
  countdownEl.hidden = true;
  starting = false;
  setStarting(false);
  if (!reply || reply.status !== 'ok') {
    showAlert("Couldn't reach the game. Try again.");
    return;
  }
  beginRun(reply);
}

// The buttons that start a run, locked while one is starting (Play again is on the results screen)
function setStarting(on) {
  [startBtn, playAgainBtn].forEach(btn => { btn.disabled = on; });
}

// 3, 2, 1, GO! - as in a room's lobby. Resolves a second after GO.
function countdown() {
  countdownEl.hidden = false;
  countWaitEl.hidden = true;
  const show = (text) => {
    countNumEl.textContent = text;
    countNumEl.classList.remove('tick');
    void countNumEl.offsetWidth; // restart the animation
    countNumEl.classList.add('tick');
  };
  return new Promise((resolve) => {
    let count = 3;
    show(count);
    sfx.beep();
    const timer = setInterval(() => {
      count--;
      if (count > 0) {
        show(count);
        sfx.beep();
      } else if (count === 0) {
        show('GO!');
        sfx.go();
      } else {
        clearInterval(timer);
        resolve();
      }
    }, 1000);
  });
}

function beginRun(reply) {
  run = reply;
  level = 0;
  answers = [];
  setPoints(0);
  showView('game');
  running = true;
  endsAt = Date.now() + SECONDS * 1000;
  shownSeconds = null;
  clearInterval(clock);
  clock = setInterval(tick, 200);
  tick();
  showLevel();
}

// The clock is worked out from endsAt each time rather than counted down, so it can't fall behind: a hidden tab's
// timers are slowed down, and a locked phone's stop altogether.
function tick() {
  const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  if (left !== shownSeconds) {
    shownSeconds = left;
    timerTextEl.textContent = left;
    timerBarEl.style.strokeDashoffset = TIMER_RING * (1 - left / SECONDS);
    gameTimerEl.classList.toggle('urgent', left <= 10);
    if (left <= 5 && left > 0 && running) sfx.tick();
  }
  if (running && left === 0) timeUp();
}

// Back from another app or tab: the time may be up already
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && running) tick();
});

function setPoints(value) {
  points = value;
  scorePillEl.textContent = `${points} pts`;
}

function showLevel() {
  locked = false;
  const scramble = run.words[level];
  levelLabelEl.textContent = `Word ${level + 1}`;
  lengthLabelEl.textContent = `${scramble.length} letters`;
  tierEls.forEach((dot, i) => dot.classList.toggle('done', i < level % WORDS_PER_LENGTH));
  showWord(scramble);
  shownAt = Date.now();
  restart(quickEl, 'running');
}

// Restarts a CSS animation that runs while the element has `className`
function restart(el, className) {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

function showFeedback(text) {
  feedbackEl.textContent = text;
  restart(feedbackEl, 'show');
}


// A full answer row (from tiles.js), filled at `filledAt`: right - celebrate, then on to the next word - or wrong -
// shake, and the letters come back to try again. (A row still marked wrong has been checked already.)
function answerReady(filledAt) {
  if (!canPick() || picked.length < tiles.length || slotsEl.classList.contains('wrong')) return;
  const answer = currentAnswer();
  const hash = wordHash(answer);
  const worth = hash === run.hashes[level] ? 2 : run.others[level].includes(hash) ? 1 : 0;
  landAll();

  if (!worth) {
    slotsEl.classList.add('wrong');
    sfx.wrong();
    sfx.buzz([60, 40, 60]);
    // The letters come back - unless one's been taken out meanwhile, to fix the answer by hand
    const at = level;
    setTimeout(() => {
      if (level === at && canPick() && picked.length === tiles.length) clearAnswer();
    }, 450);
    return;
  }

  const ms = filledAt - shownAt;
  const quick = ms < QUICK_MS;
  const gained = worth + (quick ? 1 : 0);
  answers.push({ answer, ms, points: gained, quick });
  setPoints(points + gained);
  locked = true;
  quickEl.classList.remove('running');
  slotsEl.classList.add('win');
  showFeedback(`+${gained}${quick ? ' ⚡' : ''}${worth === 1 ? ' · another word!' : ''}`);
  sfx.correct();
  sfx.buzz(30);
  // A short moment for the win - the clock is still going
  const at = level;
  setTimeout(() => {
    if (running && level === at) nextWord();
  }, 400);
}

function nextWord() {
  level++;
  // Every word there is. Nobody gets this far in a minute, but if they did, that's the run.
  if (level >= run.words.length) {
    timeUp();
    return;
  }
  showLevel();
  // A letter longer from here
  if (level % WORDS_PER_LENGTH === 0) restart(lengthLabelEl, 'bump');
}


// The minute is up: the word you were on is shown (the server says what it was), then the results
function timeUp() {
  if (!running) return;
  running = false;
  clearInterval(clock);
  tick();
  landAll();
  quickEl.classList.remove('running');
  if (leaveDialog.open) leaveDialog.close('stay');
  sfx.timeUp();
  showFeedback("Time's up!");
  levelLabelEl.textContent = "Time's up!";
  finishRun();
}

async function finishRun() {
  // The reply is normally back in a moment - on a slow connection, the screen says what it's waiting for
  const slow = setTimeout(() => { lengthLabelEl.textContent = 'Saving your score…'; }, 1000);
  const reply = await sendRun();
  clearTimeout(slow);
  if (reply && reply.status === 'ok' && reply.stuck) {
    revealAnswer(reply.stuck.word);
    await wait(1600);
  } else {
    await wait(700);
  }
  showResults(reply);
}

// The answers, for the server to score. Resolves to its reply, or null if it couldn't be reached (results.js has a
// Try again button that sends it again - the server replies the same however many times it's asked).
function sendRun() {
  const sent = answers.map(({ answer, ms }) => ({ answer, ms }));
  return request('solo-finish', { run: run.run, token: playerToken(), answers: sent }, { tries: 4 }).catch(() => null);
}

// Off the word screen (see showView)
function stopRun() {
  running = false;
  clearInterval(clock);
  clearWord();
  gameTimerEl.classList.remove('urgent');
}


startBtn.addEventListener('click', startRun);
