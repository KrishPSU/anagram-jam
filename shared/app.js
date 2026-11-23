// The iPhone app (mobile/) is this site in a Capacitor web view, which puts window.Capacitor on every page before any
// of the page's own scripts run. This file is what every page does for the app. In a browser it does nothing.
// (sfx.js has the app's haptics and home/install.js leaves the app out of its install hint.)

(() => {
  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;

  // The app opens on its loading screen - letter tiles falling in and spelling the game's name out (LaunchView.swift
  // in mobile/) - and keeps it up until the first page says it's ready: once all its scripts have built it, its font
  // is in (or a second and a half has gone by), and it has drawn. On the home page, at its top, the loading screen's
  // tiles then glide onto the page's own title: the app asks where those are (launchTitle('hide'), which also hides
  // them, so there's only ever one set to see) and says when its tiles have landed on them (launchTitle('show')).
  // Any other page gives no boxes, and the loading screen fades instead.
  // Each plugin is checked for first: an app installed before it was added doesn't have it. Apps before build 6 have a
  // still launch screen instead (the SplashScreen plugin), which this takes down.
  const whenDrawn = (then) => {
    document.addEventListener('DOMContentLoaded', () => {
      const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
      Promise.race([fonts, new Promise(resolve => setTimeout(resolve, 1500))]).catch(() => {}).then(() => requestAnimationFrame(then));
    });
  };
  if (cap.isPluginAvailable('Launch')) {
    let hidden = null; // the title, while the loading screen's tiles are on their way to it
    const show = () => {
      if (hidden) hidden.style.visibility = '';
      hidden = null;
    };
    window.launchTitle = (what) => {
      if (what !== 'hide') return show();
      const title = document.querySelector('.title-tiles');
      const tiles = title ? [...title.querySelectorAll('.tile')] : [];
      if (tiles.length !== 10 || window.scrollY > 1) return null;
      const boxes = tiles.map(tile => tile.getBoundingClientRect());
      // All there to be landed on: on the screen, and a tile's shape
      if (boxes.some(box => box.width < 10 || box.top < 0 || box.bottom > window.innerHeight)) return null;
      hidden = title;
      title.style.visibility = 'hidden';
      setTimeout(show, 3000); // never left hidden, whatever becomes of the loading screen
      return boxes.map(box => [box.left, box.top, box.width, box.height]);
    };
    whenDrawn(() => cap.Plugins.Launch.ready().catch(() => {}));
  } else if (cap.isPluginAvailable('SplashScreen')) {
    document.addEventListener('DOMContentLoaded', () => {
      requestAnimationFrame(() => cap.Plugins.SplashScreen.hide().catch(() => {}));
    });
  }

  // A reminder tapped (see push.js) goes to the page it's about. If that's what opened the app, the plugin keeps the tap
  // until a page is listening.
  if (cap.isPluginAvailable('PushNotifications')) {
    cap.Plugins.PushNotifications.addListener('pushNotificationActionPerformed', ({ notification }) => {
      const url = notification.data && notification.data.url;
      if (typeof url === 'string' && url.startsWith('/') && !location.pathname.startsWith(url)) location.href = url;
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
