// Solo mode: one player against the clock. They get two minutes to unscramble as many words as they can, with no
// skipping, and every 5 words the words get a letter longer - 3 letters to start, up to 10. The hidden word is worth 2
// points and any other real word made from all the same letters 1, with 1 more for getting it in under 3 seconds.
// Each player's best goes on a leaderboard everyone can see, with how many words it got.
//
// The page plays the two minutes on its own, so nothing waits on the network between words (see solo/js/run.js), and sends
// its answers when the time is up. The words were picked here and every answer is checked again here, so the score
// that goes on the leaderboard is the server's own - a made-up one can't be sent in.

const WORDS = require('./words');
const DICTIONARY = require('word-exists/dictionary.json'); // word-exists' own list, as used for rooms' answers
const { isRude } = require('./names');

const RUN_SECONDS = 120;
const FIRST_LENGTH = 3;
const LONGEST = 10; // words stay this long after that
const WORDS_PER_LENGTH = 5;
const QUICK_MS = 3000; // an answer this fast earns the extra point
// Every word a run can get to. Nobody gets through 40 in two minutes - the last five are ten letters long.
const RUN_WORDS = (LONGEST - FIRST_LENGTH + 1) * WORDS_PER_LENGTH;
// The page's 3-2-1 comes between asking for the run and its clock starting
const COUNTDOWN_MS = 4000;
// A run can still be sent in this long after its time is up - time for a phone whose connection dropped right at
// the end to get it through (the page keeps trying, and has a Try again button)
const FINISH_GRACE = 2 * 60 * 1000;
const RESULTS_TOP = 10; // the top of the leaderboard, as the results screen shows it
const BOARD_TOP = 50;   // and as the leaderboard itself does
const ADMIN_TOP = 1000; // the admin page's, all of it for some time to come (and what its export holds)
const RUN_VERSION = 1; // runs laid out any other way (from before a deploy) count as gone

// A leaderboard score as the store keeps it: one number, higher is better. Points first, then - on the same points -
// whoever got there first (the time fills the digits below the points, and SCORE_SPAN is more milliseconds than
// there will ever be). The best possible run is 120 points, well inside what a number holds exactly.
const SCORE_SPAN = 1e13;
const scoreKey = (points, at) => points * SCORE_SPAN + (SCORE_SPAN - 1 - at);
const pointsOf = (score) => Math.floor(score / SCORE_SPAN);
const timeOf = (score) => SCORE_SPAN - 1 - (score % SCORE_SPAN);


// The real words that can be made from all of a word's letters, the word itself among them - for the words in words.js,
// solo's and the rooms' alike (see answerHashes in index.js). Worked out from the dictionary one length at a time, the
// first time a word that long comes up, so starting the server never waits on it, and the rooms' 3 to 5 letters take a
// few milliseconds (all of solo's lengths, about a tenth of a second).
const answerSets = new Map(); // word length -> (its letters in order -> the words they make)

const letterKey = (word) => [...word].sort().join('');

function answersFor(word) {
  let sets = answerSets.get(word.length);
  if (!sets) {
    sets = new Map((WORDS[word.length] || []).map(w => [letterKey(w), []]));
    for (const words of Object.values(DICTIONARY)) {
      for (const w of words) {
        if (w.length !== word.length) continue;
        const answers = sets.get(letterKey(w));
        if (answers) answers.push(w);
      }
    }
    answerSets.set(word.length, sets);
  }
  return sets.get(letterKey(word)) || [word];
}

// Fisher-Yates shuffle (returns a new array), as in index.js
function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Same as wordHash in index.js and the pages (32-bit FNV-1a): the page gets these instead of the answers
function wordHash(word) {
  let hash = 0x811c9dc5;
  for (const letter of word.toLowerCase()) hash = Math.imul(hash ^ letter.charCodeAt(0), 0x01000193);
  return hash >>> 0;
}

// The letters mixed up so they don't already spell an answer - not the hidden word, and not another real word either,
// or tapping the tiles in the order they came would score. Every word in words.js has such an order.
function scramble(word) {
  const answers = answersFor(word);
  let letters;
  do {
    letters = shuffle([...word]).join('');
  } while (answers.includes(letters));
  return letters;
}

function pickWords() {
  const words = [];
  for (let length = FIRST_LENGTH; length <= LONGEST; length++) {
    words.push(...shuffle(WORDS[length]).slice(0, WORDS_PER_LENGTH));
  }
  return words.slice(0, RUN_WORDS);
}


// What a run's answers are worth. answers: { answer, ms } for each word they solved, in order, ms being how long it took
// them - from its letters showing up to the last one being placed. That's timed on the page, so a slow connection
// can't cost anyone the quick bonus. Counting stops at the first answer that doesn't hold up, or that couldn't have
// fitted in the time.
function scoreRun(run, answers) {
  const solved = [];
  let points = 0;
  let spent = 0;
  for (const [level, sent] of answers.slice(0, run.words.length).entries()) {
    const word = run.words[level];
    const answer = sent && typeof sent.answer === 'string' ? sent.answer.toLowerCase() : '';
    const ms = sent && Number.isFinite(sent.ms) ? Math.max(0, Math.round(sent.ms)) : null;
    const worth = answer === word ? 2 : answersFor(word).includes(answer) ? 1 : 0;
    if (!worth || ms === null || spent + ms > RUN_SECONDS * 1000) break;
    spent += ms;
    const quick = ms < QUICK_MS;
    points += worth + (quick ? 1 : 0);
    solved.push({ word, scramble: run.scrambles[level], answer, points: worth + (quick ? 1 : 0), quick, ms });
  }
  const stuck = solved.length < run.words.length ? { word: run.words[solved.length], scramble: run.scrambles[solved.length] } : null;
  return { points, solved, stuck };
}


// A name as typed - trimmed, and at most 20 characters, as in rooms
function cleanName(name) {
  return typeof name === 'string' ? name.trim().slice(0, 20) : '';
}

// The name as the leaderboard shows it (see names.js)
function shownName(name) {
  return !name || isRude(name) ? 'Player' : name;
}

const isRunId = (id) => typeof id === 'string' && /^[0-9a-f]{16,64}$/.test(id);
const isToken = (token) => typeof token === 'string' && token.length >= 16;

// A leaderboard row for a page: no ids (they're the players' token hashes), just whether it's the one asking. words:
// how many words their best got.
const rowFor = (playerId) => (entry, i) => ({ rank: i + 1, name: shownName(entry.name), words: entry.words, points: pointsOf(entry.score), you: entry.id === playerId });


// store: where runs and the leaderboard are kept (see data.js). playerIdFor: who a browser's token is, as in rooms.
// onFinish(run, scored): told about each run as it's scored, once (for the admin page's log and stats).
function createSolo({ store, playerIdFor, onFinish = () => {} }) {

  // A new run for the player whose browser holds `token`. The page makes up the run's id, so asking twice (the reply
  // got lost) gets the same run back rather than a second one.
  // Replies { status: 'ok', run, words (scrambled), hashes, others, seconds } or { status: 'bad' }.
  async function start({ run: id, token, name } = {}) {
    name = cleanName(name);
    if (!isRunId(id) || !isToken(token) || !name) return { status: 'bad' };
    const playerId = playerIdFor(token);
    let run;
    try {
      const words = pickWords();
      run = { v: RUN_VERSION, id, playerId, name, words, scrambles: words.map(scramble), startedAt: Date.now(), result: null };
      if (!(await store.createRun(run))) run = await store.getRun(id);
    } catch (err) {
      console.error('Starting a solo run failed:', err.message);
      return { status: 'bad' };
    }
    if (!run || run.playerId !== playerId) return { status: 'bad' };
    return {
      status: 'ok',
      run: run.id,
      words: run.scrambles,
      // The answers in hashes only: the hidden word's, and the other real words' (1 point each)
      hashes: run.words.map(wordHash),
      others: run.words.map(word => answersFor(word).filter(w => w !== word).map(wordHash)),
      seconds: RUN_SECONDS,
    };
  }

  // The time is up: the page sends its answers (see scoreRun), and the run goes on the leaderboard. Asking again
  // (the reply got lost) gets the same reply.
  // Replies { status: 'ok', points, solved, stuck, board } - board as placeOnBoard has it - or with status 'gone' (no
  // such run of theirs, or it's expired) or 'late' (sent in too long after the time was up).
  async function finish({ run: id, token, answers } = {}) {
    if (!isRunId(id) || !isToken(token) || !Array.isArray(answers)) return { status: 'gone' };
    let run;
    try {
      run = await store.getRun(id);
    } catch (err) {
      console.error('Reading a solo run failed:', err.message);
    }
    if (!run || run.v !== RUN_VERSION || run.playerId !== playerIdFor(token)) return { status: 'gone' };
    if (run.result) return run.result;
    if (Date.now() > run.startedAt + COUNTDOWN_MS + RUN_SECONDS * 1000 + FINISH_GRACE) return { status: 'late' };

    const scored = scoreRun(run, answers);
    run.result = { status: 'ok', ...scored, board: await placeOnBoard(run, scored.points, scored.solved.length) };
    try {
      await store.saveRun(run);
    } catch (err) {
      console.error('Saving a solo result failed:', err.message);
    }
    console.log(`Solo run by ${run.name}: ${scored.points} points, ${scored.solved.length} words`);
    onFinish(run, scored);
    return run.result;
  }

  // Where the run puts the player, once it's on the leaderboard (only runs that scored go on):
  // { better: the share of the other players' bests it beats, as a whole percent (null when nobody else is on it),
  //   first: they're the first on the leaderboard, players: how many are on it, rank, best and bestWords: their best's
  //   place, points and words, newBest: this run beat their best, top: the first few rows }
  // null if the leaderboard can't be reached right now.
  async function placeOnBoard(run, points, words) {
    let standing;
    try {
      standing = points > 0
        ? await store.addScore(run.playerId, scoreKey(points, Date.now()), run.name, words, points * SCORE_SPAN, RESULTS_TOP)
        : await store.leaderboard(RESULTS_TOP, run.playerId);
    } catch (err) {
      console.error('Putting a solo run on the leaderboard failed:', err.message);
      return null;
    }
    if (!standing) return null;
    const onBoard = standing.rank !== null;
    // "Better than" counts players with fewer points - never the player themselves, whose best is at least this run
    const others = standing.total - (onBoard ? 1 : 0);
    return {
      better: points > 0 && others > 0 ? Math.floor((100 * standing.lower) / others) : null,
      first: points > 0 && others === 0,
      players: standing.total,
      rank: onBoard ? standing.rank + 1 : null,
      best: onBoard ? pointsOf(standing.best) : null,
      bestWords: onBoard ? standing.words : null,
      newBest: points > 0 && standing.before !== null && points > pointsOf(standing.before),
      top: standing.top.map(rowFor(run.playerId)),
    };
  }

  // The leaderboard: the first `count` rows (up to 50), and where the player whose browser holds `token` is on it.
  // Replies { status: 'ok', players, top, you: { rank, words, points } or null } or { status: 'unavailable' }.
  async function board({ token, count } = {}) {
    const playerId = isToken(token) ? playerIdFor(token) : '';
    count = Number.isInteger(count) ? Math.min(Math.max(count, 0), BOARD_TOP) : BOARD_TOP;
    let board;
    try {
      board = await store.leaderboard(count, playerId);
    } catch (err) {
      console.error('Reading the solo leaderboard failed:', err.message);
    }
    if (!board) return { status: 'unavailable' };
    return {
      status: 'ok',
      players: board.total,
      top: board.top.map(rowFor(playerId)),
      you: board.rank === null ? null : { rank: board.rank + 1, words: board.words, points: pointsOf(board.best) },
    };
  }


  // For the admin page, which only calls these for someone signed in (see admin.js).

  // The top of the leaderboard with each player's id and their name as typed. Replies { status: 'ok', players, top } or
  // { status: 'unavailable' }.
  async function adminBoard() {
    let board;
    try {
      board = await store.leaderboard(ADMIN_TOP, '');
    } catch (err) {
      console.error('Reading the solo leaderboard failed:', err.message);
    }
    if (!board) return { status: 'unavailable' };
    return {
      status: 'ok',
      players: board.total,
      top: board.top.map((entry, i) => ({ rank: i + 1, id: entry.id, name: entry.name, hidden: shownName(entry.name) !== entry.name, words: entry.words, points: pointsOf(entry.score), at: timeOf(entry.score) })),
    };
  }

  // Takes player `id` off the leaderboard. They're back on it if they play again. Replies { status: 'ok' } or
  // { status: 'unavailable' }.
  async function adminRemove({ id } = {}) {
    if (typeof id !== 'string') return { status: 'ok' };
    let removed;
    try {
      removed = await store.removeScore(id);
    } catch (err) {
      console.error('Removing a solo score failed:', err.message);
    }
    if (removed === null || removed === undefined) return { status: 'unavailable' };
    console.log(`Admin took player ${id} off the solo leaderboard`);
    return { status: 'ok' };
  }

  return { start, finish, board, adminBoard, adminRemove };
}

module.exports = { createSolo, scoreRun, scramble, answersFor, RUN_WORDS };
