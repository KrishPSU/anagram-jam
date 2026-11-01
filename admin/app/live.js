// The Live tab: who's on the site right now - everyone with a game page open, by what they're doing - and the rooms,
// room by room, with a way to close a room or take someone out of one. It asks again every few seconds while it's on
// screen. Each ask costs a couple of Redis commands and a Supabase read, so it stops while the tab is hidden, paused,
// or nobody has touched the page for IDLE_AFTER.
//
// nameLine, hiddenChip and accountChip here are used by the Leaderboard and Daily Jam tabs too.

const LIVE_EVERY = 5000;
const IDLE_AFTER = 10 * 60 * 1000;

const livePanel = document.getElementById('panel-live');
const kpiEls = {
  people: document.getElementById('kpiPeople'),
  players: document.getElementById('kpiPlayers'),
  playing: document.getElementById('kpiPlaying'),
  rooms: document.getElementById('kpiRooms'),
  games: document.getElementById('kpiGames'),
};
const deployLine = document.getElementById('deployLine');
const deployTitle = document.getElementById('deployTitle');
const deployText = document.getElementById('deployText');
const pausedLine = document.getElementById('pausedLine');
const peopleListEl = document.getElementById('peopleList');
const peopleEmptyEl = document.getElementById('peopleEmpty');
const roomListEl = document.getElementById('roomList');
const roomsEmptyEl = document.getElementById('roomsEmpty');
const liveStateEl = document.getElementById('liveState');
const liveUpdatedEl = document.getElementById('liveUpdated');
const livePauseBtn = document.getElementById('livePauseBtn');
const showWordsBox = document.getElementById('showWords');

let liveOpen = false;
let livePaused = false; // the Pause updates button
let liveTimer = null;
let liveAsking = false;
let overview = null;   // the last reply, which Controls uses too
let overviewAt = 0;

try {
  showWordsBox.checked = localStorage.getItem('adminShowWords') === '1';
} catch {}

async function refreshLive() {
  clearTimeout(liveTimer);
  liveTimer = null;
  if (!liveOpen || liveAsking) return;
  if (document.hidden || livePaused || isIdle(IDLE_AFTER)) {
    showUpdated();
    return;
  }
  liveAsking = true;
  try {
    overview = await api('overview');
    overviewAt = Date.now();
    setSession(overview.session.ends);
    setState(liveStateEl, '');
    renderLive();
    markBusy(livePanel, false);
  } catch (err) {
    setState(liveStateEl, `${err.message} Trying again…`, { error: true });
  } finally {
    liveAsking = false;
  }
  if (liveOpen) liveTimer = setTimeout(refreshLive, LIVE_EVERY);
}

// Until the first reply: grey pieces where the numbers, the deploy line, the people and the rooms will be, which
// renderLive puts the real ones in place of. They stay through a failed ask, since another is on its way in a few
// seconds - the line above them says what went wrong. Every ask after the first keeps what's showing until it's in.
function showLiveSkeleton() {
  markBusy(livePanel, true);
  Object.values(kpiEls).forEach(kpi => kpi.replaceChildren(skelPiece('text', '1.4em')));
  deployLine.className = 'status-line skel-box';
  deployLine.hidden = false;
  deployTitle.replaceChildren(skelPiece('text', '7em'));
  deployText.replaceChildren(skelPiece('text', '11em'));
  peopleEmptyEl.hidden = true;
  peopleListEl.replaceChildren(el('section.people-group.skel-box', { 'aria-hidden': 'true' },
    el('header.people-head', el('h3', skelPiece('text', '4.5em')), skelPiece('chip', '4.5em')),
    el('ul.room-players', personSkeleton('7em'), personSkeleton('5em')),
  ));
  roomsEmptyEl.hidden = true;
  roomListEl.replaceChildren(el('article.room-card.skel-box', { 'aria-hidden': 'true' },
    el('header.room-head',
      el('span.mini-tiles', Array.from({ length: 5 }, () => skelPiece('tile'))),
      skelPiece('chip', '4em'),
      el('span.room-meta', skelPiece('text', '5em')),
    ),
    el('ul.room-players', roomPlayerSkeleton('6em'), roomPlayerSkeleton('4.5em')),
    el('footer.room-foot', el('span', skelPiece('text', '11em')), skelPiece('btn', '84px')),
  ));
}

// A person's row (personRow) on its way: avatar, name, what they're up to, and how long ago and for how long
function personSkeleton(nameWidth) {
  return el('li.player-row',
    skelPiece('circle'),
    el('div.player-main', el('span.player-name', skelPiece('text', nameWidth)), el('span.player-progress', skelPiece('text', '10em'))),
    el('span.player-when', el('span', skelPiece('text', '4em')), el('span', skelPiece('text', '3.5em'))),
  );
}

// A room player's row (playerRow) on its way: avatar, name, a status chip, and the Remove button
function roomPlayerSkeleton(nameWidth) {
  return el('li.player-row',
    skelPiece('circle'),
    el('div.player-main', el('span.player-name', skelPiece('text', nameWidth)), el('span.player-meta', skelPiece('chip', '5.5em'))),
    skelPiece('btn'),
  );
}

// "Updated 3s ago", or why it isn't updating
function showUpdated() {
  if (!liveOpen) return;
  const stopped = livePaused ? 'Updates paused' : isIdle(IDLE_AFTER) ? 'Paused while you were away' : null;
  const age = overviewAt ? `Updated ${ago(overviewAt)}` : '';
  liveUpdatedEl.textContent = stopped ? (age ? `${stopped} · ${age}` : stopped) : age;
}
setInterval(showUpdated, 1000);

function renderLive() {
  const { totals, rooms, storage, settings, now } = overview;
  kpiEls.people.textContent = totals.people === undefined ? '–' : totals.people;
  kpiEls.players.textContent = totals.players;
  kpiEls.playing.textContent = totals.playing;
  kpiEls.rooms.textContent = totals.rooms;
  kpiEls.games.textContent = totals.games;

  // Whether a deploy now would catch anyone mid-word. Rooms are in Redis, so they outlast a deploy; in memory they don't.
  const inMemory = storage !== 'Redis';
  deployLine.hidden = false;
  if (!totals.games) {
    deployLine.className = 'status-line ok';
    deployTitle.textContent = 'Safe to deploy';
    deployText.textContent = inMemory && totals.rooms
      ? `Nobody is mid-round, but rooms are in memory right now (${storage}), so open lobbies would close.`
      : 'Nobody is mid-round.';
  } else {
    deployLine.className = 'status-line warn';
    deployTitle.textContent = 'Hold off deploying';
    deployText.textContent = inMemory
      ? `${plural(totals.playing, 'player is', 'players are')} mid-round, and rooms are in memory right now, so a deploy would end their games.`
      : `${plural(totals.playing, 'player is', 'players are')} mid-round in ${plural(totals.games, 'room')}. A deploy now would make their pages reconnect mid-word.`;
  }
  pausedLine.hidden = !settings.paused;

  renderPeople(Array.isArray(overview.people) ? overview.people : [], now);
  roomsEmptyEl.hidden = rooms.length > 0;
  roomListEl.replaceChildren(...rooms.map(room => roomCard(room, now)));
  showUpdated();
}


// ---------- People on the site ----------

// Everyone with a game page open, by which page: their pages check in every 20 seconds (see /shared/presence.js) and
// the server keeps whoever has checked in within the last minute (livePlayers in data.js). Rooms aren't in here - a
// room's page doesn't check in, the room itself is listed below.
const PEOPLE_GROUPS = { solo: 'Solo', daily: 'Daily Jam', practice: 'Practice', home: 'Home' };
const DAILY_WORD_NAMES = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

function renderPeople(people, now) {
  peopleEmptyEl.hidden = people.length > 0;
  // The four pages in this order, then anything else the server might send, each only when someone's there
  const groups = new Map(Object.keys(PEOPLE_GROUPS).map(mode => [mode, []]));
  for (const person of people) {
    if (!groups.has(person.mode)) groups.set(person.mode, []);
    groups.get(person.mode).push(person);
  }
  peopleListEl.replaceChildren(...[...groups].filter(([, list]) => list.length).map(([mode, list]) => el('section.people-group', { 'aria-label': PEOPLE_GROUPS[mode] || mode },
    el('header.people-head', el('h3', PEOPLE_GROUPS[mode] || mode), el('span.chip.muted', plural(list.length, 'person', 'people'))),
    el('ul.room-players', list.map(person => personRow(person, now))),
  )));
}

// What someone's up to, from what their page sends along (presenceDetail in solo/js/solo.js, daily/js/daily.js and
// practice/js/practice.js). Nothing for the home page.
function doing(person) {
  const detail = person.detail || {};
  const n = (value) => (Number.isFinite(value) ? value : 0);
  if (person.mode === 'solo') {
    if (detail.state === 'run') return `In a run · ${plural(n(detail.points), 'pt')} · word ${n(detail.level) + 1}`;
    if (detail.state === 'results') return 'Reading results';
    if (detail.state === 'intro') return 'On the start screen';
  }
  if (person.mode === 'daily') {
    if (detail.state === 'word') return DAILY_WORD_NAMES[detail.level] ? `On the ${DAILY_WORD_NAMES[detail.level]} word` : 'On a word';
    if (detail.state === 'day') return 'On today’s words';
  }
  if (person.mode === 'practice' && detail.solved !== undefined) return `${n(detail.solved).toLocaleString()} solved`;
  return '';
}

function personRow(person, now) {
  const what = doing(person);
  return el('li.player-row',
    avatarEl(person.name),
    el('div.player-main',
      nameLine(person),
      what ? el('span.player-meta', el('span.player-progress', what)) : null,
    ),
    el('span.player-when',
      el('span', ago(person.seenAt, now)),
      person.since ? el('span', `for ${duration(now - person.since)}`) : null,
    ),
  );
}

// A player's name as they typed it, with what goes with it: "Shows as Player" when it has swear words in it (everyone
// else sees "Player" - see shownName in solo.js at the project root), and which account they're signed in with
function nameLine({ name, hidden, account }) {
  return el('span.player-line',
    name ? el('span.player-name', { title: name }, name) : el('span.player-name.unnamed', 'No name'),
    hidden ? hiddenChip() : null,
    accountChip(account),
  );
}

function hiddenChip() {
  return el('span.chip.warn', { title: 'Everyone else sees this name as "Player"' }, 'Shows as Player');
}

// "Google" or "Apple": the server sends the provider's name (see account.js at the project root), or null for someone
// who isn't signed in
const PROVIDERS = { google: 'Google', apple: 'Apple' };
function accountChip(account) {
  const provider = typeof account === 'string' ? account : account && account.provider;
  if (!provider) return null;
  const name = PROVIDERS[provider] || provider;
  return el('span.chip.account', { title: `Signed in with ${name}` }, name);
}


// ---------- Rooms ----------

const PHASES = {
  playing: ['Playing', 'go'],
  countdown: ['Starting', 'info'],
  results: ['Results', 'info'],
  lobby: ['Lobby', 'muted'],
};

function roomCard(room, now) {
  const [phaseName, phaseTone] = PHASES[room.phase];
  const meta = [];
  if (room.round) meta.push(`${duration(now - room.round.startedAt)} into the round`);
  else if (room.emptySince) meta.push(`Empty, closes in ${Math.max(0, 30 - Math.round((now - room.emptySince) / 1000))}s`);
  else meta.push(plural(room.players.length, 'player'));

  const close = confirmButton({
    key: `close:${room.code}`,
    label: 'Close room',
    armedLabel: 'Close it?',
    className: 'btn btn-glass btn-xs',
    onConfirm: async () => {
      try {
        const reply = await api('rooms/close', { code: room.code });
        showAlert(reply.status === 'ok' ? `Closed room ${room.code}. Everyone in it was sent home.` : `Room ${room.code} had already closed.`, 'success');
      } catch (err) {
        showAlert(err.message);
      }
      refreshLive();
    },
  });

  const foot = [];
  if (room.createdAt) foot.push(`Opened ${ago(room.createdAt, now)}`);
  if (room.lastRound) foot.push(`Last round: ${room.lastRound.winner} won${room.lastRound.tied ? ' on a tie-break' : ''}`);

  return el(`article.room-card${room.phase === 'playing' ? '.is-playing' : ''}`, { 'aria-label': `Room ${room.code}` },
    el('header.room-head',
      miniTiles(room.code),
      el(`span.chip.${phaseTone}`, phaseName),
      el('span.room-meta', meta.join(' · ')),
    ),
    room.players.length
      ? el('ul.room-players', room.players.map(player => playerRow(room, player, now)))
      : el('p.room-none', 'Nobody in it right now.'),
    room.round && showWordsBox.checked ? roundWords(room.round) : null,
    el('footer.room-foot', el('span', foot.join(' · ')), close),
  );
}

const STATUSES = {
  ready: ['Ready ✓', 'go'],
  notReady: ['Not ready', 'muted'],
  game: ['In the round', 'info'],
  results: ['Reading results', 'muted'],
};

function playerRow(room, player, now) {
  const [statusName, statusTone] = STATUSES[player.status] || ['In the room', 'muted'];
  const meta = [el(`span.chip.${statusTone}`, statusName)];
  if (player.awaySince) meta.push(el('span.chip.warn', `Away ${duration(now - player.awaySince)}`));
  if (player.level !== null && room.round) {
    const total = room.round.total;
    const where = player.level >= total ? 'finished' : `word ${player.level + 1}/${total}`;
    meta.push(el('span.player-progress', `${plural(player.points, 'pt')} · ${where}`));
  }
  if (player.wins) meta.push(el('span.player-progress', `🏆 ${player.wins}`));

  const remove = confirmButton({
    key: `remove:${room.code}:${player.id}`,
    label: 'Remove',
    armedLabel: 'Remove?',
    onConfirm: async () => {
      try {
        const reply = await api('rooms/remove', { code: room.code, id: player.id });
        showAlert(reply.status === 'ok' ? `${player.name} was taken out of room ${room.code}.` : `${player.name} had already left.`, 'success');
      } catch (err) {
        showAlert(err.message);
      }
      refreshLive();
    },
  });

  return el('li.player-row',
    avatarEl(player.name),
    el('div.player-main',
      el('span.player-name', { title: player.name }, player.name),
      el('span.player-meta', meta),
    ),
    remove,
  );
}

// The round's words (the answers), each with who got it first
function roundWords(round) {
  return el('ol.round-words', round.words.map((w, i) => el('li',
    el('span.round-n', i + 1),
    el('span.round-scramble', w.scramble.toUpperCase()),
    el('span.round-arrow', { 'aria-hidden': 'true' }, '→'),
    el('b', w.word.toUpperCase()),
    el('span.round-first', w.first ? `${w.first.name} first, ${duration(w.first.seconds * 1000)}` : ''),
  )));
}

showWordsBox.addEventListener('change', () => {
  try {
    localStorage.setItem('adminShowWords', showWordsBox.checked ? '1' : '0');
  } catch {}
  if (overview) renderLive();
});

livePauseBtn.addEventListener('click', () => {
  livePaused = !livePaused;
  livePauseBtn.textContent = livePaused ? 'Resume updates' : 'Pause updates';
  refreshLive();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && liveOpen && !liveTimer) refreshLive();
});
whenActive.add(() => {
  if (liveOpen && !liveTimer) refreshLive();
});

registerTab('live', {
  open() {
    liveOpen = true;
    if (!overview) showLiveSkeleton();
    refreshLive();
  },
  close() {
    liveOpen = false;
    clearTimeout(liveTimer);
    liveTimer = null;
  },
});
