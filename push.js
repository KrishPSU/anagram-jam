// Reminders: a push notification, at most one a day, at the hour the player picked - to play today's Daily Jam if they
// haven't, and otherwise, every few days, to go for their solo best. They're opt-in, a device at a time: the page asks
// (shared/reminders.js) and sends this device's push address, and that's kept here until they turn reminders off or the
// push service says the address is gone. Reminders stop by themselves for a device that hasn't opened the game in two
// weeks, and start again when it does: nobody gets nagged forever.
//
// A reminder gets to a phone one of two ways. The iPhone app's go through Apple (APNs), and everything else - browsers,
// and the game added to a home screen - through the browser's own push service (Web Push). Each is only on with its keys
// (APNS_KEY, VAPID_PRIVATE_KEY and the rest, see SETUP-PUSH.md), and the pages only offer what's on (see config), so
// without them this is all dormant.
//
// Nothing runs by itself on Vercel, and its free plan's cron can only run once a day, so a job in Supabase calls
// POST /push/send on the hour, every hour (supabase/migrations/20261104000000_push_reminders.sql), and sendDue looks for
// the devices it's their hour for, where they are.
//
// A device's reminders are the device's, not its account's, like its sound setting: signing in or out doesn't change
// them, though who's played what goes by who the device is signed in as (see playerId in pushDevicesSince, data.js).

const crypto = require('crypto');
const http2 = require('http2');
const { timeZone, clockIn } = require('./admin');
const { dateAt, streakFor } = require('./daily');
const { pointsOf } = require('./solo');

const FIRST_HOUR = 7;        // the hours a player can pick, as shared/reminders.js offers them: 7am
const LAST_HOUR = 22;        // to 10pm
const SOLO_EVERY_DAYS = 3;   // solo's reminder goes out this often at most, and not to anyone who's played solo since
const QUIET_AFTER_DAYS = 14; // a device that hasn't opened the game in this long gets none until it does
const KEEP_HOURS = 6;        // a reminder that can't be delivered for this long is dropped: it'd be out of date
const AT_ONCE = 20;          // reminders being sent at any one time
const SEND_TIMEOUT = 10 * 1000;

const APNS_ADDRESS = 'https://api.push.apple.com'; // TestFlight and the App Store both use this one
const APP_TOPIC = 'com.krishchavan.anagramjam';    // the app's bundle ID
const SITE = 'https://www.anagramjam.com';         // who's sending, for the web push services

// Who a web push address can belong to. The server sends to these addresses hourly, and a page can say anything, so
// without this list a script could have it making requests to wherever it liked.
const WEB_PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

const DAY_MS = 24 * 60 * 60 * 1000;
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

const isToken = (token) => typeof token === 'string' && token.length >= 16;
const isText = (text, max) => typeof text === 'string' && text.length > 0 && text.length <= max;

function isWebAddress(address) {
  if (!isText(address, 1000)) return false;
  try {
    const url = new URL(address);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && WEB_PUSH_HOSTS.some(host => host.test(url.hostname));
  } catch {
    return false;
  }
}

// What a device can be reached at: an APNs device token (hex), or a web push address with its keys
const isApnsAddress = (address) => typeof address === 'string' && /^[0-9a-f]{64,200}$/i.test(address);
const isWebKeys = (keys) => !!keys && typeof keys === 'object' && isText(keys.p256dh, 200) && isText(keys.auth, 100);


// What to tell a device today, or null for nothing. player: as pushPlayers in data.js has them.
function reminderFor(device, player, day, now) {
  if (device.daily && !player.played) {
    const streak = streakFor(player.streak, day).current;
    return {
      type: 'daily',
      url: '/daily',
      title: streak > 1 ? `Keep your ${streak}-day streak going 🔥` : "Today's Daily Jam is ready",
      body: 'Three new words, three tries at each.',
    };
  }
  if (!device.solo) return null;
  if (player.soloAt !== null && now - player.soloAt < SOLO_EVERY_DAYS * DAY_MS) return null;
  if (device.lastSoloDay && daysBetween(device.lastSoloDay, day) < SOLO_EVERY_DAYS) return null;
  const best = player.soloBest === null ? 0 : pointsOf(player.soloBest);
  return best
    ? { type: 'solo', url: '/solo', title: `Can you beat ${best}?`, body: `That's your solo best. You've got two minutes.` }
    : { type: 'solo', url: '/solo', title: 'Got two minutes?', body: 'See how many words you can unscramble in a solo run.' };
}


// Apple's push service: one HTTP/2 connection for a run of reminders, and one signed token to get in with, good for
// all of them (see Apple's "Establishing a token-based connection to APNs"). A send resolves to 'sent', 'gone' (Apple
// says this device can't be reached at that address any more) or 'failed'.
function apnsSender({ keyId, teamId, key, address = APNS_ADDRESS }) {
  const base64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${base64({ alg: 'ES256', kid: keyId })}.${base64({ iss: teamId, iat: Math.floor(Date.now() / 1000) })}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const session = http2.connect(address);
  session.on('error', err => console.error('The connection to Apple failed:', err.message));

  const send = (device, message) => new Promise((resolve) => {
    const request = session.request({
      ':method': 'POST',
      ':path': `/3/device/${device.address}`,
      authorization: `bearer ${unsigned}.${signature}`,
      'apns-topic': APP_TOPIC,
      'apns-push-type': 'alert',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + KEEP_HOURS * 3600),
      'apns-collapse-id': 'reminder',
      'content-type': 'application/json',
    });
    let status = 0;
    let reply = '';
    request.setEncoding('utf8');
    request.setTimeout(SEND_TIMEOUT, () => request.close(http2.constants.NGHTTP2_CANCEL));
    request.on('response', (headers) => { status = headers[':status']; });
    request.on('data', (chunk) => { reply += chunk; });
    request.on('error', (err) => {
      console.error('A reminder to Apple failed:', err.message);
      resolve('failed');
    });
    request.on('close', () => {
      if (status === 200) return resolve('sent');
      if (status === 410 || /BadDeviceToken|Unregistered/.test(reply)) return resolve('gone');
      if (status) console.error(`Apple turned down a reminder: ${status} ${reply.slice(0, 100)}`);
      resolve('failed');
    });
    request.end(JSON.stringify({ aps: { alert: { title: message.title, body: message.body }, sound: 'default' }, url: message.url }));
  });

  return { send, close: () => session.close() };
}

// The browsers' push services, as above. web-push is only asked for when there's something to send with it.
function webSender({ publicKey, privateKey }) {
  const webPush = require('web-push');
  const options = {
    TTL: KEEP_HOURS * 3600, urgency: 'normal', topic: 'reminder', timeout: SEND_TIMEOUT,
    vapidDetails: { subject: SITE, publicKey, privateKey },
  };
  const send = (device, { title, body, url }) => webPush
    .sendNotification({ endpoint: device.address, keys: device.keys }, JSON.stringify({ title, body, url }), options)
    .then(() => 'sent', (err) => {
      if (err.statusCode === 404 || err.statusCode === 410) return 'gone';
      console.error(`A web reminder failed: ${err.statusCode || err.message}`);
      return 'failed';
    });
  return { send, close: () => {} };
}


// store: where devices are kept, and who's played what (see data.js). playerIdFor(token): the device's id, as index.js
// works it out. apns: { keyId, teamId, key } - Apple's, or nothing. web: { publicKey, privateKey } - the VAPID pair, or
// nothing. secret: what POST /push/send has to come with. makeSender: for tests, in place of apnsSender and webSender.
function createPush({ store, playerIdFor, apns, web, secret, makeSender = {} }) {
  const makeApns = makeSender.apns || apnsSender;
  const makeWeb = makeSender.web || webSender;

  // What the pages need to know (GET /site-config.json): whether the app can have reminders, and whether browsers can -
  // the public half of the VAPID pair is what a browser needs to ask for an address.
  const config = () => ({ app: !!apns, webKey: web ? web.publicKey : '' });

  function isAddress(kind, address, keys) {
    if (kind === 'apns') return !!apns && isApnsAddress(address);
    return kind === 'web' && !!web && isWebAddress(address) && isWebKeys(keys);
  }

  // A device turning reminders on, changing them, or just saying it's still here: pages say so once a day (see
  // QUIET_AFTER_DAYS). hour: when, on the 24-hour clock, in timeZone. daily and solo: which reminders it wants.
  // Replies { status: 'ok' } or { status } 'bad' or 'unavailable'.
  async function save({ token, kind, address, keys, timeZone: zone, hour, daily, solo } = {}) {
    const hourOk = Number.isInteger(hour) && hour >= FIRST_HOUR && hour <= LAST_HOUR;
    if (!isToken(token) || !isAddress(kind, address, keys) || !hourOk) return { status: 'bad' };
    try {
      await store.savePushDevice(playerIdFor(token), {
        kind, address, keys: kind === 'web' ? { p256dh: keys.p256dh, auth: keys.auth } : {}, timeZone: timeZone(zone), hour, daily: !!daily, solo: !!solo,
      });
    } catch (err) {
      console.error('Saving a device for reminders failed:', err.message);
      return { status: 'unavailable' };
    }
    return { status: 'ok' };
  }

  // A device turning reminders off: what was kept for it goes.
  // Replies { status: 'ok' } or { status } 'bad' or 'unavailable'.
  async function remove({ token } = {}) {
    if (!isToken(token)) return { status: 'bad' };
    try {
      await store.removePushDevice(playerIdFor(token));
    } catch (err) {
      console.error('Removing a device from reminders failed:', err.message);
      return { status: 'unavailable' };
    }
    return { status: 'ok' };
  }

  // Whether a request's Authorization header is the job in Supabase's
  function canSend(header) {
    if (!secret) return false;
    const digest = (text) => crypto.createHash('sha256').update(String(text)).digest();
    return crypto.timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
  }

  // Sends the reminders of the hour. The hour can come and go without a run (Supabase or the site being down), and then
  // that hour's are simply missed: better than them turning up late.
  // Each device is claimed for its day before anything's sent, so two runs at once can't both send to it, and one that
  // fails isn't tried again until tomorrow - a device can be off for reasons that won't change in the next hour.
  // Resolves to { due, sent, gone, failed } - due being the devices it was the hour for.
  async function sendDue(now = Date.now()) {
    const tally = { due: 0, sent: 0, gone: 0, failed: 0 };
    const clocks = new Map(); // time zone -> its clock
    const due = [];
    for (const device of await store.pushDevicesSince(now - QUIET_AFTER_DAYS * DAY_MS)) {
      if (!clocks.has(device.timeZone)) clocks.set(device.timeZone, clockIn(timeZone(device.timeZone)));
      const shown = clocks.get(device.timeZone)(now);
      const day = dateAt(shown);
      const reachable = device.kind === 'apns' ? !!apns : !!web;
      if (reachable && new Date(shown).getUTCHours() === device.hour && device.lastDay !== day) due.push({ device, day });
    }
    tally.due = due.length;
    if (!due.length) return tally;

    const asked = new Map(due.map(({ device, day }) => [`${device.playerId} ${day}`, { id: device.playerId, day }]));
    const players = new Map((await store.pushPlayers([...asked.values()])).map(player => [`${player.id} ${player.day}`, player]));
    const sends = due
      .map(({ device, day }) => ({ device, day, message: reminderFor(device, players.get(`${device.playerId} ${day}`), day, now) }))
      .filter(({ message }) => message);
    if (!sends.length) return tally;
    const claimed = new Set(await store.claimPush(sends.map(({ device, day, message }) => ({ deviceId: device.deviceId, day, solo: message.type === 'solo' }))));

    const chosen = sends.filter(({ device }) => claimed.has(device.deviceId));
    const senders = {};
    function senderFor(kind) {
      if (!senders[kind]) senders[kind] = kind === 'apns' ? makeApns(apns) : makeWeb(web);
      return senders[kind];
    }
    async function deliver({ device, message }) {
      let outcome;
      try {
        outcome = await senderFor(device.kind).send(device, message);
      } catch (err) {
        console.error('Sending a reminder failed:', err.message);
        outcome = 'failed';
      }
      tally[outcome]++;
      if (outcome === 'gone') await store.removePushAddress(device.address).catch(err => console.error('Removing a dead push address failed:', err.message));
    }
    for (let i = 0; i < chosen.length; i += AT_ONCE) await Promise.all(chosen.slice(i, i + AT_ONCE).map(deliver));
    Object.values(senders).forEach(sender => sender.close());
    console.log(`Reminders: ${tally.due} due, ${tally.sent} sent, ${tally.gone} gone, ${tally.failed} failed`);
    return tally;
  }

  return { config, save, remove, canSend, sendDue };
}

module.exports = { createPush, reminderFor, FIRST_HOUR, LAST_HOUR };
