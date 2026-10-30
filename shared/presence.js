// Who's on the site right now, for the admin page's "People on the site" (see /overview in admin.js at the project
// root): a heartbeat to the server saying which page this is (data-presence on <body>: home, solo, daily or practice)
// and what's going on there, from the page's own window.presenceDetail() when it has one (solo/js/solo.js, say, says
// which screen you're on and the run so far). Every 20 seconds while the page is on screen - a tab in the background
// says nothing, and drops off the admin page after a minute - and 'gone' as the page is left, by sendBeacon, which
// still gets out while the page is being torn down. The server throttles and keeps it (see presence in account.js at
// the project root). Nothing here waits on a reply, and a beat that doesn't get through is simply the next one's job.
// Rooms aren't in this: the admin page lists them from the room store.

(() => {
  const EVERY = 20000;

  const mode = document.body.dataset.presence;
  if (!mode) return; // a page that isn't listed

  let timer = null;

  // The page's own word on what's happening, if it has one and it works (a page's globals may not be set yet)
  function detail() {
    try {
      const what = typeof window.presenceDetail === 'function' ? window.presenceDetail() : {};
      return what && typeof what === 'object' ? what : {};
    } catch {
      return {};
    }
  }

  function message(what) {
    return JSON.stringify({
      token: ensurePlayerToken(),
      name: localStorage.getItem('name') || '',
      mode: what,
      detail: what === 'gone' ? {} : detail(),
    });
  }

  function beat() {
    if (document.hidden) return;
    fetch('/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: message(mode), keepalive: true }).catch(() => {});
  }

  // Leaving: a beacon is made for this moment (fetch with keepalive is the fallback, for browsers without one)
  function gone() {
    const data = message('gone');
    try {
      if (navigator.sendBeacon && navigator.sendBeacon('/presence', new Blob([data], { type: 'application/json' }))) return;
    } catch {
      // fall through to fetch
    }
    fetch('/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: data, keepalive: true }).catch(() => {});
  }

  function start() {
    stop();
    beat();
    timer = setInterval(beat, EVERY);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else start();
  });

  window.addEventListener('pagehide', gone);
  // Back from the back-forward cache (the page was left and then returned to with Back): here again
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) start();
  });

  if (!document.hidden) start();
})();
