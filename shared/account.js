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
// The box itself opens from any [data-account] button (the home page has one; the other pages only ask). Signed out,
// it offers the providers the server has; signed in, the name (editable), the provider and the devices, Sign out and
// Delete account. The server's side of all of it is account.js at the project root.
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
  // can't finish (the verifier is in the app's own storage). From build 2 the app lets Supabase's and Apple's pages
  // through (allowNavigation in mobile/capacitor.config.json), so Apple works in it; Google never signs anyone in
  // inside an app's web view, so it's for the website. The build is in the app's user agent (AnagramJamApp/N).
  const inApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const appBuild = inApp ? Number((navigator.userAgent.match(/AnagramJamApp\/(\d+)/) || [])[1]) || 1 : 0;
  const appCanSignIn = !inApp || appBuild >= 2;

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

  let account;       // undefined until the server has said; then null (signed out) or { id, provider, name, devices }
  let config = null; // /shared/config.js's word, once it's here
  let asked = 0;     // the latest 'account-get' - a slow reply to an earlier one is ignored
  let busy = false;  // a request from the box is out

  // The box (only the home page has a button for it)
  let dialog = null;
  let bodyEl = null;
  let editing = false;    // the name is being changed
  let confirming = false; // Delete account has been tapped once
  let focusInput = false; // the name box was just opened, or kept after a failed save: the cursor goes in it
  let message = '';       // what went wrong with the last thing tried, shown in the box (a toast would be under it)

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
      setAccount(reply.account || null);
    });
  }

  // The server's word, to everything that cares
  function setAccount(next) {
    account = next;
    window.currentAccount = next;
    // Signed out, or found to be: whatever the last thing tried said is about an account this device no longer has
    if (!next) message = '';
    if (next && next.name) localStorage.setItem('name', next.name);
    buttons.forEach(btn => btn.classList.toggle('is-signed-in', !!next));
    if (next && typeof window.analyticsIdentify === 'function') window.analyticsIdentify(next.id);
    if (!next && typeof window.analyticsReset === 'function') window.analyticsReset();
    window.dispatchEvent(new CustomEvent('account', { detail: next }));
    render();
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
      </form>
    `;
    document.body.appendChild(dialog);
    bodyEl = dialog.querySelector('.account-body');

    buttons.forEach(btn => btn.addEventListener('click', () => {
      editing = false;
      confirming = false;
      message = '';
      render();
      dialog.showModal();
      dialog.querySelector('.account-card').scrollTop = 0;
    }));

    // Tapping outside the box closes it
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  function render() {
    if (!dialog || busy) return;
    let parts;
    if (!config || (link && account === undefined)) parts = [loading()];
    else if (!config.accounts.enabled) parts = [status("Signing in isn't set up on this server.")];
    else parts = account ? signedIn() : signedOut();
    if (message) {
      const note = make('p', 'account-msg', message);
      note.setAttribute('role', 'alert');
      parts.push(note);
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
    const parts = [make('p', 'account-note', 'Sign in to keep one score across your phone and laptop. Your best from each device is merged, and the leaderboards show your name.')];
    const providers = config.accounts.providers.filter(p => PROVIDERS[p]);
    if (!window.isSecureContext || !crypto.subtle) {
      // PKCE needs SHA-256, which browsers only give to pages on https (or localhost)
      parts.push(status('Needs a secure connection (https) to sign in.'));
    } else {
      const offered = appCanSignIn ? providers.filter(p => !(inApp && p === 'google')) : [];
      if (offered.length) {
        const actions = make('div', 'account-actions');
        actions.append(...offered.map(providerButton));
        parts.push(actions);
      }
      if (inApp && !appCanSignIn) parts.push(status("This version of the app can't sign in yet. Sign in on the website, anagramjam.com, for now - the app's next update will have it."));
      else if (inApp && providers.includes('google')) parts.push(make('p', 'account-fine', 'Google sign-in works on the website, anagramjam.com.'));
      if (!providers.length) parts.push(status('No way to sign in is set up on this server.'));
    }
    const fine = make('p', 'account-fine');
    fine.append('Google or Apple tells us your name and email. What we keep is in the ', anchor('/privacy', 'privacy policy'), '.');
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

    // Who you are: the avatar, the name and the pencil - or the name box, Save and ×
    const who = make('div', 'account-who');
    who.append(typeof avatarEl === 'function' ? avatarEl(name) : make('span', 'avatar', '?'));
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
      who.append(input, save, cancel);
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
      who.append(nameEl, edit);
    }

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
      box.append(make('p', '', "Delete your account? Your scores, Daily Jam records and streaks go with it, on every device. This can't be undone."));
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

    return [who, meta, actions];
  }


  // ---------- Signing in ----------

  // Off to Supabase's sign-in page for the provider, with the hash of a fresh verifier (PKCE, S256). The verifier
  // waits in localStorage for the callback page, with where to come back to; one over ten minutes old isn't trusted
  // (see /account/callback.js).
  async function signIn(provider, btn) {
    if (busy) return;
    setBusy(btn, true);
    try {
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      localStorage.setItem(SIGN_IN_KEY, JSON.stringify({ verifier, returnTo: location.pathname + location.search, at: Date.now() }));
      const params = new URLSearchParams({
        provider,
        redirect_to: `${location.origin}/account/callback`,
        code_challenge: base64url(new Uint8Array(digest)),
        code_challenge_method: 's256',
      });
      location.href = `${config.accounts.supabaseUrl.replace(/\/+$/, '')}/auth/v1/authorize?${params}`;
    } catch {
      setBusy(btn, false);
      message = "Couldn't start the sign-in. Please try again.";
      render();
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

  // A line in the middle of the box, like the leaderboard's while it loads
  function status(text) {
    return make('p', 'board-status', text);
  }

  function loading() {
    const spinner = make('span', 'spinner');
    spinner.setAttribute('aria-hidden', 'true');
    const el = make('p', 'board-status');
    el.append(spinner, 'Loading…');
    return el;
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
