// The Activity tab: the server's two logs (see admin.js), a day at a time. Games: every round that finished and every
// solo run. Sign-ins & changes: every sign-in, wrong password and lockout, and everything done on this dashboard, with
// where it came from - something done from an address you don't know is the thing to look out for.
//
// A day runs from midnight to midnight in this browser's time zone, today first. ‹ › step a day, and the calendar goes
// to any day back as far as the server keeps the logs (90 days). Entries that go together - a player's solo runs, a
// room's rounds, a run of wrong passwords from one address - fold into one item that opens to show them (see
// groupActivity). Read when the tab opens, the day or the log changes, or on Refresh - not polled.

const ACTIVITY_GAP = 30 * 60 * 1000; // entries that go together make one item while they're closer than this
const ACTIVITY_DAY_MS = 24 * 60 * 60 * 1000;
// What each log's entries are called, one and many: "42 games", "1 sign-in or change"
const ACTIVITY_NOUNS = { game: ['game', 'games'], security: ['sign-in or change', 'sign-ins and changes'] };

const feedEl = document.getElementById('feed');
const activityStateEl = document.getElementById('activityState');
const activitySubEl = document.getElementById('activitySub');
const activityNoteEl = document.getElementById('activityNote');
const activityPrevBtn = document.getElementById('activityPrev');
const activityNextBtn = document.getElementById('activityNext');
const activityTodayBtn = document.getElementById('activityTodayBtn');
const activityTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const activityClock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

let activityLog = 'game';
let activityDay = null;      // the day showing ('2026-10-31')
let activityOnToday = true;  // following today, not a day picked - after midnight, it moves on to the new day
// How long the logs keep entries, and the first day they still have - roughly, until the server has said
let activityKeptDays = 90;
let activityKept = activityShift(activityToday(), -activityKeptDays);
let activityAsking = 0;      // which ask is the latest - an older reply that comes in after it is dropped
let feedShows = null;        // the log and day on screen ('game 2026-10-31'), which reading again only dims
const feedOpenGroups = new Set(); // the day's groups that are open, so they stay open when it's read again
let feedGroupCount = 0;      // numbers each group's list, for its arrow's aria-controls


// ---------- Days ----------

// A day as 'YYYY-MM-DD', from a date's parts here
function activityDayOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// A day's midnight here, or the one `days` after it. Made from the date's parts rather than by adding hours, so a day
// the clocks change on is all of that day, 23 or 25 hours of it.
function activityMidnight(day, days = 0) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date + days);
}

function activityToday() {
  return activityDayOf(new Date());
}

function activityShift(day, days) {
  return activityDayOf(activityMidnight(day, days));
}

// The same date months away, or that month's last day when it's shorter (Mar 31 back a month is Feb 28)
function activityShiftMonth(day, months) {
  const [year, month, date] = day.split('-').map(Number);
  const last = new Date(year, month + months, 0).getDate();
  return activityDayOf(new Date(year, month - 1 + months, Math.min(date, last)));
}

// The nearest day the logs could have: none after today, and none before the first day they still keep
function activityClamp(day) {
  const today = activityToday();
  return day > today ? today : day < activityKept ? activityKept : day;
}

// "Today", "Yesterday", or "Sat, Oct 25"
function activityDayName(day) {
  const today = activityToday();
  if (day === today) return 'Today';
  if (day === activityShift(today, -1)) return 'Yesterday';
  return activityMidnight(day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}


// ---------- Reading a day ----------

async function loadActivity() {
  // Today as the tab first opens, and until another day is picked - a read after midnight (Refresh, or back to the
  // tab) moves on to the new day
  if (activityOnToday && activityDay !== activityToday()) {
    activityDay = activityToday();
    feedOpenGroups.clear();
  }
  renderActivityStepper();
  const ask = ++activityAsking;
  const log = activityLog;
  const day = activityDay;
  const panel = document.getElementById('panel-activity');
  // The day already on screen (Refresh, or back to the tab) is dimmed while it's read again; any other day starts as
  // a skeleton
  const again = feedShows === `${log} ${day}`;
  panel.classList.toggle('is-loading', again);
  feedEl.setAttribute('aria-busy', 'true');
  if (!again) {
    feedShows = null;
    showActivitySub(day);
    setState(activityStateEl, '');
    activityNoteEl.hidden = true;
    feedEl.classList.add('skel-fade');
    feedEl.replaceChildren(...feedSkeleton());
  }
  try {
    const reply = await api(`activity?log=${log}&from=${activityMidnight(day).getTime()}&to=${activityMidnight(day, 1).getTime()}`);
    if (ask !== activityAsking) return;
    if (Number.isFinite(reply.keptFrom)) {
      activityKept = activityDayOf(new Date(reply.keptFrom));
      activityKeptDays = Math.round((Date.now() - reply.keptFrom) / ACTIVITY_DAY_MS);
      renderActivityStepper();
    }
    const { entries } = reply;
    feedEl.classList.remove('skel-fade');
    renderFeed(entries);
    feedShows = `${log} ${day}`;
    showActivitySub(day, entries.length, reply.more);
    setState(activityStateEl, entries.length ? '' : activityNothing(day));
    showActivityNote(entries.length, reply.more);
  } catch (err) {
    if (ask !== activityAsking) return;
    if (!again) {
      feedEl.classList.remove('skel-fade');
      feedEl.replaceChildren();
      showActivitySub(day, null);
    }
    setState(activityStateEl, err.message, { error: true });
  } finally {
    if (ask === activityAsking) {
      panel.classList.remove('is-loading');
      feedEl.removeAttribute('aria-busy');
    }
  }
}

function renderActivityStepper() {
  const today = activityToday();
  activityPrevBtn.disabled = activityDay <= activityKept;
  activityNextBtn.disabled = activityDay >= today;
  activityTodayBtn.disabled = activityDay === today;
}

// Under the heading: the day showing and how much it has, "Today · 42 games". count: undefined while the day is read
// (a stand-in where the count goes), null when it couldn't be.
function showActivitySub(day, count, more = false) {
  const name = activityDayName(day);
  if (count === undefined) {
    activitySubEl.replaceChildren(name, el('span', { 'aria-hidden': 'true' }, ' · ', skelPiece('text', '4.5em')));
    return;
  }
  const text = count ? `${name} · ${more ? 'over ' : ''}${plural(count, ...ACTIVITY_NOUNS[activityLog])}` : name;
  // Only when it's changed: the line is read out when it does
  if (activitySubEl.textContent !== text) activitySubEl.textContent = text;
}

// What the state line says for a day with nothing in it
function activityNothing(day) {
  const name = activityDayName(day);
  if (name === 'Today') {
    return activityLog === 'game' ? 'No games yet today. Rounds and solo runs show up here as they finish.' : 'Nothing logged yet today.';
  }
  const on = name === 'Yesterday' ? 'yesterday' : `on ${name}`;
  return activityLog === 'game' ? `No games ${on}.` : `Nothing logged ${on}.`;
}

// Under the feed: that only the latest of a busy day are shown, and how far back the logs go, on the first day they
// still have
function showActivityNote(count, more) {
  const notes = [];
  if (more) notes.push(`Only the latest ${plural(count, ...ACTIVITY_NOUNS[activityLog])} of the day are shown.`);
  if (activityDay <= activityKept) notes.push(`Activity is kept for ${activityKeptDays} days.`);
  activityNoteEl.textContent = notes.join(' ');
  activityNoteEl.hidden = !notes.length;
}

// Stand-ins for a day's items while it's read - an icon, a line and a shorter one, and the time - sized like the real
// ones (see .feed-skel in admin.css) so nothing moves when they come
function feedSkeleton() {
  return [[58, 34], [44, 26], [66, 40], [50, 30], [40, 22], [54, 32]].map(([text, detail]) => el('li.feed-item.feed-skel', { 'aria-hidden': 'true' },
    skelPiece('block', '34px', '34px', '10px'),
    el('div.feed-body', skelPiece('line', `${text}%`), skelPiece('line', `${detail}%`)),
    skelPiece('line.feed-skel-time', '3.6em'),
  ));
}


// ---------- The feed ----------

function renderFeed(entries) {
  feedEl.replaceChildren(...groupActivity(entries).map(group => (group.entries.length > 1 ? feedGroup(group) : feedItem(group.entries[0]))));
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
    feedTime(entry.at),
  );
}

// When: "5 min ago" today, the time of day on any other day - with the date and time on hover, or for a group the
// times it spans
function feedTime(at, title = when(at)) {
  const today = activityDayOf(new Date(at)) === activityToday();
  return el('time.feed-time', { datetime: new Date(at).toISOString(), title }, today ? ago(at) : activityClock.format(at));
}


// ---------- Groups ----------

// What an entry is grouped by: a player's solo runs (the id their score went under, or their name for runs logged
// before runs had one), a room's rounds, or sign-ins, sign-outs, wrong passwords or lockouts from one address. null
// for one that stays on its own line: every change made on this dashboard, so none can hide in a group.
function feedGroupKey(entry) {
  if (entry.type === 'solo') return entry.player ? `solo:${entry.player}` : `solo-name:${entry.name}`;
  if (entry.type === 'round') return `round:${entry.room}`;
  if (!DESCRIBE_GROUP[entry.type] || !entry.ip) return null;
  return `${entry.type}:${entry.scope || ''}:${entry.ip}`;
}

// The day's entries as the feed's items, newest first. Going through the entries oldest first, each joins the group
// its key has going if it's less than ACTIVITY_GAP after that group's last entry, and starts a new one if not - so a
// player's runs stay together with other people's in between, until they take a long enough break. A group goes where
// its newest entry is. Each item is { key, entries }, its entries oldest first; most are a group of one.
function groupActivity(entries) {
  const groups = [];
  const going = new Map(); // key -> its latest group
  for (const entry of [...entries].sort((a, b) => a.at - b.at)) {
    const key = feedGroupKey(entry);
    const group = key === null ? undefined : going.get(key);
    if (group && entry.at - group.entries[group.entries.length - 1].at < ACTIVITY_GAP) {
      group.entries.push(entry);
    } else {
      const started = { key, entries: [entry] };
      groups.push(started);
      if (key !== null) going.set(key, started);
    }
  }
  const newest = (group) => group.entries[group.entries.length - 1].at;
  return groups.sort((a, b) => newest(b) - newest(a));
}

// A group of one kind of entry as [icon, what happened, details, whether it's one to look at, what its entries are],
// like DESCRIBE for one. The entries come oldest first.
const DESCRIBE_GROUP = {
  round: (rounds) => {
    // Rounds won, most first - players level on them in the order they first won
    const wins = new Map();
    for (const round of rounds) if (round.winner) wins.set(round.winner, (wins.get(round.winner) || 0) + 1);
    const table = [...wins].sort((a, b) => b[1] - a[1]);
    const most = table.length ? table[0][1] : 0;
    const top = table.filter(([, n]) => n === most).map(([name]) => name);
    const won = top.length === 1 ? `${top[0]} won ${most}`
      : top.length > 3 ? `${top.length} players won ${most} each`
      : top.length ? `${feedNames(top)} won ${most} each` : null;
    return ['🏁', [`Room ${rounds[0].room}`, plural(rounds.length, 'round'), won].filter(Boolean).join(' · '),
      table.map(([name, n]) => `${name} ${n}`).join(' · '), false, 'rounds'];
  },
  solo: (runs) => {
    const points = runs.map(run => run.points || 0);
    const average = points.reduce((total, n) => total + n, 0) / runs.length;
    const words = runs.reduce((total, run) => total + (run.words || 0), 0);
    const oneDecimal = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
    return ['⏱', `${runs[runs.length - 1].name} played ${plural(runs.length, 'solo run')}`,
      `best ${Math.max(...points).toLocaleString()} · avg ${average.toLocaleString(undefined, oneDecimal)} · ${plural(words, 'word')}`, false, 'runs'];
  },
  'signed-in': (times) => {
    const fresh = times.filter(e => !e.trusted).length;
    const onNew = !fresh ? '' : fresh === times.length ? ' on a new device' : `, ${fresh} on a new device`;
    return ['🔓', `Signed in ${times.length} times${onNew}`, fromWhereAll(times), false, 'sign-ins'];
  },
  'wrong-password': (tries) => ['⚠️', plural(tries.length, 'wrong password'), fromWhereAll(tries), true, 'wrong passwords'],
  locked: (locks) => (locks[0].scope === 'everyone'
    ? ['🔒', `Too many wrong passwords overall, ${locks.length} times: new devices couldn't sign in for a while`, `Known devices still could. Last tries: ${fromWhereAll(locks)}`, true, 'lockouts']
    : ['🔒', `Too many wrong passwords from one address, ${locks.length} times: it couldn't try again for a while`, fromWhereAll(locks), true, 'lockouts']),
  'signed-out': (times) => ['🚪', `Signed out ${times.length} times`, fromWhereAll(times), false, 'sign-outs'],
};

// Where a group came from: its devices, places and address, each one once, newest first
function fromWhereAll(entries) {
  const each = (key) => [...new Set(entries.map(e => e[key]).filter(Boolean).reverse())].join(' / ');
  return [each('device'), each('place'), each('ip')].filter(Boolean).join(' · ');
}

// "Wiick and Sam", "Wiick, Sam and Al"
const feedNames = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]);

// "2:10 – 2:48 PM": the times a group spans
function activitySpan(from, to) {
  try {
    return activityClock.formatRange(from, to);
  } catch {
    return `${activityClock.format(from)} – ${activityClock.format(to)}`;
  }
}

// A group: one line saying what's in it, with an arrow (or a click anywhere on the line) that opens it to show each of
// its entries under it
function feedGroup({ key, entries }) {
  const newest = entries[entries.length - 1];
  const [icon, text, detail, bad, what] = DESCRIBE_GROUP[newest.type](entries);
  const id = `${key} ${entries[0].at}`; // the same group when the day is read again, with any entries added since
  const listId = `feed-group-${++feedGroupCount}`;
  const items = [...entries].reverse().map((entry, i) => {
    const item = feedItem(entry);
    item.style.setProperty('--i', i); // its place in the cascade (see .feed-sub in admin.css)
    return item;
  });
  const group = el(`li.feed-group${bad ? '.bad' : ''}`,
    el(`div.feed-item.feed-summary${bad ? '.bad' : ''}`, {
      onclick: (e) => {
        // Not for the click that ends selecting some of its text. The arrow's always counts (a click, or Enter or
        // Space on it): pressing a button leaves a selection made anywhere on the page as it was.
        const selection = window.getSelection();
        if (!e.target.closest('.feed-arrow') && selection && !selection.isCollapsed) return;
        const open = !group.classList.contains('is-open');
        if (open) feedOpenGroups.add(id);
        else feedOpenGroups.delete(id);
        showGroup(group, open, true);
      },
    },
      el('span.feed-icon', { 'aria-hidden': 'true' }, icon),
      el('div.feed-body',
        el('p.feed-text', text),
        detail ? el('p.feed-detail', detail) : null,
      ),
      feedTime(newest.at, activitySpan(entries[0].at, newest.at)),
      el('button.feed-arrow', { type: 'button', 'aria-expanded': 'false', 'aria-controls': listId, 'aria-label': `Show the ${entries.length} ${what}` }),
    ),
    el('div.feed-more', { id: listId }, el('div.feed-clip', el('ol.feed-sub', items))),
  );
  showGroup(group, feedOpenGroups.has(id));
  return group;
}

// Opens or closes a group. cascade: opened just now, so its entries come in one after another - not when it's drawn
// open again by a refresh.
function showGroup(group, open, cascade = false) {
  group.classList.toggle('is-open', open);
  group.classList.toggle('is-cascading', open && cascade);
  group.querySelector('.feed-arrow').setAttribute('aria-expanded', String(open));
}


// ---------- The calendar ----------

// A month at a time, under its button (a sheet along the bottom on a phone). Each day with entries has a dot, from
// /activity/days: asked once per month and log, and again after Refresh.

const calBtn = document.getElementById('activityCalBtn');
const calEl = document.getElementById('activityCal');
const calBackdropEl = document.getElementById('activityCalBackdrop');
const calTitleEl = document.getElementById('activityCalTitle');
const calPrevBtn = document.getElementById('activityCalPrev');
const calNextBtn = document.getElementById('activityCalNext');
const calDaysEl = document.getElementById('activityCalDays');
const calFootEl = document.getElementById('activityCalFoot');

let calFocus = null;         // the day the arrow keys are on - the calendar shows its month
const calCounts = new Map(); // 'game 2026-10' -> { '2026-10-25': 18, ... } as the server counted them, null while asking
let calAsks = 0;             // goes up on Refresh, so counts asked for before it aren't kept

// The week starts on the day it does where this browser is (Monday in much of the world) when it can say, else Sunday
const calWeekStart = (() => {
  try {
    const locale = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale);
    const week = locale.getWeekInfo ? locale.getWeekInfo() : locale.weekInfo;
    if (week && week.firstDay) return week.firstDay % 7; // 1 is Monday and 7 Sunday; getDay() has Sunday as 0
  } catch {}
  return 0;
})();

// The weekdays' initials across the top, taken from a week that started on a Sunday (Jan 4, 2026)
document.getElementById('activityCalWeekdays').replaceChildren(...Array.from({ length: 7 }, (_, i) =>
  el('span', new Date(2026, 0, 4 + ((calWeekStart + i) % 7)).toLocaleDateString(undefined, { weekday: 'narrow' }))));

function openCal() {
  calFocus = activityClamp(activityDay);
  calEl.hidden = false;
  calBackdropEl.hidden = false;
  calBtn.setAttribute('aria-expanded', 'true');
  loadCalMonth();
  renderCal();
  focusCalDay();
}

// toButton: focus goes back to the calendar's button (Escape, or a day picked)
function closeCal(toButton) {
  if (calEl.hidden) return;
  calEl.hidden = true;
  calBackdropEl.hidden = true;
  calBtn.setAttribute('aria-expanded', 'false');
  if (toButton) calBtn.focus();
}

function renderCal() {
  const today = activityToday();
  const month = calFocus.slice(0, 7);
  const first = activityMidnight(`${month}-01`);
  calTitleEl.textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  calPrevBtn.disabled = month <= activityKept.slice(0, 7);
  calNextBtn.disabled = month >= today.slice(0, 7);
  calFootEl.textContent = `Activity is kept for ${activityKeptDays} days.`;
  calFootEl.hidden = month > activityKept.slice(0, 7);

  const cells = Array.from({ length: (first.getDay() - calWeekStart + 7) % 7 }, () => el('span'));
  const length = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  for (let date = 1; date <= length; date++) {
    const day = `${month}-${String(date).padStart(2, '0')}`;
    const showing = day === activityDay;
    const name = activityMidnight(day).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    cells.push(el(`button.cal-day${day === today ? '.is-today' : ''}${showing ? '.is-showing' : ''}`, {
      type: 'button',
      'data-day': day,
      tabindex: day === calFocus ? 0 : -1,
      disabled: day > today || day < activityKept,
      'aria-label': showing ? `${name} (showing)` : name,
      'aria-current': day === today ? 'date' : null,
    }, String(date)));
  }
  // Six weeks' room every month, so the calendar keeps its size
  while (cells.length < 42) cells.push(el('span'));
  calDaysEl.replaceChildren(...cells);
  paintCal();
}

// The dots: how much each day of the month showing has, once the server has said
function paintCal() {
  const counts = calCounts.get(`${activityLog} ${calFocus.slice(0, 7)}`);
  const most = counts ? Math.max(1, ...Object.values(counts)) : 1;
  calDaysEl.setAttribute('aria-busy', String(counts === null));
  for (const button of calDaysEl.querySelectorAll('[data-day]')) {
    const count = (counts && counts[button.dataset.day]) || 0;
    let dot = button.querySelector('.cal-dot');
    if (!count) {
      button.removeAttribute('title');
      if (dot) dot.remove();
      continue;
    }
    button.title = plural(count, ...ACTIVITY_NOUNS[activityLog]);
    if (!dot) {
      dot = el('i.cal-dot', { 'aria-hidden': 'true' });
      button.append(dot);
    }
    // Four strengths, on a log scale, so a quiet day still shows beside the busiest
    dot.dataset.level = Math.max(1, Math.ceil((4 * Math.log1p(count)) / Math.log1p(most)));
  }
}

// Asks for the month showing's counts, unless they're in already or on their way. Called before the month is drawn,
// so it's drawn as waiting for them.
async function loadCalMonth() {
  const log = activityLog;
  const month = calFocus.slice(0, 7);
  const key = `${log} ${month}`;
  if (calCounts.has(key)) return;
  calCounts.set(key, null);
  const asks = calAsks;
  const [year, monthNumber] = month.split('-').map(Number);
  const last = new Date(year, monthNumber, 0).getDate();
  try {
    const reply = await api(`activity/days?log=${log}&from=${month}-01&to=${month}-${last}&tz=${encodeURIComponent(activityTimeZone)}`);
    if (asks !== calAsks) return;
    calCounts.set(key, reply.days || {});
    if (typeof reply.keptFrom === 'string' && reply.keptFrom !== activityKept) {
      activityKept = reply.keptFrom;
      renderActivityStepper();
    }
  } catch {
    if (asks !== calAsks) return;
    calCounts.delete(key); // asked again the next time the month shows
  }
  if (!calEl.hidden && key === `${activityLog} ${calFocus.slice(0, 7)}`) paintCal();
}

// Moves the calendar to another day - the arrow keys, or a month at a time - keeping to days the logs could have
function calGo(day, focus) {
  day = activityClamp(day);
  const otherMonth = day.slice(0, 7) !== calFocus.slice(0, 7);
  calFocus = day;
  if (otherMonth) {
    loadCalMonth();
    renderCal();
  } else {
    for (const button of calDaysEl.querySelectorAll('[data-day]')) button.tabIndex = button.dataset.day === day ? 0 : -1;
  }
  if (focus) focusCalDay();
}

function focusCalDay() {
  const button = calDaysEl.querySelector(`[data-day="${calFocus}"]`);
  if (button) button.focus();
}

// A month back or on. At the first or last month there is, the button turns off, and focus goes to the days rather
// than being lost with it.
function calStepMonth(months, button) {
  calGo(activityShiftMonth(calFocus, months), false);
  if (button.disabled) focusCalDay();
}

calBtn.addEventListener('click', () => (calEl.hidden ? openCal() : closeCal(true)));
calPrevBtn.addEventListener('click', () => calStepMonth(-1, calPrevBtn));
calNextBtn.addEventListener('click', () => calStepMonth(1, calNextBtn));

// Arrows move a day or a week, Page Up and Page Down a month, Home and End to the week's first and last day. Enter and
// Space pick the day, as they press any button.
calDaysEl.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
  const intoWeek = (activityMidnight(calFocus).getDay() - calWeekStart + 7) % 7;
  let day;
  if (steps[e.key]) day = activityShift(calFocus, steps[e.key]);
  else if (e.key === 'PageUp') day = activityShiftMonth(calFocus, -1);
  else if (e.key === 'PageDown') day = activityShiftMonth(calFocus, 1);
  else if (e.key === 'Home') day = activityShift(calFocus, -intoWeek);
  else if (e.key === 'End') day = activityShift(calFocus, 6 - intoWeek);
  else return;
  e.preventDefault();
  calGo(day, true);
});

calDaysEl.addEventListener('click', (e) => {
  const button = e.target.closest('[data-day]');
  if (!button || button.disabled) return;
  closeCal(true);
  activityGo(button.dataset.day);
});

// It closes on Escape, a click anywhere else (on a phone, the dimmed page behind it), or tabbing away from it and its
// button
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !calEl.hidden) closeCal(true);
});
document.addEventListener('click', (e) => {
  if (!calEl.hidden && !calEl.contains(e.target) && !calBtn.contains(e.target)) closeCal(false);
});
[calEl, calBtn].forEach(node => node.addEventListener('focusout', (e) => {
  if (e.relatedTarget && !calEl.contains(e.relatedTarget) && e.relatedTarget !== calBtn) closeCal(false);
}));


// ---------- Controls ----------

// Shows another day
function activityGo(day) {
  activityOnToday = day === activityToday();
  if (day !== activityDay) {
    activityDay = day;
    feedOpenGroups.clear();
  }
  loadActivity();
}

activityPrevBtn.addEventListener('click', () => activityGo(activityShift(activityDay, -1)));
activityNextBtn.addEventListener('click', () => activityGo(activityShift(activityDay, 1)));
activityTodayBtn.addEventListener('click', () => activityGo(activityToday()));

// Games or sign-ins & changes, on the same day
document.getElementById('logSeg').addEventListener('click', (e) => {
  const button = e.target.closest('[data-log]');
  if (!button || button.dataset.log === activityLog) return;
  activityLog = button.dataset.log;
  e.currentTarget.querySelectorAll('[data-log]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  feedOpenGroups.clear();
  loadActivity();
});

// The day again, and the calendar's counts: the month showing is asked for now, any other when it next shows
document.getElementById('activityRefreshBtn').addEventListener('click', () => {
  calCounts.clear();
  calAsks++;
  if (!calEl.hidden) loadCalMonth();
  loadActivity();
});

registerTab('activity', {
  open: loadActivity,
  close() {
    closeCal(false);
    // Hidden and shown again, an open group would play its cascade again - and it isn't being opened just now then
    feedEl.querySelectorAll('.feed-group.is-cascading').forEach(group => group.classList.remove('is-cascading'));
  },
});
