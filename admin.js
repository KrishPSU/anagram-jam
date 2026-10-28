// The admin page (/admin): a sign-in page, and behind it a dashboard of the rooms open right now, the solo leaderboard,
// stats, a log of games and of sign-ins, and the site's controls (a banner on the home page, pausing new games, a
// message to everyone playing).
//
// None of it is public. /admin is only the sign-in page until someone signs in with ADMIN_PASSWORD (an environment
// variable - on Vercel, in the project's Settings → Environment Variables). The dashboard's page, its scripts and
// everything they read or do need a session. How that holds up:
// - A session is a cookie that scripts can't read and other sites can't send (HttpOnly, SameSite=Strict, Secure on
//   https), signed with a key made from the password and a secret only the server has, so it can't be forged, and a
//   stolen one can't be used to work out the password. It lasts SESSION_MS. Changing the password signs everyone out,
//   and so does "Sign out everywhere else".
// - Guessing is slow and capped. Each try is counted before the password is even looked at (so firing off a thousand
//   at once gets no extra), a wrong one waits a second, an address (an IPv6 one by its /64) gets ADDRESS_LIMIT tries
//   per window and everyone together EVERYONE_LIMIT. Past that, only browsers that have signed in before can try:
//   they keep a device cookie, so someone guessing from a thousand addresses can't lock the real admin out. The
//   counts are in the store, so every server instance goes by the same ones.
// - The API only answers this site's own pages. Every request needs a header that another site can't add without
//   asking first (and it's never told yes), and anything that changes something has to carry this site's Origin.
// - The pages go out with a strict Content-Security-Policy and can't be put in a frame, so a player name made to look
//   like a script is only ever text, and nothing can be laid over the buttons.

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const WORDS = require('./words');
const DICTIONARY = require('word-exists/dictionary.json'); // the same list the games' answers are checked against
const { answersFor } = require('./solo');

const SESSION_MS = 12 * 60 * 60 * 1000;
const DEVICE_MS = 180 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'aj_admin';
const DEVICE_COOKIE = 'aj_admin_device';

const ADDRESS_LIMIT = { tries: 10, windowMs: 15 * 60 * 1000 };
const EVERYONE_LIMIT = { tries: 30, windowMs: 60 * 60 * 1000 }; // tries from browsers that haven't signed in before
const WRONG_WAIT = 1000;
const SHORT_PASSWORD = 14; // the dashboard suggests a longer one below this

const MESSAGE_MAX = 160; // a banner or a message to everyone
const LOG_KEEP = 300;    // entries in each log
const SETTINGS_FOR = 15 * 1000; // each instance reads the settings again this often
const STATS_FOR = 60 * 1000;    // and the stats

const DEFAULT_PAUSED_MESSAGE = 'New games are paused for a few minutes. Try again soon!';
// sessionsFrom: sessions signed in before this don't count anymore ("Sign out everywhere else")
const DEFAULT_SETTINGS = { announcement: '', paused: false, sessionsFrom: 0 };

// Word lengths each mode deals: rooms 3 to 5 letters (getRandomWords in index.js), solo 3 to 10 (solo.js)
const ROOM_LENGTHS = [3, 5];
const SOLO_LENGTHS = [3, 10];

const LOGIN_PAGE = path.join(__dirname, 'admin', 'login.html');
const DASHBOARD_PAGE = path.join(__dirname, 'admin', 'dashboard.html');

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));


// ---------- Who's asking ----------

// The address a request came from. Vercel puts the real one in X-Forwarded-For, replacing anything the browser sent;
// other hosts (Heroku) add it to the end of the list.
function clientAddress(req) {
  const forwarded = String(req.get('x-forwarded-for') || '').split(',').map(s => s.trim()).filter(Boolean);
  const address = forwarded.length ? forwarded[forwarded.length - 1] : (req.socket.remoteAddress || '');
  return address.replace(/^::ffff:/, '').slice(0, 64);
}

// The part of an address one person can easily change within: all of an IPv4 address, but only the first half of an
// IPv6 one (anyone with one IPv6 address has the 2^64 around it)
function addressBlock(address) {
  if (!address.includes(':')) return address;
  const plain = address.split('%')[0].toLowerCase();
  const [head, tail] = plain.split('::');
  const front = head ? head.split(':') : [];
  const back = tail ? tail.split(':') : [];
  const groups = plain.includes('::') ? [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill('0'), ...back] : front;
  return groups.slice(0, 4).map(group => group || '0').join(':') + '::/64';
}

// "Chrome on macOS", for the log
function deviceName(userAgent) {
  const ua = String(userAgent || '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari'
    : /curl|wget|python|node|go-http|axios|java|okhttp/i.test(ua) ? 'A script' : 'A browser';
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

// Roughly where, as Vercel works it out from the address ("Philadelphia, PA, US"), or null elsewhere
function placeOf(req) {
  const decode = (value) => {
    try {
      return decodeURIComponent(String(value || '')).slice(0, 40);
    } catch {
      return '';
    }
  };
  const place = [decode(req.get('x-vercel-ip-city')), decode(req.get('x-vercel-ip-country-region')), decode(req.get('x-vercel-ip-country'))].filter(Boolean);
  return place.length ? place.join(', ') : null;
}

function requester(req) {
  return { ip: clientAddress(req), device: deviceName(req.get('user-agent')), place: placeOf(req) };
}

// Only this site's own pages. A browser that says where a request comes from (Sec-Fetch-Site) has to say it's from
// here, and a request that changes something has to carry this site's Origin (browsers always send one with those).
function fromThisSite(req, changing) {
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin') return false;
  if (!changing) return true;
  try {
    return new URL(req.get('origin')).host === req.get('host');
  } catch {
    return false;
  }
}

function readCookie(req, name) {
  for (const part of String(req.get('cookie') || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // Never kept by the browser or Vercel's cache: what's behind the sign-in must only ever come from the server
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  });
  next();
}


// ---------- Words ----------

const letterKey = (word) => [...word].sort().join('');

// What the word checker says about some letters: whether they're a real word, every real word they make, and if a game
// could deal them, as which word - and what each answer is worth then (the hidden word 2 points, the others 1)
function checkWord(query) {
  const word = String(query || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 15);
  if (word.length < 2) return null;
  const key = letterKey(word);
  const makes = [];
  for (const list of Object.values(DICTIONARY)) {
    for (const candidate of list) {
      if (candidate.length === word.length && letterKey(candidate) === key) makes.push(candidate);
    }
  }
  const dealt = (WORDS[word.length] || []).filter(hidden => letterKey(hidden) === key);
  const deals = ([shortest, longest]) => word.length >= shortest && word.length <= longest;
  return {
    word,
    real: makes.includes(word),
    makes: [...new Set(makes)].sort(),
    dealt: dealt.map(hidden => ({ word: hidden, others: answersFor(hidden).filter(answer => answer !== hidden) })),
    rooms: deals(ROOM_LENGTHS) && dealt.length > 0,
    solo: deals(SOLO_LENGTHS) && dealt.length > 0,
  };
}


// ---------- Rooms ----------

// A room as the dashboard shows it: everything about it, the round's words included
function roomView(room) {
  const round = room.round;
  const phase = round ? 'playing' : room.countdown ? 'countdown' : room.players.some(p => p.status === 'results') ? 'results' : 'lobby';
  return {
    code: room.roomCode,
    createdAt: room.createdAt || null,
    emptySince: room.emptySince || null,
    phase,
    round: round ? {
      startedAt: round.startedAt,
      total: round.words.regular.length,
      words: round.words.regular.map((word, i) => ({ word, scramble: round.words.jumbled[i], first: round.solves[i] || null })),
    } : null,
    lastRound: room.results ? { winner: room.results.winnerName, tied: room.results.tied, players: room.results.players.length } : null,
    players: room.players.map((p) => {
      const progress = round && round.progress[p.id];
      return {
        id: p.id,
        name: p.name,
        status: p.status === 'lobby' ? (p.ready ? 'ready' : 'notReady') : p.status,
        awaySince: p.awaySince || null,
        wins: room.wins[p.id] || 0,
        level: progress ? progress.level : null,
        points: progress ? progress.points : null,
        solved: progress ? progress.solved : null,
      };
    }),
  };
}

// Rounds going on first, then the newest
function byActivity(a, b) {
  return (b.phase === 'playing') - (a.phase === 'playing') || (b.createdAt || 0) - (a.createdAt || 0);
}


// ---------- Stats ----------

const METRICS = ['rooms', 'rounds', 'solo'];

function timeZone(name) {
  if (typeof name !== 'string' || name.length > 64) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return name;
  } catch {
    return 'UTC';
  }
}


// app: the Express app the pages and API go on. store: where its settings, logs, counters and stats are kept (see
// data.js). solo: see solo.js. rooms: { list, close, remove, health } from index.js. storageStatus(): where rooms are
// kept. dataStatus(): where the store keeps things right now. broadcast(message): to every page open. pageVersion: the game
// pages' (see PAGE_VERSION in index.js). secret: something only the server knows, the same on every instance (on
// Vercel, ADMIN_SESSION_SECRET or the Redis address).
function createAdmin({ app, store, solo, rooms, storageStatus, dataStatus, broadcast, pageVersion, secret }) {
  // Without one shared by every instance, this one makes up its own: fine for a single server, but on Vercel a session
  // would only work on the instance that started it
  const sharedSecret = !!secret;
  secret = secret || crypto.randomBytes(32).toString('hex');
  const password = () => process.env.ADMIN_PASSWORD || '';


  // ---------- Settings ----------

  let settingsCache = { at: 0, value: DEFAULT_SETTINGS };
  let settingsPending = null;

  async function readSettings() {
    return { ...DEFAULT_SETTINGS, ...(await store.getSettings()) };
  }

  // The settings as of SETTINGS_FOR ago at most, so the home page asking doesn't mean a read every time
  function settings() {
    if (Date.now() - settingsCache.at < SETTINGS_FOR) return Promise.resolve(settingsCache.value);
    if (!settingsPending) {
      settingsPending = readSettings()
        .catch((err) => {
          console.error('Reading the admin settings failed:', err.message);
          return settingsCache.value;
        })
        .then((value) => {
          // A sign-out-everywhere this instance knows about stays in force, even if the store answers without it
          // (Supabase not answering, so the settings come from this instance's empty memory)
          value = { ...value, sessionsFrom: Math.max(value.sessionsFrom || 0, settingsCache.value.sessionsFrom || 0) };
          settingsCache = { at: Date.now(), value };
          settingsPending = null;
          return value;
        });
    }
    return settingsPending;
  }

  async function saveSettings(changes) {
    const value = { ...(await readSettings()), ...changes };
    value.sessionsFrom = Math.max(value.sessionsFrom || 0, settingsCache.value.sessionsFrom || 0);
    await store.saveSettings(value);
    settingsCache = { at: Date.now(), value };
    return value;
  }

  // What players are told: the home page's banner, and whether new games can start (with what to tell them if not)
  async function forPlayers() {
    const { announcement, paused } = await settings();
    return { announcement, paused, pausedMessage: announcement || DEFAULT_PAUSED_MESSAGE };
  }


  // ---------- Logs and stats ----------

  // Written without holding up what it's about
  function log(name, entry) {
    store.log(name, { at: Date.now(), ...entry }, LOG_KEEP).catch(err => console.error(`Writing the ${name} log failed:`, err.message));
  }

  // Something done on the dashboard, and from where - an action from somewhere unexpected is worth noticing
  function noteAction(req, what) {
    log('security', { type: 'action', what, ...requester(req) });
    console.log(`Admin: ${what}`);
  }

  function track(metric, playerIds = []) {
    store.track(metric, playerIds, Date.now()).catch(err => console.error(`Counting ${metric} failed:`, err.message));
  }

  // Each of the last `days` days in time zone `tz`: rooms made, rounds started, solo runs and players (different
  // people, in either mode), and the same by hour of the day. The store keeps them by UTC hour (see store.js).
  const statsCache = new Map();
  async function statsReport(tz, days) {
    const cacheKey = `${tz}|${days}`;
    const cached = statsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < STATS_FOR) return cached.value;

    const HOUR = 60 * 60 * 1000;
    const now = Date.now();
    const local = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
    // Every UTC hour since a little before the first of those days, with the day and hour it is there
    const hours = [];
    for (let at = Math.floor(now / HOUR) * HOUR - (days + 1) * 24 * HOUR; at <= now; at += HOUR) {
      const parts = Object.fromEntries(local.formatToParts(at).map(part => [part.type, part.value]));
      hours.push({ stamp: new Date(at).toISOString().slice(0, 13), day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 });
    }
    const dayList = [...new Set(hours.map(h => h.day))].slice(-days);
    const inRange = hours.filter(h => dayList.includes(h.day));
    const utcDays = [...new Set(inRange.map(h => h.stamp.slice(0, 10)))];

    const groups = dayList.map(day => inRange.filter(h => h.day === day).map(h => h.stamp));
    const [counts, players] = await Promise.all([
      store.statsFor(utcDays),
      store.uniquePlayers([...groups, inRange.map(h => h.stamp)]),
    ]);
    const countsOn = Object.fromEntries(utcDays.map((day, i) => [day, counts[i] || {}]));

    const daily = dayList.map((day, i) => ({ day, players: players[i], ...Object.fromEntries(METRICS.map(m => [m, 0])) }));
    const hourly = Array.from({ length: 24 }, () => Object.fromEntries(METRICS.map(m => [m, 0])));
    for (const h of inRange) {
      const row = daily[dayList.indexOf(h.day)];
      const dayCounts = countsOn[h.stamp.slice(0, 10)];
      for (const m of METRICS) {
        const n = dayCounts[`${m}:${h.stamp.slice(11)}`] || 0;
        row[m] += n;
        hourly[h.hour][m] += n;
      }
    }
    const value = { tz, daily, hourly, players: players[players.length - 1] };
    statsCache.set(cacheKey, { at: Date.now(), value });
    return value;
  }


  // ---------- Sessions ----------

  const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest();
  // The password is part of the key, so changing it signs everyone out
  const keyFor = (kind) => hmac(secret, `anagram-jam admin ${kind}\n${password()}`);

  function sign(kind, payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${hmac(keyFor(kind), body).toString('base64url')}`;
  }

  // The payload, if the token is one this server signed and it hasn't run out; otherwise null
  function verify(kind, token) {
    if (typeof token !== 'string' || token.length > 1000) return null;
    const [body, mac, extra] = token.split('.');
    if (!body || !mac || extra !== undefined) return null;
    const expected = hmac(keyFor(kind), body);
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    } catch {
      return null;
    }
    return payload && Number.isFinite(payload.exp) && payload.exp > Date.now() ? payload : null;
  }

  const isHttps = (req) => req.protocol === 'https' || req.get('x-forwarded-proto') === 'https';
  const cookieOptions = (req) => ({ httpOnly: true, sameSite: 'strict', secure: isHttps(req), path: '/admin' });

  // The session a request comes with ({ iat, exp }), or null if it isn't signed in
  async function sessionOf(req) {
    if (!password()) return null;
    const session = verify('session', readCookie(req, SESSION_COOKIE));
    if (!session || !Number.isFinite(session.iat)) return null;
    const { sessionsFrom } = await settings();
    return session.iat >= sessionsFrom ? session : null;
  }

  function startSession(req, res) {
    const now = Date.now();
    res.cookie(SESSION_COOKIE, sign('session', { iat: now, exp: now + SESSION_MS }), { ...cookieOptions(req), maxAge: SESSION_MS });
    res.cookie(DEVICE_COOKIE, sign('device', { exp: now + DEVICE_MS }), { ...cookieOptions(req), maxAge: DEVICE_MS });
  }

  const isTrusted = (req) => !!verify('device', readCookie(req, DEVICE_COOKIE));

  function passwordMatches(given) {
    if (typeof given !== 'string' || given.length > 1000) return false;
    const digest = (text) => crypto.createHash('sha256').update(text).digest();
    return crypto.timingSafeEqual(digest(given), digest(password()));
  }

  // Counts a try at signing in, and resolves to how long (ms) until another is allowed if it's over a limit, or 0.
  // Counted before the password is looked at, so a thousand tries sent at once still only get the limit's worth.
  const lockedUntil = new Map(); // limit's name -> when it's over: once over, it's turned away here without a store read
  async function countTry(req, trusted) {
    const now = Date.now();
    const limits = [[`address:${addressBlock(clientAddress(req))}`, ADDRESS_LIMIT]];
    if (!trusted) limits.push(['everyone', EVERYONE_LIMIT]);
    for (const [name] of limits) {
      if (lockedUntil.get(name) > now) return lockedUntil.get(name) - now;
    }
    if (lockedUntil.size > 5000) lockedUntil.forEach((until, name) => until <= now && lockedUntil.delete(name));
    for (const [name, limit] of limits) {
      const { count, resetsIn } = await store.bump(`signin:${name}`, limit.windowMs);
      if (count > limit.tries) {
        lockedUntil.set(name, now + resetsIn);
        if (count === limit.tries + 1) log('security', { type: 'locked', scope: name === 'everyone' ? 'everyone' : 'address', minutes: Math.ceil(resetsIn / 60000), ...requester(req) });
        return resetsIn;
      }
    }
    return 0;
  }


  // ---------- Pages ----------

  const router = express.Router();
  router.use(securityHeaders);

  router.get('/', async (req, res) => {
    if (await sessionOf(req)) res.sendFile(DASHBOARD_PAGE, { cacheControl: false });
    else res.sendFile(LOGIN_PAGE, { cacheControl: false });
  });

  // The sign-in page's script and both pages' styles
  router.use('/assets', express.static(path.join(__dirname, 'admin', 'assets'), { cacheControl: false }));
  // The dashboard's scripts, for whoever is signed in only
  router.use('/app', async (req, res, next) => ((await sessionOf(req)) ? next() : res.sendStatus(404)));
  router.use('/app', express.static(path.join(__dirname, 'admin', 'app'), { cacheControl: false }));

  // Replies { status: 'ok' } with the session's cookies, or 'wrong', 'locked' (with retryIn, in ms), 'unset' (there's no
  // ADMIN_PASSWORD) or 'forbidden' (not from this site)
  router.post('/login', express.json({ limit: '2kb' }), async (req, res) => {
    if (!fromThisSite(req, true)) return res.status(403).json({ status: 'forbidden' });
    if (!password()) return res.json({ status: 'unset' });
    const trusted = isTrusted(req);
    const retryIn = await countTry(req, trusted);
    if (retryIn) return res.status(429).json({ status: 'locked', retryIn });
    if (!passwordMatches(req.body && req.body.password)) {
      log('security', { type: 'wrong-password', trusted, ...requester(req) });
      await wait(WRONG_WAIT);
      return res.status(401).json({ status: 'wrong' });
    }
    startSession(req, res);
    log('security', { type: 'signed-in', trusted, ...requester(req) });
    console.log(`Admin signed in from ${clientAddress(req)}`);
    res.json({ status: 'ok' });
  });

  // This browser only. It stays a known device, so it isn't held up by other people's wrong guesses.
  router.post('/logout', async (req, res) => {
    if (!fromThisSite(req, true)) return res.status(403).json({ status: 'forbidden' });
    if (await sessionOf(req)) log('security', { type: 'signed-out', ...requester(req) });
    res.clearCookie(SESSION_COOKIE, cookieOptions(req));
    res.json({ status: 'ok' });
  });


  // ---------- API ----------

  // Every request needs the X-Admin header (only this site's pages send it) and a session. 401 means signed out.
  const api = express.Router();
  api.use(async (req, res, next) => {
    if (req.get('x-admin') !== '1' || !fromThisSite(req, req.method !== 'GET')) return res.status(403).json({ error: 'forbidden' });
    const session = await sessionOf(req);
    if (!session) return res.status(401).json({ error: 'signed out' });
    res.locals.session = session;
    next();
  });
  api.use(express.json({ limit: '4kb' }));
  router.use('/api', api);

  const bodyOf = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
  const text = (value, max) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '');

  // Everything the Live tab shows, polled while it's open
  api.get('/overview', async (req, res) => {
    const [list, current] = await Promise.all([rooms.list(), settings()]);
    const views = list.map(roomView).sort(byActivity);
    const everyone = views.flatMap(room => room.players);
    res.json({
      now: Date.now(),
      totals: {
        players: everyone.length,
        playing: everyone.filter(p => p.status === 'game').length,
        rooms: views.length,
        games: views.filter(room => room.phase === 'playing').length,
      },
      rooms: views,
      storage: storageStatus(),
      settings: { announcement: current.announcement, paused: current.paused },
      session: { ends: res.locals.session.exp },
    });
  });

  // Sends everyone in it home ("That room was closed")
  api.post('/rooms/close', async (req, res) => {
    const code = text(bodyOf(req).code, 5);
    const closed = await rooms.close(code);
    if (!closed) return res.json({ status: 'gone' });
    noteAction(req, `Closed room ${code}${closed.players.length ? ` (${closed.players.join(', ')})` : ''}`);
    res.json({ status: 'ok' });
  });

  // Takes a player out of a room and sends them home. They can't get back into that room.
  api.post('/rooms/remove', async (req, res) => {
    const { code, id } = bodyOf(req);
    const removed = await rooms.remove(text(code, 5), text(id, 32));
    if (!removed) return res.json({ status: 'gone' });
    noteAction(req, `Removed ${removed.name} from room ${text(code, 5)}`);
    res.json({ status: 'ok' });
  });

  api.get('/leaderboard', async (req, res) => {
    res.json(await solo.adminBoard());
  });

  // name: theirs as the dashboard showed it, for the log
  api.post('/leaderboard/remove', async (req, res) => {
    const { id, name } = bodyOf(req);
    const reply = await solo.adminRemove({ id: text(id, 64) });
    if (reply.status === 'ok') noteAction(req, `Took ${text(name, 20) || 'a player'} off the solo leaderboard`);
    res.json(reply);
  });

  // log: 'game' (rounds and solo runs) or 'security' (sign-ins and what was done here)
  api.get('/activity', async (req, res) => {
    const name = req.query.log === 'security' ? 'security' : 'game';
    res.json({ log: name, entries: await store.logs(name, 200) });
  });

  api.get('/stats', async (req, res) => {
    const days = [7, 14, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    res.json(await statsReport(timeZone(req.query.tz), days));
  });

  // { announcement, paused } - either or both
  api.post('/settings', async (req, res) => {
    const body = bodyOf(req);
    const changes = {};
    if (typeof body.announcement === 'string') changes.announcement = text(body.announcement, MESSAGE_MAX);
    if (typeof body.paused === 'boolean') changes.paused = body.paused;
    const before = await settings();
    const after = await saveSettings(changes);
    if ('announcement' in changes && changes.announcement !== before.announcement) {
      noteAction(req, changes.announcement ? `Set the home page banner: "${changes.announcement}"` : 'Took down the home page banner');
    }
    if ('paused' in changes && changes.paused !== before.paused) {
      noteAction(req, changes.paused ? 'Paused new games' : 'Let new games start again');
    }
    res.json({ announcement: after.announcement, paused: after.paused });
  });

  // A pop-up on every page open right now
  api.post('/broadcast', async (req, res) => {
    const message = text(bodyOf(req).message, MESSAGE_MAX);
    if (!message) return res.json({ status: 'empty' });
    broadcast(message);
    noteAction(req, `Sent everyone: "${message}"`);
    res.json({ status: 'ok' });
  });

  api.get('/word', (req, res) => {
    res.json({ result: checkWord(req.query.q) });
  });

  api.get('/system', async (req, res) => {
    const env = process.env;
    const session = res.locals.session;
    const [redis, supabase, [everyone]] = await Promise.all([
      rooms.health().catch(() => null),
      store.health().catch(() => null),
      store.peek(['signin:everyone']),
    ]);
    res.json({
      // Vercel's, about the deployment that's running (with "Automatically expose System Environment Variables" on,
      // as it is by default)
      deploy: {
        commit: env.VERCEL_GIT_COMMIT_SHA || null,
        message: (env.VERCEL_GIT_COMMIT_MESSAGE || '').slice(0, 300) || null,
        branch: env.VERCEL_GIT_COMMIT_REF || null,
        repo: env.VERCEL_GIT_REPO_OWNER && env.VERCEL_GIT_REPO_SLUG ? `${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}` : null,
        environment: env.VERCEL_ENV || (env.VERCEL ? 'vercel' : 'local'),
        region: env.VERCEL_REGION || null,
        url: env.VERCEL_URL || null,
      },
      server: {
        node: process.version,
        uptime: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
        pageVersion,
        storage: storageStatus(),
        redis,
        data: dataStatus(),
        supabase,
      },
      security: {
        signedInAt: session.iat,
        sessionEnds: session.exp,
        trustedDevice: isTrusted(req),
        shortPassword: password().length < SHORT_PASSWORD,
        sharedSecret,
        everyone: { tries: everyone.count, resetsIn: everyone.resetsIn },
        limits: { address: ADDRESS_LIMIT, everyone: EVERYONE_LIMIT },
      },
    });
  });

  // Every other session stops working (within SETTINGS_FOR on other instances); this one carries on with a new cookie
  api.post('/sign-out-everywhere', async (req, res) => {
    await saveSettings({ sessionsFrom: Date.now() });
    startSession(req, res);
    noteAction(req, 'Signed out every other session');
    res.json({ status: 'ok' });
  });

  router.use((req, res) => res.status(404).json({ error: 'not found' }));
  router.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'bad request' });
    console.error('Admin page:', err.message);
    res.status(500).json({ error: 'failed' });
  });

  app.use('/admin', router);

  return {
    forPlayers,
    // For index.js: something that happened in a game, for the dashboard's log, and a count for its stats
    log: (entry) => log('game', entry),
    track,
  };
}

module.exports = { createAdmin, addressBlock, checkWord };
