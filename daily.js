// Daily Jam: three words a day - 5, 7 and 9 letters, for easy, medium and hard - the same for everyone. They go with the
// date where each player is, so they change at the player's own midnight, as Wordle's do. Each word has 3 tries and no
// hints, and its clock starts when it's opened and doesn't stop. Fewer tries is better, then a faster time. Once a word
// is done, got or not, the player sees the share of the day's players they did better than, how everyone did, and their
// streak (days in a row they finished at least one).
//
// A word doesn't come up again for at least a year. Every day's words are kept (daily_words in supabase/migrations),
// and a new day's are picked from the words that haven't been used within a year of it.
//
// Every try is checked here and kept as it's made, so nothing can be undone by reloading - the page carries on with the
// tries that are left, and the clock where it was.

const DICTIONARY = require('word-exists/dictionary.json'); // word-exists' own list, as used for rooms' answers
const DAILY_WORDS = require('./daily-words');

const LEVELS = { easy: 5, medium: 7, hard: 9 }; // word lengths
const TRIES = 3;
const GAP_DAYS = 366;           // a word comes up again no sooner than this many days later
const FIRST_DAY = '2026-10-28'; // Daily Jam #1
// The world's time zones run from 12 hours behind UTC to 14 ahead, so a date is "today" somewhere for about 50 hours
const BEHIND_HOURS = 12;
const AHEAD_HOURS = 14;
// A word opened just before midnight can still be finished after it - for up to this long after the date is over
// everywhere
const FINISH_GRACE_HOURS = 24;
const ADMIN_WRONG_TOP = 8; // the admin page shows this many of a word's most made wrong tries

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Days are dates as the player's page has them: '2026-10-28'
const dateAt = (ms) => new Date(ms).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

function isDate(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const ms = Date.parse(day);
  return Number.isFinite(ms) && dateAt(ms) === day;
}

// Whether it's `day` somewhere in the world right now, or was less than graceHours ago
function isToday(day, graceHours = 0) {
  if (!isDate(day) || day < FIRST_DAY) return false;
  const now = Date.now();
  return day >= dateAt(now - (BEHIND_HOURS + graceHours) * HOUR_MS) && day <= dateAt(now + AHEAD_HOURS * HOUR_MS);
}

const numberOf = (day) => daysBetween(FIRST_DAY, day) + 1;

const letterKey = (word) => [...word].sort().join('');

// The real words that can be made from all of a word's letters, the word itself first. Any of them gets it.
function answersOf(word) {
  const key = letterKey(word);
  const others = [];
  for (const words of Object.values(DICTIONARY)) {
    for (const w of words) {
      if (w.length === word.length && w !== word && letterKey(w) === key) others.push(w);
    }
  }
  return [word, ...others];
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

// Same as wordHash in solo.js and the pages (32-bit FNV-1a): the page gets these instead of the answers
function wordHash(word) {
  let hash = 0x811c9dc5;
  for (const letter of word.toLowerCase()) hash = Math.imul(hash ^ letter.charCodeAt(0), 0x01000193);
  return hash >>> 0;
}

// The letters mixed up so they don't already spell an answer, as in solo.js
function scramble(word, answers) {
  let letters;
  do {
    letters = shuffle([...word]).join('');
  } while (answers.includes(letters));
  return letters;
}

const isToken = (token) => typeof token === 'string' && token.length >= 16;

// A player's go at a word, as the page gets it: { guesses: their wrong tries, solved: null while they're on it, then
// whether they got it, answer: what they got it with, word: the word, once it's done, ms: how long it took, once it's
// done, elapsed: ms since they opened it }
const playFor = (play) => play && {
  guesses: play.guesses, solved: play.solved, answer: play.answer, word: play.word, ms: play.ms, elapsed: play.elapsed,
};

// A streak as of `day`: one that last went up before yesterday is over
function streakFor(streak, day) {
  if (!streak) return { current: 0, best: 0 };
  return { current: daysBetween(streak.lastDay, day) <= 1 ? streak.current : 0, best: streak.best };
}


// store: where the words and goes are kept (see data.js). playerIdFor: who a browser's token is, as in rooms.
function createDaily({ store, playerIdFor }) {
  // The days asked about lately, each as a promise of its words: { level -> { word, scramble, answers } }. A day's
  // words never change once they're picked.
  const puzzles = new Map();

  function puzzleFor(day) {
    if (!puzzles.has(day)) {
      const puzzle = pickWords(day);
      puzzles.set(day, puzzle);
      // Not kept if it failed, so the next ask tries again
      puzzle.catch(() => puzzles.delete(day));
      for (const old of puzzles.keys()) if (!isToday(old, FINISH_GRACE_HOURS)) puzzles.delete(old);
    }
    return puzzles.get(day);
  }

  // The day's words, picked by whoever asks for them first. Another instance may pick the same day at the same moment,
  // or the same word for another day - the words that went in first stand, and anything still missing is picked again.
  async function pickWords(day) {
    let words = await store.dailyWords(day);
    const missing = () => Object.keys(LEVELS).filter(level => !words.some(w => w.level === level));
    for (let attempt = 0; attempt < 3 && missing().length; attempt++) {
      const used = new Set(await store.dailyWordsNear(day, GAP_DAYS));
      const picks = missing().map((level) => {
        const fresh = DAILY_WORDS[LEVELS[level]].filter(w => !used.has(w));
        if (!fresh.length) throw new Error(`Every ${LEVELS[level]}-letter word in daily-words.js was used within the year`);
        const word = fresh[Math.floor(Math.random() * fresh.length)];
        return { level, word, scramble: scramble(word, answersOf(word)) };
      });
      words = await store.addDailyWords(day, picks, GAP_DAYS);
    }
    if (missing().length) throw new Error(`Couldn't pick the words for ${day}`);
    console.log(`Daily Jam #${numberOf(day)} (${day}): ${words.map(w => w.word).join(', ')}`);
    return Object.fromEntries(words.map(w => [w.level, { word: w.word, scramble: w.scramble, answers: answersOf(w.word) }]));
  }

  // How the day's players did on a word the player has finished:
  // { players: how many have finished it, got: how many got it on try 1, 2 and 3, missed: how many ran out of tries,
  //   median: the middle time of those who got it (ms, or null), better: the share of the others they did better than,
  //   as a whole percent (null if they missed it, or nobody else has finished), first: nobody else has finished it
  //   yet, streak: { current, best } }
  // Resolves to null if they haven't finished it, and rejects if it can't be had right now.
  async function resultFor(day, level, playerId) {
    const stats = await store.dailyStats(day, level, playerId, TRIES);
    if (stats.solved === null) return null;
    const others = stats.players - 1;
    return {
      players: stats.players,
      got: stats.got,
      missed: stats.missed,
      median: stats.median,
      better: others > 0 && stats.solved ? Math.floor((100 * stats.behind) / others) : null,
      first: others === 0,
      streak: streakFor(stats.streak, day),
    };
  }

  // resultFor, or null if it can't be had right now - the page asks again (stats)
  function resultOrNull(day, level, playerId) {
    return resultFor(day, level, playerId).catch((err) => {
      console.error("Reading Daily Jam's stats failed:", err.message);
      return null;
    });
  }

  // The day as the player has it: its number, and how they're doing on each word - the words themselves only come when
  // they open one.
  // Replies { status: 'ok', number, levels: [{ level, length, play }], streak: { current, best } } - play as playFor has
  // it, or null if they haven't opened it - or { status } 'bad', 'not-today' (the page's date isn't today anywhere -
  // its clock is off) or 'unavailable'.
  async function today({ day, token } = {}) {
    if (!isToken(token)) return { status: 'bad' };
    if (!isToday(day)) return { status: 'not-today' };
    let mine;
    try {
      mine = await store.dailyPlayer(day, playerIdFor(token));
    } catch (err) {
      console.error("Reading a player's Daily Jam failed:", err.message);
      return { status: 'unavailable' };
    }
    return {
      status: 'ok',
      number: numberOf(day),
      levels: Object.entries(LEVELS).map(([level, length]) => ({
        level, length, play: playFor(mine.plays.find(play => play.level === level)) || null,
      })),
      streak: streakFor(mine.streak, day),
    };
  }

  // Opens one of the day's words: its letters, and the player's clock starts - unless it's going already, when opening
  // it again (say after a reload) carries on where they were. paused: new games are paused from the admin page, so only
  // a word they'd opened already can be.
  // Replies { status: 'ok', scramble, hashes, play, result } - hashes: the word's and any other real word's with all its
  // letters, so the page's shuffle never spells one; play as playFor has it; result as resultFor, once it's done - or
  // { status } 'bad', 'not-today', 'paused' or 'unavailable'.
  async function open({ day, level, token } = {}, { paused = false } = {}) {
    if (!LEVELS[level] || !isToken(token)) return { status: 'bad' };
    // A word opened before midnight carries on after it, but a new one is today's
    if (!isToday(day, FINISH_GRACE_HOURS)) return { status: 'not-today' };
    const playerId = playerIdFor(token);
    let puzzle;
    let play;
    try {
      puzzle = await puzzleFor(day);
      play = await store.openDaily(day, level, playerId, !paused && isToday(day));
    } catch (err) {
      console.error('Opening a Daily Jam word failed:', err.message);
      return { status: 'unavailable' };
    }
    if (!play) return { status: paused ? 'paused' : 'not-today' };
    const { scramble, answers } = puzzle[level];
    return {
      status: 'ok',
      scramble,
      hashes: answers.map(wordHash),
      play: playFor(play),
      result: play.solved === null ? null : await resultOrNull(day, level, playerId),
    };
  }

  // Try number `n` (1 for the first) at a word the player has opened: `guess` is its letters in the order they put
  // them. It's got if it's the word or another real word with all its letters. Asking twice (the reply got lost) counts
  // it once, and a wrong one they've tried already doesn't count again.
  // Replies { status: 'ok', play, result } - as open has them - or { status } 'bad', 'not-today', 'gone' (they haven't
  // opened it) or 'unavailable'.
  async function guess({ day, level, token, try: n, guess } = {}) {
    if (!LEVELS[level] || !isToken(token) || !Number.isInteger(n) || n < 1 || n > TRIES || typeof guess !== 'string') {
      return { status: 'bad' };
    }
    if (!isToday(day, FINISH_GRACE_HOURS)) return { status: 'not-today' };
    const playerId = playerIdFor(token);
    const answer = guess.toLowerCase();
    let play;
    try {
      const { word, answers } = (await puzzleFor(day))[level];
      if (letterKey(answer) !== letterKey(word)) return { status: 'bad' };
      play = await store.guessDaily(day, level, playerId, n, answer, answers.includes(answer), TRIES);
    } catch (err) {
      console.error('A Daily Jam try failed:', err.message);
      return { status: 'unavailable' };
    }
    if (!play) return { status: 'gone' };
    if (play.solved === null) return { status: 'ok', play: playFor(play), result: null };
    // The try that finished it (not a later one, sent after it was over)
    if (n === play.guesses.length + (play.solved ? 1 : 0)) {
      console.log(`Daily Jam #${numberOf(day)} ${level}: ${play.solved ? `got in ${n}` : 'missed'}, ${Math.round(play.ms / 1000)}s`);
    }
    return { status: 'ok', play: playFor(play), result: await resultOrNull(day, level, playerId) };
  }

  // How the day's players did on a word the player has finished - it changes as more of them play.
  // Replies { status: 'ok', result } - as resultFor has it - or { status } 'bad', 'not-today', 'gone' (they haven't
  // finished it) or 'unavailable'.
  async function stats({ day, level, token } = {}) {
    if (!LEVELS[level] || !isToken(token)) return { status: 'bad' };
    if (!isToday(day, FINISH_GRACE_HOURS)) return { status: 'not-today' };
    let result;
    try {
      result = await resultFor(day, level, playerIdFor(token));
    } catch (err) {
      console.error("Reading Daily Jam's stats failed:", err.message);
      return { status: 'unavailable' };
    }
    return result ? { status: 'ok', result } : { status: 'gone' };
  }

  // For the admin page (see admin.js): a failed read as the status to reply with. 'missing' is Supabase saying it
  // doesn't have the functions these use - supabase/migrations/20261028200000_daily_jam_admin.sql isn't applied yet.
  function adminFailed(err) {
    console.error("Reading Daily Jam's numbers for the admin page failed:", err.message);
    return { status: err.status === 404 ? 'missing' : 'unavailable' };
  }

  // How a day went, for the admin page's Daily Jam tab.
  // Replies { status: 'ok', day, number, players, finished, allDone, allGot, levels } - as dailyAdminDay in data.js has
  // them, with each level's length too, and answers: the other real words with all its letters, which also get it.
  // levels is empty until someone opens the day (that's when its words are picked). Or { status } 'bad', 'unavailable'
  // or 'missing'.
  async function adminDay({ day } = {}) {
    if (!isDate(day) || day < FIRST_DAY) return { status: 'bad' };
    let report;
    try {
      report = await store.dailyAdminDay(day, TRIES, ADMIN_WRONG_TOP);
    } catch (err) {
      return adminFailed(err);
    }
    return {
      status: 'ok',
      day,
      number: numberOf(day),
      ...report,
      levels: report.levels.map(l => ({ ...l, length: l.word.length, answers: answersOf(l.word).slice(1) })),
    };
  }

  // The `count` days up to `to` (none before Daily Jam #1), newest first, for the admin page's Daily Jam tab.
  // Replies { status: 'ok', first: Daily Jam #1's day, days: [{ day, number, players, levels }], streaks } - as
  // dailyAdminDays in data.js has them, with a day nobody played as 0 players and no levels - or { status } 'bad',
  // 'unavailable' or 'missing'.
  async function adminDays({ to, count } = {}) {
    if (!isDate(to) || to < FIRST_DAY || !Number.isInteger(count) || count < 1) return { status: 'bad' };
    const days = [];
    for (let i = 0; i < count; i++) {
      const day = dateAt(Date.parse(to) - i * DAY_MS);
      if (day < FIRST_DAY) break;
      days.push(day);
    }
    let report;
    try {
      report = await store.dailyAdminDays(days[days.length - 1], to);
    } catch (err) {
      return adminFailed(err);
    }
    return {
      status: 'ok',
      first: FIRST_DAY,
      days: days.map(day => ({ day, number: numberOf(day), players: 0, levels: [], ...report.days.find(d => d.day === day) })),
      streaks: report.streaks,
    };
  }

  return { today, open, guess, stats, adminDay, adminDays };
}

module.exports = { createDaily, LEVELS, TRIES };
