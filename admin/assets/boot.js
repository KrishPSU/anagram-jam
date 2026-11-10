// The dashboard's safety net. It's in admin/assets, so it loads without the session the dashboard's own scripts need
// (admin/app - see admin.js). If any of those didn't come, or didn't get a tab open, the page would sit there empty
// until it was closed and opened again - so it loads again once by itself, and if that doesn't do it either, says so,
// with a button to try again.

const RELOADED_AT = 'adminReloadedAt'; // in sessionStorage: when this loaded itself again

document.addEventListener('DOMContentLoaded', () => {
  // After every deferred script has run, core.js's DOMContentLoaded (which opens a tab) included
  setTimeout(() => {
    const names = [...document.querySelectorAll('[role="tab"]')].map(tab => tab.dataset.tab);
    const started = typeof tabs !== 'undefined' && names.every(name => tabs[name])
      && !!document.querySelector('[role="tabpanel"]:not([hidden])');
    if (started) return;

    let reloadedAt = 0;
    try {
      reloadedAt = Number(sessionStorage.getItem(RELOADED_AT)) || 0;
      if (Date.now() - reloadedAt > 60 * 1000) {
        sessionStorage.setItem(RELOADED_AT, String(Date.now()));
        window.location.reload();
        return;
      }
    } catch {}

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-glass btn-sm';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => window.location.reload());
    const note = document.createElement('p');
    note.className = 'state is-error boot-failed';
    note.append("The dashboard didn't load all the way. ", retry);
    document.querySelector('.panels').prepend(note);
  }, 0);
});
