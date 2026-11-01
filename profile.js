// Player stats: how a player has done in every mode, and the awards they've earned, for the account box on the home page
// (see shared/account.js). Only a signed-in player is shown theirs, but they're kept for everyone, under the same id as
// the rest of a player's things (see account.js) - so when a device signs in, what it had joins the account's, as its
// scores do (link_account in supabase/migrations, and linkAccount in data.js).
//
// Most of them are worked out from what the game keeps anyway, as they're asked for: the solo leaderboard, Daily Jam's
// goes and streaks. The rest are counted here as they happen - every solo run as it's scored (see recordSolo) and every
// round played in a room (see recordRound) - from when this went in, so a player's runs and rounds from before it
// aren't in them. Daily Jam's goes are kept 400 days, and as they go their numbers are folded into the player's stats,
// so lifetime numbers stay whole.
//
// The store hands back the raw numbers (see profile in data.js); what they add up to is worked out here (see statsFrom).

const { pointsOf, RUN_SECONDS } = require('./solo');
const { isDate, dateAt, streakFor, LEVELS } = require('./daily');

const RECENT_RUNS = 20;   // a player's newest solo runs kept, for their chart (link_account keeps as many when merging)
const RECENT_AVERAGE = 10; // and the newest of those their recent average is over
const STATS_FOR = 10 * 1000; // a player's stats, once read, are given again for this long (see reads)
const READS_MAX = 1000;      // and at most this many players' (each for a day) are held
const DAY_MS = 24 * 60 * 60 * 1000;

// Tokens are checked as in the other modules: anything long enough to hash counts
const isToken = (token) => typeof token === 'string' && token.length >= 16;

// Averages and rates show one decimal place
const oneDecimal = (n) => Math.round(n * 10) / 10;

// The awards, in the order the box shows them. value(stats) is how far along a player is - a count, or 1 or 0 for the
// yes-or-no ones - and they've got it at `need`.
const AWARDS = [
  { id: 'streak3', icon: '🔥', title: 'On a roll', detail: 'A 3-day Daily Jam streak', need: 3, value: s => s.daily.streak.best },
  { id: 'streak7', icon: '📅', title: 'Week streak', detail: 'A 7-day Daily Jam streak', need: 7, value: s => s.daily.streak.best },
  { id: 'streak30', icon: '🗓️', title: 'Month streak', detail: 'A 30-day Daily Jam streak', need: 30, value: s => s.daily.streak.best },
  { id: 'perfect', icon: '⭐', title: 'Perfect day', detail: 'All three Daily Jam words in one day', need: 1, value: s => s.daily.perfect },
  { id: 'sharp', icon: '🎯', title: 'Sharpshooter', detail: 'The hard Daily Jam word on the first try', need: 1, value: s => s.daily.hardFirstTry },
  { id: 'dailyTop', icon: '🥇', title: 'Daily champion', detail: "1st on a day's Daily Jam board", need: 1, value: s => (s.daily.bestFinish && s.daily.bestFinish.rank === 1 ? 1 : 0) },
  { id: 'runs10', icon: '⏱️', title: 'Warmed up', detail: '10 solo runs', need: 10, value: s => s.solo.runs },
  { id: 'runs100', icon: '💯', title: 'Century', detail: '100 solo runs', need: 100, value: s => s.solo.runs },
  { id: 'points50', icon: '🚀', title: 'Fifty', detail: '50 points in one solo run', need: 50, value: s => (s.solo.best ? s.solo.best.points : 0) },
  { id: 'quick100', icon: '⚡', title: 'Quick hands', detail: '100 solo words in under 3 seconds', need: 100, value: s => s.solo.quickWords },
  { id: 'long10', icon: '🔟', title: 'Ten letters', detail: 'A 10-letter word in solo', need: 10, value: s => (s.solo.longest ? s.solo.longest.length : 0) },
  { id: 'soloTop', icon: '🏆', title: 'Top of the board', detail: '1st on the solo leaderboard', need: 1, value: s => (s.solo.bestRank === 1 ? 1 : 0) },
  { id: 'win1', icon: '🎉', title: 'First win', detail: 'A round won in a room', need: 1, value: s => s.rooms.wins },
  { id: 'win10', icon: '👑', title: 'Ten wins', detail: '10 rounds won in rooms', need: 10, value: s => s.rooms.wins },
  { id: 'words1k', icon: '📚', title: 'Wordsmith', detail: '1,000 words unscrambled', need: 1000, value: s => s.words },
];

// The date the stats are as of: the player's own ('YYYY-MM-DD', as Daily Jam's page works it out), which is today
// somewhere in the world - within a day of the server's own UTC date. Any other (a page whose clock is off) is taken
// as the server's.
function dayFor(day) {
  const today = dateAt(Date.now());
  return isDate(day) && Math.abs(Date.parse(day) - Date.parse(today)) <= DAY_MS ? day : today;
}

// A player's stats as the page gets them, from the store's raw numbers (see profile in data.js), as of `day`:
// { since: when they were first seen or first played (ms) or null, words: words unscrambled in every mode,
//   solo: { best: { points, words } or null, rank (1 = top) or null, players, bestRank, runs, average, recentAverage,
//     wordsPerMinute, recent: [{ points, words, at }] (oldest first), longest, quick (the share of their words got in
//     under 3 seconds), quickWords },
//   daily: { streak: { current, best }, days, finished, got, tries, missed, perfect, hardFirstTry, today: { rank,
//     players }, bestFinish: { rank, day, players } or null, fastest: { easy, medium, hard }, calendar: [{ day, got,
//     finished }] },
//   rooms: { rounds, wins, podiums, best },
//   awards: [{ id, icon, title, detail, got, have, need }] }
// Averages and rates have one decimal place, and are null with nothing to work them out from.
function statsFrom(raw, day) {
  const { solo, rooms, daily } = raw;
  const { standing } = solo;
  const rank = standing.rank === null ? null : standing.rank + 1;
  const latest = solo.recent.slice(-RECENT_AVERAGE);
  const stats = {
    since: raw.since,
    words: solo.words + rooms.words + daily.got,
    solo: {
      best: rank === null ? null : { points: pointsOf(standing.best), words: standing.words },
      rank,
      players: standing.total,
      // The place they hold now may be higher than any they were seen at (someone above them was taken off the board)
      bestRank: rank !== null && (solo.bestRank === null || rank < solo.bestRank) ? rank : solo.bestRank,
      runs: solo.runs,
      average: solo.runs ? oneDecimal(solo.points / solo.runs) : null,
      recentAverage: latest.length ? oneDecimal(latest.reduce((sum, run) => sum + run.points, 0) / latest.length) : null,
      wordsPerMinute: solo.runs ? oneDecimal(solo.words / (solo.runs * RUN_SECONDS / 60)) : null,
      recent: solo.recent.map(({ points, words, at }) => ({ points, words, at })),
      longest: solo.longest || null,
      quick: solo.words ? solo.quick / solo.words : null,
      quickWords: solo.quick,
    },
    daily: {
      streak: streakFor(daily.streak, day),
      days: daily.days,
      finished: daily.finished,
      got: daily.got,
      tries: [...daily.tries],
      missed: daily.missed,
      perfect: daily.perfect,
      hardFirstTry: daily.hardFirstTry,
      today: { rank: daily.today.rank, players: daily.today.players },
      bestFinish: daily.bestFinish ? { rank: daily.bestFinish.rank, day: daily.bestFinish.day, players: daily.bestFinish.players } : null,
      fastest: Object.fromEntries(Object.keys(LEVELS).map(level => [level, daily.fastest[level] === undefined ? null : daily.fastest[level]])),
      calendar: daily.calendar.map(entry => ({ day: entry.day, got: entry.got, finished: entry.finished })),
    },
    rooms: { rounds: rooms.rounds, wins: rooms.wins, podiums: rooms.podiums, best: rooms.best },
  };
  stats.awards = AWARDS.map(({ id, icon, title, detail, need, value }) => {
    const have = value(stats);
    return { id, icon, title, detail, got: have >= need, have: Math.min(have, need), need };
  });
  return stats;
}


// store: where the stats are kept (see data.js). identify(token): who a browser's token is - the device, and the
// account it's signed in to, if any (see account.js). subjectFor(deviceId): the id a device's things are kept under -
// its account's if it's signed in, else its own - for rooms, which know their players by device.
function createProfile({ store, identify, subjectFor }) {

  // A player's stats as read lately: `${id} ${day}` -> { at: when the read began, raw: a promise of what the store
  // gave }, oldest first. Reading them ranks the player on every Daily Jam board they've played (see player_profile in
  // supabase/migrations), and the box asks each time it opens - so asks for the same player and day share one read,
  // going on or from the last STATS_FOR, unless they've finished a solo run or a round since (see forget). A read that
  // fails isn't kept, so the next ask tries again; and the oldest go once there are READS_MAX.
  const reads = new Map();

  function readStats(id, day) {
    const key = `${id} ${day}`;
    const now = Date.now();
    const held = reads.get(key);
    if (held && now - held.at < STATS_FOR) return held.raw;
    reads.delete(key);
    for (const [other, read] of reads) {
      if (now - read.at < STATS_FOR && reads.size < READS_MAX) break;
      reads.delete(other);
    }
    const entry = { at: now, raw: null };
    const drop = () => {
      if (reads.get(key) === entry) reads.delete(key);
    };
    // Through a promise even if the store throws outright
    entry.raw = Promise.resolve().then(() => store.profile(id, day)).then((raw) => {
      if (!raw) drop();
      return raw;
    }, (err) => {
      drop();
      throw err;
    });
    reads.set(key, entry);
    return entry.raw;
  }

  // A player's stats are read afresh at the next ask: they've just added to them
  function forget(id) {
    reads.forEach((entry, key) => {
      if (key.startsWith(`${id} `)) reads.delete(key);
    });
  }

  // The stats of the account the browser holding `token` is signed in to, as of `day`, their date (see dayFor). Only a
  // signed-in player is shown theirs, and the page only asks while signed in - so a device that isn't any more (it was
  // signed out in another tab, say, or its account deleted) is told so, rather than given its own empty stats for the
  // page to show under the account's name.
  // Replies { status: 'ok', stats } - as statsFrom has them - or { status } 'bad' or 'unavailable'.
  async function get({ token, day } = {}) {
    if (!isToken(token)) return { status: 'bad' };
    const identity = await identify(token);
    if (!identity.account) return { status: 'bad' };
    day = dayFor(day);
    let raw;
    try {
      raw = await readStats(identity.id, day);
    } catch (err) {
      console.error("Reading a player's stats failed:", err.message);
      return { status: 'unavailable' };
    }
    if (!raw) return { status: 'unavailable' };
    return { status: 'ok', stats: statsFrom(raw, day) };
  }

  // A solo run, as it's scored (from onFinish, see index.js): its points and words, how many of them were got in under
  // 3 seconds, its longest answer, and the place on the leaderboard it left the player in (null if they're not on it,
  // or it couldn't be had). Under whoever the score went to. Written without holding anything up, and a failure is
  // only logged. What's held of their stats is let go of as it's written - an ask meanwhile reads the store - and again
  // once it's in, as a read made meanwhile may not have it: the box has it at once.
  async function recordSolo(run, scored) {
    const board = run.result && run.result.board;
    const play = {
      points: scored.points,
      words: scored.solved.length,
      quick: scored.solved.filter(word => word.quick).length,
      // What they made of the letters - another real word with all of them is as long as the hidden one
      longest: scored.solved.reduce((longest, word) => (word.answer.length > longest.length ? word.answer : longest), ''),
      rank: board && board.rank ? board.rank : null,
    };
    forget(run.playerId);
    try {
      await store.recordSolo(run.playerId, play, RECENT_RUNS);
    } catch (err) {
      console.error("Recording a solo run's stats failed:", err.message);
    }
    forget(run.playerId);
  }

  // A round played in a room, as it's over (see changeRoom in index.js): results as buildResults has them, its players
  // in order of where they finished. Each player's device is looked up to who they are now - their account, if that
  // device is signed in - and two devices of one account in the same round count once, at the better place (with that
  // device's points and words). A failure is only logged. What's held of their stats is let go of as for a run.
  async function recordRound(results) {
    const players = [];
    try {
      const ids = await Promise.all(results.players.map(player => subjectFor(player.id)));
      results.players.forEach((player, i) => {
        if (players.some(p => p.id === ids[i])) return;
        players.push({ id: ids[i], points: player.points, words: player.solved, place: i + 1, left: !!player.left });
      });
      players.forEach(player => forget(player.id));
      await store.recordRound(players, results.players.length);
    } catch (err) {
      console.error("Recording a round's stats failed:", err.message);
    }
    players.forEach(player => forget(player.id));
  }

  return { get, recordSolo, recordRound };
}

module.exports = { createProfile };
