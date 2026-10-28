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
})();
