// The Daily Jam tab: how a day's three words went - who played, how many tries it took, the times, the wrong tries
// made most - then each of the day's players and how their words went, then players each day and streaks. The server
// works them out (see adminDay, adminPlayers and adminDays in daily.js at the project root). Read when the tab opens,
// the day changes, or on Refresh - not polled.
//
// Days are dates as players have them (Daily Jam changes at each player's own midnight), and "today" is this
// browser's. A day that could still be played here keeps its words hidden until "Show today's words" is ticked, so
// opening the tab doesn't give away a Daily Jam you haven't done yet.
//
// Uses columnChart, chartSkeleton, dayLabel and chartResize from stats.js, and nameLine from live.js.

const JAM_LEVELS = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
const JAM_TRIES = 3; // a word's tries (TRIES in daily.js at the project root)
const JAM_DAY_MS = 24 * 60 * 60 * 1000;

const jamPanel = document.getElementById('panel-daily');
const jamTitleEl = document.getElementById('jamTitle');
const jamSubEl = document.getElementById('jamSub');
const jamStateEl = document.getElementById('jamState');
const jamBodyEl = document.getElementById('jamBody');
const jamLevelsEl = document.getElementById('jamLevels');
const jamEmptyEl = document.getElementById('jamEmpty');
const jamPlayersPaneEl = document.getElementById('jamPlayersPane');
const jamPlayersTableEl = document.getElementById('jamPlayersTable');
const jamPlayersEmptyEl = document.getElementById('jamPlayersEmpty');
const jamChartEl = document.getElementById('jamChart');
const jamTableEl = document.getElementById('jamTable');
const jamStreaksEl = document.getElementById('jamStreaks');
const jamPrevBtn = document.getElementById('jamPrev');
const jamNextBtn = document.getElementById('jamNext');
const jamTodayBtn = document.getElementById('jamTodayBtn');
const showJamWordsBox = document.getElementById('showJamWords');

let jamDay = null;        // the day showing ('2026-10-28')
let jamFirst = null;      // Daily Jam #1's day, as the server has it
let jamRange = 30;        // days in the chart
let jamDayReport = null;  // the last replies: the day's, and every day's
let jamDaysReport = null;
let jamAsking = 0;        // which ask is the latest - an older reply that comes in after it is dropped

try {
  showJamWordsBox.checked = localStorage.getItem('adminShowJamWords') === '1';
} catch {}

// Today here, as Daily Jam's page works it out
function jamToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

const jamShift = (day, days) => new Date(Date.parse(day) + days * JAM_DAY_MS).toISOString().slice(0, 10);
// The latest day that's today somewhere: the world's clocks run up to 14 hours ahead of UTC
const jamLatest = () => new Date(Date.now() + 14 * 60 * 60 * 1000).toISOString().slice(0, 10);
// Whether to keep a day's words hidden
const jamHides = (day) => day >= jamToday() && !showJamWordsBox.checked;

// "Today", "Yesterday", "Tomorrow", or "Mon, Oct 27"
function jamDayName(day) {
  const today = jamToday();
  if (day === today) return 'Today';
  if (day === jamShift(today, -1)) return 'Yesterday';
  if (day === jamShift(today, 1)) return 'Tomorrow';
  return dayLabel(day, { weekday: 'short', month: 'short', day: 'numeric' });
}

const jamPercent = (part, whole) => (whole ? `${Math.round((100 * part) / whole)}%` : '–');
const jamTotal = (numbers) => numbers.reduce((sum, n) => sum + n, 0);

// What's wrong, for a reply that isn't 'ok'
function jamProblem(reply) {
  if (reply.status === 'missing') {
    return 'Daily Jam’s numbers need a database update that Supabase doesn’t have yet. Paste supabase/migrations/20261028200000_daily_jam_admin.sql into the SQL Editor on supabase.com, then Refresh.';
  }
  if (reply.status === 'unavailable') return 'Daily Jam can’t be reached right now (Supabase isn’t answering). Try again in a bit.';
  return 'The server didn’t take that day.';
}

// Reads the day showing, and the days for the chart if `withDays` (or they haven't been read yet). Until a day has been
// shown - the first time, or after something went wrong and took it all down - grey pieces stand in for the whole tab
// (showJamSkeleton), and go again if the read doesn't come. Any other time, what's showing stays, dimmed, until the new
// day's in.
async function loadJam(withDays = true) {
  const ask = ++jamAsking;
  const first = jamBodyEl.hidden || !jamDayReport;
  if (first) {
    setState(jamStateEl, '');
    // (They're up already if this ask took over from one that put them up)
    if (jamBodyEl.hidden) showJamSkeleton();
  } else {
    jamPanel.classList.add('is-loading');
  }
  try {
    const [dayReply, daysReply] = await Promise.all([
      api(`daily/day?day=${jamDay}`),
      withDays || !jamDaysReport ? api(`daily/days?to=${jamToday()}&days=${jamRange}`) : jamDaysReport,
    ]);
    if (ask !== jamAsking) return;
    const problem = [dayReply, daysReply].find(reply => reply.status !== 'ok');
    if (problem) {
      setState(jamStateEl, jamProblem(problem), { error: true });
      jamBodyEl.hidden = true;
      if (first) jamSubEl.textContent = '';
      return;
    }
    jamDayReport = dayReply;
    jamDaysReport = daysReply;
    jamFirst = daysReply.first;
    setState(jamStateEl, '');
    jamBodyEl.hidden = false;
    renderJam();
  } catch (err) {
    if (ask !== jamAsking) return;
    setState(jamStateEl, err.message, { error: true });
    if (first) {
      jamBodyEl.hidden = true;
      jamSubEl.textContent = '';
    }
  } finally {
    if (ask === jamAsking) {
      jamPanel.classList.remove('is-loading');
      markBusy(jamPanel, false);
    }
  }
}

// The tab on its way: grey pieces where the day's numbers, its three words, its players, the chart and the streaks will
// be, which renderJam puts the real ones in place of
function showJamSkeleton() {
  markBusy(jamPanel, true);
  jamSubEl.replaceChildren(skelPiece('text', '10em'));
  for (const id of ['jamPlayers', 'jamFinished', 'jamGot', 'jamAll']) {
    document.getElementById(id).replaceChildren(skelPiece('text', '1.6em'));
    document.getElementById(id + 'Sub').replaceChildren(skelPiece('text', '9em'));
  }
  jamEmptyEl.hidden = true;
  // A word each for easy, medium and hard, as long as theirs are (LEVELS in daily.js at the project root)
  jamLevelsEl.replaceChildren(...[5, 7, 9].map(jamLevelSkeleton));
  jamPlayersPaneEl.hidden = false;
  jamPlayersEmptyEl.hidden = true;
  jamPlayersTableEl.replaceChildren(jamPlayersHead(), el('tbody.skel-fade', { 'aria-hidden': 'true' },
    ['8em', '6em', '9em', '5em', '7em'].map(nameWidth => el('tr',
      el('td', el('div.jam-player', skelPiece('circle', '24px'), skelPiece('text', nameWidth))),
      Object.keys(JAM_LEVELS).map(() => el('td', skelPiece('text', '5.5em'))),
      el('td', skelPiece('text', '6em')),
    ))));
  chartSkeleton(jamChartEl, jamRange);
  jamStreaksEl.replaceChildren(...['16em', '5em', '5em', '7em'].flatMap(width => [el('dt', skelPiece('text', '6em')), el('dd', skelPiece('text', width))]));
  jamBodyEl.hidden = false;
}

// One of the day's words on its way, laid out as jamLevelCard lays it out: its name and how many got it, its letters,
// the tries bars and the four facts under them
function jamLevelSkeleton(length) {
  return el('section.pane.jam-level.skel-box', { 'aria-hidden': 'true' },
    el('div.jam-level-head', el('h3', skelPiece('text', '6em')), skelPiece('chip', '5.5em')),
    el('div.jam-word',
      el('span.mini-tiles', Array.from({ length }, () => skelPiece('tile'))),
      el('p.jam-answer', skelPiece('text', '10em')),
    ),
    el('div.jam-dist', ['70%', '45%', '25%', '35%'].map(width => el('div.jam-bar',
      el('span.jam-bar-label', skelPiece('text', '3.5em')),
      el('span.jam-bar-track', skelPiece('block', width)),
      el('span.jam-bar-count', skelPiece('text', '3.5em')),
    ))),
    el('dl.jam-facts', Array.from({ length: 4 }, () => el('div', el('dt', skelPiece('text', '4.5em')), el('dd', skelPiece('text', '2.5em'))))),
  );
}

function renderJam() {
  renderJamDay();
  renderJamDays();
}

function renderJamStepper() {
  jamPrevBtn.disabled = !jamFirst || jamDay <= jamFirst;
  jamNextBtn.disabled = jamDay >= jamLatest();
  jamTodayBtn.disabled = jamDay === jamToday();
}


// ---------- The day ----------

function renderJamDay() {
  const report = jamDayReport;
  const levels = report.levels;
  jamTitleEl.textContent = `Daily Jam #${report.number}`;
  const name = jamDayName(report.day);
  jamSubEl.textContent = name === 'Tomorrow'
    ? `${name}, ${dayLabel(report.day, { month: 'short', day: 'numeric' })} · already today in time zones ahead of yours`
    : `${name}${name.includes(',') ? '' : `, ${dayLabel(report.day, { weekday: 'short', month: 'short', day: 'numeric' })}`}`;
  renderJamStepper();

  const opened = jamTotal(levels.map(l => l.opened));
  const finished = jamTotal(levels.map(l => l.opened - l.playing));
  const got = jamTotal(levels.map(l => jamTotal(l.got)));
  const unfinished = opened - finished;
  // Who played comes as the list of them (see adminPlayers in daily.js at the project root); it was a count before that
  const players = Array.isArray(report.players) ? report.players : [];
  const playerCount = Array.isArray(report.players) ? players.length : report.players;
  document.getElementById('jamPlayers').textContent = playerCount.toLocaleString();
  document.getElementById('jamPlayersSub').textContent = `${report.finished.toLocaleString()} finished a word`;
  document.getElementById('jamFinished').textContent = finished.toLocaleString();
  document.getElementById('jamFinishedSub').textContent = unfinished ? `${unfinished.toLocaleString()} opened, not finished` : `of ${plural(opened, 'word')} opened`;
  document.getElementById('jamGot').textContent = jamPercent(got, finished);
  document.getElementById('jamGotSub').textContent = finished ? `${got.toLocaleString()} of ${plural(finished, 'word')} finished` : 'Nobody’s finished one yet';
  document.getElementById('jamAll').textContent = report.allDone.toLocaleString();
  document.getElementById('jamAllSub').textContent = `${report.allGot.toLocaleString()} got all three`;

  jamEmptyEl.hidden = levels.length > 0;
  document.getElementById('jamEmptyTitle').textContent = `Nobody has opened Daily Jam #${report.number} yet`;
  const hide = jamHides(report.day);
  jamLevelsEl.replaceChildren(...levels.map(level => jamLevelCard(level, hide)));
  renderJamPlayers(players, levels.length > 0);
}

// One of the day's words: its letters, how many tries people took, times, and the wrong tries made most
function jamLevelCard(level, hide) {
  const finished = level.opened - level.playing;
  const got = jamTotal(level.got);
  const rows = [
    ...level.got.map((count, i) => ({ label: i ? `${i + 1} tries` : '1 try', count, got: true })),
    { label: 'Missed', count: level.missed, got: false },
  ];
  const time = (ms) => (ms === null ? '–' : duration(ms));
  return el('section.pane.jam-level',
    el('div.jam-level-head',
      el('h3', JAM_LEVELS[level.level] || level.level, el('span.jam-length', ` · ${level.length} letters`)),
      finished ? el('span.chip.info', `${jamPercent(got, finished)} got it`) : el('span.chip.muted', 'Nobody’s finished it'),
    ),
    el('div.jam-word',
      miniTiles(level.scramble.toUpperCase()),
      hide
        ? el('p.jam-hidden', 'The word’s hidden until you tick Show today’s words')
        : el('p.jam-answer', el('span.round-arrow', { 'aria-hidden': 'true' }, '→ '), el('b', level.word.toUpperCase()),
          level.answers.length ? el('span.jam-also', ` · also counts: ${level.answers.map(a => a.toUpperCase()).join(', ')}`) : null),
    ),
    el('div.jam-dist', { role: 'list', 'aria-label': `How the ${plural(finished, 'player')} who finished it did` },
      rows.map(row => jamBar(row, finished))),
    el('dl.jam-facts',
      el('div', { title: 'Players who opened it' }, el('dt', 'Opened'), el('dd', level.opened.toLocaleString())),
      el('div', { title: 'Opened it but haven’t got it or run out of tries' }, el('dt', 'Unfinished'), el('dd', level.playing.toLocaleString())),
      el('div', { title: 'The middle time of those who got it' }, el('dt', 'Median'), el('dd', time(level.median))),
      el('div', { title: 'The quickest anyone got it' }, el('dt', 'Fastest'), el('dd', time(level.fastest))),
    ),
    hide ? null : jamChips('Wrong tries made most', level.wrong.map(w => `${w.guess.toUpperCase()} ×${w.count}`)),
    hide || !level.others.length ? null : jamChips('Got with another word', level.others.map(o => `${o.answer.toUpperCase()} ×${o.count}`)),
  );
}

// A row of the tries breakdown: its share of those who finished the word, with the count and percent written out
function jamBar({ label, count, got }, finished) {
  const fill = el(`span.jam-bar-fill${got ? '' : '.missed'}`);
  fill.style.width = finished ? `${(100 * count) / finished}%` : '0%';
  return el('div.jam-bar', { role: 'listitem', 'aria-label': `${label}: ${count} (${jamPercent(count, finished)})` },
    el('span.jam-bar-label', { 'aria-hidden': 'true' }, label),
    el('span.jam-bar-track', { 'aria-hidden': 'true' }, fill),
    el('span.jam-bar-count', { 'aria-hidden': 'true' }, finished ? `${count.toLocaleString()} · ${jamPercent(count, finished)}` : '0'),
  );
}

function jamChips(title, chips) {
  return el('div.jam-chips',
    el('p.preview-label', title),
    el('div', chips.length ? chips.map(chip => el('span.word-chip', chip)) : el('span.jam-none', 'None yet')),
  );
}


// ---------- The day's players ----------

// Everyone who opened one of the day's words, in the order the day's leaderboard has them (most words got, then fewest
// tries, then fastest) with anyone still on a word at the end. Their streaks are as of today, like the Streaks pane's.
// Nothing to show until someone has opened the day - the empty box above says so.
function renderJamPlayers(players, opened) {
  jamPlayersPaneEl.hidden = !opened;
  jamPlayersEmptyEl.hidden = players.length > 0;
  const levelNames = Object.keys(JAM_LEVELS);
  jamPlayersTableEl.replaceChildren(...(players.length ? [
    jamPlayersHead(),
    el('tbody', players.map(player => el('tr',
      el('td', el('div.jam-player', avatarEl(player.name), nameLine(player))),
      levelNames.map(level => jamPlayerCell(player.levels && player.levels[level])),
      jamStreakCell(player.streak),
    ))),
  ] : []));
}

// The players table's head row - the same while its rows are on their way (showJamSkeleton)
function jamPlayersHead() {
  return el('thead', el('tr', el('th', 'Player'), Object.keys(JAM_LEVELS).map(level => el('th', JAM_LEVELS[level])), el('th', 'Streak')));
}

// How one of the day's words went for a player: got it (in how many tries, and how long it took), missed it, still on
// it, or never opened it
function jamPlayerCell(play) {
  if (!play) return el('td.jam-cell.none', '–');
  if (play.solved === null || play.solved === undefined) return el('td.jam-cell.playing', 'playing');
  if (!play.solved) return el('td.jam-cell.missed', `✗ ${plural(play.tries, 'try', 'tries')}`);
  return el('td.jam-cell.got', `✓ ${play.tries}/${JAM_TRIES}${Number.isFinite(play.ms) ? ` · ${duration(play.ms)}` : ''}`);
}

// "🔥 3 (best 5)" while it's going (they finished a word today or yesterday), else what it got to before it ended
function jamStreakCell(streak) {
  if (!streak || !streak.best) return el('td.jam-cell.none', '–');
  if (streak.lastDay < jamShift(jamToday(), -1)) {
    return el('td.jam-cell.ended', { title: `Last finished a word on ${jamDayName(streak.lastDay)}` }, `Ended · best ${streak.best}`);
  }
  return el('td.jam-cell', `🔥 ${streak.current} (best ${streak.best})`);
}


// ---------- Every day ----------

function renderJamDays() {
  const days = [...jamDaysReport.days].reverse(); // oldest first, for the chart
  const every = days.length > 10 ? 5 : 1;
  columnChart(jamChartEl, days.map((row, i) => ({
    value: row.players,
    label: (days.length - 1 - i) % every === 0 ? dayLabel(row.day, days.length > 10 ? { month: 'short', day: 'numeric' } : { weekday: 'short', day: 'numeric' }) : '',
    tip: `#${row.number} · ${dayLabel(row.day, { weekday: 'short', month: 'short', day: 'numeric' })}`,
    unit: (n) => (n === 1 ? 'player' : 'players'),
  })));

  // Every number on the chart, and how each word went - a day's name goes to it
  const levelNames = Object.keys(JAM_LEVELS);
  jamTableEl.replaceChildren(
    el('thead', el('tr', el('th', 'Day'), el('th', 'Players'), levelNames.map(level => el('th', JAM_LEVELS[level])))),
    el('tbody', jamDaysReport.days.map((row) => {
      const hide = jamHides(row.day);
      return el('tr',
        el('td', el('button.link-btn', { type: 'button', onclick: () => jamGo(row.day, true) }, `#${row.number} · ${jamDayName(row.day)}`)),
        el('td', row.players.toLocaleString()),
        levelNames.map((name) => {
          const level = row.levels.find(l => l.level === name);
          if (!level) return el('td', '–');
          return el('td', hide ? null : el('span.jam-cell-word', level.word.toUpperCase()), `${level.got}/${level.finished}`);
        }),
      );
    })),
  );

  const { going, longest, best, ever } = jamDaysReport.streaks;
  const inARow = (n) => plural(n, 'day');
  jamStreaksEl.replaceChildren(...[
    ['Going', `${plural(going, 'player')} (finished one today or yesterday)`],
    ['Longest going', going ? inARow(longest) : '–'],
    ['Longest ever', best ? inARow(best) : '–'],
    ['Ever finished one', plural(ever, 'player')],
  ].flatMap(([label, value]) => [el('dt', label), el('dd', value)]));
}


// ---------- Controls ----------

// Shows another day. fromTable: picked in the table below, so back up to the top where the day is.
function jamGo(day, fromTable = false) {
  jamDay = day;
  renderJamStepper();
  if (fromTable) window.scrollTo({ top: 0, behavior: 'smooth' });
  loadJam(false);
}

jamPrevBtn.addEventListener('click', () => jamGo(jamShift(jamDay, -1)));
jamNextBtn.addEventListener('click', () => jamGo(jamShift(jamDay, 1)));
jamTodayBtn.addEventListener('click', () => jamGo(jamToday()));
document.getElementById('jamRefreshBtn').addEventListener('click', () => loadJam());

document.getElementById('jamRangeSeg').addEventListener('click', (e) => {
  const button = e.target.closest('[data-days]');
  if (!button || Number(button.dataset.days) === jamRange) return;
  jamRange = Number(button.dataset.days);
  e.currentTarget.querySelectorAll('[data-days]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  loadJam();
});

showJamWordsBox.addEventListener('change', () => {
  try {
    localStorage.setItem('adminShowJamWords', showJamWordsBox.checked ? '1' : '0');
  } catch {}
  if (jamDayReport) renderJam();
});

chartResize.observe(jamChartEl);

registerTab('daily', {
  open() {
    if (!jamDay) jamDay = jamToday();
    renderJamStepper();
    loadJam();
  },
});
