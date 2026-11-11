// Moving between screens the way an app does. A page you open slides in from the right; going back home, the page you're
// on slides away to the right. Screens inside a page (a Daily Jam word and today's list, a solo run and its results, a
// room's results going back up off the lobby) move the same way, with slideScreen. (A room's results come down on their
// curtain - results.js.)
//
// It's all plain animation of transform and opacity (the Web Animations API), which the phone runs by itself, off the
// page's main thread, so it stays smooth while the page is busy - a page arriving is setting itself up. The browser's
// View Transitions did this at first, but iOS draws those on the main thread: about 20 frames a second in the iPhone
// app, and none at all while the page was busy, so the start of each slide was lost.
//
// Opening a page also doesn't wait on the network: goTo asks for the page at its version (/site-config.json's pages,
// see assets.js at the project root), which was fetched ahead of time (getReady), and so is kept by the browser.
//
// Loaded in each page's <head>, not deferred: a page that's arriving has to be off to the side from its very first frame.

const EASE_OUT = 'cubic-bezier(0.33, 1, 0.68, 1)'; // fast, then settling
const EASE_IN = 'cubic-bezier(0.4, 0, 1, 1)';      // gathering speed on the way out

// [keyframes, timing] of each move
const MOVES = {
  // In from the right edge...
  in: [[{ transform: 'translateX(100%)' }, { transform: 'none' }], { duration: 420, easing: EASE_OUT }],
  // ...while what was there drifts off to the left, fading
  under: [[{ transform: 'none', opacity: 1 }, { transform: 'translateX(-18%)', opacity: 0 }], { duration: 180, easing: EASE_IN }],
  // Going back: away to the right...
  away: [[{ transform: 'none' }, { transform: 'translateX(100%)' }], { duration: 260, easing: EASE_IN }],
  // ...and what it goes back to coming in from the left
  back: [[{ transform: 'translateX(-18%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 320, easing: EASE_OUT }],
  // A room's results going back up off the lobby (results.js drops them down), and the lobby coming up
  lift: [[{ transform: 'none' }, { transform: 'translateY(-100%)' }], { duration: 420, easing: 'cubic-bezier(0.5, 0, 0.75, 0)' }],
  rise: [[{ transform: 'translateY(16px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: EASE_OUT }],
};

const ARRIVING = 'slideIn';       // sessionStorage: { how, at }, left by goTo for the page it's going to
const GOT_READY = 'pagesReady';   // sessionStorage: the versioned pages already fetched ahead of time this session

const stillMotion = matchMedia('(prefers-reduced-motion: reduce)');

// Whether things will really move
function canSlide() {
  return !document.hidden && !stillMotion.matches && typeof Element.prototype.animate === 'function';
}

function animateAll(elements, move, fill = 'none') {
  const [keyframes, timing] = MOVES[move];
  return elements.map(el => el.animate(keyframes, { ...timing, fill }));
}

const allDone = (animations) => Promise.all(animations.map(a => a.finished));


// ---------- Once the page has arrived ----------

// For what can wait until the page has slid in (the music, analytics): run after the slide, or straight away if there
// wasn't one
let settled = false;
const onSettled = [];

function whenSettled(callback) {
  if (settled) setTimeout(callback, 0);
  else onSettled.push(callback);
}

function settle() {
  if (settled) return;
  settled = true;
  onSettled.splice(0).forEach(callback => setTimeout(callback, 0));
}


// ---------- Arriving ----------

(() => {
  const root = document.documentElement;
  let how = null;
  try {
    const note = JSON.parse(sessionStorage.getItem(ARRIVING));
    sessionStorage.removeItem(ARRIVING);
    if (note && Date.now() - note.at < 8000 && (note.how === 'forward' || note.how === 'back')) how = note.how;
  } catch {}

  // A page asked for at its version (goTo) shows its plain address
  const query = new URLSearchParams(location.search);
  if (query.has('v')) {
    query.delete('v');
    const rest = query.toString();
    history.replaceState(history.state, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  }

  if (!how || !canSlide()) {
    settle();
    return;
  }
  // Off to the side (theme.css) until the slide in starts, on the page's first frame
  root.dataset.arrive = how;
  const start = () => {
    if (!document.body) {
      requestAnimationFrame(start);
      return;
    }
    const [move] = animateAll([document.body], how === 'back' ? 'back' : 'in', 'backwards');
    delete root.dataset.arrive;
    move.finished.catch(() => {}).then(settle);
  };
  requestAnimationFrame(start);
  // However the page gets on, it's never left hidden
  setTimeout(() => {
    if (!root.dataset.arrive) return;
    delete root.dataset.arrive;
    settle();
  }, 3000);
})();


// ---------- Leaving for another page ----------

let leaving = null; // the page's moves on its way out

// Everything on screen: the page's own elements, not the dialogs (closed by now, or above it all) or what's never shown
function pageParts() {
  return [...document.body.children].filter(el => !/^(SCRIPT|STYLE|LINK|TEMPLATE|NOSCRIPT|DIALOG)$/.test(el.tagName) && el.getClientRects().length);
}

// how: 'forward' (the new page slides in from the right) or 'back' (this one slides away to the right first). The page
// goes as the screen fades to the plain dark under every page (.page-cover in theme.css) - the iPhone app shows that for
// a moment between two pages, so this way it's never a flicker. A page that was got ready ahead of time is there at
// once, so it's asked for once the screen is dark; any other is asked for straight away, while it fades.
function goTo(url, how = 'forward') {
  if (leaving) return;
  const address = versioned(url);
  if (!canSlide()) {
    window.location.href = address;
    return;
  }
  try {
    sessionStorage.setItem(ARRIVING, JSON.stringify({ how, at: Date.now() }));
  } catch {}
  const parts = pageParts();
  const cover = document.createElement('div');
  cover.className = 'page-cover';
  document.body.append(cover);
  const out = how === 'back' ? 'away' : 'under';
  const moves = [...animateAll(parts, out, 'forwards'), cover.animate([{ opacity: 0 }, { opacity: 1 }], { ...MOVES[out][1], fill: 'forwards' })];
  leaving = { moves, cover };
  const go = () => { window.location.href = address; };
  if (isReady(address)) allDone(moves).then(go, () => {});
  else go();
  // The next page never came (no connection, say): this one comes back
  const left = leaving;
  setTimeout(() => {
    if (leaving === left) comeBack();
  }, 8000);
}

function comeBack() {
  if (!leaving) return;
  leaving.moves.forEach(move => move.cancel());
  leaving.cover.remove();
  leaving = null;
  try {
    sessionStorage.removeItem(ARRIVING);
  } catch {}
}

// Back to a page that was left (the browser's Back, which can bring the page back just as it was left)
window.addEventListener('pageshow', (e) => {
  if (e.persisted) comeBack();
});


// ---------- Between screens of a page ----------

let screenSlide = null; // the move between screens going on now

// The screens of the page that are showing (each has data-screen)
const showingScreens = () => [...document.querySelectorAll('[data-screen]')].filter(el => el.getClientRects().length);

// update switches the page over to the new screen. The screen showing moves off first, so update runs a moment later
// rather than straight away, and anything that has to happen on the new screen goes in it. how: 'forward' (the new
// screen slides in from the right), 'back' (the one showing slides away to the right), or 'lift' (a room's results go
// up). Resolves once it's all over. Another one starting in the meantime finishes this one at once.
function slideScreen(update, how = 'forward') {
  if (screenSlide) screenSlide.finish();
  if (!canSlide()) {
    update();
    return Promise.resolve();
  }
  const [outMove, inMove] = { forward: ['under', 'in'], back: ['away', 'back'], lift: ['lift', 'rise'] }[how];
  let updated = false;
  let incoming = [];
  const switchOver = () => {
    if (updated) return;
    updated = true;
    update();
    outgoing.forEach(move => move.cancel());
  };
  const outgoing = animateAll(showingScreens(), outMove, 'forwards');
  const slide = {
    finish() {
      switchOver();
      incoming.forEach(move => move.finish());
    },
  };
  screenSlide = slide;
  return allDone(outgoing)
    .then(() => {
      if (screenSlide !== slide) return;
      switchOver();
      incoming = animateAll(showingScreens(), inMove);
      return allDone(incoming);
    })
    .catch(() => {})
    .finally(() => {
      if (screenSlide === slide) screenSlide = null;
    });
}


// ---------- The next pages, got ready ahead of time ----------

let pageVersions = {}; // address -> version, from /site-config.json

function versioned(url) {
  const version = pageVersions[url];
  return version ? `${url}?v=${version}` : url;
}

function gotReady() {
  try {
    return JSON.parse(sessionStorage.getItem(GOT_READY)) || [];
  } catch {
    return [];
  }
}

const isReady = (address) => gotReady().includes(address);

// Once the page has settled: the pages it can go to (home goes to the modes, everything else back home) at their
// versions, and the scripts and styles they load - each once a session, and then the browser keeps them
async function getReady() {
  if (navigator.connection && navigator.connection.saveData) return;
  const ready = gotReady();
  const next = location.pathname === '/' ? ['/solo/', '/daily/', '/practice/'] : ['/'];
  for (const page of next) {
    const url = versioned(page);
    if (url === page || ready.includes(url)) continue;
    let html;
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) continue;
      html = await res.text();
    } catch {
      continue;
    }
    const files = new Set([...html.matchAll(/\s(?:src|href)="([^"]+\?v=[0-9a-f]+)"/g)].map(m => new URL(m[1], location.origin + page).href));
    await Promise.all([...files].map(file => fetch(file, { credentials: 'same-origin' }).then(res => res.arrayBuffer()).catch(() => {})));
    ready.push(url);
    try {
      sessionStorage.setItem(GOT_READY, JSON.stringify(ready));
    } catch {}
  }
}

// config.js is deferred, so it's there once the page has been read
document.addEventListener('DOMContentLoaded', () => {
  if (!window.siteConfig) return;
  window.siteConfig().then((config) => {
    pageVersions = config.pages || {};
    whenSettled(() => setTimeout(getReady, 1000));
  });
});
