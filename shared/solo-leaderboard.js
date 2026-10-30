// The leaderboard box, shared by the home page, the solo page and the Daily Jam page: any button with
// data-solo-leaderboard opens it - on its Daily tab when the button also has data-board="daily", on Solo otherwise.
// Solo is everyone's best score in two minutes; Daily is how today's Daily Jam players stand against each other. Each
// tab lists the top 10, then your own place if it's further down, and a Show more button that fetches the next 25 until
// everyone is listed. It's fetched fresh every time it opens or the tab changes, over the page's own connection
// (`socket` - home/script.js, solo/js/solo.js and daily/js/daily.js each have one). Names and avatars as everywhere
// else (/shared/players.js). The box itself is styled by the board-* rules in theme.css; what the tabs added is in
// board.css.

(() => {
  const FIRST = 10;      // rows when it opens
  const MORE = 25;       // and for each Show more (the server sends up to 50 - see board in solo.js and daily.js at the root)
  const WORDS_A_DAY = 3; // a Daily Jam is three words (LEVELS in daily.js at the project root)
  const MEDALS = ['🥇', '🥈', '🥉'];

  // What each tab asks the server for, and what it says about itself
  const TABS = {
    solo: {
      event: 'solo-board',
      note: "Everyone's best score in two minutes.",
      empty: "Nobody's played solo yet. Be the first!",
      row: soloRow,
    },
    daily: {
      event: 'daily-board',
      note: "Today's Daily Jam: most words, then fewest tries, then fastest.",
      empty: 'Nobody has finished a Daily Jam word yet today.',
      row: dailyRow,
    },
  };

  const dialog = document.createElement('dialog');
  dialog.className = 'board-dialog';
  dialog.setAttribute('aria-labelledby', 'boardTitle');
  dialog.innerHTML = `
    <form class="board-card card" method="dialog">
      <div class="board-head">
        <h2 id="boardTitle">🏆 Leaderboard</h2>
        <button class="board-close" aria-label="Close">×</button>
      </div>
      <div class="board-tabs" role="tablist" aria-label="Which leaderboard">
        <button type="button" role="tab" id="boardTabSolo" data-tab="solo" aria-selected="true" aria-controls="boardPanel">⏱ Solo</button>
        <button type="button" role="tab" id="boardTabDaily" data-tab="daily" aria-selected="false" aria-controls="boardPanel" tabindex="-1">📅 Daily</button>
      </div>
      <div class="board-panel" id="boardPanel" role="tabpanel" aria-labelledby="boardTabSolo">
        <p class="board-note"></p>
        <ol class="board-list"></ol>
        <div class="board-status" role="status"></div>
        <button class="btn btn-ghost btn-sm board-more" type="button" hidden><span class="spinner" aria-hidden="true"></span>Show more</button>
        <p class="board-count"></p>
      </div>
      <button class="btn btn-ghost">Close</button>
    </form>
  `;
  document.body.appendChild(dialog);

  const tabsEl = dialog.querySelector('.board-tabs');
  const panelEl = dialog.querySelector('.board-panel');
  const noteEl = dialog.querySelector('.board-note');
  const listEl = dialog.querySelector('.board-list');
  const statusEl = dialog.querySelector('.board-status');
  const moreBtn = dialog.querySelector('.board-more');
  const countEl = dialog.querySelector('.board-count');
  const doneBtn = dialog.querySelector('.board-card > .btn');

  let tab = 'solo';  // the tab showing: 'solo' or 'daily'
  let asked = 0;     // the latest ask - a slow reply to an earlier one, or to the other tab's, is ignored
  let shown = 0;     // rows listed so far, not counting your own row under the gap - and so the next ask's offset
  let players = 0;   // how many are on the board, as of the latest reply
  let you = null;    // your own place from the first reply ({ rank, name, ... }), or null when you aren't on it
  let gapEl = null;  // the "…" and your row under it, for as long as your rank is past the rows listed
  let youEl = null;

  function setStatus(content) {
    statusEl.replaceChildren(...content);
    statusEl.hidden = !content.length;
  }

  // Switches to a tab and fetches its first rows. Picking the tab that's already showing fetches them again.
  function select(next) {
    tab = next;
    for (const btn of tabsEl.querySelectorAll('[role="tab"]')) {
      const on = btn.dataset.tab === tab;
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
      if (on) panelEl.setAttribute('aria-labelledby', btn.id);
    }
    noteEl.textContent = TABS[tab].note;
    load();
  }

  // Today's date where the player is - same as localDay in daily/js/daily.js, so the Daily tab is about the day they're
  // playing
  function localDay() {
    const at = new Date();
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  }

  // Asks the tab's server event for `count` rows from `offset` down. callback gets the reply, or null when it didn't
  // come or wasn't ok - unless the box has closed or asked for something else since, when it isn't called at all.
  function fetchRows(count, offset, callback) {
    const ask = asked;
    // The token says which row is yours. Someone who has never played anything doesn't have one yet.
    const data = { token: localStorage.getItem('playerToken') || '', count, offset };
    if (tab === 'daily') data.day = localDay();
    socket.timeout(8000).emit(TABS[tab].event, data, (err, reply) => {
      if (ask !== asked || !dialog.open) return;
      callback(err || !reply || reply.status !== 'ok' ? null : reply);
    });
  }

  // The first rows of the tab showing, and your own place if it's further down
  function load() {
    asked++;
    shown = 0;
    players = 0;
    you = null;
    gapEl = youEl = null;
    listEl.replaceChildren();
    countEl.textContent = '';
    moreBtn.hidden = true;
    busy(false);
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    setStatus([spinner, 'Loading…']);
    fetchRows(FIRST, 0, (reply) => {
      if (!reply) {
        setStatus(["Couldn't load the leaderboard.", retryButton(load)]);
        return;
      }
      if (!reply.players) {
        setStatus([TABS[tab].empty]);
        return;
      }
      setStatus([]);
      you = reply.you;
      // Your own row goes under a gap while your rank is past the rows listed (append takes it away once they reach it).
      // Its name is the server's word on yours, else the one you go by here; whether you're signed in is the server's
      // word too, else what /shared/account.js found out.
      if (you && you.rank > FIRST) {
        gapEl = document.createElement('li');
        gapEl.className = 'board-gap';
        gapEl.textContent = '…';
        youEl = TABS[tab].row({
          ...you,
          name: you.name || localStorage.getItem('name') || 'You',
          you: true,
          account: you.account || (window.currentAccount ? window.currentAccount.provider : null),
        });
        listEl.append(gapEl, youEl);
      }
      append(reply);
    });
  }

  // Lists the reply's rows after the ones already there (above your own row, while that's still at the bottom), then
  // sets the count and Show more by what's left. The rows are a snapshot: someone finishing a run between two asks
  // can shift the ranks under them by one, which is fine for a glance at where everyone is.
  function append(reply) {
    const rows = reply.top.map(TABS[tab].row);
    if (gapEl) gapEl.before(...rows);
    else listEl.append(...rows);
    shown += reply.top.length;
    players = reply.players;
    if (youEl && you.rank <= shown) {
      gapEl.remove();
      youEl.remove();
      gapEl = youEl = null;
    }
    countEl.textContent = `${players} ${players === 1 ? 'player' : 'players'}`;
    // Everyone's listed - or the server has run out of rows, if the count and the rows disagree
    moreBtn.hidden = shown >= players || !reply.top.length;
  }

  // The next rows, under the ones listed
  function more() {
    // One ask at a time: a second tap (on Try again, say, which stays while the ask is out) would add the same rows twice
    if (moreBtn.disabled) return;
    // Disabling the button for the wait drops the keyboard focus, so whoever was on it (or on Try again after a miss)
    // is put back on it afterwards - or on the Close button under it, once it has gone
    const hadFocus = document.activeElement === moreBtn || statusEl.contains(document.activeElement);
    busy(true);
    fetchRows(MORE, shown, (reply) => {
      busy(false);
      if (!reply) {
        // Said in the box, where the button was: a toast would be behind it (a modal dialog is above everything else)
        const retry = retryButton(more);
        moreBtn.hidden = true;
        setStatus(["Couldn't load the rest.", retry]);
        if (hadFocus) retry.focus();
        return;
      }
      setStatus([]);
      append(reply);
      if (hadFocus) (moreBtn.hidden ? doneBtn : moreBtn).focus();
    });
  }

  // Show more while it waits on the server: its spinner on, and no second ask
  function busy(loading) {
    moreBtn.disabled = loading;
    moreBtn.classList.toggle('is-loading', loading);
  }

  function retryButton(onClick) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-ghost btn-sm';
    retry.textContent = 'Try again';
    retry.addEventListener('click', onClick);
    return retry;
  }

  // The start every row shares: place, avatar and name - with a ✓ after the name of someone who's signed in (see
  // /shared/account.js). kind is the tab, for the Daily rows' own layout in board.css.
  function rowStart(kind, { rank, name, you, account }) {
    const item = document.createElement('li');
    item.className = `board-row ${kind}` + (you ? ' you' : '');
    const label = span('name', '');
    label.append(span('text', you ? `${name} (you)` : name));
    if (account) {
      const badge = span('board-badge', '✓');
      badge.setAttribute('role', 'img');
      badge.setAttribute('aria-label', 'Signed in');
      badge.title = 'Signed in';
      label.append(badge);
    }
    item.append(span('place', MEDALS[rank - 1] || String(rank)), avatarEl(name), label);
    return item;
  }

  // words: how many words the run got (null if that wasn't kept)
  function soloRow(row) {
    const item = rowStart('solo', row);
    if (typeof row.words === 'number') item.append(span('words', `${row.words} ${row.words === 1 ? 'word' : 'words'}`));
    item.append(span('pts', `${row.points} pts`));
    return item;
  }

  // got: words got right out of today's three. tries and ms add up over those, so someone who finished a word without
  // getting it has neither to show - their places stay, blank, so the columns line up.
  function dailyRow(row) {
    const item = rowStart('daily', row);
    const stats = span('board-stats', '');
    stats.append(
      span('words', `${row.got}/${WORDS_A_DAY} words`),
      span('tries', typeof row.tries === 'number' ? `${row.tries} ${row.tries === 1 ? 'try' : 'tries'}` : ''),
      span('time', typeof row.ms === 'number' ? formatTime(row.ms) : ''),
    );
    item.append(stats);
    return item;
  }

  function span(className, text) {
    const node = document.createElement('span');
    node.className = className;
    node.textContent = text;
    return node;
  }

  // 0:41 - or 1:02:41 past an hour, as formatTime in daily/js/daily.js has it (the clock doesn't stop on a word left open)
  function formatTime(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor(seconds / 60) % 60;
    const s = String(seconds % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  document.querySelectorAll('[data-solo-leaderboard]').forEach(btn => btn.addEventListener('click', () => {
    dialog.showModal();
    dialog.querySelector('.board-card').scrollTop = 0;
    select(btn.dataset.board === 'daily' ? 'daily' : 'solo');
  }));

  tabsEl.addEventListener('click', (event) => {
    const btn = event.target.closest('[role="tab"]');
    if (btn) select(btn.dataset.tab);
  });

  // The arrow keys move between the tabs too, as a keyboard user expects of tabs
  tabsEl.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'solo' : event.key === 'End' ? 'daily' : tab === 'solo' ? 'daily' : 'solo';
    select(next);
    tabsEl.querySelector(`[data-tab="${next}"]`).focus();
  });

  moreBtn.addEventListener('click', more);

  // Tapping outside the box closes it
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
})();
