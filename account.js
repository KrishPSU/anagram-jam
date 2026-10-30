// Accounts: a player can sign in with Google or Apple, and then their best, their Daily Jam records and their streak are
// one and the same on every device they sign in on. Without signing in, a player is their browser - the random token it
// keeps (see playerIdFor in index.js) - which can't follow them to another device.
//
// So who a player is comes in two parts (see identify): the DEVICE - the hash of the browser's token, as rooms have
// always known players - and the SUBJECT everything scored or remembered goes under: the account's id when the device is
// signed in to one, else the device id. Signing in on a device MERGES what the device had into the account (link_account
// in supabase/migrations, and the same in data.js): 35 points on the laptop and 38 on the phone become one best of 38,
// under the account's name. Signing out on a device only unlinks it - the device starts afresh, the account keeps
// everything.
//
// Signing in is Supabase Auth's doing, without supabase-js (a few HTTP calls do). The page sends the browser to
// Supabase's authorize page with a PKCE challenge, Supabase sends it back to /account/callback with a code, and the
// callback page hands the code and its verifier to the server (POST /account/link), which trades them for the user with
// Supabase and links the device to it (see link). Supabase's tokens are never kept or logged - all the server wants to
// know is who the user is. Deleting an account removes its game data, then the Supabase user (see remove).
//
// Also here: who's on the site right now, for the admin page (see presence). Each page says every 20 seconds which mode
// it's on and how it's going (see shared/presence.js), and that's kept in the store under the player's subject id.
//
// Accounts are only enabled with a Supabase project (see createData in data.js): in memory there's nobody to sign in with.

const { isRude } = require('./names');
const { cleanName } = require('./solo');

const PROVIDERS = ['google', 'apple']; // the ways in there are buttons for (see shared/account.js)
const MODES = ['home', 'solo', 'daily', 'practice', 'gone']; // where a page can say its player is ('gone': they left it)
const IDENTITY_FOR = 60 * 1000;   // who a device is, once looked up, holds for this long in this instance
const PRESENCE_EVERY = 10 * 1000; // a device's presence is written at most this often, unless it changed modes
const AUTH_TIMEOUT = 8000;        // for a call to Supabase Auth - longer than data.js gives, there's a person waiting on it just once
const DETAIL_TEXT = 20;           // the most characters in a presence detail's text
const DETAIL_COUNT = 1000000;     // and the most any of its counts can be
const CACHE_MAX = 5000;           // devices remembered here before the stale ones are swept out

// Tokens are 32 hex characters (see playerToken in solo/js/solo.js), but anything long enough to hash counts, as in solo.js
const isToken = (token) => typeof token === 'string' && token.length >= 16;
const isUuid = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;


// store: where accounts, links and presence are kept (see data.js). playerIdFor(token): the device id, as index.js
// works it out. supabase: { url, key } for the Supabase project, or nothing - then nobody can sign in. posthog: { key,
// host } for the pages' analytics (see shared/analytics.js) - no key, no analytics. providers: the ways to sign in to
// offer (from AUTH_PROVIDERS), out of PROVIDERS.
// note(entry): a line for the admin page's sign-ins & changes log, for the one thing here the owner has to finish by
// hand (see remove).
function createAccounts({ store, playerIdFor, supabase, posthog, providers = PROVIDERS, note = () => {} }) {
  const enabled = !!supabase;
  const supabaseUrl = enabled ? supabase.url.replace(/\/+$/, '') : null;
  const offered = providers.map(provider => String(provider).trim().toLowerCase()).filter(provider => PROVIDERS.includes(provider));

  // What the pages need to know (GET /site-config.json): whether they can offer signing in, and with what, and where
  // their analytics go. Nothing secret - the pages send browsers to the Supabase address, and a PostHog key is public.
  function config() {
    return {
      accounts: { enabled, providers: offered, supabaseUrl },
      posthog: posthog && typeof posthog.key === 'string' && posthog.key ? { key: posthog.key, host: posthog.host } : null,
    };
  }


  // ---------- Who a device is ----------

  // Who each device is, as looked up lately: device id -> { at, identity (a promise of it), accountId (once known) }.
  // Looked up again after IDENTITY_FOR, or sooner when something done here changes it (see forget). Every instance has
  // its own, so a change made on another instance can take IDENTITY_FOR to show here - which is why `get`, the first
  // thing every page asks, always looks afresh. A lookup that fails isn't kept: the player counts as signed out this
  // once, and the next ask tries again.
  const identities = new Map();

  function lookUp(playerId, fresh = false) {
    const cached = identities.get(playerId);
    if (cached && !fresh && Date.now() - cached.at < IDENTITY_FOR) return cached.identity;
    if (identities.size >= CACHE_MAX) sweep(identities, IDENTITY_FOR);
    const entry = { at: Date.now(), identity: null, accountId: null };
    // Through a promise even if the store throws outright (its account functions aren't there yet, say)
    entry.identity = Promise.resolve().then(() => store.accountFor(playerId)).then((account) => {
      entry.accountId = account ? account.id : null;
      return { playerId, id: account ? account.id : playerId, account: account || null };
    }, (err) => {
      console.error("Looking up a device's account failed:", err.message);
      if (identities.get(playerId) === entry) identities.delete(playerId);
      return { playerId, id: playerId, account: null };
    });
    identities.set(playerId, entry);
    return entry.identity;
  }

  // Entries older than `age` go, so the map can't grow with every token anyone ever sends
  function sweep(map, age) {
    const now = Date.now();
    map.forEach((entry, key) => {
      if (now - entry.at >= age) map.delete(key);
    });
  }

  // Who the browser holding `token` is: { playerId: the device id, id: the subject id everything of theirs goes under,
  // account: { id, provider, name, devices } if the device is signed in, else null }. The token has been checked by the
  // caller (isToken). fresh: look the device up again rather than trust what this instance knew a minute ago - for
  // the moments that write a row under the id (a solo run ending, a Daily Jam word being opened), since another instance
  // may just have signed the device out, or deleted the account, and a row written under a gone account is nobody's.
  const identify = (token, fresh = false) => lookUp(playerIdFor(token), fresh);

  // This device is looked up afresh next time: it was linked, unlinked, or its account changed
  const forget = (playerId) => identities.delete(playerId);

  // And so is every device signed in to the account, on this instance - its name or device count changed, or it's gone
  function forgetAccount(accountId) {
    identities.forEach((entry, playerId) => {
      if (entry.accountId === accountId) identities.delete(playerId);
    });
  }

  // The name a player goes by: their account's, if they're signed in and it has one, else the one they typed - cleaned
  // up as in solo.js, which may leave nothing
  function displayName(identity, typedName) {
    return identity && identity.account && identity.account.name ? identity.account.name : cleanName(typedName);
  }


  // ---------- Supabase Auth ----------

  // One call to Supabase Auth. Resolves to the reply's JSON. Rejects with `status` set if Supabase answered with an
  // error (its message in the error's - an error reply holds no tokens), or without one if it couldn't be reached.
  async function auth(method, route, { body, asAdmin = false } = {}) {
    const headers = { apikey: supabase.key, 'Content-Type': 'application/json' };
    if (asAdmin) headers.Authorization = `Bearer ${supabase.key}`;
    const res = await fetch(`${supabaseUrl}/auth/v1/${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(AUTH_TIMEOUT),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) {
      const message = (json && (json.error_description || json.msg || json.message || json.error)) || text.slice(0, 200) || res.statusText;
      throw Object.assign(new Error(`${method} ${route.split('?')[0]}: ${res.status} ${message}`), { status: res.status });
    }
    return json;
  }


  // ---------- Signing in and out ----------

  // Signs the device whose browser holds `token` in: `code` is what Supabase sent the callback page back with, and
  // `verifier` the PKCE secret the page made up before it left (see shared/account.js). The code is traded for the
  // user here, so the page never holds anything more than the code - no good to anyone without the verifier, and used
  // up at once. The device's own history goes into the account (see the top of the file).
  // Replies { status: 'ok', account } or { status } 'off' (there's nobody to sign in with - no Supabase), 'bad',
  // 'denied' (Supabase wouldn't take the code: used already, run out, or not one of its own) or 'unavailable'.
  async function link({ token, code, verifier } = {}) {
    if (!enabled) return { status: 'off' };
    // A code is Supabase's own (a uuid, as it happens) and a PKCE verifier is 43 to 128 of these characters (RFC 7636):
    // anything that can't be either isn't sent on, since every player's calls to Supabase Auth share this server's
    // rate limit there
    const isCode = (value) => typeof value === 'string' && /^[A-Za-z0-9._~-]{16,128}$/.test(value);
    const isVerifier = (value) => typeof value === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
    if (!isToken(token) || !isCode(code) || !isVerifier(verifier)) return { status: 'bad' };
    let user;
    try {
      ({ user } = await auth('POST', 'token?grant_type=pkce', { body: { auth_code: code, code_verifier: verifier } }));
    } catch (err) {
      console.error('Signing in failed:', err.message);
      return { status: err.status && err.status < 500 ? 'denied' : 'unavailable' };
    }
    const provider = user && user.app_metadata && typeof user.app_metadata.provider === 'string' ? user.app_metadata.provider.trim().toLowerCase().slice(0, 20) : '';
    if (!user || !isUuid(user.id) || !provider) {
      console.error("Signing in failed: Supabase's reply had no user in it");
      return { status: 'unavailable' };
    }
    // Google gives a full name; Apple does too unless they hid it, and only the first time - then the account keeps the
    // name it has (see link_account)
    const metadata = user.user_metadata || {};
    const name = cleanName(typeof metadata.full_name === 'string' && metadata.full_name ? metadata.full_name : metadata.name);
    const playerId = playerIdFor(token);
    let account;
    try {
      account = await store.linkAccount(playerId, { id: user.id, provider, name });
    } catch (err) {
      console.error('Linking an account failed:', err.message);
      return { status: 'unavailable' };
    }
    forget(playerId);
    forgetAccount(user.id);
    if (!account) {
      console.error('Linking an account failed: the store gave nothing back');
      return { status: 'unavailable' };
    }
    console.log(`Account linked: ${provider}${account.name ? ` "${account.name}"` : ''} (${plural(account.devices, 'device')})`);
    return { status: 'ok', account };
  }

  // Whether the device whose browser holds `token` is signed in, and as whom. Looked up afresh (see identities) - this
  // is what every page asks first, maybe right after the callback page signed in on another instance.
  // Replies { status: 'ok', account: the account, or null } or { status: 'bad' }.
  async function get({ token } = {}) {
    if (!isToken(token)) return { status: 'bad' };
    const identity = await lookUp(playerIdFor(token), true);
    return { status: 'ok', account: identity.account };
  }

  // Gives the account the device is signed in to a new name - on the leaderboards too, wherever its player shows.
  // Replies { status: 'ok', account } or { status } 'bad' (not signed in, or nothing left of the name once cleaned up),
  // 'rude' (see names.js - it would only ever show as "Player") or 'unavailable'.
  async function rename({ token, name } = {}) {
    if (!isToken(token)) return { status: 'bad' };
    name = cleanName(name);
    const identity = await identify(token);
    if (!identity.account || !name) return { status: 'bad' };
    if (isRude(name)) return { status: 'rude' };
    try {
      await store.renameAccount(identity.account.id, name);
    } catch (err) {
      console.error('Renaming an account failed:', err.message);
      return { status: 'unavailable' };
    }
    forgetAccount(identity.account.id);
    forget(identity.playerId);
    return { status: 'ok', account: { ...identity.account, name } };
  }

  // Signs the device out: the link goes, the account keeps everything, and the device starts afresh - its old best and
  // streak went into the account when it signed in. Replies { status: 'ok' } (signed in or not) or { status } 'bad' or
  // 'unavailable'.
  async function unlink({ token } = {}) {
    if (!isToken(token)) return { status: 'bad' };
    const identity = await identify(token);
    let unlinked;
    try {
      unlinked = await store.unlinkAccount(identity.playerId);
    } catch (err) {
      console.error('Unlinking an account failed:', err.message);
      return { status: 'unavailable' };
    }
    forget(identity.playerId);
    if (identity.account) forgetAccount(identity.account.id);
    if (unlinked) console.log(`Account unlinked from a device${identity.account ? `: ${identity.account.provider}` : ''}`);
    return { status: 'ok' };
  }

  // Deletes the account the device is signed in to: its scores, Daily Jam records and streak, every device's link, and
  // then the Supabase user, so signing in again starts from nothing. The user staying behind in Supabase (it failed to
  // go) is logged, no more: what they asked to have gone is gone.
  // Replies { status: 'ok' } or { status } 'bad' (not signed in) or 'unavailable'.
  async function remove({ token } = {}) {
    if (!isToken(token)) return { status: 'bad' };
    const identity = await lookUp(playerIdFor(token), true);
    if (!identity.account) return { status: 'bad' };
    const { id, provider, devices } = identity.account;
    try {
      await store.deleteAccount(id);
    } catch (err) {
      console.error('Deleting an account failed:', err.message);
      return { status: 'unavailable' };
    }
    forgetAccount(id);
    forget(identity.playerId);
    if (enabled) {
      try {
        await auth('DELETE', `admin/users/${encodeURIComponent(id)}`, { asAdmin: true });
      } catch (err) {
        console.error("Deleting an account's Supabase user failed:", err.message);
        // The privacy policy says the sign-in record goes too, so the owner finishes it by hand: a line in the admin
        // page's sign-ins & changes log says which user
        note({ type: 'action', what: `Account ${id} (${provider}) was deleted here, but its sign-in record at Supabase Auth wasn't (${String(err.message).slice(0, 80)}) - delete that user in Supabase's dashboard, under Authentication`, device: 'The server' });
      }
    }
    console.log(`Account deleted: ${provider} (${plural(devices, 'device')})`);
    return { status: 'ok' };
  }


  // ---------- Who's on the site ----------

  // When each device's presence last went to the store, and as what: device id -> { at, mode }
  const presences = new Map();

  // What a page says about how its player is doing, kept to what the admin page shows (see admin/app/live.js): state
  // (which screen), level (solo's word number, or which of Daily Jam's words), points, solved and words (counts).
  // Anything else is dropped - it would only be kept and shown to the admin, and there's no call to keep what nobody
  // asked for.
  function detailOf(detail) {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return {};
    const isCount = (n) => Number.isInteger(n) && n >= 0 && n <= DETAIL_COUNT;
    const isText = (s) => typeof s === 'string' && s.length <= DETAIL_TEXT;
    const kept = {};
    if (isText(detail.state)) kept.state = detail.state;
    if (isCount(detail.level) || isText(detail.level)) kept.level = detail.level;
    for (const key of ['points', 'solved', 'words']) {
      if (isCount(detail[key])) kept[key] = detail[key];
    }
    return kept;
  }

  // A page saying where its player is: `mode` is which page ('home', 'solo', 'daily' or 'practice' - 'gone' as they
  // leave it), `detail` how it's going there (see presenceDetail in each page's script), `name` the one they typed.
  // Kept in the store under their subject id for the admin page (see livePlayers in data.js) - at most once every
  // PRESENCE_EVERY per device unless they changed modes or left, since a page sends one every 20 seconds and another
  // whenever it comes back into view, and two tabs send twice as many. A write that doesn't go through is only logged.
  // Replies { status: 'ok' } or { status: 'bad' }.
  async function presence({ token, name, mode, detail } = {}) {
    if (!isToken(token) || !MODES.includes(mode)) return { status: 'bad' };
    const identity = await identify(token);
    const last = presences.get(identity.playerId);
    if (mode !== 'gone' && last && last.mode === mode && Date.now() - last.at < PRESENCE_EVERY) return { status: 'ok' };
    if (presences.size >= CACHE_MAX) sweep(presences, PRESENCE_EVERY);
    presences.set(identity.playerId, { at: Date.now(), mode });
    try {
      // An account's name is the store's business (set when the device is linked, and by renames): sending it from
      // here would put back an old one this instance still had cached. A device's nickname is only known from here.
      await store.touchPlayer(identity.id, identity.account ? '' : displayName(identity, name), mode, detailOf(detail), Date.now());
    } catch (err) {
      console.error("Keeping a player's presence failed:", err.message);
    }
    return { status: 'ok' };
  }

  return { enabled, config, identify, displayName, link, get, rename, unlink, remove, presence };
}

module.exports = { createAccounts };
