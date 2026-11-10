// "Download the app": on an iPhone, Anagram Jam on the App Store; on Android, the game installed right from here in one
// tap (the browser's own install box). Nowhere else - not on an iPad (the app is made for iPhones), a computer, a
// browser that can't install it, the iPhone app itself, or Android once it's installed. (An iPhone that added the site
// to its home screen still gets asked: that isn't the App Store app.)
//
// Two ways in: the quiet line under the home page's start card (#installHint, hidden for good by its ×), and a small
// box that asks after a game, once a session at most (offerApp - each mode calls it when a game's done). A session is
// the tab: closing it and opening a new one starts a new one (sessionStorage).

(() => {
  const APP_STORE = 'https://apps.apple.com/app/id6828193475'; // as in /shared/app.js
  const HIDE_KEY = 'hideInstallHint'; // the home page line's ×, in localStorage
  const ASKED = 'appOffered';        // in sessionStorage once the box has asked

  const cap = window.Capacitor;
  const inApp = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const homeScreen = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ua = navigator.userAgent;
  const phone = inApp ? null : /iPhone|iPod/.test(ua) ? 'iphone' : /Android/.test(ua) && !homeScreen ? 'android' : null;

  const hint = document.getElementById('installHint');
  const hintBtn = document.getElementById('installBtn');
  const hideBtn = document.getElementById('installHide');

  let installPrompt = null; // Android: the browser's install box, once it says the game can be installed
  let dialog = null;

  if (!phone) return;

  // There's something to offer: always on an iPhone, and on Android once the browser says it can install the game
  // (never once it has - and apps' built-in browsers, which can't, don't say so at all)
  const canOffer = () => phone === 'iphone' || !!installPrompt;

  function showHint() {
    if (!hint || !canOffer()) return;
    try {
      if (localStorage.getItem(HIDE_KEY)) return;
    } catch {
      return;
    }
    hint.hidden = false;
  }

  if (phone === 'android') {
    window.addEventListener('beforeinstallprompt', (e) => {
      // The browser's own install banner would pop up over the page, so the line and the box are the only nudges
      e.preventDefault();
      installPrompt = e;
      showHint();
    });
    window.addEventListener('appinstalled', () => {
      installPrompt = null;
      if (hint) hint.hidden = true;
      if (dialog && dialog.open) dialog.close();
      if (window.showAlert) showAlert('Installed! Anagram Jam is on your home screen now.', 'success');
    });
  } else {
    showHint();
  }

  // iPhone: to the App Store. Android: the browser's install box, which can only be shown once a page - so the line and
  // the box go away until the next.
  function getApp() {
    if (phone === 'iphone') {
      window.location.href = APP_STORE;
      return;
    }
    if (!installPrompt) return;
    installPrompt.prompt();
    installPrompt = null;
    if (hint) hint.hidden = true;
  }

  if (hintBtn) hintBtn.addEventListener('click', getApp);
  if (hideBtn) {
    hideBtn.addEventListener('click', () => {
      try {
        localStorage.setItem(HIDE_KEY, '1');
      } catch {}
      hint.hidden = true;
    });
  }


  // ---------- The box after a game ----------

  function makeDialog() {
    dialog = document.createElement('dialog');
    dialog.className = 'app-dialog';
    dialog.setAttribute('aria-labelledby', 'appTitle');
    const iphone = phone === 'iphone';
    dialog.innerHTML = `
      <form class="card app-card" method="dialog">
        <img class="app-icon" src="/icon-192.png?v=2" alt="" width="72" height="72">
        <h2 id="appTitle">Get the app</h2>
        <p class="app-text">${iphone
          ? 'Anagram Jam is free on the App Store. It opens full screen in a tap, and it can remind you to play.'
          : 'Put Anagram Jam on your home screen. It opens full screen in a tap, like any other app.'}</p>
        <button class="btn btn-primary app-get" type="button">${iphone ? 'Download on the App Store' : 'Install the app'}</button>
        <button class="app-later" value="later">Not now</button>
      </form>
    `;
    dialog.querySelector('.app-get').addEventListener('click', () => {
      dialog.close();
      getApp();
    });
    // Tapping outside the box is the same as Not now
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
    document.body.append(dialog);
  }

  // After a game. True if the box opened - then the reminders box (shared/reminders.js) waits for another game.
  window.offerApp = () => {
    if (!canOffer() || document.querySelector('dialog[open]')) return false;
    try {
      if (sessionStorage.getItem(ASKED)) return false;
      sessionStorage.setItem(ASKED, '1');
    } catch {
      return false;
    }
    if (!dialog) makeDialog();
    dialog.showModal();
    return true;
  };
})();
