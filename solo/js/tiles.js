// The word on screen: its letters as tiles to tap or type, and the answer row they go into. It works like the room
// page's (create-room/js/game.js) - same picking, flying and shuffling - but solo words go up to 10 letters, so a long
// word's tiles shrink to fit the screen, and go onto two rows rather than get too small to tap. Practice mode uses it too.
// The page's own script (run.js, or practice.js) decides when letters can be picked (canPick) and typed (canType),
// what a full answer row is worth (answerReady), and what ? on a keyboard does (helpKey) - in solo mode it uses a hint
// (giveLetter).

const tilesEl = document.getElementById('anagramDisplay');
const slotsEl = document.getElementById('answerSlots');
const gameContentEl = document.getElementById('gameContent');
const shuffleBtn = document.getElementById('shuffleBtn');
const undoBtn = document.getElementById('undoBtn');

// Smaller than this is hard to hit with a thumb. (The answer row can go smaller - it's mostly for reading.)
const MIN_TILE = 40;

let tiles = [];      // { letter, used, el } in the order the server scrambled them
let order = [];      // display order of `tiles` (changes on shuffle)
let picked = [];     // indexes into `tiles`, in the order they were picked
let given = 0;       // how many of the picked, from the first, a hint put there - they can't be taken back
let slots = [];      // the answer row's spaces, kept for the whole word so their animations aren't cut off
let flights = new Set(); // tiles still flying to the answer row - each entry lands its tile right away


function showWord(scramble) {
  landAll();
  tiles = [...scramble.toUpperCase()].map((letter, i) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'tile';
    el.textContent = letter;
    el.setAttribute('aria-label', `Letter ${letter}`);
    // Picked the moment a finger touches it. A click waits for the finger to lift, and phones drop
    // the click when another finger is already down, so quick two-thumb tapping would lose letters.
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
  given = 0;
  tilesEl.replaceChildren(...tiles.map(t => t.el));
  slots = tiles.map((_, i) => {
    const slot = document.createElement('button');
    slot.type = 'button';
    slot.addEventListener('click', () => removeAt(i));
    return slot;
  });
  slotsEl.replaceChildren(...slots);
  slotsEl.className = 'answer-slots';
  fitTiles();
  renderSlots();
}

// As big as the room page's tiles (--tile-size in game-state.css) when the word fits across the screen. Past that the
// answer row closes up and shrinks to stay on one line, and the tiles wrap onto a second row instead.
function fitTiles() {
  const count = tiles.length;
  if (!count) return;
  const style = getComputedStyle(gameContentEl);
  const size = parseFloat(style.getPropertyValue('--tile-size'));
  const gap = parseFloat(style.getPropertyValue('--tile-gap'));
  const width = gameContentEl.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const across = (perRow, spacing) => Math.floor((width - (perRow - 1) * spacing) / perRow);
  const fits = across(count, gap) >= MIN_TILE;

  const slotGap = fits ? gap : Math.min(gap, 4);
  slotsEl.style.setProperty('--tile-gap', `${slotGap}px`);
  slotsEl.style.setProperty('--tile-size', `${Math.min(size, across(count, slotGap))}px`);

  const perRow = fits ? count : Math.ceil(count / 2);
  const tileSize = Math.min(size, across(perRow, gap));
  tilesEl.style.setProperty('--tile-size', `${tileSize}px`);
  tilesEl.style.maxWidth = `${perRow * tileSize + (perRow - 1) * gap + 1}px`;
}

window.addEventListener('resize', fitTiles);

// text: letters to show instead of the picked ones (used to reveal the answer)
function renderSlots(text) {
  const letters = text ? [...text] : picked.map(i => tiles[i].letter);
  slots.forEach((slot, i) => {
    // toggle rather than reset the class, so a slot still waiting on its flying tile keeps 'landing'
    slot.classList.add('slot');
    slot.classList.toggle('filled', !!letters[i]);
    slot.classList.toggle('given', !text && i < given);
    slot.textContent = letters[i] || '';
    slot.setAttribute('aria-label', !text && i < given ? `${letters[i]}, from a hint` : letters[i] ? `Remove ${letters[i]}` : `Empty space ${i + 1}`);
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
  // Every answer uses all the letters, so a full row is ready to check. The quick bonus is timed to this moment,
  // not to the check a moment later.
  if (picked.length === tiles.length) {
    const filledAt = Date.now();
    setTimeout(() => answerReady(filledAt), 120);
  }
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
  if (!canPick() || slotIndex < given || slotIndex >= picked.length) return;
  landAll();
  const [i] = picked.splice(slotIndex, 1);
  tiles[i].used = false;
  tiles[i].el.classList.remove('used');
  slotsEl.classList.remove('wrong');
  renderSlots();
}

function undoLetter() {
  if (picked.length > given) removeAt(picked.length - 1);
}

// Every letter off the answer row but the ones a hint gave
function clearAnswer() {
  takeBack(given);
}

// The letters in the answer row's spaces from `from` on go back to the tiles
function takeBack(from) {
  landAll();
  picked.splice(from).forEach(i => {
    tiles[i].used = false;
    tiles[i].el.classList.remove('used');
  });
  slotsEl.className = 'answer-slots';
  renderSlots();
}

// A hint: the hidden word's next letter, straight after the letters in the answer row that are right so far (any after
// those go back first). steps: the hashes of the hidden word's first letter, its first two, and so on up to the whole
// word (see start in solo.js at the project root). Returns whether there was a letter to give.
function giveLetter(steps) {
  // A full row is about to be checked - unless it's been marked wrong already
  if (!canPick() || (picked.length === tiles.length && !slotsEl.classList.contains('wrong'))) return false;
  const spelled = currentAnswer();
  let right = given;
  while (right < picked.length && wordHash(spelled.slice(0, right + 1)) === steps[right]) right++;
  // The first tile on screen with the letter that comes next, from the ones not staying in the row
  const staying = picked.slice(0, right);
  const next = order.find(i => !staying.includes(i) && wordHash(spelled.slice(0, right) + tiles[i].letter) === steps[right]);
  if (next === undefined) return false;
  takeBack(right);
  given = right + 1;
  pickTile(next);
  return true;
}

// What the answer row spells
function currentAnswer() {
  return picked.map(i => tiles[i].letter).join('').toLowerCase();
}

// The word you were on when the time ran out
function revealAnswer(word) {
  landAll();
  tiles.forEach(t => t.el.classList.add('used'));
  slotsEl.className = 'answer-slots reveal';
  renderSlots(word.toUpperCase());
}

function clearWord() {
  landAll();
  tiles = [];
  picked = [];
  given = 0;
  slots = [];
  tilesEl.replaceChildren();
  slotsEl.replaceChildren();
}


// Same as wordHash in solo.js at the project root (32-bit FNV-1a)
function wordHash(word) {
  let hash = 0x811c9dc5;
  for (const letter of word.toLowerCase()) hash = Math.imul(hash ^ letter.charCodeAt(0), 0x01000193);
  return hash >>> 0;
}

function shuffleTiles() {
  if (!canPick()) return;
  const spell = (o) => o.map(i => tiles[i].letter).join('');
  const current = spell(order);
  const answers = answerHashes();
  const isAnswer = (o) => answers.includes(wordHash(spell(o)));
  let next = order;
  // Re-roll so the button never looks like it did nothing (happens a lot with 3-letter words), and never lays the
  // tiles out as an answer - the hidden word or any other
  for (let tries = 0; tries < 20; tries++) {
    next = [...order].sort(() => 0.5 - Math.random());
    if (spell(next) !== current && !isAnswer(next)) break;
  }
  // Out of tries: staying put is better than showing an answer (the order on screen never spells one)
  if (isAnswer(next)) next = order;
  order = next;
  tilesEl.replaceChildren(...order.map(i => tiles[i].el));
}

shuffleBtn.addEventListener('click', shuffleTiles);
undoBtn.addEventListener('click', undoLetter);


// Typing on a real keyboard, as on the room page (create-room/js/keyboard.js): letters pick a matching tile,
// Backspace takes the last one back and Space shuffles. A full row checks itself. ? is the page's (helpKey).
document.addEventListener('keydown', (event) => {
  // Leave browser shortcuts alone, and only type while the page says so
  if (event.metaKey || event.ctrlKey || event.altKey || !canType()) return;

  if (/^[a-z]$/i.test(event.key)) {
    event.preventDefault();
    typeLetter(event.key.toUpperCase());
  } else if (event.key === 'Backspace') {
    event.preventDefault();
    undoLetter();
  } else if (event.key === 'Enter' || event.key === ' ') {
    // preventDefault so a focused button isn't pressed as well
    event.preventDefault();
    if (event.key === ' ') shuffleTiles();
  } else if (event.key === '?' || event.key === '/') {
    event.preventDefault();
    helpKey();
  }
});
