// "Add Anagram Jam to your home screen", the quiet line under the start card. Phones and tablets only, and
// never once the game is installed. Where the browser has its own install box (Chrome, Edge and Samsung
// Internet on Android), the line opens that. Everywhere else (iPhone, iPad, Firefox) it opens a card with the
// steps to do it by hand. Its × hides it for good in this browser.

(() => {
  const HIDE_KEY = 'hideInstallHint';

  const hint = document.getElementById('installHint');
  const openBtn = document.getElementById('installBtn');
  const hideBtn = document.getElementById('installHide');

  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const touchDevice = matchMedia('(pointer: coarse)').matches;
  if (installed || !touchDevice) return;

  const hiddenForGood = localStorage.getItem(HIDE_KEY);
  let installPrompt = null;
  let stepsDialog = null;

  if ('BeforeInstallPromptEvent' in window) {
    // Fired once the browser is happy the game can be installed, and never after it has been
    window.addEventListener('beforeinstallprompt', (e) => {
      // Chrome's own install banner would pop up over the page, so this line is the only nudge (or none after its ×)
      e.preventDefault();
      if (hiddenForGood) return;
      installPrompt = e;
      // One tap installs it here, so it says so
      openBtn.textContent = '📲 Install Anagram Jam';
      hint.hidden = false;
    });
  } else {
    const ua = navigator.userAgent;
    // iPads say they're a Mac, but Macs don't have touch screens
    const apple = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    // Apps' built-in browsers (Instagram, Messenger, ...) can't add to the home screen. On iPhone they leave
    // "Safari" out of their name, and on Android they're a WebView ("; wv)").
    const canAdd = apple ? /Safari\//.test(ua) : !/; wv\)/.test(ua);
    if (hiddenForGood || !canAdd) return;

    stepsDialog = makeStepsDialog(apple);
    hint.hidden = false;
  }

  openBtn.addEventListener('click', () => {
    if (!installPrompt) {
      stepsDialog.showModal();
      return;
    }
    installPrompt.prompt();
    // Each install box can only be shown once, so the line goes away until the next visit
    installPrompt = null;
    hint.hidden = true;
  });

  hideBtn.addEventListener('click', () => {
    localStorage.setItem(HIDE_KEY, '1');
    hint.hidden = true;
  });

  window.addEventListener('appinstalled', () => {
    hint.hidden = true;
  });

  function makeStepsDialog(apple) {
    // The iPhone's Share button: a box with an arrow coming out of the top
    const shareIcon = '<svg class="install-share" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3M8 7l4-4 4 4M8 10H6v11h12V10h-2"/></svg>';

    const steps = apple ? `
        <li>
          <h3>Tap Share ${shareIcon}</h3>
          <p>It's in your browser's toolbar. Don't see it? Tap <b>⋯</b> first.</p>
        </li>
        <li>
          <h3>Tap Add to Home Screen</h3>
          <p>Scroll down the list if it isn't showing, then tap <b>Add</b>.</p>
        </li>` : `
        <li>
          <h3>Open the menu</h3>
          <p>Tap <b>⋮</b> in your browser's toolbar.</p>
        </li>
        <li>
          <h3>Tap Add to Home screen</h3>
          <p>Some browsers call it <b>Install</b>. Then tap <b>Add</b>.</p>
        </li>`;

    // Dressed like the How to play box (shared/how-to-play.js)
    const dialog = document.createElement('dialog');
    dialog.className = 'howto-dialog';
    dialog.setAttribute('aria-labelledby', 'installTitle');
    dialog.innerHTML = `
      <form class="howto-card card" method="dialog">
        <div class="howto-head">
          <h2 id="installTitle">Play it like an app</h2>
          <button class="howto-close" aria-label="Close">×</button>
        </div>

        <ol class="howto-steps">${steps}
        </ol>

        <p class="howto-tip">Then Anagram Jam opens full screen from its own icon, like any other app.</p>

        <button class="btn btn-primary">Got it</button>
      </form>
    `;
    document.body.appendChild(dialog);

    // Tapping outside the box closes it
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });

    return dialog;
  }
})();
