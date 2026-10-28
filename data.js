// Where solo mode and the admin page keep their things. Rooms are kept apart from these, in Redis (see store.js).
//
// Solo mode (see solo.js) keeps each run while it's being played (its words, so the answers sent at the end can be
// checked), and the leaderboard - every player's best score, and how many words it got. A leaderboard score is a single
// number, higher is better (solo.js packs the points and the time into it).
//
// Daily Jam (see daily.js) keeps every day's words - the record that keeps a word from coming up again within a year -
// each player's go at them (their tries and time), and their streaks.
//
// The admin page (see admin.js) keeps counters that cap wrong passwords, two short logs (games, and sign-ins with what was
// done on the page), the site's settings (a banner, games paused), and stats - how many rooms, rounds and solo runs there
// were each hour, and who played.
//
// With a Supabase project (SUPABASE_URL and SUPABASE_SECRET_KEY; its tables and functions are in supabase/migrations,
// which Supabase's GitHub integration applies on a push to main) they're kept there, so every server instance sees the same ones. It's reached through its HTTP API, one request per
// call - nothing to connect or keep open, which suits Vercel's short-lived instances - and anything that has to happen
// in one step is a function in the database.
// Without one (local development), they stay in this process's memory.
//
// If Supabase stops answering (see fallbackData), runs and the admin page's things are kept in memory until it does,
// and the leaderboard and Daily Jam can't be reached.

// The stats are kept by UTC hour, so the admin page can add them up into days in its own time zone.
// hourStamp: '2026-10-27T13' for 1pm UTC, as statsFor and uniquePlayers take them.
const hourStamp = (at) => new Date(at).toISOString().slice(0, 13);

// A solo run is two minutes long - this leaves plenty of time to send it in after a dropped connection
const RUN_TTL = 15 * 60 * 1000;

// Give up on a call this quickly, so the game can fall back to memory while Supabase is unreachable or slow
const CALL_TIMEOUT = 3000;

// Days apart, for Daily Jam's days ('2026-10-28')
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / (24 * 60 * 60 * 1000));

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
  let settings = null;

  function liveRun(id) {
    const run = runs.get(id);
    if (run && run.expiresAt <= Date.now()) runs.delete(id);
    return runs.get(id);
  }

  // Where everyone stands, as Supabase's functions work it out. below: a score to count the players under.
  function standings(playerId, top, below) {
    const board = [...scores].map(([id, entry]) => ({ id, ...entry })).sort((a, b) => b.score - a.score);
    const rank = board.findIndex(entry => entry.id === playerId);
    return {
      total: board.length,
      lower: board.filter(entry => entry.score < below).length,
      rank: rank === -1 ? null : rank,
      best: rank === -1 ? null : board[rank].score,
      words: rank === -1 ? null : board[rank].words,
      top: board.slice(0, top),
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
    // (their latest), and says where everyone stands: { before (their best until now, or null), total, lower (players
    // with a score under `below`), rank (0 = top), best, words (their best's), top: the first `top` entries, as
    // { id, score, name, words } }
    async addScore(playerId, score, name, words, below, top) {
      const old = scores.get(playerId);
      const best = old && old.score >= score ? old : { score, words };
      scores.set(playerId, { score: best.score, name, words: best.words });
      return { before: old ? old.score : null, ...standings(playerId, top, below) };
    },

    // The first `top` entries and where playerId stands: { total, rank, best, words, top } as for addScore
    async leaderboard(top, playerId) {
      const { total, rank, best, words, top: entries } = standings(playerId, top, -Infinity);
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

    // Adds an entry to the front of log `name`, keeping the newest `keep`
    async log(name, entry, keep) {
      logs.set(name, [entry, ...(logs.get(name) || [])].slice(0, keep));
    },

    async logs(name, count) {
      return (logs.get(name) || []).slice(0, count);
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

    // Opens a level of the day for a player, starting their clock unless it's going already (start false only looks).
    // Resolves to their go: { level, guesses (the wrong ones), solved (null while playing), answer, ms, elapsed (ms since
    // they opened it), word (once they've finished) } - or null if they haven't opened it.
    async openDaily(day, level, playerId, start) {
      const key = playKey(day, level, playerId);
      if (start && !dailyPlays.has(key)) {
        dailyPlays.set(key, { day, level, openedAt: Date.now(), guesses: [], solved: null, answer: null, ms: null });
        dailyPlays.forEach((play, k) => { if (daysBetween(play.day, day) > 400) dailyPlays.delete(k); });
      }
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
      const times = done.filter(d => d.solved).map(d => d.ms).sort((a, b) => a - b);
      const middle = times.length >> 1;
      const me = done.find(d => d.id === playerId && d.solved);
      return {
        players: done.length,
        got: Array.from({ length: tries }, (_, i) => done.filter(d => d.solved && d.tries === i + 1).length),
        missed: done.filter(d => !d.solved).length,
        median: !times.length ? null : times.length % 2 ? times[middle] : Math.round((times[middle - 1] + times[middle]) / 2),
        solved: (done.find(d => d.id === playerId) || { solved: null }).solved,
        behind: me ? done.filter(d => d.id !== playerId && (!d.solved || d.tries > me.tries || (d.tries === me.tries && d.ms > me.ms))).length : 0,
        streak: streakOf(playerId),
      };
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
    leaderboard: (top, playerId) => call('solo_standings', { p_top: top, p_player_id: playerId || '' }),
    removeScore: (playerId) => call('remove_solo_score', { p_player_id: playerId }),

    bump: (name, windowMs) => call('bump_admin_counter', { p_name: name, p_window_ms: windowMs }),
    peek: (names) => call('peek_admin_counters', { p_names: names }),

    log: (name, entry, keep) => call('add_admin_log', { p_log: name, p_entry: entry, p_keep: keep }),
    logs: (name, count) => call('admin_log_entries', { p_log: name, p_count: count }),

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
    openDaily: (day, level, playerId, start) =>
      call('open_daily', { p_day: day, p_level: level, p_player_id: playerId, p_start: start }),
    guessDaily: (day, level, playerId, n, guess, right, tries) =>
      call('guess_daily', { p_day: day, p_level: level, p_player_id: playerId, p_try: n, p_guess: guess, p_right: right, p_tries: tries }),
    dailyPlayer: (day, playerId) => call('daily_player_day', { p_day: day, p_player_id: playerId }),
    dailyStats: (day, level, playerId, tries) =>
      call('daily_stats', { p_day: day, p_level: level, p_player_id: playerId, p_tries: tries }),

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

  async function attempt(operation, onFailure) {
    if (outage) return onFailure();
    try {
      const result = await operation();
      failures = 0;
      return result;
    } catch (err) {
      supabaseFailed(err);
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

    health: () => attempt(() => supabase.health(), () => null),
  };
}

module.exports = { createData };
