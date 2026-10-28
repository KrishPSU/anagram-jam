// The admin dashboard's shared parts: asking the API, the tabs, the session in the corner, and helpers for building the
// page. Each tab is a file of its own (live.js, leaderboard.js, ...) that registers itself with registerTab.
//
// Everything players typed (names, mostly) goes onto the page as text, never as HTML - el() only ever makes text
// nodes from strings - and the page's Content-Security-Policy (see admin.js) wouldn't run a script in one anyway.


// ---------- The API ----------

// GET /admin/api/<path>, or a POST with `body`. Resolves to the reply; rejects with a message to show. Signed out (the
// session ran out, or was signed out from elsewhere) loads the sign-in page.
async function api(path, body) {
  const options = { headers: { 'X-Admin': '1' }, credentials: 'same-origin', cache: 'no-store' };
  if (body !== undefined) {
    options.method = 'POST';
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch('/admin/api/' + path, options);
  } catch {
    throw new Error("Couldn't reach the server.");
  }
  if (res.status === 401) {
    signedOut();
    throw new Error('Signed out.');
  }
  if (!res.ok) throw new Error(`The server couldn't do that (${res.status}).`);
  return res.json();
}

function signedOut() {
  window.location.replace('/admin');
}


// ---------- Building the page ----------

// el('div.room-card.is-playing', { title: '…', onclick }, child, 'text', ...): an element with its classes, attributes
// and children. Strings become text. Attributes that are null, undefined or false are left off.
function el(spec, attrs, ...children) {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  if (attrs === null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    children.unshift(attrs);
    attrs = {};
  }
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

// A room code (or any word) as little letter tiles
function miniTiles(text) {
  return el('span.mini-tiles', { 'aria-label': text }, [...text].map(letter => el('span.tile', { 'aria-hidden': 'true' }, letter)));
}

// A line saying the tab is loading, or what went wrong - hidden when there's nothing to say
function setState(stateEl, message, { loading = false, error = false } = {}) {
  stateEl.hidden = !message;
  stateEl.classList.toggle('is-error', error);
  stateEl.replaceChildren(...(loading ? [el('span.spinner', { 'aria-hidden': 'true' })] : []), message || '');
}

// A button that has to be pressed twice, for anything that can't be undone: the first press turns it into "Sure?"
// for a few seconds. key: what it does, so a list drawn again while it's waiting (Live, every few seconds) keeps it.
const armed = new Map(); // key -> until when
function confirmButton({ key, label, armedLabel = 'Sure?', className = 'btn btn-glass btn-xs', onConfirm }) {
  const button = el('button', { type: 'button', class: className }, label);
  const show = () => {
    const on = armed.get(key) > Date.now();
    button.textContent = on ? armedLabel : label;
    button.classList.toggle('armed', on);
  };
  button.addEventListener('click', async () => {
    if (armed.get(key) > Date.now()) {
      armed.delete(key);
      show();
      button.disabled = true;
      try {
        await onConfirm();
      } finally {
        button.disabled = false;
      }
      return;
    }
    armed.set(key, Date.now() + 4000);
    show();
    setTimeout(show, 4000);
  });
  show();
  return button;
}

// Saves text as a file, for the exports
function download(filename, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = el('a', { href: url, download: filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}


// ---------- Words for numbers and times ----------

const plural = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// "just now", "40s ago", "5 min ago", "3 h ago", "2 days ago"
function ago(at, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return plural(Math.floor(seconds / 86400), 'day') + ' ago';
}

// "0:42", "12:05", "1 h 20 min"
function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// "Oct 27, 9:41 PM"
function when(at) {
  return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// "Today", "Yesterday", "Sat, Oct 25"
function dayName(at) {
  const day = new Date(at).toDateString();
  if (day === new Date().toDateString()) return 'Today';
  if (day === new Date(Date.now() - 86400000).toDateString()) return 'Yesterday';
  return new Date(at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}


// ---------- Tabs ----------

const tabs = {};     // name -> { open(), close() }
let openTabName = null;

function registerTab(name, handlers) {
  tabs[name] = handlers;
}

function openTab(name) {
  if (!tabs[name]) name = 'live';
  if (openTabName === name) return;
  if (openTabName && tabs[openTabName].close) tabs[openTabName].close();
  openTabName = name;
  document.querySelectorAll('[role="tab"]').forEach((tab) => {
    const on = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('[role="tabpanel"]').forEach((panel) => {
    panel.hidden = panel.id !== 'panel-' + name;
  });
  if (window.location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  tabs[name].open();
}

document.querySelectorAll('[role="tab"]').forEach((tab, i, all) => {
  tab.addEventListener('click', () => openTab(tab.dataset.tab));
  // Arrow keys move along the tabs
  tab.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    const next = all[(i + step + all.length) % all.length];
    next.focus();
    openTab(next.dataset.tab);
  });
});

// Buttons elsewhere that go to a tab ("Change" on Live goes to Controls)
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-goto]');
  if (link) openTab(link.dataset.goto);
});

window.addEventListener('hashchange', () => openTab(window.location.hash.slice(1)));

// Every tab's script has run by now (they're all deferred, after this one)
document.addEventListener('DOMContentLoaded', () => openTab(window.location.hash.slice(1)));


// ---------- Someone at the page ----------

// The Live tab stops asking for updates once nobody has touched the page for a while (see live.js)
let lastActive = Date.now();
const whenActive = new Set(); // called when someone comes back after being idle
function isIdle(after) {
  return Date.now() - lastActive > after;
}
['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'].forEach((type) => {
  window.addEventListener(type, () => {
    const wasIdle = isIdle(60 * 1000);
    lastActive = Date.now();
    if (wasIdle) whenActive.forEach(callback => callback());
  }, { passive: true });
});


// ---------- The session ----------

const sessionLeftEl = document.getElementById('sessionLeft');
let sessionEnds = null;

// From the API's replies: when this session runs out
function setSession(ends) {
  sessionEnds = ends;
  showSession();
}

function showSession() {
  if (!sessionEnds) return;
  const left = sessionEnds - Date.now();
  if (left <= 0) {
    signedOut();
    return;
  }
  const hours = Math.floor(left / 3600000);
  sessionLeftEl.textContent = hours >= 1 ? `Signed in · ${hours} h left` : `Signed in · ${Math.max(1, Math.ceil(left / 60000))} min left`;
  sessionLeftEl.title = `This session ends ${when(sessionEnds)}`;
}
setInterval(showSession, 30000);

document.getElementById('signOutBtn').addEventListener('click', async () => {
  try {
    await fetch('/admin/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
  } finally {
    signedOut();
  }
});
