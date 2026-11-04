// Where solo mode, Daily Jam, accounts and the admin page keep their things. Rooms are kept apart from these, in Redis
// (see store.js).
//
// Solo mode (see solo.js) keeps each run while it's being played (its words, so the answers sent at the end can be
// checked), and the leaderboard - every player's best score, and how many words it got. A leaderboard score is a single
// number, higher is better (solo.js packs the points and the time into it).
//
// Daily Jam (see daily.js) keeps every day's words - the record that keeps a word from coming up again within a year -
// each player's go at them (their tries and time), and their streaks.
//
// Accounts (see account.js): who has signed in with Google or Apple, and which browsers are signed in to which account.
// Everything scored or remembered is kept under one text id - the hash of the browser's token, or the account's id
// once the browser is linked to one - so linking is where a browser's history moves under the account (see
// linkAccount). And who's on the site right now: the pages send a heartbeat with what the player is doing, for the
// admin page, and the name they go by, for the Daily Jam board.
//
// Reminders (see push.js): the devices that asked for them, where they can be reached and when they want reminding.
//
// Player stats (see profile.js), for the account box: most are worked out from the leaderboard and Daily Jam's goes as
// they're asked for (see profile), and the rest are counted as they happen - solo runs and rounds in rooms - along with
// the Daily Jam numbers of goes too old to keep (see retireDailyPlays), kept under the same id as the rest.
//
// The admin page (see admin.js) keeps counters that cap wrong passwords, two logs kept for 90 days (games, and sign-ins
// with what was done on the page), the site's settings (a banner, games paused), and stats - how many rooms, rounds and
// solo runs there were each hour, and who played.
//
// With a Supabase project (SUPABASE_URL and SUPABASE_SECRET_KEY; its tables and functions are in supabase/migrations,
// which Supabase's GitHub integration applies on a push to main) they're kept there, so every server instance sees the same ones. It's reached through its HTTP API, one request per
// call - nothing to connect or keep open, which suits Vercel's short-lived instances - and anything that has to happen
// in one step is a function in the database.
// Without one (local development), they stay in this process's memory - and the memory versions follow the database's
// functions rule for rule, so the game plays the same either way.
//
// If Supabase stops answering (see fallbackData), runs and the admin page's things are kept in memory until it does,
// and the leaderboard, Daily Jam, accounts and players' stats can't be reached.

// The stats are kept by UTC hour, so the admin page can add them up into days in its own time zone.
// hourStamp: '2026-10-27T13' for 1pm UTC, as statsFor and uniquePlayers take them.
const hourStamp = (at) => new Date(at).toISOString().slice(0, 13);

// A solo run is two minutes long - this leaves plenty of time to send it in after a dropped connection
const RUN_TTL = 15 * 60 * 1000;

// Give up on a call this quickly, so the game can fall back to memory while Supabase is unreachable or slow
const CALL_TIMEOUT = 3000;

// The admin page's list of who's on the site stops at this many (live_players in supabase/migrations says the same
// number), so a script making up tokens can't make it endless
const LIVE_MAX = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

// Days apart, for Daily Jam's days ('2026-10-28')
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

// A player who hasn't been seen in this long is forgotten by the players list, unless they're on the leaderboard or
// have an account (as touch_player in supabase/migrations does)
const PLAYER_TTL = 400 * DAY_MS;

// Daily Jam's goes are kept this many days (as open_daily in supabase/migrations keeps them)
const DAILY_KEEP_DAYS = 400;

// A device with reminders on that hasn't been seen in this long is cleared out (as save_push_device in
// supabase/migrations does)
const PUSH_DEVICE_TTL = 400 * DAY_MS;

// A player's newest solo runs that two players' stats keep between them when they're merged (see linkAccount) - as
// many as each keeps (RECENT_RUNS in profile.js), and as link_account in supabase/migrations keeps
const MERGED_RUNS = 20;

// Daily Jam's levels and tries a word, as daily.js has them (LEVELS and TRIES), for a player's numbers below
const DAILY_LEVELS = ['easy', 'medium', 'hard'];
const DAILY_TRIES = 3;

// A player's Daily Jam numbers, as add_daily_old in supabase/migrations has them: days they finished at least one word,
// words finished and got, how many they got on each try, missed, perfect days (every word got), hard words got on the
// first try, their fastest time to get each level's word (ms, null for none), and their best place on a day's board
// that's over (see profile) as { rank, day, players } (null for none). None yet:
const noDaily = () => ({
  days: 0, finished: 0, got: 0, tries: Array(DAILY_TRIES).fill(0), missed: 0, perfect: 0, hardFirstTry: 0,
  fastest: Object.fromEntries(DAILY_LEVELS.map(level => [level, null])), bestFinish: null,
});

// The lower and the higher of two numbers either of which can be null for none, as least() and greatest() take them
const lower = (a, b) => (a === null ? b : b === null ? a : Math.min(a, b));
const higher = (a, b) => (a === null ? b : b === null ? a : Math.max(a, b));

// The better of two best finishes: the higher place, then the later day - the first on a tie
const betterFinish = (a, b) => (!b ? a : !a ? b : b.rank < a.rank || (b.rank === a.rank && b.day > a.day) ? b : a);

// Two lots of Daily Jam numbers added together, as add_daily_old does: counts summed, the faster of each level's
// fastest, and the better best finish
function addDaily(a, b) {
  return {
    days: a.days + b.days,
    finished: a.finished + b.finished,
    got: a.got + b.got,
    tries: a.tries.map((n, i) => n + b.tries[i]),
    missed: a.missed + b.missed,
    perfect: a.perfect + b.perfect,
    hardFirstTry: a.hardFirstTry + b.hardFirstTry,
    fastest: Object.fromEntries(DAILY_LEVELS.map(level => [level, lower(a.fastest[level], b.fastest[level])])),
    bestFinish: betterFinish(a.bestFinish, b.bestFinish),
  };
}

// The admin page's logs are kept by age and read a day at a time, by functions that come with
// 20261031000100_admin_activity.sql. Until that migration has been run in Supabase, the server falls back on the ones
// from before (see the log functions in supabaseData): add_admin_log keeps a log's newest p_keep entries, so it's
// asked for OLD_LOG_KEEP - about 90 days of games at the rate they're played now (the 300 it kept were about three
// days') - and nothing is cut in the meantime; and a day's entries are looked for among the newest OLD_LOG_READ.
const OLD_LOG_KEEP = 10000;
const OLD_LOG_READ = 300;

// The most entries each of the memory store's logs keeps (it's used without Supabase, and while it isn't answering):
// every entry added copies and sorts its log, and every solo run is logged - a script playing them as fast as it can
// mustn't make that slower without end, or fill the memory
const MEMORY_LOG_MAX = 20000;

// A log's entries (newest first) from fromMs up to (not including) toMs, as admin_log_between in supabase/migrations
// returns them: { entries: the first `limit` of them, more: whether there were more }
function entriesBetween(entries, fromMs, toMs, limit) {
  const between = entries.filter(entry => entry.at >= fromMs && entry.at < toMs);
  return { entries: between.slice(0, Math.max(limit, 0)), more: between.length > Math.max(limit, 0) };
}

// How many of a log's entries from fromMs up to (not including) toMs there are on each day, days being dates in time
// zone tz (the admin's), as admin_log_days in supabase/migrations counts them: { '2026-10-25': 18, ... }, days with
// none left out
function entriesByDay(entries, fromMs, toMs, tz) {
  const format = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const days = {};
  for (const { at } of entries.filter(entry => entry.at >= fromMs && entry.at < toMs)) {
    const parts = Object.fromEntries(format.formatToParts(at).map(part => [part.type, part.value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    days[day] = (days[day] || 0) + 1;
  }
  return days;
}

// supabase: { url, key } for a Supabase project, or nothing
function createData(supabase) {
  return supabase ? fallbackData(supabaseData(supabase.url, supabase.key), memoryData()) : memoryData();
}

function memoryData() {
  const runs = new Map();  // solo run id -> { raw: JSON, expiresAt }
  const scores = new Map(); // player id -> { score, name, words }: the solo leaderboard
  const counters = new Map(); // name -> { count, resetAt }
  const logs = new Map();     // log name -> entries, newest first
  const stats = new Map();    // UTC day -> { 'metric:hour': count }
  const players = new Map();  // hourStamp -> Set of player ids
  const dailyWords = new Map();   // day -> { level -> { level, word, scramble } }
  const dailyPlays = new Map();   // 'day level playerId' -> { day, level, openedAt, guesses, solved, answer, ms }
  const dailyStreaks = new Map(); // player id -> { lastDay, current, best }
  const accounts = new Map(); // account id -> { provider, name, avatar, createdAt }: who has signed in
  const links = new Map();    // device id -> account id: which browsers are signed in to which account
  const people = new Map();   // id -> { name, mode, detail, since, seenAt, firstSeen }: everyone seen lately, and what
                              // they're doing (the players table in supabase/migrations)
  const playerStats = new Map(); // player id -> what their stats count (see newStats)
  const rankedDays = new Set();  // the days whose board is over and has been ranked (see rankFinalBoards)
  const pushDevices = new Map(); // device id -> { kind, address, keys, timeZone, hour, daily, solo, lastDay, lastSoloDay, seenAt }
  let settings = null;

  function liveRun(id) {
    const run = runs.get(id);
    if (run && run.expiresAt <= Date.now()) runs.delete(id);
    return runs.get(id);
  }

  // The provider a player signed in with, if their id is an account's - what the boards show a ✓ for
  const providerOf = (id) => (accounts.has(id) ? accounts.get(id).provider : null);

  // The account a browser is signed in to, as accountFor has it
  function accountOf(playerId) {
    const accountId = links.get(playerId);
    if (!accountId) return null;
    const account = accounts.get(accountId);
    return { id: accountId, provider: account.provider, name: account.name, avatar: account.avatar, devices: [...links.values()].filter(id => id === accountId).length };
  }

  // Notes the name a player goes by, for the boards and the players list, without touching what they're doing. A new
  // player's row starts out with no mode - their heartbeat fills that in (see touchPlayer).
  function noteName(id, name) {
    const person = people.get(id);
    if (!person) people.set(id, { name: name || '', mode: null, detail: {}, since: null, seenAt: Date.now(), firstSeen: Date.now() });
    else if (name) person.name = name;
  }

  // Where everyone stands, as Supabase's functions work it out. below: a score to count the players under. offset:
  // where top starts. Equal scores go by player id, last first, as the database orders them.
  function standings(playerId, top, below, offset = 0) {
    const board = [...scores].map(([id, entry]) => ({ id, ...entry, account: providerOf(id) }))
      .sort((a, b) => b.score - a.score || (b.id > a.id ? 1 : -1));
    const rank = board.findIndex(entry => entry.id === playerId);
    return {
      total: board.length,
      lower: board.filter(entry => entry.score < below).length,
      rank: rank === -1 ? null : rank,
      best: rank === -1 ? null : board[rank].score,
      words: rank === -1 ? null : board[rank].words,
      top: board.slice(Math.max(offset, 0), Math.max(offset, 0) + Math.max(top, 0)),
    };
  }

  // Daily Jam, as Supabase's functions work it out (see supabase/migrations)
  const wordsOn = (day) => Object.values(dailyWords.get(day) || {});
  const wordsNear = (day, gap) => [...dailyWords].filter(([other]) => Math.abs(daysBetween(other, day)) < gap)
    .flatMap(([other]) => wordsOn(other).map(w => w.word));
  const playKey = (day, level, playerId) => `${day} ${level} ${playerId}`;

  function playJson(play) {
    return {
      level: play.level,
      guesses: [...play.guesses],
      solved: play.solved,
      answer: play.answer,
      ms: play.ms,
      elapsed: Date.now() - play.openedAt,
      word: play.solved === null ? null : dailyWords.get(play.day)[play.level].word,
    };
  }

  function countStreak(playerId, day) {
    const streak = dailyStreaks.get(playerId);
    if (!streak) {
      dailyStreaks.set(playerId, { lastDay: day, current: 1, best: 1 });
      return;
    }
    const apart = daysBetween(streak.lastDay, day);
    if (apart <= 0) return;
    streak.current = apart === 1 ? streak.current + 1 : 1;
    streak.best = Math.max(streak.best, streak.current);
    streak.lastDay = day;
  }

  const streakOf = (playerId) => (dailyStreaks.has(playerId) ? { ...dailyStreaks.get(playerId) } : null);

  // The middle time, or the two middle ones' average (as percentile_cont(0.5)); null for none
  function median(times) {
    const sorted = [...times].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    if (!sorted.length) return null;
    return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  }

  // [[thing, how many times]], most first, then alphabetically
  const tally = (things) => [...things.reduce((counts, thing) => counts.set(thing, (counts.get(thing) || 0) + 1), new Map())]
    .sort(([a, n], [b, m]) => m - n || (a < b ? -1 : a > b ? 1 : 0));

  // Every go at the day's words, with who it was and how many tries it took
  const playsOn = (day) => [...dailyPlays].filter(([, play]) => play.day === day)
    .map(([key, play]) => ({ ...play, playerId: key.split(' ')[2], tries: play.guesses.length + 1 }));

  // Every go of one player's, as [key, play] (ids have no spaces in them, so the key's end is theirs alone)
  const playsOf = (playerId) => [...dailyPlays].filter(([key]) => key.endsWith(` ${playerId}`));

  const byLength = (a, b) => a.word.length - b.word.length;

  // Whether go a at a word is the better of two by the same person (from two browsers, see linkAccount), as
  // daily_play_beats in supabase/migrations has it: a finished one beats one still going, getting it beats missing it,
  // then fewer tries, then faster. Equal goes aren't.
  const playRank = (play) => [play.solved !== null, !!play.solved, -play.guesses.length, -(play.ms || 0)];
  function beats(a, b) {
    const [ra, rb] = [playRank(a), playRank(b)];
    const i = ra.findIndex((v, at) => v !== rb[at]);
    return i !== -1 && ra[i] > rb[i];
  }

  // A player's streak counted again from the days they've finished a word on (see linkAccount): the run of days in a
  // row ending at the latest of them is the current one, and the longest run is their best - unless oldBest, from a
  // streak row whose days are gone, was higher. Null if they've no finished word left.
  function recountStreak(playerId, oldBest) {
    const days = [...new Set(playsOf(playerId).filter(([, play]) => play.solved !== null).map(([, play]) => play.day))].sort();
    if (!days.length) return null;
    let run = 0;
    let longest = 0;
    days.forEach((day, i) => {
      run = i > 0 && daysBetween(days[i - 1], day) === 1 ? run + 1 : 1;
      longest = Math.max(longest, run);
    });
    return { lastDay: days[days.length - 1], current: run, best: Math.max(longest, oldBest) };
  }

  // Everyone who opened a word of the day, each with how they did over all of its words - got (how many they got),
  // tries and ms (over the words they got, null if none), finished (got or not) - and each level's go
  function dailyPeople(day) {
    const rows = new Map();
    for (const play of playsOn(day)) {
      const row = rows.get(play.playerId) || { id: play.playerId, got: 0, tries: null, ms: null, finished: 0, levels: {} };
      if (play.solved !== null) row.finished++;
      if (play.solved) {
        row.got++;
        row.tries = (row.tries || 0) + play.tries;
        row.ms = (row.ms || 0) + play.ms;
      }
      // tries here: the wrong ones and, if they got it, the one that did - so a missed word shows its 3 (play.tries, the
      // try they're on, is for the board's sums over the words they got)
      row.levels[play.level] = { solved: play.solved, tries: play.guesses.length + (play.solved ? 1 : 0), ms: play.ms };
      rows.set(play.playerId, row);
    }
    return [...rows.values()];
  }

  // Numbers before nulls, as the database's "asc nulls last"
  const nullsLast = (a, b) => (a === null) - (b === null) || a - b;

  // The day's board's order (see daily_standings in supabase/migrations): most got first, then fewest tries, then
  // fastest, then by id
  const byStanding = (a, b) => b.got - a.got || nullsLast(a.tries, b.tries) || nullsLast(a.ms, b.ms) || (a.id < b.id ? -1 : 1);

  // The day's board: everyone who finished a word that day, in its order
  const boardOn = (day) => dailyPeople(day).filter(row => row.finished > 0).sort(byStanding);

  const personName = (id) => (people.has(id) ? people.get(id).name : '');

  // A player's stats as the player_stats table in supabase/migrations keeps them, with nothing counted yet: firstAt and
  // updatedAt (ms); solo runs, points, words and quick words, their longest answer ('' for none), the highest place on
  // the leaderboard they've reached (1 = top, null for never) and their newest runs ([{ points, words, at }], oldest
  // first); rounds played in rooms, won and on the podium, the most points in one, and words got; and dailyOld, the
  // Daily Jam numbers of their goes that are gone (see retireDailyPlays)
  const newStats = (firstAt, updatedAt = firstAt) => ({
    firstAt, updatedAt,
    soloRuns: 0, soloPoints: 0, soloWords: 0, soloQuick: 0, soloLongest: '', soloBestRank: null, soloRecent: [],
    roomRounds: 0, roomWins: 0, roomPodiums: 0, roomBest: null, roomWords: 0,
    dailyOld: noDaily(),
  });

  function statsOf(playerId) {
    if (!playerStats.has(playerId)) playerStats.set(playerId, newStats(Date.now()));
    return playerStats.get(playerId);
  }

  // A row nobody has added to in PLAYER_TTL goes, as their players row does - unless it's an account's, they're on the
  // leaderboard, or they've been on the site since (as clear_old_player_stats in supabase/migrations does)
  function clearOldStats() {
    const since = Date.now() - PLAYER_TTL;
    playerStats.forEach((row, id) => {
      const seen = people.has(id) && people.get(id).seenAt >= since;
      if (row.updatedAt < since && !scores.has(id) && !accounts.has(id) && !seen) playerStats.delete(id);
    });
  }

  // A device's stats added into its account's as it signs in, as link_account in supabase/migrations does: counts
  // summed, the higher best place, the longer longest word (the account's on a tie), the higher best round, the earlier
  // first time, the newest MERGED_RUNS runs between them by when they were played (the account's first on a tie), and
  // their Daily Jam numbers folded at DAILY_KEEP_DAYS together (see addDaily). Those are totals, so a day both of them
  // played that was folded before they were merged counts once for each - the goes still kept are merged a word at a
  // time instead, keeping the better go (see linkAccount).
  function addStats(mine, device) {
    return {
      firstAt: Math.min(mine.firstAt, device.firstAt),
      updatedAt: Math.max(mine.updatedAt, device.updatedAt),
      soloRuns: mine.soloRuns + device.soloRuns,
      soloPoints: mine.soloPoints + device.soloPoints,
      soloWords: mine.soloWords + device.soloWords,
      soloQuick: mine.soloQuick + device.soloQuick,
      soloLongest: device.soloLongest.length > mine.soloLongest.length ? device.soloLongest : mine.soloLongest,
      soloBestRank: lower(mine.soloBestRank, device.soloBestRank),
      // sort keeps the order of equal times, so the account's come first
      soloRecent: [...mine.soloRecent, ...device.soloRecent].sort((a, b) => a.at - b.at).slice(-MERGED_RUNS),
      roomRounds: mine.roomRounds + device.roomRounds,
      roomWins: mine.roomWins + device.roomWins,
      roomPodiums: mine.roomPodiums + device.roomPodiums,
      roomBest: higher(mine.roomBest, device.roomBest),
      roomWords: mine.roomWords + device.roomWords,
      dailyOld: addDaily(mine.dailyOld, device.dailyOld),
    };
  }

  // A player's Daily Jam numbers (see noDaily) over their finished goes from before day `before` - all of them if it's
  // null - as daily_numbers in supabase/migrations has them: all but bestFinish, which takes everyone's goes (see
  // bestFinishOn)
  function dailyNumbers(playerId, before) {
    const plays = playsOf(playerId).map(([, play]) => play).filter(play => play.solved !== null && (!before || play.day < before));
    const got = plays.filter(play => play.solved);
    const days = [...new Set(plays.map(play => play.day))];
    const fastest = (level) => {
      const times = got.filter(play => play.level === level).map(play => play.ms);
      return times.length ? Math.min(...times) : null;
    };
    return {
      ...noDaily(),
      days: days.length,
      finished: plays.length,
      got: got.length,
      tries: Array.from({ length: DAILY_TRIES }, (_, i) => got.filter(play => play.guesses.length === i).length),
      missed: plays.length - got.length,
      perfect: days.filter((day) => {
        const n = got.filter(play => play.day === day).length;
        return n > 0 && n === wordsOn(day).length;
      }).length,
      hardFirstTry: got.filter(play => play.level === 'hard' && !play.guesses.length).length,
      fastest: Object.fromEntries(DAILY_LEVELS.map(level => [level, fastest(level)])),
    };
  }

  // playerId's best finish on the days given, as { rank, day, players } (see betterFinish), or null if they're on
  // none of their boards. boards: [[day, its board as boardOn has it]].
  function bestFinishOn(playerId, boards) {
    return boards.reduce((best, [day, board]) => {
      const at = board.findIndex(row => row.id === playerId);
      return at === -1 ? best : betterFinish(best, { rank: at + 1, day, players: board.length });
    }, null);
  }

  // Daily Jam's goes from more than DAILY_KEEP_DAYS before `day` go, as retire_daily_plays in supabase/migrations has
  // them go: each player's numbers from them, and their best place on those days' boards, are folded into their stats'
  // dailyOld first, and the earliest go into their firstAt. A player with no stats gets them, dated by those goes, so
  // they're cleared out with the rest if the player's long gone (see clearOldStats).
  function retireDailyPlays(day) {
    const old = [...dailyPlays].filter(([, play]) => daysBetween(play.day, day) > DAILY_KEEP_DAYS);
    if (!old.length) return;
    const before = new Date(Date.parse(day) - DAILY_KEEP_DAYS * DAY_MS).toISOString().slice(0, 10);
    const boards = [...new Set(old.filter(([, play]) => play.solved !== null).map(([, play]) => play.day))].map(d => [d, boardOn(d)]);
    for (const playerId of new Set(old.map(([key]) => key.split(' ')[2]))) {
      const opened = old.filter(([key]) => key.endsWith(` ${playerId}`)).map(([, play]) => play.openedAt);
      const numbers = { ...dailyNumbers(playerId, before), bestFinish: bestFinishOn(playerId, boards) };
      if (!playerStats.has(playerId)) playerStats.set(playerId, newStats(Math.min(...opened), Math.max(...opened)));
      const row = playerStats.get(playerId);
      row.firstAt = Math.min(row.firstAt, ...opened);
      row.dailyOld = addDaily(row.dailyOld, numbers);
    }
    old.forEach(([key]) => dailyPlays.delete(key));
  }

  // Each day's board that's over is ranked once, and everyone on it has their place folded into their dailyOld's best
  // finish, as rank_final_boards in supabase/migrations does - so profile reads it rather than ranking every board again.
  // A board is over from 3 days before today's UTC date; days back to 400 before that are looked at. A player with no
  // stats gets them, dated by those days' goes.
  function rankFinalBoards() {
    const through = new Date(Date.now() - 3 * DAY_MS).toISOString().slice(0, 10);
    const days = [...dailyWords.keys()].filter(d => d <= through && daysBetween(d, through) < DAILY_KEEP_DAYS && !rankedDays.has(d));
    if (!days.length) return;
    const boards = days.map(d => [d, boardOn(d)]);
    for (const playerId of new Set(boards.flatMap(([, board]) => board.map(row => row.id)))) {
      const opened = playsOf(playerId).filter(([, play]) => days.includes(play.day)).map(([, play]) => play.openedAt);
      if (!playerStats.has(playerId)) playerStats.set(playerId, newStats(Math.min(...opened), Math.max(...opened)));
      const row = playerStats.get(playerId);
      row.firstAt = Math.min(row.firstAt, ...opened);
      row.dailyOld = addDaily(row.dailyOld, { ...noDaily(), bestFinish: bestFinishOn(playerId, boards) });
    }
    days.forEach(d => rankedDays.add(d));
  }

  return {
    status: () => ({ store: 'memory', reason: null }),

    hasRun: (id) => !!liveRun(id),

    // false if there's already a run with this id
    async createRun(run) {
      runs.forEach((_, id) => liveRun(id)); // clears out the expired ones
      if (runs.has(run.id)) return false;
      runs.set(run.id, { raw: JSON.stringify(run), expiresAt: Date.now() + RUN_TTL });
      return true;
    },

    async getRun(id) {
      const run = liveRun(id);
      return run ? JSON.parse(run.raw) : null;
    },

    async saveRun(run) {
      runs.set(run.id, { raw: JSON.stringify(run), expiresAt: Date.now() + RUN_TTL });
    },

    // Puts score (a run that got `words` words) on the leaderboard if it's the player's best, under the name given
    // (their latest, noted for the players list too), and says where everyone stands: { before (their best until now,
    // or null), total, lower (players with a score under `below`), rank (0 = top), best, words (their best's), top:
    // the first `top` entries, as { id, score, name, words, account (the provider they signed in with, or null) } }
    async addScore(playerId, score, name, words, below, top) {
      const old = scores.get(playerId);
      const best = old && old.score >= score ? old : { score, words };
      scores.set(playerId, { score: best.score, name, words: best.words });
      noteName(playerId, name);
      return { before: old ? old.score : null, ...standings(playerId, top, below) };
    },

    // Entries `offset` to `offset + top` and where playerId stands: { total, rank, best, words, top } as for addScore
    async leaderboard(top, playerId, offset = 0) {
      const { total, rank, best, words, top: entries } = standings(playerId, top, -Infinity, offset);
      return { total, rank, best, words, top: entries };
    },

    // false if they weren't on it
    async removeScore(playerId) {
      return scores.delete(playerId);
    },

    // Counts one more against `name`, starting a window of windowMs if there isn't one. Resolves to { count, resetsIn }:
    // the count so far this window, and the ms until it starts again from nothing.
    async bump(name, windowMs) {
      const now = Date.now();
      let counter = counters.get(name);
      if (!counter || counter.resetAt <= now) counters.set(name, counter = { count: 0, resetAt: now + windowMs });
      counter.count++;
      return { count: counter.count, resetsIn: counter.resetAt - now };
    },

    // Where each of `names` stands, as bump has it ({ count: 0, resetsIn: 0 } for one with no window going)
    async peek(names) {
      const now = Date.now();
      return names.map((name) => {
        const counter = counters.get(name);
        return counter && counter.resetAt > now ? { count: counter.count, resetsIn: counter.resetAt - now } : { count: 0, resetsIn: 0 };
      });
    },

    // Adds an entry to log `name` and lets go of the entries from more than keepDays ago - every log's, not just this
    // one's - as add_admin_log_for in supabase/migrations does. And of all but the log's newest MEMORY_LOG_MAX: fewer
    // than the database keeps (its newest 90,000, cut now and then), as every entry added here copies the log. A log is
    // kept newest first, as the database reads them: by when they happened, and the later added first of two at the
    // same time.
    async log(name, entry, keepDays) {
      const since = Date.now() - Math.max(keepDays, 1) * DAY_MS;
      // sort keeps the order of equal times, so the new entry stays ahead of one from the same ms
      logs.set(name, [entry, ...(logs.get(name) || [])].filter(e => e.at >= since).sort((a, b) => b.at - a.at).slice(0, MEMORY_LOG_MAX));
      // The others' oldest entries are at their ends
      logs.forEach((entries) => {
        while (entries.length && entries[entries.length - 1].at < since) entries.pop();
      });
    },

    // The newest `count` entries of log `name`
    async logs(name, count) {
      return (logs.get(name) || []).slice(0, count);
    },

    // For the Activity tab: a day's entries, and how many each day has (see entriesBetween and entriesByDay)
    async logsBetween(name, fromMs, toMs, limit) {
      return entriesBetween(logs.get(name) || [], fromMs, toMs, limit);
    },

    async logDays(name, fromMs, toMs, tz) {
      return entriesByDay(logs.get(name) || [], fromMs, toMs, tz);
    },

    // One more of `metric` this hour, and the players (ids) who were in it
    async track(metric, playerIds, at) {
      const day = hourStamp(at).slice(0, 10);
      const field = `${metric}:${hourStamp(at).slice(11)}`;
      const counts = stats.get(day) || {};
      counts[field] = (counts[field] || 0) + 1;
      stats.set(day, counts);
      if (playerIds.length) {
        const hour = players.get(hourStamp(at)) || new Set();
        playerIds.forEach(id => hour.add(id));
        players.set(hourStamp(at), hour);
      }
    },

    // The counts for each UTC day ('2026-10-27'), as { 'metric:hour': count }
    async statsFor(days) {
      return days.map(day => ({ ...(stats.get(day) || {}) }));
    },

    // How many different players there were in each group of hours (hourStamps)
    async uniquePlayers(groups) {
      return groups.map(hours => new Set(hours.flatMap(hour => [...(players.get(hour) || [])])).size);
    },

    async getSettings() {
      return settings && JSON.parse(settings);
    },

    async saveSettings(value) {
      settings = JSON.stringify(value);
    },

    // Daily Jam. Days are dates as players have them ('2026-10-28').

    // A day's words, as [{ level, word, scramble }] (none until they're picked)
    async dailyWords(day) {
      return wordsOn(day).map(w => ({ ...w }));
    },

    // The words used fewer than `gap` days before or after `day`
    async dailyWordsNear(day, gap) {
      return wordsNear(day, gap);
    },

    // Puts in the words picked for a day ([{ level, word, scramble }]): each only if that level of the day has none yet,
    // and if the word hasn't been used fewer than `gap` days from it. Resolves to the day's words, as dailyWords.
    async addDailyWords(day, words, gap) {
      const levels = dailyWords.get(day) || {};
      for (const w of words) {
        if (!levels[w.level] && !wordsNear(day, gap).includes(w.word)) levels[w.level] = { level: w.level, word: w.word, scramble: w.scramble };
      }
      dailyWords.set(day, levels);
      return wordsOn(day).map(w => ({ ...w }));
    },

    // Opens a level of the day for a player, starting their clock unless it's going already (start false only looks),
    // and notes the name they go by (for the day's board). Resolves to their go: { level, guesses (the wrong ones),
    // solved (null while playing), answer, ms, elapsed (ms since they opened it), word (once they've finished) } - or
    // null if they haven't opened it.
    async openDaily(day, level, playerId, start, name) {
      const key = playKey(day, level, playerId);
      if (start && !dailyPlays.has(key)) {
        dailyPlays.set(key, { day, level, openedAt: Date.now(), guesses: [], solved: null, answer: null, ms: null });
        retireDailyPlays(day);
        rankFinalBoards();
      }
      if (start) noteName(playerId, name);
      return dailyPlays.has(key) ? playJson(dailyPlays.get(key)) : null;
    },

    // Try number `n` (1 for the first) at a level they've opened. right: it's the word or another real word with all its
    // letters. A try sent twice, one out of order, or a wrong one tried already counts for nothing, and the `tries`-th
    // wrong one ends it. Resolves to their go, as openDaily, or null if they haven't opened it.
    async guessDaily(day, level, playerId, n, guess, right, tries) {
      const play = dailyPlays.get(playKey(day, level, playerId));
      if (!play) return null;
      if (play.solved === null && n === play.guesses.length + 1 && !play.guesses.includes(guess)) {
        if (right) {
          play.solved = true;
          play.answer = guess;
        } else {
          play.guesses.push(guess);
          if (n >= tries) play.solved = false;
        }
        if (play.solved !== null) {
          play.ms = Date.now() - play.openedAt;
          countStreak(playerId, day);
        }
      }
      return playJson(play);
    },

    // A player's day: { plays: their go at each level they've opened, as openDaily; streak: { lastDay, current, best },
    // or null if they've never finished one }
    async dailyPlayer(day, playerId) {
      const plays = [...dailyPlays].filter(([key]) => key.startsWith(`${day} `) && key.endsWith(` ${playerId}`));
      return { plays: plays.map(([, play]) => playJson(play)), streak: streakOf(playerId) };
    },

    // How everyone who's finished a level of the day did: { players, got: how many got it on try 1, 2, ... `tries`,
    // missed, median: the middle time of those who got it, solved: whether playerId got it (null if they haven't
    // finished), behind: how many others did worse than them (fewer tries, then faster, is better), streak: playerId's,
    // as dailyPlayer }
    async dailyStats(day, level, playerId, tries) {
      const done = [...dailyPlays]
        .filter(([key, play]) => key.startsWith(`${day} ${level} `) && play.solved !== null)
        .map(([key, play]) => ({ id: key.split(' ')[2], solved: play.solved, ms: play.ms, tries: play.guesses.length + 1 }));
      const me = done.find(d => d.id === playerId && d.solved);
      return {
        players: done.length,
        got: Array.from({ length: tries }, (_, i) => done.filter(d => d.solved && d.tries === i + 1).length),
        missed: done.filter(d => !d.solved).length,
        median: median(done.filter(d => d.solved).map(d => d.ms)),
        solved: (done.find(d => d.id === playerId) || { solved: null }).solved,
        behind: me ? done.filter(d => d.id !== playerId && (!d.solved || d.tries > me.tries || (d.tries === me.tries && d.ms > me.ms))).length : 0,
        streak: streakOf(playerId),
      };
    },

    // For the admin page. How a day went: { players (who opened a word), finished (who finished one), allDone (who
    // finished every one), allGot (who got every one), levels: [{ level, word, scramble, opened, playing (opened, not
    // finished), got: how many got it on try 1, 2, ... `tries`, missed, median and fastest (ms, of those who got it),
    // wrong: the `top` wrong tries made most, as [{ guess, count }], others: the other real words it was got with, as
    // [{ answer, count }] }] } - levels is empty until the day's words are picked
    async dailyAdminDay(day, tries, top) {
      const words = wordsOn(day).sort(byLength);
      const plays = playsOn(day);
      const people = [...new Set(plays.map(p => p.playerId))].map((playerId) => {
        const theirs = plays.filter(p => p.playerId === playerId);
        return { done: theirs.filter(p => p.solved !== null).length, got: theirs.filter(p => p.solved).length };
      });
      return {
        players: people.length,
        finished: people.filter(p => p.done > 0).length,
        allDone: people.filter(p => p.done === words.length).length,
        allGot: people.filter(p => p.got === words.length).length,
        levels: words.map((w) => {
          const goes = plays.filter(p => p.level === w.level);
          const got = goes.filter(p => p.solved);
          return {
            level: w.level,
            word: w.word,
            scramble: w.scramble,
            opened: goes.length,
            playing: goes.filter(p => p.solved === null).length,
            got: Array.from({ length: tries }, (_, i) => got.filter(p => p.tries === i + 1).length),
            missed: goes.filter(p => p.solved === false).length,
            median: median(got.map(p => p.ms)),
            fastest: got.length ? Math.min(...got.map(p => p.ms)) : null,
            wrong: tally(goes.flatMap(p => p.guesses)).slice(0, Math.max(top, 0)).map(([guess, count]) => ({ guess, count })),
            others: tally(got.filter(p => p.answer !== w.word).map(p => p.answer)).map(([answer, count]) => ({ answer, count })),
          };
        }),
      };
    },

    // For the admin page. Each day from `from` to `to` that has words, newest first: { day, players, levels:
    // [{ level, word, opened, finished, got }] }. And streaks as of `to`: { going (still on: they finished a word on
    // `to` or the day before), longest (of those), best (anyone's, ever), ever (players who've finished a word) }.
    async dailyAdminDays(from, to) {
      const days = [...dailyWords.keys()].filter(day => day >= from && day <= to).sort().reverse();
      const streaks = [...dailyStreaks.values()];
      const going = streaks.filter(streak => daysBetween(streak.lastDay, to) <= 1);
      return {
        days: days.map((day) => {
          const plays = playsOn(day);
          return {
            day,
            players: new Set(plays.map(p => p.playerId)).size,
            levels: wordsOn(day).sort(byLength).map((w) => {
              const goes = plays.filter(p => p.level === w.level);
              return {
                level: w.level,
                word: w.word,
                opened: goes.length,
                finished: goes.filter(p => p.solved !== null).length,
                got: goes.filter(p => p.solved).length,
              };
            }),
          };
        }),
        streaks: {
          going: going.length,
          longest: Math.max(0, ...going.map(streak => streak.current)),
          best: Math.max(0, ...streaks.map(streak => streak.best)),
          ever: streaks.length,
        },
      };
    },

    // The day's board, as daily_board in supabase/migrations has it: everyone who finished a word that day, most words
    // got first, then fewest tries and fastest over the words they got (then by id). { total, rank (1 = top, null if
    // playerId hasn't finished a word), you: their row or null, top: rows `offset` to `offset + top`, each { rank, id,
    // name (as noted, '' if never), got, tries, ms, finished, account } }
    async dailyBoard(day, playerId, top, offset) {
      const standings = boardOn(day).map((row, i) => ({
        rank: i + 1, id: row.id, name: personName(row.id), got: row.got, tries: row.tries, ms: row.ms, finished: row.finished, account: providerOf(row.id),
      }));
      const you = standings.find(row => row.id === playerId) || null;
      return {
        total: standings.length,
        rank: you ? you.rank : null,
        you,
        top: standings.slice(Math.max(offset, 0), Math.max(offset, 0) + Math.max(top, 0)),
      };
    },

    // For the admin page: everyone who opened a word of the day, as [{ id, name, account, streak: { current, best,
    // lastDay } or null if they've never finished one, levels: { easy: { solved (null while playing), tries, ms },
    // medium, hard } (a level missing wasn't opened) }], in the board's order with those who've finished nothing last
    async dailyAdminPlayers(day) {
      return dailyPeople(day).sort((a, b) => (b.finished > 0) - (a.finished > 0) || byStanding(a, b)).map((row) => {
        const streak = dailyStreaks.get(row.id);
        return {
          id: row.id,
          name: personName(row.id),
          account: providerOf(row.id),
          streak: streak ? { current: streak.current, best: streak.best, lastDay: streak.lastDay } : null,
          levels: row.levels,
        };
      });
    },

    // Accounts. An account is a Supabase Auth user, { id (a uuid), provider ('google' or 'apple'), name, avatar (its
    // profile photo's address, '' for none) }; its things are kept under its id as a player id.

    // The account the browser with device id playerId is signed in to, as { id, provider, name, avatar, devices: how
    // many browsers are signed in to it }, or null
    async accountFor(playerId) {
      return accountOf(playerId);
    },

    // Signs the browser in to the account (which is made if it's new, keeping its name once it has one, and taking the
    // photo given unless that's '') and moves the browser's history under it, as link_account in supabase/migrations
    // does: the solo leaderboard keeps the higher best (with its words) under the account's name, each Daily Jam word
    // keeps the better go (see beats), the streak is counted again (see recountStreak), the players list keeps the
    // earlier first visit, and the browser's stats are added into the account's (see addStats). A browser signed in to
    // another account moves over; its history stays with the old one. Resolves to the account, as accountFor.
    async linkAccount(playerId, { id, provider, name, avatar }) {
      // The table takes no account without an id or a provider (neither may be null in supabase/migrations), so
      // neither does this - the same call fails the same way in either store, before anything is changed
      if (id === null || id === undefined || provider === null || provider === undefined) {
        throw new Error('linkAccount: an account needs an id and a provider');
      }
      const account = accounts.get(id) || { provider, name: '', avatar: '', createdAt: Date.now() };
      account.provider = provider;
      if (!account.name) account.name = name || '';
      // Google's photo addresses change, so a new one replaces the old
      if (avatar) account.avatar = avatar;
      accounts.set(id, account);
      links.set(playerId, id);
      // Nothing to move if the browser's id is the account's own (it can't be, but a merge of a row with itself would
      // lose it)
      if (playerId === id) return accountOf(playerId);

      const device = scores.get(playerId);
      if (device) {
        const mine = scores.get(id);
        if (!mine) scores.set(id, device);
        else if (device.score > mine.score) Object.assign(mine, { score: device.score, words: device.words });
        scores.delete(playerId);
      }
      if (account.name && scores.has(id)) scores.get(id).name = account.name;

      for (const [key, play] of playsOf(playerId)) {
        const theirs = playKey(play.day, play.level, id);
        if (!dailyPlays.has(theirs) || beats(play, dailyPlays.get(theirs))) dailyPlays.set(theirs, play);
        dailyPlays.delete(key);
      }

      const deviceStreak = dailyStreaks.get(playerId) || null;
      dailyStreaks.delete(playerId);
      const myStreak = dailyStreaks.get(id) || null;
      const deviceBest = deviceStreak ? deviceStreak.best : 0;
      const recounted = recountStreak(id, Math.max(myStreak ? myStreak.best : 0, deviceBest));
      if (recounted) dailyStreaks.set(id, recounted);
      // No finished plays left, only the rows: the account's stands, with the best of both
      else if (myStreak) myStreak.best = Math.max(myStreak.best, deviceBest);
      else if (deviceStreak) dailyStreaks.set(id, deviceStreak);

      const devicePerson = people.get(playerId);
      const person = people.get(id);
      const shown = account.name || (devicePerson ? devicePerson.name : '');
      if (!person) {
        people.set(id, { ...(devicePerson || { mode: null, detail: {}, since: null, seenAt: Date.now(), firstSeen: Date.now() }), name: shown });
      } else {
        if (shown) person.name = shown;
        if (devicePerson) person.firstSeen = Math.min(person.firstSeen, devicePerson.firstSeen);
      }
      people.delete(playerId);

      const deviceStats = playerStats.get(playerId);
      if (deviceStats) {
        // Into an empty row of the account's own if it has none yet, which comes out the same as the browser's
        const mine = playerStats.get(id) || newStats(deviceStats.firstAt, deviceStats.updatedAt);
        playerStats.set(id, addStats(mine, deviceStats));
        playerStats.delete(playerId);
      }
      return accountOf(playerId);
    },

    // Signs the browser out: it starts fresh, and the account keeps everything. Resolves to whether it was signed in.
    async unlinkAccount(playerId) {
      return links.delete(playerId);
    },

    // The account's new name, everywhere it shows
    async renameAccount(accountId, name) {
      if (accounts.has(accountId)) accounts.get(accountId).name = name;
      if (scores.has(accountId)) scores.get(accountId).name = name;
      if (people.has(accountId)) people.get(accountId).name = name;
    },

    // Deletes the account and everything kept under it, signing its browsers out
    async deleteAccount(accountId) {
      scores.delete(accountId);
      for (const [key] of playsOf(accountId)) dailyPlays.delete(key);
      dailyStreaks.delete(accountId);
      playerStats.delete(accountId);
      people.delete(accountId);
      for (const [playerId, id] of links) if (id === accountId) links.delete(playerId);
      accounts.delete(accountId);
    },

    // Reminders (see push.js), as push_devices and its functions in supabase/migrations have them.

    // A device turning reminders on, changing them, or saying it's still around. An address is only one device's.
    async savePushDevice(deviceId, device) {
      const now = Date.now();
      pushDevices.forEach((other, id) => {
        if (now - other.seenAt >= PUSH_DEVICE_TTL || (other.address === device.address && id !== deviceId)) pushDevices.delete(id);
      });
      const old = pushDevices.get(deviceId);
      pushDevices.set(deviceId, { ...device, lastDay: old ? old.lastDay : null, lastSoloDay: old ? old.lastSoloDay : null, seenAt: now });
    },

    async removePushDevice(deviceId) {
      pushDevices.delete(deviceId);
    },

    // An address the push service says is gone
    async removePushAddress(address) {
      pushDevices.forEach((device, id) => {
        if (device.address === address) pushDevices.delete(id);
      });
    },

    // The devices seen since `since` (ms) that want any reminder, as [{ deviceId, playerId: who their plays are under -
    // their account, or the device itself - kind, address, keys, timeZone, hour, daily, solo, lastDay, lastSoloDay }]
    async pushDevicesSince(since) {
      return [...pushDevices]
        .filter(([, device]) => device.seenAt >= since && (device.daily || device.solo))
        .map(([deviceId, { seenAt, ...device }]) => ({ ...device, deviceId, playerId: links.get(deviceId) || deviceId }));
    },

    // What a reminder goes by, for each of players: [{ id, day }], as [{ id, day, played: they've opened a word of that
    // day's Daily Jam, streak: as dailyPlayer's, soloBest: their leaderboard score or null, soloAt: their last solo run
    // (ms) or null }]
    async pushPlayers(players) {
      return players.map(({ id, day }) => {
        const recent = playerStats.has(id) ? playerStats.get(id).soloRecent : [];
        return {
          id,
          day,
          played: playsOf(id).some(([, play]) => play.day === day),
          streak: streakOf(id),
          soloBest: scores.has(id) ? scores.get(id).score : null,
          soloAt: recent.length ? recent[recent.length - 1].at : null,
        };
      });
    },

    // Marks each of claims: [{ deviceId, day, solo }] as reminded on its day, unless it has been already, and resolves to
    // the ids of those it did
    async claimPush(claims) {
      const claimed = [];
      for (const { deviceId, day, solo } of claims) {
        const device = pushDevices.get(deviceId);
        if (!device || (device.lastDay && device.lastDay >= day)) continue;
        device.lastDay = day;
        if (solo) device.lastSoloDay = day;
        claimed.push(deviceId);
      }
      return claimed;
    },

    // Player stats (see profile.js), counted as they happen.

    // A solo run, as it's scored, as record_solo_play in supabase/migrations has it: its points, words (how many it
    // got), quick (how many in under 3 seconds), longest (its longest answer, '' for none) and rank (the player's place
    // on the leaderboard after it, 1 = top, or null). The newest `keep` runs are kept.
    async recordSolo(playerId, { points, words, quick, longest, rank }, keep) {
      const row = statsOf(playerId);
      row.soloRuns++;
      row.soloPoints += points;
      row.soloWords += words;
      row.soloQuick += quick;
      if ((longest || '').length > row.soloLongest.length) row.soloLongest = longest;
      row.soloBestRank = lower(row.soloBestRank, rank === undefined ? null : rank);
      row.soloRecent = keep > 0 ? [...row.soloRecent, { points, words, at: Date.now() }].slice(-keep) : [];
      row.updatedAt = Date.now();
      clearOldStats();
    },

    // A round played in a room, as it's over, as record_round has it. players: [{ id, points, words, place, left }], one
    // per player id, place being where they finished (1 = won) and left whether they'd left the room. count: how many
    // played it. A win is a first place, and a podium a place from 1 to 3 that isn't last - neither for anyone who left.
    async recordRound(players, count) {
      for (const { id, points, words, place, left } of players) {
        const row = statsOf(id);
        row.roomRounds++;
        if (place === 1 && !left) row.roomWins++;
        if (place <= 3 && place < count && !left) row.roomPodiums++;
        row.roomBest = higher(row.roomBest, points);
        row.roomWords += words;
        row.updatedAt = Date.now();
      }
      clearOldStats();
    },

    // Everything profile.js works a player's stats out from, as of `day` (their date), as player_profile has it:
    // { since: when they were first seen or first played (ms), or null; solo: { runs, points, words, quick, longest,
    //   bestRank, recent, standing: where they are on the leaderboard, { total, rank (0 = top), best, words } }; rooms:
    //   { rounds, wins, podiums, best, words }; daily: their Daily Jam numbers (see noDaily) - their goes' and the
    //   folded ones' together - and calendar: every day they finished a word, oldest first, as [{ day, got, finished }],
    //   today: { rank (1 = top, null if they haven't finished a word that day), players }, and streak (see streakOf) }
    async profile(playerId, day) {
      const row = playerStats.get(playerId) || newStats(null);
      const { total, rank, best, words } = standings(playerId, 0, -Infinity);
      const plays = playsOf(playerId).map(([, play]) => play);
      const finished = plays.filter(play => play.solved !== null);
      const days = [...new Set(finished.map(play => play.day))].sort();
      const today = boardOn(day);
      const place = today.findIndex(entry => entry.id === playerId);
      const times = [
        people.has(playerId) ? people.get(playerId).firstSeen : null,
        accounts.has(playerId) ? accounts.get(playerId).createdAt : null,
        row.firstAt,
        ...plays.map(play => play.openedAt),
      ].filter(at => at !== null);
      return {
        since: times.length ? Math.min(...times) : null,
        solo: {
          runs: row.soloRuns, points: row.soloPoints, words: row.soloWords, quick: row.soloQuick, longest: row.soloLongest,
          bestRank: row.soloBestRank, recent: row.soloRecent.map(run => ({ ...run })), standing: { total, rank, best, words },
        },
        rooms: { rounds: row.roomRounds, wins: row.roomWins, podiums: row.roomPodiums, best: row.roomBest, words: row.roomWords },
        daily: {
          // The best finish is dailyOld's, from the boards that are over (see rankFinalBoards)
          ...addDaily(dailyNumbers(playerId, null), row.dailyOld),
          calendar: days.map(d => ({
            day: d, got: finished.filter(play => play.day === d && play.solved).length, finished: finished.filter(play => play.day === d).length,
          })),
          today: { rank: place === -1 ? null : place + 1, players: today.length },
          streak: streakOf(playerId),
        },
      };
    },

    // Who's on the site. A page's heartbeat (see account.js): player `id` is on `mode` ('home', 'solo', 'daily' or
    // 'practice') doing `detail`, under `name` (kept if ''), at time `at`. 'gone' is the page being left: their mode is
    // cleared and they're dated a day back, so livePlayers drops them at once. since only moves when the mode changes.
    async touchPlayer(id, name, mode, detail, at = Date.now()) {
      // Leaving makes no row: someone never heard from (a made-up token) has nothing to mark as gone
      if (mode === 'gone' && !people.has(id)) return;
      const person = people.get(id) || { name: '', mode: null, detail: {}, since: null, seenAt: at, firstSeen: at };
      if (name) person.name = name;
      if (mode === 'gone') {
        person.mode = null;
        person.seenAt = at - DAY_MS;
      } else {
        if (person.mode !== mode) person.since = at;
        person.mode = mode;
        person.detail = { ...detail };
        person.seenAt = at;
      }
      people.set(id, person);
      people.forEach((p, pid) => { if (p.seenAt < at - PLAYER_TTL && !scores.has(pid) && !accounts.has(pid)) people.delete(pid); });
    },

    // Everyone heard from in the last withinMs who hasn't left, by mode and then by who came first:
    // [{ id, name, mode, detail, since (ms), seenAt (ms), account }] - at most LIVE_MAX of them
    async livePlayers(withinMs) {
      const now = Date.now();
      return [...people].filter(([, p]) => p.mode !== null && p.seenAt > now - withinMs)
        .sort(([, a], [, b]) => (a.mode < b.mode ? -1 : a.mode > b.mode ? 1 : a.since - b.since))
        .slice(0, LIVE_MAX)
        .map(([id, p]) => ({ id, name: p.name, mode: p.mode, detail: { ...p.detail }, since: p.since, seenAt: p.seenAt, account: providerOf(id) }));
    },

    // Nothing to measure without Supabase
    async health() {
      return null;
    },
  };
}

function supabaseData(url, key) {
  const rpc = `${url.replace(/\/+$/, '')}/rest/v1/rpc/`;

  // Calls one of the functions in supabase/migrations with these arguments, resolving to what it returns
  async function call(name, args) {
    const res = await fetch(rpc + name, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(CALL_TIMEOUT),
    });
    const body = await res.text();
    if (!res.ok) {
      let message = body.slice(0, 200);
      try {
        message = JSON.parse(body).message || message;
      } catch {}
      // status: Supabase answered, but with an error
      throw Object.assign(new Error(`${name}: ${res.status} ${message}`), { status: res.status });
    }
    return body ? JSON.parse(body) : null;
  }

  const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 24 * 60 * 60 * 1000).toISOString();

  return {
    createRun: (run) => call('create_solo_run', { p_id: run.id, p_run: run, p_ttl_ms: RUN_TTL }),
    getRun: (id) => call('get_solo_run', { p_id: id }),
    saveRun: (run) => call('save_solo_run', { p_id: run.id, p_run: run, p_ttl_ms: RUN_TTL }),

    addScore: (playerId, score, name, words, below, top) =>
      call('add_solo_score', { p_player_id: playerId, p_score: score, p_name: name, p_words: words, p_below: below, p_top: top }),
    leaderboard: (top, playerId, offset = 0) => call('solo_standings', { p_top: top, p_player_id: playerId || '', p_offset: offset }),
    removeScore: (playerId) => call('remove_solo_score', { p_player_id: playerId }),

    bump: (name, windowMs) => call('bump_admin_counter', { p_name: name, p_window_ms: windowMs }),
    peek: (names) => call('peek_admin_counters', { p_names: names }),

    // Kept by age, unless Supabase doesn't have add_admin_log_for yet - the server can go out before the migration that
    // adds it is run, and the admin page's logs mustn't stop in between: then it's the one from before (see
    // OLD_LOG_KEEP)
    async log(name, entry, keepDays) {
      try {
        return await call('add_admin_log_for', { p_log: name, p_entry: entry, p_keep_days: keepDays });
      } catch (err) {
        if (err.status !== 404) throw err;
        return call('add_admin_log', { p_log: name, p_entry: entry, p_keep: OLD_LOG_KEEP });
      }
    },

    logs: (name, count) => call('admin_log_entries', { p_log: name, p_count: count }),

    // For the Activity tab, the same way: without the migration's functions, a day is found among the log's newest
    // entries, as the memory versions find it (see OLD_LOG_READ)
    async logsBetween(name, fromMs, toMs, limit) {
      try {
        return await call('admin_log_between', {
          p_log: name, p_from: new Date(fromMs).toISOString(), p_to: new Date(toMs).toISOString(), p_limit: limit,
        });
      } catch (err) {
        if (err.status !== 404) throw err;
        return entriesBetween(await call('admin_log_entries', { p_log: name, p_count: OLD_LOG_READ }), fromMs, toMs, limit);
      }
    },

    async logDays(name, fromMs, toMs, tz) {
      try {
        return await call('admin_log_days', {
          p_log: name, p_from: new Date(fromMs).toISOString(), p_to: new Date(toMs).toISOString(), p_tz: tz,
        });
      } catch (err) {
        if (err.status !== 404) throw err;
        return entriesByDay(await call('admin_log_entries', { p_log: name, p_count: OLD_LOG_READ }), fromMs, toMs, tz);
      }
    },

    track: (metric, playerIds, at) =>
      call('track_stat', { p_metric: metric, p_player_ids: playerIds, p_at: new Date(at).toISOString() }),

    // Every hour from the first day to the end of the last in one call, sorted back into days
    async statsFor(days) {
      if (!days.length) return [];
      const sorted = [...days].sort();
      const rows = await call('stats_between', { p_from: `${sorted[0]}T00:00:00Z`, p_to: nextDay(sorted[sorted.length - 1]) });
      const counts = new Map(days.map(day => [day, {}]));
      for (const { hour, metric, count } of rows) {
        const stamp = hourStamp(hour);
        const dayCounts = counts.get(stamp.slice(0, 10));
        if (dayCounts) dayCounts[`${metric}:${stamp.slice(11)}`] = count;
      }
      return days.map(day => counts.get(day));
    },

    uniquePlayers: (groups) => call('unique_players', { p_groups: groups.map(hours => hours.map(hour => `${hour}:00:00Z`)) }),

    getSettings: () => call('get_admin_settings', {}),
    saveSettings: (value) => call('save_admin_settings', { p_value: value }),

    dailyWords: (day) => call('daily_words_for', { p_day: day }),
    dailyWordsNear: (day, gap) => call('daily_words_near', { p_day: day, p_gap: gap }),
    addDailyWords: (day, words, gap) => call('add_daily_words', { p_day: day, p_words: words, p_gap: gap }),
    openDaily: (day, level, playerId, start, name) =>
      call('open_daily', { p_day: day, p_level: level, p_player_id: playerId, p_start: start, p_name: name || '' }),
    guessDaily: (day, level, playerId, n, guess, right, tries) =>
      call('guess_daily', { p_day: day, p_level: level, p_player_id: playerId, p_try: n, p_guess: guess, p_right: right, p_tries: tries }),
    dailyPlayer: (day, playerId) => call('daily_player_day', { p_day: day, p_player_id: playerId }),
    dailyStats: (day, level, playerId, tries) =>
      call('daily_stats', { p_day: day, p_level: level, p_player_id: playerId, p_tries: tries }),
    dailyAdminDay: (day, tries, top) => call('daily_admin_day', { p_day: day, p_tries: tries, p_top: top }),
    dailyAdminDays: (from, to) => call('daily_admin_days', { p_from: from, p_to: to }),
    dailyBoard: (day, playerId, top, offset) =>
      call('daily_board', { p_day: day, p_player_id: playerId || '', p_top: top, p_offset: offset }),
    dailyAdminPlayers: (day) => call('daily_admin_players', { p_day: day }),

    accountFor: (playerId) => call('account_for_player', { p_player_id: playerId }),

    // With the photo, unless Supabase doesn't have that link_account yet - the server can go out before the migration
    // that adds it (20261031000000_player_stats.sql) is run, and signing in mustn't break in between: then it's the
    // one from before, without the photo
    async linkAccount(playerId, { id, provider, name, avatar }) {
      const args = { p_player_id: playerId, p_account_id: id, p_provider: provider, p_name: name || '' };
      try {
        return await call('link_account', { ...args, p_avatar: avatar || '' });
      } catch (err) {
        if (err.status !== 404) throw err;
        return call('link_account', args);
      }
    },

    unlinkAccount: (playerId) => call('unlink_account', { p_player_id: playerId }),
    renameAccount: (accountId, name) => call('rename_account', { p_account_id: accountId, p_name: name }),
    deleteAccount: (accountId) => call('delete_account', { p_account_id: accountId }),

    recordSolo: (playerId, { points, words, quick, longest, rank }, keep) =>
      call('record_solo_play', { p_player_id: playerId, p_points: points, p_words: words, p_quick: quick, p_longest: longest || '', p_rank: rank || null, p_keep: keep }),
    recordRound: (players, count) => call('record_round', { p_players: players, p_count: count }),
    profile: (playerId, day) => call('player_profile', { p_player_id: playerId, p_day: day }),

    savePushDevice: (deviceId, { kind, address, keys, timeZone, hour, daily, solo }) => call('save_push_device', {
      p_device_id: deviceId, p_kind: kind, p_address: address, p_keys: keys, p_time_zone: timeZone, p_hour: hour, p_daily: daily, p_solo: solo,
    }),
    removePushDevice: (deviceId) => call('remove_push_device', { p_device_id: deviceId }),
    removePushAddress: (address) => call('remove_push_address', { p_address: address }),
    pushDevicesSince: (since) => call('push_devices_since', { p_since: new Date(since).toISOString() }),
    pushPlayers: (players) => call('push_players', { p_players: players }),
    claimPush: (claims) => call('claim_push', { p_claims: claims }),

    // The database times the heartbeat itself (its now() is the same for every server instance), so `at` isn't sent
    touchPlayer: (id, name, mode, detail) => call('touch_player', { p_id: id, p_name: name || '', p_mode: mode, p_detail: detail || {} }),

    // Its times come as ISO strings, and go out as ms like the memory version's
    async livePlayers(withinMs) {
      const rows = await call('live_players', { p_within_ms: withinMs });
      return rows.map(row => ({ ...row, since: row.since === null ? null : Date.parse(row.since), seenAt: Date.parse(row.seenAt) }));
    },

    // How long a call takes to come back
    async health() {
      const started = Date.now();
      await call('get_admin_settings', {});
      return { latencyMs: Date.now() - started };
    },
  };
}

// Supabase with a safety net, as store.js has for Redis. If it stops answering three times in a row - it's
// unreachable, or a free project that was paused for being idle - this instance keeps runs and the admin page's things
// in memory instead, and every 30 seconds checks whether Supabase answers again.
function fallbackData(supabase, memory) {
  let outage = null; // { since, reason } while Supabase isn't answering
  let failures = 0;  // in a row
  let touchFailedAt = 0; // when a dropped heartbeat was last logged

  // An error Supabase answered with (a function that isn't there yet, between a deploy and its migration) isn't Supabase
  // being down: that one call falls back, and the instance stays on Supabase for everything else (as attemptDaily).
  async function attempt(operation, onFailure) {
    if (outage) return onFailure();
    try {
      const result = await operation();
      failures = 0;
      return result;
    } catch (err) {
      if (!err.status || err.status >= 500) supabaseFailed(err);
      else console.error(`Supabase error (${err.message})`);
      return onFailure();
    }
  }

  // Daily Jam's calls. Its words have to be the same on every instance, so they're only ever Supabase's: while it isn't
  // answering these reject, and Daily Jam can't be reached. An error Supabase did answer with (say its functions aren't
  // there yet, in the moment between a deploy and the migration that adds them) isn't Supabase being down, so it
  // doesn't count toward moving everything else to memory.
  async function attemptDaily(operation) {
    if (outage) throw new Error(`Supabase isn't answering (${outage.reason})`);
    try {
      const result = await operation();
      failures = 0;
      return result;
    } catch (err) {
      if (!err.status || err.status >= 500) supabaseFailed(err);
      throw err;
    }
  }

  function supabaseFailed(err) {
    failures++;
    if (outage) return; // several calls failed at once - the first one already switched
    if (failures < 3) {
      console.error(`Supabase error (${err.message})`);
      return;
    }
    outage = { since: Date.now(), reason: err.message };
    console.error(`Supabase isn't answering (${err.message}) - keeping solo runs and the admin page's things in memory until it does`);
    const check = setInterval(async () => {
      try {
        await supabase.health();
        outage = null;
        failures = 0;
        clearInterval(check);
        console.log('Supabase is answering again');
      } catch {}
    }, 30 * 1000);
    check.unref();
  }

  return {
    status: () => (outage ? { store: 'memory', reason: outage.reason, since: outage.since } : { store: 'supabase' }),

    // A run started while Supabase isn't answering is kept in memory and played from there
    async createRun(run) {
      if (memory.hasRun(run.id)) return false;
      return attempt(() => supabase.createRun(run), () => memory.createRun(run));
    },

    async getRun(id) {
      if (memory.hasRun(id)) return memory.getRun(id);
      return attempt(() => supabase.getRun(id), () => null);
    },

    async saveRun(run) {
      if (memory.hasRun(run.id)) return memory.saveRun(run);
      return attempt(() => supabase.saveRun(run), () => {});
    },

    // The leaderboard is only ever the one in Supabase - an instance's own in memory would be a different board on every
    // instance. While Supabase isn't answering these resolve to null: the leaderboard can't be reached.
    addScore: (...args) => attempt(() => supabase.addScore(...args), () => null),
    leaderboard: (...args) => attempt(() => supabase.leaderboard(...args), () => null),
    removeScore: (...args) => attempt(() => supabase.removeScore(...args), () => null),

    // The admin page's. While Supabase isn't answering, this instance keeps its own in memory: its own count of wrong
    // passwords (so guessing is still capped), and its own log, stats and settings until Supabase is back.
    bump: (...args) => attempt(() => supabase.bump(...args), () => memory.bump(...args)),
    peek: (...args) => attempt(() => supabase.peek(...args), () => memory.peek(...args)),
    log: (...args) => attempt(() => supabase.log(...args), () => memory.log(...args)),
    logs: (...args) => attempt(() => supabase.logs(...args), () => memory.logs(...args)),
    logsBetween: (...args) => attempt(() => supabase.logsBetween(...args), () => memory.logsBetween(...args)),
    logDays: (...args) => attempt(() => supabase.logDays(...args), () => memory.logDays(...args)),
    track: (...args) => attempt(() => supabase.track(...args), () => memory.track(...args)),
    statsFor: (...args) => attempt(() => supabase.statsFor(...args), () => memory.statsFor(...args)),
    uniquePlayers: (...args) => attempt(() => supabase.uniquePlayers(...args), () => memory.uniquePlayers(...args)),
    getSettings: () => attempt(() => supabase.getSettings(), () => memory.getSettings()),
    saveSettings: (value) => attempt(() => supabase.saveSettings(value), () => memory.saveSettings(value)),

    // Daily Jam's (see attemptDaily)
    dailyWords: (...args) => attemptDaily(() => supabase.dailyWords(...args)),
    dailyWordsNear: (...args) => attemptDaily(() => supabase.dailyWordsNear(...args)),
    addDailyWords: (...args) => attemptDaily(() => supabase.addDailyWords(...args)),
    openDaily: (...args) => attemptDaily(() => supabase.openDaily(...args)),
    guessDaily: (...args) => attemptDaily(() => supabase.guessDaily(...args)),
    dailyPlayer: (...args) => attemptDaily(() => supabase.dailyPlayer(...args)),
    dailyStats: (...args) => attemptDaily(() => supabase.dailyStats(...args)),
    dailyAdminDay: (...args) => attemptDaily(() => supabase.dailyAdminDay(...args)),
    dailyAdminDays: (...args) => attemptDaily(() => supabase.dailyAdminDays(...args)),
    dailyBoard: (...args) => attemptDaily(() => supabase.dailyBoard(...args)),
    dailyAdminPlayers: (...args) => attemptDaily(() => supabase.dailyAdminPlayers(...args)),

    // Accounts and who's on the site are Supabase's alone too (an account has to be the same on every instance), so
    // they go the same way as Daily Jam's
    accountFor: (...args) => attemptDaily(() => supabase.accountFor(...args)),
    linkAccount: (...args) => attemptDaily(() => supabase.linkAccount(...args)),
    unlinkAccount: (...args) => attemptDaily(() => supabase.unlinkAccount(...args)),
    renameAccount: (...args) => attemptDaily(() => supabase.renameAccount(...args)),
    deleteAccount: (...args) => attemptDaily(() => supabase.deleteAccount(...args)),
    livePlayers: (...args) => attemptDaily(() => supabase.livePlayers(...args)),

    // And so are players' stats: an instance's own in memory would be a different record on each instance
    recordSolo: (...args) => attemptDaily(() => supabase.recordSolo(...args)),
    recordRound: (...args) => attemptDaily(() => supabase.recordRound(...args)),
    // Reading them is refused while Supabase isn't answering too - but one that fails doesn't count toward moving
    // everything else to memory: it ranks the player on every Daily Jam board they've played (see player_profile), so a
    // long-time player's can be slow enough to time out without anything being wrong with Supabase
    profile: (...args) => (outage ? Promise.reject(new Error(`Supabase isn't answering (${outage.reason})`)) : supabase.profile(...args)),

    // Reminders go by the same goes and streaks, so they're Supabase's alone too
    savePushDevice: (...args) => attemptDaily(() => supabase.savePushDevice(...args)),
    removePushDevice: (...args) => attemptDaily(() => supabase.removePushDevice(...args)),
    removePushAddress: (...args) => attemptDaily(() => supabase.removePushAddress(...args)),
    pushDevicesSince: (...args) => attemptDaily(() => supabase.pushDevicesSince(...args)),
    pushPlayers: (...args) => attemptDaily(() => supabase.pushPlayers(...args)),
    claimPush: (...args) => attemptDaily(() => supabase.claimPush(...args)),

    // Except the heartbeat: it's the most frequent call on the site and nothing waits on it, so one that fails is
    // dropped - and said so at most once a minute, since every player's page sends one every 20 seconds
    touchPlayer: (...args) => attemptDaily(() => supabase.touchPlayer(...args)).catch((err) => {
      if (Date.now() - touchFailedAt < 60 * 1000) return;
      touchFailedAt = Date.now();
      console.error("Noting who's on the site failed:", err.message);
    }),

    health: () => attempt(() => supabase.health(), () => null),
  };
}

module.exports = { createData };
