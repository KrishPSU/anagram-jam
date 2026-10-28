// The Activity tab: the server's two logs (see admin.js), newest first. Games: every round that finished and every solo
// run. Sign-ins & changes: every sign-in, wrong password and lockout, and everything done on this dashboard, with where
// it came from - something done from an address you don't know is the thing to look out for.

const feedEl = document.getElementById('feed');
const activityStateEl = document.getElementById('activityState');
let activityLog = 'game';

async function loadActivity() {
  setState(activityStateEl, 'Loading…', { loading: true });
  try {
    const { entries } = await api(`activity?log=${activityLog}`);
    setState(activityStateEl, entries.length ? '' : activityLog === 'game'
      ? 'No games logged yet. Rounds and solo runs show up here as they finish.'
      : 'Nothing logged yet.');
    renderFeed(entries);
  } catch (err) {
    setState(activityStateEl, err.message, { error: true });
  }
}

function renderFeed(entries) {
  const items = [];
  let lastDay = null;
  for (const entry of entries) {
    const day = dayName(entry.at);
    if (day !== lastDay) {
      items.push(el('li.feed-day', day));
      lastDay = day;
    }
    items.push(feedItem(entry));
  }
  feedEl.replaceChildren(...items);
}

// Where a sign-in or a change came from: "Chrome on macOS · Philadelphia, PA, US · 203.0.113.9"
const fromWhere = (entry) => [entry.device, entry.place, entry.ip].filter(Boolean).join(' · ');

// Each kind of entry as [icon, what happened, details, whether it's one to look at]
const DESCRIBE = {
  round: (e) => {
    const standings = (e.players || []).map(p => `${p.name} ${p.points}${p.left ? ' (left)' : ''}`).join(' · ');
    return ['🏁', `${e.winner} won a round in ${e.room}${e.tied ? ' on a tie-break' : ''}`, standings];
  },
  solo: (e) => ['⏱', `${e.name} scored ${plural(e.points, 'point')} in solo`, plural(e.words, 'word')],
  'signed-in': (e) => ['🔓', e.trusted ? 'Signed in' : 'Signed in on a new device', fromWhere(e)],
  'wrong-password': (e) => ['⚠️', 'Wrong password', fromWhere(e), true],
  locked: (e) => (e.scope === 'everyone'
    ? ['🔒', `Too many wrong passwords overall: new devices can't sign in for ${e.minutes} min`, `Known devices still can. Last try: ${fromWhere(e)}`, true]
    : ['🔒', `Too many wrong passwords from one address: it can't try again for ${e.minutes} min`, fromWhere(e), true]),
  'signed-out': (e) => ['🚪', 'Signed out', fromWhere(e)],
  action: (e) => ['🛠', e.what, fromWhere(e)],
};

function feedItem(entry) {
  const describe = DESCRIBE[entry.type] || ((e) => ['•', e.type, '']);
  const [icon, text, detail, bad] = describe(entry);
  return el(`li.feed-item${bad ? '.bad' : ''}`,
    el('span.feed-icon', { 'aria-hidden': 'true' }, icon),
    el('div.feed-body',
      el('p.feed-text', text),
      detail ? el('p.feed-detail', detail) : null,
    ),
    el('time.feed-time', { datetime: new Date(entry.at).toISOString(), title: when(entry.at) }, ago(entry.at)),
  );
}

document.getElementById('logSeg').addEventListener('click', (e) => {
  const button = e.target.closest('[data-log]');
  if (!button || button.dataset.log === activityLog) return;
  activityLog = button.dataset.log;
  e.currentTarget.querySelectorAll('[data-log]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  feedEl.replaceChildren();
  loadActivity();
});

document.getElementById('activityRefreshBtn').addEventListener('click', loadActivity);

registerTab('activity', {
  open: loadActivity,
});
