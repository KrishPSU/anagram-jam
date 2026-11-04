// Your account, on every page that has a connection to the server (`socket` - home/script.js, solo/js/solo.js,
// daily/js/daily.js and create-room/js/lobby.js each make one). Signing in with Google or Apple ties this device to an
// account, so one score follows you from your phone to your laptop: the server merges each device's history into the
// account (see link_account in supabase/migrations) and the leaderboards show the account's name.
//
// Once connected, this asks the server whose device this is ('account-get') and tells the rest of the page:
// window.currentAccount, and an 'account' event on window with the account (or null, signed out). home/script.js
// locks the name field to the account's name on it, and /shared/analytics.js knows PostHog's visitor by the account's
// id. The account's name is also kept as the `name` the pages go by, so a signed-in player is never asked for one.
//
// The box itself opens from any [data-account] button (the home page has one; the other pages only ask), and the
// button wears the account: its Google photo, else its initial on its color - 👤 while signed out. Signed out, the box
// offers the providers the server has; signed in, it's the photo and the name (editable), then the player's stats in
// tabs - Solo, Daily, Rooms and Awards, asked for each time it opens ('account-stats', worked out in profile.js at the
// project root) - then the provider and the devices, Sign out and Delete account. The server's side of the rest is
// account.js at the project root.
//
// Signing in is Supabase Auth's PKCE flow without its library: a random verifier is kept in localStorage (`signIn`)
// and its hash goes along to Supabase's authorize page, which comes back to /account/callback with a code. That page
// sends the code and the verifier to the server, which swaps them with Supabase for who you are and links the device
// (see /account/callback.js). No Supabase token ever reaches the browser.

(() => {
  const ASK_TIMEOUT = 5000;
  const SIGN_IN_KEY = 'signIn';        // localStorage: { verifier, returnTo, at } while a sign-in is out
  const SIGNED_IN_FLAG = 'signedInAs'; // sessionStorage: the name, left by /account/callback.js on the way back
  const NAME_MAX = 20;                 // as cleanName in solo.js at the project root
  const SIGN_IN_FOR = 10 * 60 * 1000;  // a sign-in out longer than this isn't trusted by the callback page, so it's cleared
  const STATS_TIMEOUT = 8000;          // for 'account-stats', which has more to add up than the other asks
  const WORDS_A_DAY = 3;               // a Daily Jam is three words (LEVELS in daily.js at the project root)
  const RUN_SLOTS = 20;                // the runs chart has room for the last 20 runs, as many as the server sends

  // Practice and the info pages have no connection, and only the home page has the button
  const link = typeof socket !== 'undefined' && socket && typeof socket.emit === 'function' ? socket : null;
  const buttons = [...document.querySelectorAll('[data-account]')];
  if (!link && !buttons.length) return;

  // A sign-in that never came back (Google's page closed, say) would leave its verifier on the device for good; one
  // older than the callback page would take (see /account/callback.js) is cleared here, on the next page
  try {
    const started = JSON.parse(localStorage.getItem(SIGN_IN_KEY) || 'null');
    if (started && !(Date.now() - started.at < SIGN_IN_FOR)) localStorage.removeItem(SIGN_IN_KEY);
  } catch {
    localStorage.removeItem(SIGN_IN_KEY);
  }

  // The iPhone app (mobile/): its web view shows anagramjam.com and hands any other site to Safari, where a sign-in
  // can't finish (the verifier is in the app's own storage). Build 2 lets Supabase's and Apple's pages through
  // (allowNavigation in mobile/capacitor.config.json), so Apple works in it, as a plain form; Google never signs
  // anyone in inside an app's web view, so there it's for the website. From build 3 both run in iOS's sign-in sheet
  // instead (the AuthSession plugin, mobile/ios/App/App/AuthSessionPlugin.swift), where Google works and Apple shows
  // its own sheet. The build is in the app's user agent (AnagramJamApp/N); old builds run this script too, so the
  // plugin is looked for rather than assumed.
  const inApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const appBuild = inApp ? Number((navigator.userAgent.match(/AnagramJamApp\/(\d+)/) || [])[1]) || 1 : 0;
  const appCanSignIn = !inApp || appBuild >= 2;
  const authSession = inApp && window.Capacitor.isPluginAvailable && window.Capacitor.isPluginAvailable('AuthSession')
    ? window.Capacitor.Plugins.AuthSession : null;

  const PROVIDERS = {
    google: {
      label: 'Google',
      logo: `<svg viewBox="0 0 48 48" aria-hidden="true">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
      </svg>`,
    },
    apple: {
      label: 'Apple',
      logo: `<svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/>
      </svg>`,
    },
  };

  // The stats' tabs: what each is called, and what draws it from the stats
  const TABS = [
    { id: 'solo', icon: '⏱', label: 'Solo', draw: soloStats },
    { id: 'daily', icon: '📅', label: 'Daily', draw: dailyStats },
    { id: 'rooms', icon: '🏁', label: 'Rooms', draw: roomStats },
    { id: 'awards', icon: '🏅', label: 'Awards', draw: awardStats },
  ];

  let account;       // undefined until the server has said; then null (signed out) or { id, provider, name, devices, avatar }
  let config = null; // /shared/config.js's word, once it's here
  let asked = 0;     // the latest 'account-get' - a slow reply to an earlier one is ignored
  let busy = false;  // a request from the box is out
  let painted = null; // what the account button shows: '' for 👤, else the account's photo and name it was drawn from
  const brokenPhotos = new Set(); // photo addresses that wouldn't load here - the initial stands in for them from then on

  // The box (only the home page has a button for it)
  let dialog = null;
  let bodyEl = null;
  let liveEl = null;      // what screen readers hear about the stats (see say)
  let editing = false;    // the name is being changed
  let confirming = false; // Delete account has been tapped once
  let focusInput = false; // the name box was just opened, or kept after a failed save: the cursor goes in it
  let message = '';       // what went wrong with the last thing tried, shown in the box (a toast would be under it)

  // The account's stats, in the box while signed in
  let stats = null;         // the latest the server sent (as tidyStats has them), or null before any came
  let statsOf = null;       // whose those are (the account's id) - another account's are never shown
  let statsAsked = 0;       // the latest 'account-stats' - a slow reply to an earlier one is ignored
  let statsFailed = false;  // the latest ask got nothing back
  let tab = 'solo';         // the tab showing, kept while the page is open
  let month = '';           // the month the Daily tab's calendar shows ('2026-10'), '' for this one
  let sinceEl = null;       // while the box shows a signed-in account: the line under the name...
  let statsEl = null;       // ...and the stats

  // Back from Google's or Apple's page without finishing, with the browser restoring this page as it was left: the box
  // was waiting on a sign-in that isn't coming, so it's given back
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && busy) {
      busy = false;
      render();
    }
  });


  // ---------- Whose device this is ----------

  function ask() {
    const thisAsk = ++asked;
    link.timeout(ASK_TIMEOUT).emit('account-get', { token: ensurePlayerToken() }, (err, reply) => {
      if (thisAsk !== asked) return;
      if (err || !reply || reply.status !== 'ok') {
        // Nothing to go on (an older server, or the connection blinked): signed out as far as this page can tell.
        // The next connection asks again.
        if (account === undefined) setAccount(null);
        return;
      }
      setAccount(reply.account || null, true);
    });
  }

  // The server's word, to everything that cares. keep (an ask's answer): if it's the account the box shows already,
  // the box is left as it is - every reconnect asks again, and drawing the box afresh would lose the keyboard's place
  // in it, and a name being typed.
  function setAccount(next, keep = false) {
    const same = keep && !!account && !!next && ['id', 'name', 'avatar', 'provider', 'devices'].every(key => account[key] === next[key]);
    account = next;
    window.currentAccount = next;
    // Signed out, or found to be: whatever the last thing tried said is about an account this device no longer has
    if (!next) message = '';
    // And the stats kept here are only ever the account's that's signed in
    if (!next || next.id !== statsOf) {
      stats = statsOf = null;
      statsFailed = false;
    }
    if (next && next.name) localStorage.setItem('name', next.name);
    paintButtons(next);
    if (next && typeof window.analyticsIdentify === 'function') window.analyticsIdentify(next.id);
    if (!next && typeof window.analyticsReset === 'function') window.analyticsReset();
    window.dispatchEvent(new CustomEvent('account', { detail: next }));
    if (!same) render();
    // Signed in, renamed or reconnected with the box open: its stats are asked for again, and slip in (see fillStats)
    if (next && dialog && dialog.open) loadStats();
  }

  // The account button wears the account: its photo, else its initial on its color - and 👤 signed out. Only drawn
  // again when that changes, so a reconnect's ask doesn't load the photo all over again.
  function paintButtons(next) {
    const look = next ? `${next.avatar || ''} ${next.name || ''}` : '';
    if (look === painted) return;
    painted = look;
    buttons.forEach((btn) => {
      btn.classList.toggle('is-signed-in', !!next);
      const circle = btn.querySelector('i');
      if (circle) circle.replaceChildren(next ? photoEl(next) : '👤');
    });
  }

  // An account's picture: its Google photo, or its initial on its color (as avatarEl draws everyone's) when it has
  // none or the photo won't load. Only an https address is shown, and fetched without saying which page asked - and
  // PostHog (/shared/analytics.js) never gets it: ph-no-capture leaves a blank of its size in replays, and a tap on it
  // isn't recorded (the home page's button lets taps through it, so they're still the button's - see home/styles.css).
  function photoEl(acct) {
    const src = typeof acct.avatar === 'string' && acct.avatar.startsWith('https://') ? acct.avatar : '';
    if (!src || brokenPhotos.has(src)) return initialEl(acct.name);
    const img = make('img', 'account-photo ph-no-capture');
    img.alt = '';
    img.setAttribute('referrerpolicy', 'no-referrer');
    img.addEventListener('error', () => {
      brokenPhotos.add(src);
      img.replaceWith(initialEl(acct.name));
    }, { once: true });
    img.src = src;
    return img;
  }

  function initialEl(name) {
    return typeof avatarEl === 'function' ? avatarEl(name) : make('span', 'avatar', '?');
  }

  // Sends something the server answers; resolves to its reply, or null when none came
  function send(event, data) {
    return new Promise((resolve) => {
      if (!link) {
        resolve(null);
        return;
      }
      link.timeout(ASK_TIMEOUT).emit(event, data, (err, reply) => resolve(err ? null : reply || null));
    });
  }

  // Asked on every connection: the room page's socket connects on DOMContentLoaded (lobby.js), and a connection that
  // was replaced after a dropped one asks again, which also covers an ask that went unanswered
  if (link) {
    link.on('connect', ask);
    if (link.connected) ask();
  }

  siteConfig().then((c) => {
    config = c;
    render();
  });

  // Back from /account/callback (see callback.js): say so
  const signedInAs = sessionStorage.getItem(SIGNED_IN_FLAG);
  if (signedInAs !== null) {
    sessionStorage.removeItem(SIGNED_IN_FLAG);
    whenReady(() => {
      showAlert(`${signedInAs ? `Signed in as ${signedInAs}.` : 'Signed in.'} Your scores on this device are now one with your account.`, 'success', 7000);
    });
  }

  // Every script on the page has run (toast.js's included)
  function whenReady(callback) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', callback);
    else callback();
  }


  // ---------- The box ----------

  if (buttons.length) {
    // Made like the leaderboard's box (shared/solo-leaderboard.js) - its head and close button are reused as they are
    dialog = document.createElement('dialog');
    dialog.className = 'account-dialog';
    dialog.setAttribute('aria-labelledby', 'accountTitle');
    dialog.innerHTML = `
      <form class="account-card card" method="dialog">
        <div class="board-head">
          <h2 id="accountTitle">Account</h2>
          <button class="board-close" aria-label="Close">×</button>
        </div>
        <div class="account-body"></div>
        <p class="sr-only" role="status"></p>
      </form>
    `;
    document.body.appendChild(dialog);
    bodyEl = dialog.querySelector('.account-body');
    liveEl = dialog.querySelector('.account-card > [role="status"]');

    buttons.forEach(btn => btn.addEventListener('click', () => {
      editing = false;
      confirming = false;
      message = '';
      render();
      dialog.showModal();
      dialog.querySelector('.account-card').scrollTop = 0;
      // Fresh stats every time it opens (the last ones show meanwhile)
      if (account) loadStats();
    }));

    // Tapping outside the box closes it
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  function render() {
    if (!dialog || busy) return;
    sinceEl = statsEl = null;
    let parts;
    if (!config || (link && account === undefined)) parts = loading();
    else if (!config.accounts.enabled) parts = [status("Signing in isn't set up on this server.")];
    else parts = account ? signedIn() : signedOut();
    // No stats in the box, so nothing about them for screen readers (signedIn's fillStats says how they stand)
    if (!statsEl) say('');
    if (message) {
      const note = make('p', 'account-msg', message);
      note.setAttribute('role', 'alert');
      // Under the name box while it's open (a save that didn't go through), else at the bottom, under the buttons -
      // either way next to what it's about, with the stats in between
      parts.splice(account && editing ? 1 : parts.length, 0, note);
    }
    bodyEl.replaceChildren(...parts);
    if (focusInput) {
      focusInput = false;
      const input = bodyEl.querySelector('.account-input');
      if (input) {
        input.focus();
        input.select();
      }
    }
  }

  function signedOut() {
    const parts = [
      make('p', 'account-note', 'Sign in to keep one score across your phone and laptop. Your best from each device is merged, and the leaderboards show your name.'),
      // What's kept for everyone is only shown to those signed in (see signedIn)
      make('p', 'account-invite', '📊 Sign in to see your stats too: your runs, your Daily Jam streak, your wins and your awards.'),
    ];
    const providers = config.accounts.providers.filter(p => PROVIDERS[p]);
    if (!window.isSecureContext || !crypto.subtle) {
      // PKCE needs SHA-256, which browsers only give to pages on https (or localhost)
      parts.push(status('Needs a secure connection (https) to sign in.'));
    } else {
      const offered = appCanSignIn ? providers.filter(p => !(inApp && !authSession && p === 'google')) : [];
      if (offered.length) {
        const actions = make('div', 'account-actions');
        actions.append(...offered.map(providerButton));
        parts.push(actions);
      }
      if (inApp && !appCanSignIn) parts.push(status("This version of the app can't sign in yet. Sign in on the website, anagramjam.com, for now - the app's next update will have it."));
      else if (inApp && !authSession && providers.includes('google')) parts.push(make('p', 'account-fine', 'Google sign-in works on the website, anagramjam.com.'));
      if (!providers.length) parts.push(status('No way to sign in is set up on this server.'));
    }
    const fine = make('p', 'account-fine');
    fine.append('Google or Apple tells us your name and email, and Google your profile photo. What we keep is in the ', anchor('/privacy', 'privacy policy'), '.');
    parts.push(fine);
    return parts;
  }

  function providerButton(provider) {
    const { label, logo } = PROVIDERS[provider];
    const btn = make('button', `btn btn-${provider}`);
    btn.type = 'button';
    btn.innerHTML = logo;
    btn.append(`Continue with ${label}`);
    btn.addEventListener('click', () => signIn(provider, btn));
    return btn;
  }

  function signedIn() {
    const { name, provider, devices } = account;

    // Who you are: the photo, the name and the pencil - or the name box, Save and × - and, under them, since when
    // and how many words (from the stats)
    const who = make('div', 'account-who');
    const id = make('div', 'account-id');
    const nameRow = make('div', 'account-name-row');
    sinceEl = make('p', 'account-since');
    id.append(nameRow, sinceEl);
    who.append(photoEl(account), id);
    if (editing) {
      const input = make('input', 'account-input');
      input.type = 'text';
      input.value = name;
      input.maxLength = NAME_MAX;
      input.placeholder = 'Your name';
      input.autocomplete = 'nickname';
      input.enterKeyHint = 'done';
      input.setAttribute('aria-label', 'Your name');
      const save = make('button', 'btn btn-primary btn-sm');
      save.type = 'button';
      save.innerHTML = '<span class="spinner" aria-hidden="true"></span>Save';
      save.addEventListener('click', () => saveName(input, save));
      const cancel = iconButton('×', 'Cancel');
      cancel.addEventListener('click', () => {
        editing = false;
        render();
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault(); // in a method="dialog" form, Enter would close the box
          saveName(input, save);
        } else if (event.key === 'Escape') {
          event.preventDefault(); // and Escape too - here it only puts the pencil back
          editing = false;
          render();
        }
      });
      // Save and × go together, under the name box when they can't fit beside it
      const saveRow = make('span', 'account-rename');
      saveRow.append(save, cancel);
      nameRow.append(input, saveRow);
    } else {
      const startEditing = () => {
        editing = true;
        focusInput = true;
        message = '';
        render();
      };
      const edit = iconButton('✏️', 'Change your name');
      edit.addEventListener('click', startEditing);
      const nameEl = make('span', 'account-name' + (name ? '' : ' unnamed'), name || 'Pick a name');
      if (!name) {
        // "Pick a name" is an invitation, so the words open the editor too, not just the pencil
        nameEl.setAttribute('role', 'button');
        nameEl.tabIndex = 0;
        nameEl.addEventListener('click', startEditing);
        nameEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            startEditing();
          }
        });
      }
      nameRow.append(nameEl, edit);
    }

    // The stats, as they stand (see fillStats) - asked for afresh when the box opens
    statsEl = make('div', 'account-stats');
    // Somewhere for the keyboard's place to go when what had it is swapped out (see fillStats)
    statsEl.tabIndex = -1;
    fillStats();

    const label = PROVIDERS[provider] ? PROVIDERS[provider].label : provider;
    const meta = make('p', 'account-meta', `Signed in with ${label} · ${devices} ${devices === 1 ? 'device' : 'devices'}`);

    const actions = make('div', 'account-actions');
    const out = make('button', 'btn btn-ghost');
    out.type = 'button';
    out.innerHTML = '<span class="spinner" aria-hidden="true"></span>Sign out on this device';
    out.addEventListener('click', () => unlink(out));
    actions.append(out);

    // Delete account asks twice: the first tap opens the question, the second answers it
    if (confirming) {
      const box = make('div', 'account-confirm');
      box.append(make('p', '', "Delete your account? Your scores, stats, Daily Jam records and streaks go with it, on every device. This can't be undone."));
      const row = make('div', 'account-actions');
      const yes = make('button', 'btn btn-danger btn-sm');
      yes.type = 'button';
      yes.innerHTML = '<span class="spinner" aria-hidden="true"></span>Delete everything';
      yes.addEventListener('click', () => remove(yes));
      const no = make('button', 'btn btn-ghost btn-sm', 'Keep it');
      no.type = 'button';
      no.addEventListener('click', () => {
        confirming = false;
        render();
      });
      row.append(yes, no);
      box.append(row);
      actions.append(box);
    } else {
      const del = make('button', 'btn btn-ghost btn-sm account-delete', 'Delete account');
      del.type = 'button';
      del.addEventListener('click', () => {
        confirming = true;
        message = '';
        render();
      });
      actions.append(del);
    }

    return [who, statsEl, meta, actions];
  }


  // ---------- Signed in: your stats ----------

  // Asks the server for the account's stats - each time the box opens while signed in, and after a sign-in, a new
  // name or a reconnect (see setAccount). The last ones show meanwhile; until the first have come, a skeleton does.
  function loadStats() {
    if (!link || !account) return;
    const thisAsk = ++statsAsked;
    const askedFor = account.id;
    statsFailed = false;
    fillStats();
    link.timeout(STATS_TIMEOUT).emit('account-stats', { token: ensurePlayerToken(), day: localDay() }, (err, reply) => {
      // A slow reply to an earlier ask is ignored, and so is one about an account this device has left since
      if (thisAsk !== statsAsked || !account || account.id !== askedFor) return;
      if (err || !reply || reply.status !== 'ok' || !reply.stats || typeof reply.stats !== 'object') {
        statsFailed = true;
      } else {
        stats = tidyStats(reply.stats);
        statsOf = askedFor;
      }
      fillStats();
      // 'bad': this device isn't signed in any more (signed out in another tab, say, or the account deleted on another
      // device) - the server's word on whose it is replaces the box, as when a name won't save
      if (reply && reply.status === 'bad') ask();
    });
  }

  // The line under the name and the stats under it, as they stand: the account's latest stats, else a skeleton while
  // the first are on their way - or what went wrong, with Try again. Done in place, even while the box waits on
  // something else, so fresh stats slip in quietly: the same tab and month, and the keyboard's place kept.
  function fillStats() {
    if (!statsEl) return;
    const mine = stats && account && statsOf === account.id ? stats : null;
    const hadFocus = statsEl.contains(document.activeElement);
    const focusKey = hadFocus ? document.activeElement.dataset.focus || '' : '';
    // The latest ask got nothing back: said over the last stats, if there are some
    const trouble = !statsFailed ? '' : mine ? "Couldn't get your latest stats." : "Couldn't load your stats.";

    if (mine) sinceEl.replaceChildren(...sinceLine(mine));
    else sinceEl.replaceChildren(...(statsFailed ? [] : [skel('skel-line', { '--w': '80%' })]));
    sinceEl.hidden = !mine && statsFailed;

    const parts = [];
    if (trouble) parts.push(statsTrouble(trouble, !!mine));
    if (mine) parts.push(...statTabs(mine));
    else if (!statsFailed) parts.push(statsSkeleton());
    statsEl.replaceChildren(...parts);
    statsEl.setAttribute('aria-busy', String(!mine && !statsFailed));
    // And screen readers hear it (the skeleton and the trouble say nothing themselves) - nothing once the stats are in
    say(trouble || (mine ? '' : 'Loading your stats…'));
    // While the box waits on the server for something else (a new name, say), these can't be pressed either
    if (busy) statsEl.querySelectorAll('button').forEach((btn) => { btn.disabled = true; });

    // Whatever had the keyboard is back on its new self - or, if it's gone, on the tab showing, else Try again - without
    // scrolling the box to it
    if (hadFocus) {
      const candidates = [
        focusKey && statsEl.querySelector(`[data-focus="${focusKey}"]`),
        statsEl.querySelector('[aria-selected="true"]'),
        statsEl.querySelector('button'),
      ];
      (candidates.find(el => el && !el.disabled) || statsEl).focus({ preventScroll: true });
    }
  }

  // What screen readers hear about the stats - that they're loading, that they couldn't be got, the calendar's
  // month - through the one line that's always in the box, outside what render() draws afresh: a line that comes with
  // its words already in it isn't always read out. Only while the box is open (said before it opens, the same words
  // after it has wouldn't be news), and only when the words change.
  function say(text) {
    const words = dialog.open ? text : '';
    if (liveEl.textContent !== words) liveEl.textContent = words;
  }

  // "Playing since Oct 28, 2026 · 2,431 words" - each half kept whole, so a narrow box breaks the line between them
  function sinceLine({ since, words }) {
    const bits = [];
    if (since) bits.push(`Playing since ${new Date(since).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`);
    if (words) bits.push(plural(words, 'word'));
    if (!bits.length) bits.push('New here - welcome!');
    return bits.flatMap((bit, i) => (i ? [' · ', make('span', '', bit)] : [make('span', '', bit)]));
  }

  // The latest ask got no stats: `text` says so where they go - a toast would be under the box - with a way to ask
  // again; the last ones, if any (stale), stay under it. Screen readers are told through say (see fillStats).
  function statsTrouble(text, stale) {
    const retry = make('button', 'btn btn-ghost btn-sm', 'Try again');
    retry.type = 'button';
    retry.dataset.focus = 'retry';
    retry.addEventListener('click', () => loadStats());
    const box = make('div', stale ? 'account-stale' : 'board-status');
    box.append(make('span', '', text), retry);
    return box;
  }

  // Standing in for the stats until the first come: the tabs, and two rows of tiles (that they're loading, screen
  // readers hear through say - see fillStats)
  function statsSkeleton() {
    const shape = make('div', 'account-stats-skel');
    shape.setAttribute('aria-hidden', 'true');
    const tiles = make('div', 'account-tiles skel-fade');
    for (let i = 0; i < 4; i++) tiles.append(skel('skel-block', { '--h': '74px' }));
    shape.append(skel('skel-block', { '--h': '40px' }), tiles);
    return shape;
  }

  // The server's stats (see profile.js at the project root) with everything drawn here there and of the right kind, so
  // drawing them can't trip over a missing one - from an older server, say: a count that isn't one is 0, a value that
  // may not be there yet is null, and a list is a list.
  function tidyStats(raw) {
    const group = value => (value && typeof value === 'object' ? value : {});
    const list = value => (Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : []);
    const count = value => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
    const amount = value => (Number.isFinite(value) ? value : null);
    const place = value => (Number.isFinite(value) && value >= 1 ? Math.round(value) : null);
    const isDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

    const solo = group(raw.solo);
    const best = group(solo.best);
    const daily = group(raw.daily);
    const streak = group(daily.streak);
    const today = group(daily.today);
    const finish = group(daily.bestFinish);
    const fastest = group(daily.fastest);
    const tries = Array.isArray(daily.tries) ? daily.tries : [];
    const rooms = group(raw.rooms);
    return {
      since: count(raw.since) || null,
      words: count(raw.words),
      solo: {
        best: Number.isFinite(best.points) ? { points: count(best.points), words: amount(best.words) } : null,
        rank: place(solo.rank),
        players: count(solo.players),
        bestRank: place(solo.bestRank),
        runs: count(solo.runs),
        average: amount(solo.average),
        recentAverage: amount(solo.recentAverage),
        wordsPerMinute: amount(solo.wordsPerMinute),
        recent: list(solo.recent).map(run => ({ points: count(run.points), words: count(run.words), at: count(run.at) || null })),
        longest: typeof solo.longest === 'string' && solo.longest ? solo.longest : null,
        quick: amount(solo.quick),
      },
      daily: {
        streak: { current: count(streak.current), best: count(streak.best) },
        days: count(daily.days),
        finished: count(daily.finished),
        got: count(daily.got),
        tries: [0, 1, 2].map(i => count(tries[i])),
        missed: count(daily.missed),
        perfect: count(daily.perfect),
        today: { rank: place(today.rank), players: count(today.players) },
        bestFinish: place(finish.rank) && isDay(finish.day) ? { rank: place(finish.rank), day: finish.day, players: count(finish.players) } : null,
        fastest: { easy: amount(fastest.easy), medium: amount(fastest.medium), hard: amount(fastest.hard) },
        // Oldest first, as the calendar's ‹ goes back to the first
        calendar: list(daily.calendar).filter(entry => isDay(entry.day))
          .map(entry => ({ day: entry.day, got: count(entry.got), finished: count(entry.finished) }))
          .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
      },
      rooms: { rounds: count(rooms.rounds), wins: count(rooms.wins), podiums: count(rooms.podiums), best: amount(rooms.best) },
      awards: list(raw.awards).filter(award => typeof award.title === 'string').map((award) => {
        const need = count(award.need) || 1;
        return {
          icon: typeof award.icon === 'string' && award.icon ? award.icon : '🏅',
          title: award.title,
          detail: typeof award.detail === 'string' ? award.detail : '',
          got: !!award.got,
          have: Math.min(count(award.have), need),
          need,
        };
      }),
    };
  }

  // The tabs, and the one showing - made like the leaderboard box's (shared/solo-leaderboard.js), arrow keys and all
  function statTabs(mine) {
    const list = make('div', 'account-tabs');
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', 'Your stats');
    const panel = make('div', 'account-panel');
    panel.id = 'accountPanel';
    panel.setAttribute('role', 'tabpanel');

    const tabButtons = TABS.map(({ id, icon, label }) => {
      const btn = make('button');
      btn.type = 'button';
      btn.id = `accountTab-${id}`;
      btn.dataset.tab = id;
      btn.dataset.focus = `tab-${id}`;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-controls', panel.id);
      const emoji = make('span', 'account-tab-icon', icon);
      emoji.setAttribute('aria-hidden', 'true');
      btn.append(emoji, make('span', '', label));
      return btn;
    });
    list.append(...tabButtons);

    // Switches to a tab: the buttons say which, and the panel draws it
    const show = (next) => {
      tab = next;
      tabButtons.forEach((btn) => {
        const on = btn.dataset.tab === tab;
        btn.setAttribute('aria-selected', String(on));
        btn.tabIndex = on ? 0 : -1;
        if (on) panel.setAttribute('aria-labelledby', btn.id);
      });
      panel.replaceChildren(...TABS.find(t => t.id === tab).draw(mine));
    };

    list.addEventListener('click', (event) => {
      const btn = event.target.closest('[role="tab"]');
      if (btn) show(btn.dataset.tab);
    });

    // The arrow keys move between the tabs too, as a keyboard user expects of tabs
    list.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const at = TABS.findIndex(t => t.id === tab);
      const to = event.key === 'Home' ? 0
        : event.key === 'End' ? TABS.length - 1
          : (at + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
      show(TABS[to].id);
      tabButtons[to].focus();
    });

    show(TABS.some(t => t.id === tab) ? tab : TABS[0].id);
    return [list, panel];
  }

  // ⏱ Solo: their best and where it stands, how their runs go, and the last few as a chart
  function soloStats({ solo }) {
    const { best, runs } = solo;
    if (!best && !runs) return [empty('Play a solo run and your numbers show up here.')];
    const tiles = [];
    if (best) tiles.push(tile('Best', withUnit(best.points, 'pts'), best.words === null ? '' : plural(best.words, 'word')));
    if (solo.rank) tiles.push(tile('Rank', `#${solo.rank.toLocaleString()}`, rankLine(solo.rank, solo.players)));
    if (solo.bestRank) tiles.push(tile('Highest rank', `#${solo.bestRank.toLocaleString()}`));
    if (runs) tiles.push(tile('Runs', runs.toLocaleString()));
    // "last 10" only says something new once there have been more than 10
    if (solo.average !== null) {
      tiles.push(tile('Average', decimal(solo.average), runs > 10 && solo.recentAverage !== null ? `last 10: ${decimal(solo.recentAverage)}` : ''));
    }
    if (solo.wordsPerMinute !== null) tiles.push(tile('Word rate', decimal(solo.wordsPerMinute), 'words a minute'));
    if (solo.quick !== null) tiles.push(tile('Quick answers', `${Math.round(solo.quick * 100)}%`, 'under 3 seconds'));
    if (solo.longest) tiles.push(longestTile(solo.longest));
    const parts = [tileGrid(tiles)];
    // A best from before runs were counted: why the rest isn't here yet
    if (!runs) parts.push(statsNote("Runs, averages and the rest count from this update on - they weren't kept before. Your next run starts them."));
    if (solo.recent.length > 1) parts.push(runsChart(solo.recent));
    return parts;
  }

  // "of 15 · top 14%" - the share only for the top half, and not for 1st, where #1 says it all
  function rankLine(rank, players) {
    if (!players) return '';
    const share = Math.max(1, Math.ceil((100 * rank) / players));
    return `of ${players.toLocaleString()}${rank > 1 && share <= 50 ? ` · top ${share}%` : ''}`;
  }

  // The longest answer they've got, as the game's letter tiles - as big as fit across the box
  function longestTile(word) {
    const letters = [...word.toUpperCase()].slice(0, 15);
    const row = make('span', 'account-word');
    row.style.setProperty('--letters', letters.length);
    row.setAttribute('aria-hidden', 'true');
    row.append(...letters.map(letter => make('span', 'tile', letter)));
    const shown = document.createDocumentFragment();
    shown.append(row, make('span', 'sr-only', word));
    return tile('Longest word', shown, plural(letters.length, 'letter'), true);
  }

  // Their last runs' points as a little bar chart - oldest on the left, the best of them picked out - with room for
  // RUN_SLOTS, so it fills in as they play. Pointing at a bar says what that run was.
  function runsChart(recent) {
    const runs = recent.slice(-RUN_SLOTS);
    const points = runs.map(run => run.points);
    const top = Math.max(...points);
    const best = points.lastIndexOf(top);
    const slot = 10;
    const height = 48;
    const svg = svgEl('svg', { class: 'account-runs', viewBox: `0 0 ${RUN_SLOTS * slot} ${height}`, role: 'img' });
    svg.setAttribute('aria-label', `Points in your last ${plural(runs.length, 'run')}, oldest first: ${points.map(n => n.toLocaleString()).join(', ')}. Best: ${top.toLocaleString()}.`);
    svg.append(svgEl('line', { class: 'base', x1: 0, y1: height - 0.5, x2: RUN_SLOTS * slot, y2: height - 0.5, 'vector-effect': 'non-scaling-stroke' }));
    runs.forEach((run, i) => {
      // A run of 0 still gets a sliver, so it's there
      const barHeight = Math.max(1, Math.round((run.points / Math.max(1, top)) * (height - 2)));
      const bar = svgEl('g', i === best ? { class: 'best' } : {});
      const tip = svgEl('title');
      tip.textContent = [`${run.points.toLocaleString()} pts`, plural(run.words, 'word'), run.at ? dateText(new Date(run.at)) : ''].filter(Boolean).join(' · ');
      // The whole slot answers the pointer, not just the bar in it
      bar.append(tip, svgEl('rect', { class: 'hit', x: i * slot, y: 0, width: slot, height }), svgEl('path', { d: barPath(i * slot + 1.5, slot - 3, barHeight, height) }));
      svg.append(bar);
    });
    const key = make('span', 'account-key');
    key.append(make('i'), `best ${top.toLocaleString()}`);
    return section(`Last ${plural(runs.length, 'run')}`, key, svg);
  }

  // A bar standing on the baseline at `base`: square at the bottom, its top corners rounded
  function barPath(x, width, height, base) {
    const y = base - height;
    const r = Math.min(2, width / 2, height);
    return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${base}Z`;
  }

  // 📅 Daily: the streak and how their words go, today's board and their best place on one, how fast they've been,
  // how many tries their words took, and a calendar of the days they played
  function dailyStats({ daily }) {
    if (!daily.days) return [empty('Finish a Daily Jam word and your streak starts here.')];
    const { streak, today, bestFinish } = daily;
    const tiles = [
      tile('Streak', `🔥 ${streak.current.toLocaleString()}`, `best ${streak.best.toLocaleString()}`),
      tile('Days played', daily.days.toLocaleString()),
      tile('Got it', `${percent(daily.got, daily.finished)}%`, `${daily.got.toLocaleString()} of ${plural(daily.finished, 'word')}`),
      tile('Perfect days', daily.perfect.toLocaleString(), 'all three words'),
      today.rank
        ? tile('Today', `#${today.rank.toLocaleString()}`, `of ${today.players.toLocaleString()}`)
        : tile('Today', 'Not yet', today.players ? `${today.players.toLocaleString()} played today` : 'Be the first today'),
    ];
    if (bestFinish) tiles.push(tile('Best finish', ordinal(bestFinish.rank), `${dateText(dayAt(bestFinish.day))} · of ${bestFinish.players.toLocaleString()}`));
    const fastest = fastestTile(daily.fastest);
    if (fastest) tiles.push(fastest);
    return [tileGrid(tiles), triesChart(daily), calendarEl(daily)];
  }

  // Their fastest get of each level's word, side by side
  function fastestTile(fastest) {
    const levels = [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']];
    if (levels.every(([level]) => fastest[level] === null)) return null;
    const row = make('span', 'account-fastest');
    for (const [level, name] of levels) {
      const cell = make('span');
      cell.append(make('small', '', name), fastest[level] === null ? '-' : formatTime(fastest[level]));
      row.append(cell);
    }
    return tile('Fastest', row, '', true);
  }

  // How their words went - got on the 1st, 2nd or 3rd try, or missed - as bars like Daily Jam's after a word
  // (daily/js/result.js), the biggest picked out
  function triesChart({ tries, missed, finished }) {
    const rows = [...tries.map((count, i) => ({ label: `${ordinal(i + 1)} try`, count })), { label: 'Missed', count: missed }];
    const most = Math.max(...rows.map(row => row.count));
    const list = make('ol', 'account-bars');
    list.append(...rows.map((row) => {
      const item = make('li', most && row.count === most ? 'top' : '');
      item.setAttribute('aria-label', `${row.label}: ${plural(row.count, 'word')}`);
      const bar = make('span', 'account-bar');
      bar.style.width = row.count ? `${Math.max(3, (100 * row.count) / most)}%` : '0';
      const track = make('span', 'account-bar-track');
      track.append(bar, make('span', 'account-bar-count', row.count.toLocaleString()));
      item.append(make('span', 'account-bar-label', row.label), track);
      return item;
    }));
    return section(`How your ${plural(finished, 'word')} went`, null, list);
  }

  // The days they played, a month at a time - all three words got, some, or none each filled their own way, and today
  // ringed - with ‹ back as far as the first month they played and › on to this one
  function calendarEl(daily) {
    const today = localDay();
    const thisMonth = today.slice(0, 7);
    const first = daily.calendar.length ? daily.calendar[0].day.slice(0, 7) : thisMonth;
    const shown = month && month >= first && month <= thisMonth ? month : thisMonth;
    const year = Number(shown.slice(0, 4));
    const monthIndex = Number(shown.slice(5, 7)) - 1;
    const title = new Date(year, monthIndex, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const played = new Map(daily.calendar.map(entry => [entry.day, entry]));

    const prev = monthButton('‹', 'Previous month', 'cal-prev', shown > first);
    const next = monthButton('›', 'Next month', 'cal-next', shown < thisMonth);
    const head = make('div', 'account-cal-head');
    head.append(prev, make('h3', '', title), next);

    // Sunday first, under each day's initial (January 1, 2023 was a Sunday)
    const grid = make('div', 'account-cal-grid');
    for (let i = 0; i < 7; i++) grid.append(make('span', 'account-cal-weekday', new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' })));
    for (let i = new Date(year, monthIndex, 1).getDay(); i > 0; i--) grid.append(make('span'));
    const tally = { all: 0, some: 0, none: 0 };
    const days = new Date(year, monthIndex + 1, 0).getDate();
    for (let date = 1; date <= days; date++) {
      const day = `${shown}-${String(date).padStart(2, '0')}`;
      const entry = played.get(day);
      const kind = !entry ? '' : entry.got >= WORDS_A_DAY ? 'all' : entry.got ? 'some' : 'none';
      const cell = make('span', ['account-cal-day', kind, day === today ? 'today' : '', day > today ? 'later' : ''].filter(Boolean).join(' '), String(date));
      if (entry) {
        tally[kind]++;
        cell.title = `${dateText(dayAt(day))}: ${gotText(entry.got)}`;
      }
      grid.append(cell);
    }
    // Read out as what the month adds up to, rather than thirty-odd numbers
    grid.setAttribute('role', 'img');
    grid.setAttribute('aria-label', monthSummary(title, tally));

    const key = make('p', 'account-cal-key');
    key.setAttribute('aria-hidden', 'true');
    for (const [kind, label] of [['all', 'Got all 3'], ['some', 'Got some'], ['none', 'Got none']]) {
      const item = make('span');
      item.append(make('i', kind), label);
      key.append(item);
    }

    const box = make('div', 'account-section account-cal');
    box.append(head, grid, key);

    // ‹ and › draw the month next to this one in its place, keeping the keyboard on the button pressed - whose name is
    // the same, so screen readers are told the month it's on now, as its grid sums it up
    const move = (step, focusKey, can) => {
      if (!can) return;
      month = addMonth(shown, step);
      const again = calendarEl(daily);
      box.replaceWith(again);
      again.querySelector(`[data-focus="${focusKey}"]`).focus();
      say(again.querySelector('.account-cal-grid').getAttribute('aria-label'));
    };
    prev.addEventListener('click', () => move(-1, 'cal-prev', shown > first));
    next.addEventListener('click', () => move(1, 'cal-next', shown < thisMonth));
    return box;
  }

  // ‹ or ›. At either end it stays focusable (aria-disabled rather than disabled), so the keyboard's place isn't lost.
  function monthButton(text, label, focusKey, can) {
    const btn = make('button', 'account-cal-nav', text);
    btn.type = 'button';
    btn.dataset.focus = focusKey;
    btn.setAttribute('aria-label', label);
    btn.title = label;
    if (!can) btn.setAttribute('aria-disabled', 'true');
    return btn;
  }

  // '2026-10' and a step of -1: '2026-09'
  function addMonth(yearMonth, step) {
    const at = new Date(Number(yearMonth.slice(0, 4)), Number(yearMonth.slice(5, 7)) - 1 + step, 1);
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`;
  }

  // How a day went, for its square's tooltip
  function gotText(got) {
    return got >= WORDS_A_DAY ? `got all ${WORDS_A_DAY}` : `got ${got || 'none'} of ${WORDS_A_DAY}`;
  }

  // "October 2026: played 12 days - got all three words on 5, some on 6, none on 1"
  function monthSummary(title, { all, some, none }) {
    const total = all + some + none;
    if (!total) return `${title}: no days played`;
    const how = [all && `all three words on ${all}`, some && `some on ${some}`, none && `none on ${none}`].filter(Boolean);
    return `${title}: played ${plural(total, 'day')} - got ${how.join(', ')}`;
  }

  // 🏁 Rooms: rounds played and won, the best one, and top-3 finishes
  function roomStats({ rooms }) {
    if (!rooms.rounds) return [empty('Play a room with friends and your rounds and wins show up here. They count from this update on.')];
    return [tileGrid([
      tile('Rounds', rooms.rounds.toLocaleString()),
      tile('Wins', rooms.wins.toLocaleString()),
      tile('Win rate', `${percent(rooms.wins, rooms.rounds)}%`),
      tile('Best round', rooms.best === null ? '-' : withUnit(rooms.best, 'pts')),
      tile('Top-3 finishes', rooms.podiums.toLocaleString(), '1st, 2nd or 3rd - last place never counts', true),
    ])];
  }

  // 🏅 Awards: how many, then each one - earned ones in color, the rest greyed with how far along they are
  function awardStats({ awards }) {
    if (!awards.length) return [empty('Awards show up here as you play.')];
    const earned = awards.filter(award => award.got).length;
    const head = make('p', 'account-awards-count');
    head.append(make('b', '', earned.toLocaleString()), ` of ${awards.length.toLocaleString()} earned`);
    const list = make('ul', 'account-awards');
    list.append(...awards.map(awardEl));
    return earned ? [head, list] : [head, statsNote('None yet - play solo, a Daily Jam or a room to earn your first.'), list];
  }

  function awardEl({ icon, title, detail, got, have, need }) {
    const item = make('li', got ? 'account-award got' : 'account-award');
    const emoji = make('span', 'account-award-icon', icon);
    emoji.setAttribute('aria-hidden', 'true');
    item.append(emoji, make('b', '', title), make('small', '', detail));
    if (got) {
      const check = make('span', 'account-award-check', '✓');
      check.setAttribute('aria-hidden', 'true');
      item.append(check, make('span', 'sr-only', 'Earned'));
    } else if (need > 1) {
      // A count to reach: how far along it is
      const meter = make('span', 'account-meter');
      meter.setAttribute('aria-hidden', 'true');
      const fill = make('i');
      fill.style.width = `${(100 * have) / need}%`;
      meter.append(fill);
      item.append(meter, make('span', 'account-award-progress', `${have.toLocaleString()} of ${need.toLocaleString()}`));
    } else {
      item.append(make('span', 'sr-only', 'Not yet'));
    }
    return item;
  }

  // A number tile: what it is, the number, and a line under it when there's more to say. A wide one has its row to
  // itself.
  function tile(label, value, sub, wide = false) {
    const box = make('div', wide ? 'account-tile wide' : 'account-tile');
    const number = make('dd');
    number.append(value);
    if (sub) number.append(make('small', '', sub));
    box.append(make('dt', '', label), number);
    return box;
  }

  // Tiles two to a row, the wide ones last. An odd one out has its row to itself too, rather than a hole beside it.
  function tileGrid(tiles) {
    const half = tiles.filter(item => !item.classList.contains('wide'));
    if (half.length % 2) half[half.length - 1].classList.add('wide');
    const grid = make('dl', 'account-tiles');
    grid.append(...tiles);
    return grid;
  }

  // "48 pts", the unit a size down
  function withUnit(n, unit) {
    const shown = document.createDocumentFragment();
    shown.append(n.toLocaleString(), make('span', 'account-unit', ` ${unit}`));
    return shown;
  }

  // A heading with a note on its right, if there's one, over a chart
  function section(title, aside, ...content) {
    const head = make('div', 'account-section-head');
    head.append(make('h3', '', title));
    if (aside) head.append(aside);
    const box = make('div', 'account-section');
    box.append(head, ...content);
    return box;
  }

  // A tab with nothing in it yet
  function empty(text) {
    return make('p', 'account-empty', text);
  }

  function statsNote(text) {
    return make('p', 'account-stats-note', text);
  }


  // ---------- Signing in ----------

  // Off to Supabase's sign-in page for the provider, with the hash of a fresh verifier (PKCE, S256). The verifier
  // waits in localStorage for the callback page, with where to come back to; one over ten minutes old isn't trusted
  // (see /account/callback.js).
  async function signIn(provider, btn) {
    if (busy) return;
    setBusy(btn, true);
    let url;
    try {
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      localStorage.setItem(SIGN_IN_KEY, JSON.stringify({ verifier, returnTo: location.pathname + location.search, at: Date.now() }));
      const params = new URLSearchParams({
        provider,
        // In the app's sign-in sheet, the callback page hands the code back to the app (see /account/callback.js).
        // Supabase takes any address on the site's own host, so this needs no entry in its list.
        redirect_to: `${location.origin}/account/callback${authSession ? '?via=app' : ''}`,
        code_challenge: base64url(new Uint8Array(digest)),
        code_challenge_method: 's256',
      });
      url = `${config.accounts.supabaseUrl.replace(/\/+$/, '')}/auth/v1/authorize?${params}`;
    } catch {
      setBusy(btn, false);
      message = "Couldn't start the sign-in. Please try again.";
      render();
      return;
    }
    if (!authSession) {
      location.href = url;
      return;
    }
    // The app (build 3 on): the sign-in runs in iOS's sheet, then the callback page it came back to opens here, in the
    // web view that has the verifier. Closing the sheet just ends it.
    try {
      const back = new URL((await authSession.start({ url, ephemeral: true })).url);
      back.searchParams.delete('via');
      location.href = `/account/callback${back.search}${back.hash}`;
    } catch (err) {
      localStorage.removeItem(SIGN_IN_KEY);
      setBusy(btn, false);
      if (!(err && err.code === 'cancelled')) {
        message = "Couldn't finish the sign-in. Please try again.";
        render();
      }
    }
  }

  // Bytes as the URL-safe base64 PKCE wants, without padding
  function base64url(bytes) {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }


  // ---------- Signed in: the name, signing out, deleting ----------

  async function saveName(input, save) {
    if (busy) return;
    message = '';
    const name = input.value.trim().slice(0, NAME_MAX);
    if (!name) {
      shake(input);
      input.focus();
      return;
    }
    if (name === account.name) {
      editing = false;
      render();
      return;
    }
    setBusy(save, true);
    const reply = await send('account-name', { token: ensurePlayerToken(), name });
    setBusy(save, false);
    if (reply && reply.status === 'ok' && reply.account) {
      editing = false;
      setAccount(reply.account);
      return;
    }
    if (reply && reply.status === 'rude') message = "That name isn't allowed here. Try another.";
    else if (reply && reply.status === 'bad') message = "This device isn't signed in any more.";
    else message = "Couldn't save your name. Try again in a bit.";
    focusInput = true;
    render();
    // 'bad' can also mean this device isn't signed in any more - the server's word on that replaces the box
    if (reply && reply.status === 'bad') ask();
  }

  // This device starts fresh and the account keeps everything (see unlink_account). The page starts over too, so
  // every screen is for a signed-out player.
  async function unlink(btn) {
    if (busy) return;
    message = '';
    setBusy(btn, true);
    const reply = await send('account-unlink', { token: ensurePlayerToken() });
    if (!reply || reply.status !== 'ok') {
      setBusy(btn, false);
      message = "Couldn't sign out. Try again in a bit.";
      render();
      return;
    }
    busy = false;
    setAccount(null);
    location.reload();
  }

  // The account and everything under it, on the server and in Supabase Auth. The name goes too - it was the
  // account's - and the page starts over.
  async function remove(btn) {
    if (busy) return;
    message = '';
    setBusy(btn, true);
    const reply = await send('account-delete', { token: ensurePlayerToken() });
    if (!reply || reply.status !== 'ok') {
      setBusy(btn, false);
      message = reply && reply.status === 'bad' ? "This device isn't signed in." : "Couldn't delete the account. Try again in a bit.";
      render();
      if (reply && reply.status === 'bad') ask();
      return;
    }
    localStorage.removeItem('name');
    busy = false;
    setAccount(null);
    location.reload();
  }

  // While a request is out: the button that was pressed spins, and nothing else in the box can be pressed
  function setBusy(btn, on) {
    busy = on;
    bodyEl.querySelectorAll('button, input').forEach((el) => { el.disabled = on; });
    btn.classList.toggle('is-loading', on);
  }


  // ---------- Bits ----------

  function make(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function anchor(href, text) {
    const a = make('a', '', text);
    a.href = href;
    return a;
  }

  // A line in the middle of the box, like the leaderboard's
  function status(text) {
    return make('p', 'board-status', text);
  }

  // Until it's known whether you're signed in: a skeleton of the box's top - a face, a line or two, a button
  function loading() {
    const shape = make('div', 'account-skel');
    shape.setAttribute('aria-hidden', 'true');
    const row = make('div', 'skel-row');
    const lines = make('div', 'skel-grow');
    lines.append(skel('skel-line', { '--w': '45%' }), skel('skel-line', { '--w': '80%' }));
    row.append(skel('skel-circle', { '--size': '56px' }), lines);
    shape.append(row, skel('skel-block', { '--h': '48px' }));
    return [shape, loadingNote('Loading…')];
  }

  // A skeleton piece (/shared/skeleton.css): its shape's class, and its size
  function skel(shape, size = {}) {
    const piece = make('span', `skel ${shape}`);
    Object.entries(size).forEach(([prop, value]) => piece.style.setProperty(prop, value));
    return piece;
  }

  // What screen readers hear while a skeleton stands in - the skeleton itself says nothing
  function loadingNote(text) {
    const note = make('p', 'sr-only', text);
    note.setAttribute('role', 'status');
    return note;
  }

  function svgEl(tag, attrs = {}) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs).forEach(([name, value]) => node.setAttribute(name, value));
    return node;
  }

  // "1 word", "2,431 words"
  function plural(n, word) {
    return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
  }

  // 41.8 - one decimal, even when it's 42.0, so they line up with each other
  function decimal(x) {
    return x.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }

  function percent(part, whole) {
    return whole ? Math.round((100 * part) / whole) : 0;
  }

  // 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th ... 21st
  function ordinal(n) {
    const teen = n % 100 >= 11 && n % 100 <= 13;
    return `${n}${teen ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
  }

  // "Oct 29" - with the year when it isn't this one
  function dateText(at) {
    const options = { month: 'short', day: 'numeric' };
    if (at.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
    return at.toLocaleDateString(undefined, options);
  }

  // A Daily Jam day ('2026-10-28') as a date - at noon, as daily/js/daily.js has it, so it's that day wherever you are
  function dayAt(day) {
    return new Date(`${day}T12:00`);
  }

  // Today's date where the player is - same as localDay in daily/js/daily.js, so "today" on the Daily tab is the day
  // they're playing
  function localDay() {
    const at = new Date();
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  }

  // 0:41 - or 1:02:41 past an hour, as formatTime in daily/js/daily.js has it
  function formatTime(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor(seconds / 60) % 60;
    const s = String(seconds % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  function iconButton(text, label) {
    const btn = make('button', 'account-edit', text);
    btn.type = 'button';
    btn.setAttribute('aria-label', label);
    btn.title = label;
    return btn;
  }

  function shake(el) {
    el.classList.remove('shake');
    void el.offsetWidth; // restart the animation
    el.classList.add('shake');
  }
})();
