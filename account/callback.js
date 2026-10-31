// The way back from Google or Apple (see /shared/account.js for the way there), one of two ways. Straight from them,
// they POST the sign-in's ID token to /account/return/<provider>, and the server writes what they sent into this page
// (#signInReply, see index.js at the project root); through Supabase, it sends the browser here with a code (or an
// error). This page checks it's the sign-in this browser started, and hands the token with its nonce - or the code
// with its verifier - to the server, which has Supabase say who signed in and ties this device to that account,
// merging what the device had into it (POST /account/link, link in account.js at the project root). Then it's straight
// back to where the sign-in started, leaving a note for that page to show (sessionStorage, see account.js). If anything
// is wrong, it says what, and offers the way home.

(() => {
  const SIGN_IN_KEY = 'signIn';        // localStorage: { provider, nonce, state, returnTo, at } or { verifier, returnTo, at }, left by /shared/account.js
  const SIGN_IN_TTL = 10 * 60 * 1000;  // older than this and it isn't trusted
  const SIGNED_IN_FLAG = 'signedInAs'; // sessionStorage: the name, for the toast on the page we go back to

  const statusEl = document.getElementById('status');
  const backEl = document.getElementById('back');

  // What the server says went wrong, in plain words (see link in account.js at the project root)
  const REASONS = {
    off: "Signing in isn't set up on this server.",
    bad: 'Something was missing from the sign-in. Please start it again.',
    denied: "Google or Apple didn't accept the sign-in - it may have taken too long. Please try again.",
    unavailable: "Couldn't reach the sign-in service. Please try again in a bit.",
  };

  function fail(message) {
    statusEl.textContent = message;
    backEl.hidden = false;
  }

  // Straight from Google or Apple: what they sent, as the server wrote it into the page
  const replyEl = document.getElementById('signInReply');
  let direct = null;
  if (replyEl) {
    try {
      direct = JSON.parse(replyEl.textContent);
    } catch {
      direct = { error: 'unreadable' };
    }
    // This address answered a form POST, and reloading it would ask to send that again - so it becomes the plain one
    history.replaceState(null, '', '/account/callback');
  }

  // Through Supabase: it answers in the query string, and some of its errors come in the hash instead
  const params = new URLSearchParams(location.search);
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  const code = params.get('code');
  const error = direct ? direct.error : params.get('error') || hashParams.get('error');
  const errorText = direct ? '' : params.get('error_description') || hashParams.get('error_description');

  // What went with this sign-in when it started - taken out whatever happens, so it's good for one go
  let pending = null;
  try {
    pending = JSON.parse(localStorage.getItem(SIGN_IN_KEY));
  } catch {
    pending = null;
  }
  localStorage.removeItem(SIGN_IN_KEY);
  const recent = !!pending && Date.now() - Number(pending.at) < SIGN_IN_TTL;
  // The one this browser started: straight, the same provider and state (anyone can send a page to /account/return, so
  // the state is how this one knows it's its own) and a nonce to go with the token; through Supabase, a verifier
  const ours = direct
    ? recent && pending.provider === direct.provider && typeof pending.state === 'string' && pending.state !== ''
      && pending.state === direct.state && typeof pending.nonce === 'string' && pending.nonce !== ''
    : recent && typeof pending.verifier === 'string' && pending.verifier !== '';
  // Only somewhere on this site
  const returnTo = pending && typeof pending.returnTo === 'string' && /^\/(?!\/)/.test(pending.returnTo) ? pending.returnTo : '/';

  if (error) {
    // Cancelled on Google's page (or Supabase's) or on Apple's
    if (error === 'access_denied' || error === 'user_cancelled_authorize') fail('The sign-in was cancelled.');
    else fail(Object.hasOwn(REASONS, error) ? REASONS[error] : `Sign-in failed: ${errorText || error}`);
    return;
  }
  if (direct ? !direct.idToken : !code) {
    fail('No sign-in came back. Please start the sign-in again.');
    return;
  }
  if (!ours) {
    fail('That sign-in took too long, or was started in another browser. Please start it again.');
    return;
  }

  const body = direct
    ? { token: ensurePlayerToken(), provider: direct.provider, idToken: direct.idToken, nonce: pending.nonce, name: direct.name || '' }
    : { token: ensurePlayerToken(), code, verifier: pending.verifier };
  fetch('/account/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then(res => res.json().catch(() => ({ status: res.ok ? 'bad' : 'unavailable' })))
    .then((reply) => {
      if (!reply || reply.status !== 'ok' || !reply.account) {
        fail(REASONS[reply && reply.status] || REASONS.unavailable);
        return;
      }
      // The account's name is the name the pages go by from now on (see account.js); '' leaves the nickname alone
      const name = typeof reply.account.name === 'string' ? reply.account.name : '';
      if (name) localStorage.setItem('name', name);
      sessionStorage.setItem(SIGNED_IN_FLAG, name);
      location.replace(returnTo);
    })
    .catch(() => fail("Couldn't reach the server. Check your connection, then start the sign-in again."));
})();
