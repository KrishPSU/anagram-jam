// What the server has set up for the pages, from /site-config.json (see accounts.config in account.js at the project
// root): whether signing in is on and with which providers (and Supabase's address, where its sign-in page is),
// PostHog's key, if there is one, the oldest build of the iPhone app that can still play, which reminders can be had
// (see push.js), and the version of each page the game moves between (see /shared/slide.js). Asked for once per page -
// every script that wants it gets the same promise - and a server that can't say (an older one, or a blink in the
// connection) reads as nothing set up, so the pages simply go on without accounts or analytics, and let any app in.
//
// Also the random token this browser keeps (ensurePlayerToken), for the scripts that run on pages without their own
// playerToken() - /shared/presence.js, /shared/account.js and /account/callback.js.

(() => {
  const NOTHING = { accounts: { enabled: false, providers: [], supabaseUrl: '' }, posthog: null, app: { minBuild: 1 }, push: { app: false, webKey: '' }, pages: {} };

  let config = null; // the promise, once asked for

  // Whatever the server sends, the pages get every field, so none of them has to check
  function tidy(raw) {
    const accounts = raw && typeof raw.accounts === 'object' && raw.accounts ? raw.accounts : {};
    const posthog = raw && typeof raw.posthog === 'object' && raw.posthog ? raw.posthog : null;
    const app = raw && typeof raw.app === 'object' && raw.app ? raw.app : {};
    const push = raw && typeof raw.push === 'object' && raw.push ? raw.push : {};
    const pages = raw && typeof raw.pages === 'object' && raw.pages ? raw.pages : {};
    return {
      accounts: {
        enabled: !!accounts.enabled,
        providers: Array.isArray(accounts.providers) ? accounts.providers.filter(p => typeof p === 'string') : [],
        supabaseUrl: typeof accounts.supabaseUrl === 'string' ? accounts.supabaseUrl : '',
      },
      posthog: posthog && typeof posthog.key === 'string' && posthog.key
        ? { key: posthog.key, host: typeof posthog.host === 'string' && posthog.host ? posthog.host : 'https://us.i.posthog.com' }
        : null,
      app: { minBuild: Number.isInteger(app.minBuild) && app.minBuild > 0 ? app.minBuild : 1 },
      push: { app: !!push.app, webKey: typeof push.webKey === 'string' ? push.webKey : '' },
      pages: Object.fromEntries(Object.entries(pages).filter(([address, version]) => address.startsWith('/') && /^[0-9a-f]+$/.test(version))),
    };
  }

  window.siteConfig = () => {
    if (!config) {
      config = fetch('/site-config.json')
        .then(res => (res.ok ? res.json() : NOTHING))
        .catch(() => NOTHING)
        .then(tidy);
    }
    return config;
  };

  // Same as playerToken in solo/js/solo.js: the random token this browser keeps. The server only ever sees a hash of
  // it, and that hash is who you are in rooms, on the leaderboards and in Daily Jam - and which device an account is
  // tied to.
  window.ensurePlayerToken = () => {
    let token = localStorage.getItem('playerToken');
    if (!token) {
      token = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('playerToken', token);
    }
    return token;
  };
})();
