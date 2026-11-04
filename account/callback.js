// The way back from Google or Apple (see /shared/account.js for the way there). Supabase sends the browser here with
// a code (or an error), and this page hands the code, with the verifier that was kept for it, to the server, which
// swaps them with Supabase for who signed in and ties this device to that account - merging what the device had
// into it (POST /account/link in index.js at the project root, link in account.js there). Then it's straight back to
// where the sign-in started, leaving a note for that page to show (sessionStorage, see account.js). If anything is
// wrong, it says what, and offers the way home.

(() => {
  const SIGN_IN_KEY = 'signIn';        // localStorage: { verifier, returnTo, at }, left by /shared/account.js
  const SIGN_IN_TTL = 10 * 60 * 1000;  // older than this and it isn't trusted
  const SIGNED_IN_FLAG = 'signedInAs'; // sessionStorage: the name, for the toast on the page we go back to
  const APP_RETURN = 'com.krishchavan.anagramjam://account/callback'; // callbackScheme in AuthSessionPlugin.swift

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

  // Supabase answers in the query string; some of its errors come in the hash instead
  const params = new URLSearchParams(location.search);
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));

  // A sign-in from the iPhone app (build 3 on, see /shared/account.js) comes back here inside iOS's sign-in sheet,
  // which doesn't have the verifier - the app's web view does. Going to the app's own scheme closes the sheet and
  // gives the app this address, which opens it again in the web view, without 'via', to finish there.
  const inApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  if (params.get('via') === 'app' && !inApp) {
    location.replace(`${APP_RETURN}${location.search}${location.hash}`);
    return;
  }
  const code = params.get('code');
  const error = params.get('error') || hashParams.get('error');
  const errorText = params.get('error_description') || hashParams.get('error_description');

  // The verifier that went with this sign-in - taken out whatever happens, so it's good for one go
  let pending = null;
  try {
    pending = JSON.parse(localStorage.getItem(SIGN_IN_KEY));
  } catch {
    pending = null;
  }
  localStorage.removeItem(SIGN_IN_KEY);
  const fresh = !!pending && typeof pending.verifier === 'string' && pending.verifier !== '' && Date.now() - Number(pending.at) < SIGN_IN_TTL;
  // Only somewhere on this site
  const returnTo = pending && typeof pending.returnTo === 'string' && /^\/(?!\/)/.test(pending.returnTo) ? pending.returnTo : '/';

  if (error) {
    fail(error === 'access_denied' ? 'The sign-in was cancelled.' : `Sign-in failed: ${errorText || error}`);
    return;
  }
  if (!code) {
    fail('No sign-in code came back. Please start the sign-in again.');
    return;
  }
  if (!fresh) {
    fail('That sign-in took too long, or was started in another browser. Please start it again.');
    return;
  }

  fetch('/account/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: ensurePlayerToken(), code, verifier: pending.verifier }),
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
