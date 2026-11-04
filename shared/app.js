// The iPhone app (mobile/) is this site in a Capacitor web view, which puts window.Capacitor on every page before any
// of the page's own scripts run. This file is what every page does for the app. In a browser it does nothing.
// (sfx.js has the app's haptics and home/install.js leaves the app out of its install hint.)

(() => {
  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;

  // The app keeps its launch screen up until a page is ready (or 6 seconds pass) - this one is once all its scripts
  // have built it and it has drawn. Each plugin is checked for first: an app installed before it was added
  // doesn't have it.
  if (cap.isPluginAvailable('SplashScreen')) {
    document.addEventListener('DOMContentLoaded', () => {
      requestAnimationFrame(() => cap.Plugins.SplashScreen.hide().catch(() => {}));
    });
  }

  // An app older than the oldest build that can still play (minAppBuild, set on the admin page's Controls tab) gets a
  // note over the page that it needs updating, which can't be closed, with the way to the App Store. The help and
  // privacy pages stay open to it. The build is in the app's user agent (AnagramJamApp/N, there from build 1).
  const APP_STORE = 'https://apps.apple.com/app/id6828193475';
  const build = Number((navigator.userAgent.match(/AnagramJamApp\/(\d+)/) || [])[1]) || 1;
  document.addEventListener('DOMContentLoaded', () => {
    if (!window.siteConfig || /^\/(privacy|support|info)\b/.test(location.pathname)) return;
    window.siteConfig().then((config) => {
      if (build < config.app.minBuild) askToUpdate();
    });
  });

  function askToUpdate() {
    const dialog = document.createElement('dialog');
    dialog.className = 'update-dialog';
    dialog.setAttribute('aria-labelledby', 'updateTitle');
    dialog.innerHTML = `
      <div class="card update-card">
        <h2 id="updateTitle">Time to update</h2>
        <p>There's a new version of Anagram Jam. Update the app to keep playing.</p>
        <a class="btn btn-primary" href="${APP_STORE}">Update in the App Store</a>
        <a class="update-help" href="/support">Help</a>
      </div>`;
    dialog.addEventListener('cancel', e => e.preventDefault());
    document.body.append(dialog);
    dialog.showModal();
  }
})();
