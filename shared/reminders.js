// Reminders to play (see push.js at the project root): the box that turns them on, changes them, tests them and turns
// them off, for this device. Any button with data-reminders opens it. They're all hidden where reminders can't be had,
// and the ones with data-reminders="offer" (after a Daily Jam word or a solo run) go away once they're on. After a Daily
// Jam word or a solo run the box also asks by itself, once a session (see offerReminders).
//
// Reminders reach the iPhone app through Capacitor's PushNotifications plugin, and a browser through Web Push, with the
// service worker (/sw.js) showing them. An app installed before the plugin was added doesn't have it, and a phone's
// Safari only has Web Push once the game has been added to the home screen, so this looks for each rather than assuming.
//
// Once a day at most, a page with reminders on tells the server this device is still around (see checkIn): that keeps
// its reminders coming, and its time zone and address up to date.

(() => {
  const KEY = 'reminders'; // in localStorage while they're on: { hour, daily, solo, zone, seen: the last day checked in }
  const HOURS = { first: 7, last: 22, usual: 18 }; // as FIRST_HOUR and LAST_HOUR in push.js
  const ADDRESS_TIMEOUT = 10 * 1000; // how long iOS gets to come up with a device's address

  const cap = window.Capacitor;
  const inApp = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const plugin = inApp && cap.isPluginAvailable('PushNotifications') ? cap.Plugins.PushNotifications : null;

  let webKey = '';    // the server's public key, for asking a browser for an address
  let dialog = null;
  let controls = null; // what's in the box: { daily, solo, hour, on, test, off, later, title, intro, note }
  let testHeard = false; // the app has heard the test it asked for (see sendTest)
  let asking = false;    // the box opened by itself (see offerReminders), so it says why and has a Not now

  const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Same as localDay in daily/js/daily.js
  function localDay(at = new Date()) {
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  }

  function stored() {
    try {
      return JSON.parse(localStorage.getItem(KEY));
    } catch {
      return null;
    }
  }

  const store = (settings) => localStorage.setItem(KEY, JSON.stringify(settings));

  async function post(path, body) {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, token: window.ensurePlayerToken() }),
      });
      return res.ok && (await res.json()).status === 'ok';
    } catch {
      return false;
    }
  }


  // ---------- This device, the app's way or a browser's ----------

  // 'granted', 'denied' or 'prompt' (it hasn't been asked)
  async function permission() {
    if (plugin) return (await plugin.checkPermissions()).receive;
    return Notification.permission === 'default' ? 'prompt' : Notification.permission;
  }

  // Asks, the first time. Once it's been answered no is final: only the phone's or the browser's settings can change it.
  async function askPermission() {
    if (plugin) return (await plugin.requestPermissions()).receive;
    const answer = await Notification.requestPermission();
    return answer === 'default' ? 'prompt' : answer;
  }

  // iOS says what the address is by an event, which is fired again each time it's asked
  function appAddress() {
    return new Promise((resolve) => {
      let listening = [];
      const finish = (found) => {
        clearTimeout(timer);
        listening.forEach(listener => Promise.resolve(listener).then(handle => handle.remove()).catch(() => {}));
        resolve(found);
      };
      const timer = setTimeout(() => finish(null), ADDRESS_TIMEOUT);
      listening = [
        plugin.addListener('registration', ({ value }) => finish({ kind: 'apns', address: value })),
        plugin.addListener('registrationError', () => finish(null)),
      ];
      plugin.register().catch(() => finish(null));
    });
  }

  // The bytes of a base64url string
  const bytesOf = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

  // The browser's push manager, once the service worker is up. `ready` never settles if it can't be set up.
  function pushManager() {
    return new Promise((resolve, reject) => {
      navigator.serviceWorker.ready.then(registration => resolve(registration.pushManager), reject);
      setTimeout(() => reject(new Error('No service worker')), ADDRESS_TIMEOUT);
    });
  }

  async function webAddress() {
    const manager = await pushManager();
    const subscription = await manager.getSubscription()
      || await manager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesOf(webKey) });
    const { endpoint, keys } = subscription.toJSON();
    return { kind: 'web', address: endpoint, keys };
  }

  // Where this device can be reached: { kind, address, keys }, or null if that can't be found out right now
  const findAddress = () => (plugin ? appAddress() : webAddress()).catch(() => null);

  const saveOnServer = (address, { hour, daily, solo }) => post('/push/device', { ...address, timeZone: zone(), hour, daily, solo });

  // Turned off, or they took the permission away
  async function forget() {
    if (!(await post('/push/device/remove', {}))) return false;
    localStorage.removeItem(KEY);
    if (!plugin) {
      const subscription = await pushManager().then(manager => manager.getSubscription()).catch(() => null);
      if (subscription) await subscription.unsubscribe().catch(() => {});
    }
    return true;
  }

  // Only the permission going away turns reminders off. An address that can't be found right now (no signal, say) is
  // tried again on the next page.
  async function checkIn() {
    const settings = stored();
    if (!settings || (settings.seen === localDay() && settings.zone === zone())) return;
    const allowed = await permission().catch(() => null);
    if (allowed === null) return;
    if (allowed !== 'granted') {
      forget().then(showButtons);
      return;
    }
    const address = await findAddress();
    if (address && await saveOnServer(address, settings)) store({ ...settings, seen: localDay(), zone: zone() });
  }


  // ---------- The box ----------

  const hourName = (hour) => `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`;

  function makeDialog() {
    dialog = document.createElement('dialog');
    dialog.className = 'reminders-dialog';
    dialog.setAttribute('aria-labelledby', 'remindersTitle');
    let hours = '';
    for (let hour = HOURS.first; hour <= HOURS.last; hour++) hours += `<option value="${hour}">${hourName(hour)}</option>`;
    dialog.innerHTML = `
      <form class="reminders-card card" method="dialog">
        <div class="howto-head">
          <h2 id="remindersTitle"></h2>
          <button class="howto-close" aria-label="Close">×</button>
        </div>
        <p class="reminders-intro"></p>
        <div class="reminders-rows">
          <label class="reminders-row">
            <span><b>Daily Jam</b><small>If you haven't played today's words</small></span>
            <input class="reminders-switch" type="checkbox" role="switch" data-field="daily">
          </label>
          <label class="reminders-row">
            <span><b>Solo</b><small>Every few days, to beat your best</small></span>
            <input class="reminders-switch" type="checkbox" role="switch" data-field="solo">
          </label>
          <label class="reminders-row">
            <span><b>Time</b></span>
            <select class="reminders-time" data-field="hour">${hours}</select>
          </label>
        </div>
        <p class="reminders-note" role="status" hidden></p>
        <button class="btn btn-primary" type="button" data-action="on">Turn on reminders</button>
        <button class="reminders-test" type="button" data-action="test">Send a test</button>
        <button class="reminders-off" type="button" data-action="off">Turn off reminders</button>
        <button class="reminders-later" type="button" data-action="later">Not now</button>
      </form>`;
    const find = (selector) => dialog.querySelector(selector);
    controls = {
      daily: find('[data-field="daily"]'), solo: find('[data-field="solo"]'), hour: find('[data-field="hour"]'),
      on: find('[data-action="on"]'), test: find('[data-action="test"]'), off: find('[data-action="off"]'),
      later: find('[data-action="later"]'), title: find('#remindersTitle'), intro: find('.reminders-intro'),
      note: find('.reminders-note'),
    };
    [controls.daily, controls.solo, controls.hour].forEach(control => control.addEventListener('change', changed));
    controls.on.addEventListener('click', turnOn);
    controls.test.addEventListener('click', sendTest);
    controls.off.addEventListener('click', turnOff);
    controls.later.addEventListener('click', () => dialog.close());
    if (plugin) plugin.addListener('pushNotificationReceived', testArrived);
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
    document.body.append(dialog);
  }

  const chosen = () => ({ hour: Number(controls.hour.value), daily: controls.daily.checked, solo: controls.solo.checked });

  function showNote(text, bad = false) {
    controls.note.textContent = text;
    controls.note.classList.toggle('bad', bad);
    controls.note.hidden = !text;
  }

  function showState() {
    const on = !!stored();
    controls.on.hidden = on;
    controls.test.hidden = !on;
    controls.off.hidden = !on;
    controls.later.hidden = on || !asking;
    controls.on.disabled = !controls.daily.checked && !controls.solo.checked;
    showButtons();
  }

  function setBusy(busy) {
    controls.on.disabled = busy;
    controls.test.disabled = busy;
    controls.off.disabled = busy;
  }

  async function open(byItself = false) {
    if (!dialog) makeDialog();
    asking = byItself;
    controls.title.textContent = asking ? 'Want a reminder to play?' : 'Reminders';
    controls.intro.textContent = asking
      ? "We'll send a nudge to this device on days you haven't played, once a day at most."
      : 'A nudge on this device, once a day at most.';
    const settings = stored() || { hour: HOURS.usual, daily: true, solo: true };
    controls.daily.checked = settings.daily;
    controls.solo.checked = settings.solo;
    controls.hour.value = String(settings.hour);
    showNote('');
    showState();
    dialog.showModal();
    if (!stored() && (await permission().catch(() => 'prompt')) === 'denied') showBlocked();
  }

  function showBlocked() {
    showNote(plugin
      ? "Notifications are off for Anagram Jam. You can turn them on in your iPhone's Settings."
      : "Notifications are blocked for this site. You can allow them in your browser's settings.", true);
  }

  async function turnOn() {
    setBusy(true);
    showNote('');
    const answer = await askPermission().catch(() => 'denied');
    if (answer !== 'granted') {
      setBusy(false);
      if (answer === 'denied') showBlocked();
      showState();
      return;
    }
    const address = await findAddress();
    const settings = chosen();
    const saved = !!address && await saveOnServer(address, settings);
    setBusy(false);
    if (saved) {
      store({ ...settings, zone: zone(), seen: localDay() });
      showNote(`You're all set. We'll remind you around ${hourName(settings.hour)}.`);
    } else {
      showNote("Couldn't turn them on. Please try again.", true);
    }
    showState();
  }

  // A change while they're on goes straight in. If it can't, it's kept here for the next check-in to send.
  async function changed() {
    const settings = stored();
    showNote('');
    if (!settings) return showState();
    const next = { ...settings, ...chosen(), seen: null };
    store(next);
    const address = await findAddress();
    if (address && await saveOnServer(address, next)) store({ ...next, seen: localDay() });
    else showNote("Couldn't save that just now. We'll try again next time you play.", true);
    showState();
  }

  // The app shows nothing for a reminder that arrives while it's open (see mobile/README.md), so it's said here instead
  function testArrived() {
    testHeard = true;
    showNote("It got here! You'll see reminders as a banner when you're not in the game.");
  }

  // A reminder right now, to see they get through (see test in push.js). The push service taking it is as far as the
  // server can see, so the note says where to look if it doesn't turn up.
  async function sendTest() {
    setBusy(true);
    showNote('');
    testHeard = false;
    const address = await findAddress();
    const sent = !!address && await post('/push/test', address);
    setBusy(false);
    if (!sent) showNote("Couldn't send one just now. Please try again.", true);
    else if (!testHeard) showNote(plugin
      ? "Sent. If nothing happens in a few seconds, check that notifications are on for Anagram Jam in your iPhone's Settings."
      : 'Sent. If nothing shows up in a few seconds, check that your device allows notifications from this browser and that Do Not Disturb is off.');
  }

  async function turnOff() {
    setBusy(true);
    showNote('');
    const done = await forget();
    setBusy(false);
    if (!done) showNote("Couldn't turn them off. Please try again.", true);
    showState();
  }


  // ---------- The buttons ----------

  function showButtons() {
    const on = !!stored();
    document.querySelectorAll('[data-reminders]').forEach((button) => {
      if (button.dataset.reminders === 'offer') button.hidden = on;
      else {
        button.hidden = false;
        button.textContent = on ? '🔔 Reminders on' : '🔔 Get a reminder to play';
      }
    });
  }

  // Whether reminders can be had here at all
  const available = window.siteConfig().then((config) => {
    webKey = config.push.webKey;
    const canWeb = !inApp && !!webKey && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    return canWeb || !!(plugin && config.push.app);
  });

  available.then((can) => {
    if (!can) return;
    document.querySelectorAll('[data-reminders]').forEach(button => button.addEventListener('click', () => open()));
    showButtons();
    checkIn();
  });


  // ---------- Asking ----------

  const ASKED = 'remindersAsked'; // in sessionStorage once the box has asked by itself

  // Called after a Daily Jam word or a solo run (daily/js/result.js, solo/js/results.js): the box opens by itself if
  // reminders could be on here and aren't. Once a session at most, a session being while the app (or the tab) stays
  // open, so playing again doesn't ask again. Not once notifications have been refused either: only the phone's or the
  // browser's settings can undo that, so there'd be nothing to say yes to.
  window.offerReminders = async () => {
    if (!(await available) || stored()) return;
    try {
      if (sessionStorage.getItem(ASKED)) return;
    } catch {
      return;
    }
    if ((await permission().catch(() => 'denied')) === 'denied' || document.querySelector('dialog[open]')) return;
    sessionStorage.setItem(ASKED, '1');
    open(true);
  };
})();
