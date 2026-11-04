// The Controls tab: the home page banner, pausing new games, the oldest iPhone app build that can play, a message to
// everyone, and the word checker.

const controlsPanel = document.getElementById('panel-controls');
const bannerForm = document.getElementById('bannerForm');
const bannerText = document.getElementById('bannerText');
const bannerCount = document.getElementById('bannerCount');
const bannerNow = document.getElementById('bannerNow');
const bannerSaveBtn = document.getElementById('bannerSaveBtn');
const bannerClearBtn = document.getElementById('bannerClearBtn');
const pauseToggle = document.getElementById('pauseToggle');
const pauseLabel = document.getElementById('pauseLabel');
const appBuildForm = document.getElementById('appBuildForm');
const appBuildInput = document.getElementById('appBuildInput');
const appBuildBtn = document.getElementById('appBuildBtn');
const appBuildNow = document.getElementById('appBuildNow');
const reachCountEl = document.getElementById('reachCount');
const broadcastForm = document.getElementById('broadcastForm');
const broadcastText = document.getElementById('broadcastText');
const broadcastBtn = document.getElementById('broadcastBtn');
const wordForm = document.getElementById('wordForm');
const wordInput = document.getElementById('wordInput');
const wordResultEl = document.getElementById('wordResult');

const PAUSED_FALLBACK = 'New games are paused for a few minutes. Try again soon!';

let siteSettings = null; // { announcement, paused, minAppBuild }, as the server has them

// The settings come with the Live tab's overview. Until they've come once, grey bars stand in for what they say
// (showControlsSkeleton); after that, what's showing stays until they're in.
async function loadControls() {
  const first = !siteSettings;
  if (first) showControlsSkeleton();
  try {
    const reply = await api('overview');
    setSession(reply.session.ends);
    siteSettings = reply.settings;
    reachCountEl.textContent = reply.totals.players
      ? `${plural(reply.totals.players, 'player')} in rooms, plus anyone on the home page or playing solo`
      : 'nobody is in a room right now, but anyone on the home page or playing solo will see it';
    if (document.activeElement !== bannerText) bannerText.value = siteSettings.announcement;
    if (document.activeElement !== appBuildInput) appBuildInput.value = siteSettings.minAppBuild;
    if (first) pauseToggle.disabled = false;
    showSettings();
  } catch (err) {
    showAlert(err.message);
    if (first) hideControlsSkeleton();
  } finally {
    markBusy(controlsPanel, false);
  }
}

// Grey bars where what's on the home page now, whether games are paused and who a message would reach will go. The
// switch can't be flipped meanwhile: until it shows the real setting, a flip could go the wrong way.
function showControlsSkeleton() {
  markBusy(controlsPanel, true);
  bannerNow.classList.add('is-empty');
  bannerNow.replaceChildren(skelPiece('text', '18em'));
  pauseToggle.disabled = true;
  pauseLabel.replaceChildren(skelPiece('text', '9em'));
  appBuildBtn.disabled = true;
  appBuildNow.replaceChildren(skelPiece('text', '14em'));
  reachCountEl.replaceChildren(skelPiece('text', '16em'));
}

// They didn't come: the switch can be flipped again, and what's still grey goes back to how the page starts out, with
// the toast saying what went wrong. What a save (or a newer read) put up meanwhile stays.
function hideControlsSkeleton() {
  pauseToggle.disabled = false;
  appBuildBtn.disabled = false;
  if (reachCountEl.querySelector('.skel')) reachCountEl.textContent = '…';
  if (siteSettings) return;
  bannerNow.classList.remove('is-empty');
  bannerNow.textContent = '';
  pauseLabel.textContent = 'New games can start';
  appBuildNow.textContent = '';
}

function showSettings() {
  const { announcement, paused, minAppBuild } = siteSettings;
  appBuildBtn.disabled = false;
  appBuildNow.textContent = minAppBuild > 1
    ? `Builds before ${minAppBuild} are asked to update.`
    : 'Every build of the app can play.';
  bannerCount.textContent = `${bannerText.value.length} / 160`;
  const shown = announcement || (paused ? PAUSED_FALLBACK : '');
  bannerNow.textContent = shown || 'Nothing - the banner is down.';
  bannerNow.classList.toggle('is-empty', !shown);
  bannerNow.classList.toggle('paused', paused);
  bannerClearBtn.disabled = !announcement;
  pauseToggle.checked = paused;
  pauseLabel.textContent = paused ? 'New games are paused' : 'New games can start';
}

async function saveSettings(changes, done) {
  try {
    siteSettings = await api('settings', changes);
    showSettings();
    showAlert(done, 'success');
  } catch (err) {
    showAlert(err.message);
    showSettings();
  }
}

bannerText.addEventListener('input', () => {
  bannerCount.textContent = `${bannerText.value.length} / 160`;
});

bannerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = bannerText.value.trim();
  if (!text) {
    bannerText.focus();
    return showAlert('Write something for the banner first, or use Take down.', 'info');
  }
  bannerSaveBtn.disabled = true;
  await saveSettings({ announcement: text }, 'The banner is up on the home page.');
  bannerSaveBtn.disabled = false;
});

bannerClearBtn.addEventListener('click', async () => {
  bannerText.value = '';
  await saveSettings({ announcement: '' }, 'The banner is down.');
});

pauseToggle.addEventListener('change', async () => {
  pauseToggle.disabled = true;
  await saveSettings({ paused: pauseToggle.checked }, pauseToggle.checked ? 'New games are paused.' : 'New games can start again.');
  pauseToggle.disabled = false;
});

// Raising it shuts older apps out, so that takes two presses; lowering it doesn't
let appBuildArmedUntil = 0;
appBuildForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const build = Number(appBuildInput.value);
  if (!Number.isInteger(build) || build < 1 || build > 9999) {
    appBuildInput.focus();
    return showAlert('A build is a whole number from 1 up.', 'info');
  }
  if (!siteSettings || build === siteSettings.minAppBuild) return;
  if (build > siteSettings.minAppBuild && Date.now() > appBuildArmedUntil) {
    appBuildArmedUntil = Date.now() + 4000;
    appBuildBtn.textContent = 'Lock out older?';
    appBuildBtn.classList.add('armed');
    setTimeout(() => {
      appBuildBtn.textContent = 'Save';
      appBuildBtn.classList.remove('armed');
    }, 4000);
    return;
  }
  appBuildArmedUntil = 0;
  appBuildBtn.textContent = 'Save';
  appBuildBtn.classList.remove('armed');
  appBuildBtn.disabled = true;
  await saveSettings({ minAppBuild: build }, build > 1 ? `Builds before ${build} are asked to update now.` : 'Every build of the app can play again.');
});

// Two presses, since it goes straight out to everyone
let broadcastArmedUntil = 0;
broadcastForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = broadcastText.value.trim();
  if (!message) {
    broadcastText.focus();
    return;
  }
  if (Date.now() > broadcastArmedUntil) {
    broadcastArmedUntil = Date.now() + 4000;
    broadcastBtn.textContent = 'Send to all?';
    broadcastBtn.classList.add('armed');
    setTimeout(() => {
      broadcastBtn.textContent = 'Send';
      broadcastBtn.classList.remove('armed');
    }, 4000);
    return;
  }
  broadcastArmedUntil = 0;
  broadcastBtn.textContent = 'Send';
  broadcastBtn.classList.remove('armed');
  broadcastBtn.disabled = true;
  try {
    await api('broadcast', { message });
    broadcastText.value = '';
    showAlert('Sent to everyone online.', 'success');
  } catch (err) {
    showAlert(err.message);
  } finally {
    broadcastBtn.disabled = false;
  }
});


// ---------- Word checker ----------

wordForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = wordInput.value.trim();
  if (!query) return;
  // Grey lines where the answer will go while it's looked up (a quick answer never shows them)
  markBusy(wordResultEl, true);
  wordResultEl.replaceChildren(...['22em', '14em', '18em'].map(width => el('p.word-line', skelPiece('text', width))));
  try {
    const { result } = await api(`word?q=${encodeURIComponent(query)}`);
    wordResultEl.replaceChildren(...(result ? wordAnswer(result) : [el('p.word-line', 'Type at least two letters.')]));
  } catch (err) {
    wordResultEl.replaceChildren(el('p.word-line.bad', err.message));
  } finally {
    markBusy(wordResultEl, false);
  }
});

function wordAnswer(r) {
  const out = [];
  const upper = r.word.toUpperCase();
  out.push(el(`p.word-line${r.real ? '.good' : '.bad'}`,
    el('b', upper), r.real ? ' is a real word - it counts as an answer wherever its letters come up.' : ' isn’t in the dictionary the game checks against, so it never counts.'));

  const others = r.makes.filter(w => w !== r.word);
  if (others.length) {
    out.push(el('p.word-line', r.real ? 'The same letters also make: ' : 'Its letters do make: ', ...chips(others)));
  } else if (!r.makes.length) {
    out.push(el('p.word-line.muted', 'No real word uses exactly these letters.'));
  }

  if (r.dealt.length) {
    const modes = [r.rooms ? 'rooms' : null, r.solo ? 'solo' : null].filter(Boolean).join(' and ');
    for (const dealt of r.dealt) {
      out.push(el('p.word-line',
        'These letters can come up in ', modes, ' as ', el('b', dealt.word.toUpperCase()), ' (2 points)',
        dealt.others.length ? ['. These count for 1 point: ', ...chips(dealt.others)] : '. No other word counts.'));
    }
  } else {
    out.push(el('p.word-line.muted', `These letters are never dealt: games only use words from their own list (rooms 3 to 5 letters, solo 3 to 10).`));
  }
  return out;
}

function chips(words) {
  return words.map(word => el('span.word-chip', word.toUpperCase()));
}

registerTab('controls', {
  open: loadControls,
});
