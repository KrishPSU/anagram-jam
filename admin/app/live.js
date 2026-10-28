// The Live tab: who's playing right now, room by room, with a way to close a room or take someone out of one. It asks
// again every few seconds while it's on screen. Each ask costs a couple of Redis commands, so it stops while the tab is
// hidden, paused, or nobody has touched the page for IDLE_AFTER.

const LIVE_EVERY = 5000;
const IDLE_AFTER = 10 * 60 * 1000;

const kpiEls = {
  players: document.getElementById('kpiPlayers'),
  playing: document.getElementById('kpiPlaying'),
  rooms: document.getElementById('kpiRooms'),
  games: document.getElementById('kpiGames'),
};
const deployLine = document.getElementById('deployLine');
const deployTitle = document.getElementById('deployTitle');
const deployText = document.getElementById('deployText');
const pausedLine = document.getElementById('pausedLine');
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
  } catch (err) {
    setState(liveStateEl, `${err.message} Trying again…`, { error: true });
  } finally {
    liveAsking = false;
  }
  if (liveOpen) liveTimer = setTimeout(refreshLive, LIVE_EVERY);
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

  roomsEmptyEl.hidden = rooms.length > 0;
  roomListEl.replaceChildren(...rooms.map(room => roomCard(room, now)));
  showUpdated();
}

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
    if (!overview) setState(liveStateEl, 'Loading…', { loading: true });
    refreshLive();
  },
  close() {
    liveOpen = false;
    clearTimeout(liveTimer);
    liveTimer = null;
  },
});
