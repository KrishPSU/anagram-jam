// Practice mode: words one after another for as long as you like - no clock, no points, no leaderboard. Stuck on one?
// 🤷 shows you the word, and the next one comes up. Words start at 3 letters and get a letter longer after every 5 you
// get (the ones 🤷 showed you don't count), up to 10.
//
// The page gets every word from the server once (practiceWords in solo.js at the project root) and deals them itself,
// so nothing waits on the network after that, and no connection is held open however long the tab is left there.
// tiles.js is the word on screen, as in solo mode.

const FIRST_LENGTH = 3;   // as in solo.js
const LONGEST = 10;       // and words stay this long after that
const GOT_PER_LENGTH = 5; // a letter longer after this many got
const REVEAL_MS = 2000;   // how long 🤷's word stays up before the next one

const homeBtn = document.getElementById('homeBtn');
const solvedPillEl = document.getElementById('solvedPill');
const progressEl = document.getElementById('progress');
const levelLabelEl = document.getElementById('levelLabel');
const lengthLabelEl = document.getElementById('lengthLabel');
const loadViewEl = document.getElementById('loadView');
const loadTextEl = document.getElementById('loadText');
const retryBtn = document.getElementById('retryBtn');
const feedbackEl = document.getElementById('feedback');
const shrugBtn = document.getElementById('shrugBtn');
const tierEl = document.getElementById('tier');
const tierEls = [...tierEl.querySelectorAll('li')];

const view = 'game'; // the music (/js/audio.js) plays the round's track

let lists = null;     // word length -> [the word, ...the other real words its letters make], one for each word
const decks = {};     // word length -> the words of that length still to deal, shuffled
let word = null;      // on screen: [the word, ...the others] - any of them is right
let wordLength = FIRST_LENGTH;
let got = 0;          // words got at this length
let dealt = 0;
let solved = 0;
let locked = false;   // celebrating a right answer, or showing 🤷's word - no input

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function canPick() {
  return !!word && !locked;
}

// Typing goes to the word (tiles.js) once there is one
function canType() {
  return !!word;
}

// ? on a keyboard (tiles.js)
const helpKey = giveUp;

// The word's hash and the others' (tiles.js shuffles clear of them)
function answerHashes() {
  return word ? word.map(wordHash) : [];
}


// Every word, once. A few tries, since a phone's connection can blink - then a Try again button.
async function loadWords() {
  loadTextEl.innerHTML = '<span class="spinner" aria-hidden="true"></span>Getting words…';
  retryBtn.hidden = true;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch('/practice/words.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      lists = await res.json();
      loadViewEl.hidden = true;
      progressEl.hidden = false;
      nextWord();
      return;
    } catch (err) {
      console.log("Couldn't load the practice words:", err);
      if (attempt < 3) await wait(1000 * attempt);
    }
  }
  loadTextEl.textContent = "Couldn't get the words. Check your connection.";
  retryBtn.hidden = false;
}

// The next word, from a shuffled deck of every word that long - dealt to the end before it's shuffled again
function nextWord() {
  let longer = false;
  if (got >= GOT_PER_LENGTH && wordLength < LONGEST) {
    wordLength++;
    got = 0;
    longer = true;
  }
  if (!decks[wordLength] || !decks[wordLength].length) decks[wordLength] = shuffle(lists[wordLength]);
  word = decks[wordLength].pop();
  dealt++;
  locked = false;
  levelLabelEl.textContent = `Word ${dealt}`;
  lengthLabelEl.textContent = `${wordLength} letters`;
  if (longer) restart(lengthLabelEl, 'bump');
  // The dots count up to the next length - there isn't one past the longest
  tierEl.hidden = wordLength === LONGEST;
  tierEls.forEach((dot, i) => dot.classList.toggle('done', i < got));
  showWord(scramble(word));
}

// The letters mixed up so they don't already spell an answer, as in solo.js (every word in words.js has such an order)
function scramble(answers) {
  let letters;
  do {
    letters = shuffle([...answers[0]]).join('');
  } while (answers.includes(letters));
  return letters;
}

// Fisher-Yates shuffle (returns a new array), as in solo.js
function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}


// A full answer row (from tiles.js): right - the word, or another real one with its letters - and on to the next
// word, or wrong - shake, and the letters come back to try again. (A row still marked wrong has been checked already.)
function answerReady() {
  if (!canPick() || picked.length < tiles.length || slotsEl.classList.contains('wrong')) return;
  const answer = currentAnswer();
  landAll();

  if (!word.includes(answer)) {
    slotsEl.classList.add('wrong');
    sfx.wrong();
    sfx.buzz([60, 40, 60]);
    // The letters come back - unless one's been taken out meanwhile, to fix the answer by hand
    const at = dealt;
    setTimeout(() => {
      if (dealt === at && canPick() && picked.length === tiles.length) clearAnswer();
    }, 450);
    return;
  }

  solved++;
  solvedPillEl.textContent = `${solved} solved`;
  got++;
  locked = true;
  slotsEl.classList.add('win');
  showFeedback(answer === word[0] ? 'Nice!' : 'Another word!');
  sfx.correct();
  sfx.buzz(30);
  setTimeout(nextWord, 400);
}

// 🤷, or ?: the word goes up in the answer row for a moment, then the next one comes. It doesn't count toward the words
// getting longer.
function giveUp() {
  if (!canPick()) return;
  locked = true;
  revealAnswer(word[0]);
  restart(shrugBtn, 'shrugging');
  sfx.shrug();
  setTimeout(nextWord, REVEAL_MS);
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


homeBtn.addEventListener('click', () => {
  window.location.href = '/';
});
shrugBtn.addEventListener('click', giveUp);
retryBtn.addEventListener('click', loadWords);

// Every script on the page has run by now, tiles.js's included
document.addEventListener('DOMContentLoaded', loadWords);
