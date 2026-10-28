// The Controls tab: the home page banner, pausing new games, a message to everyone, and the word checker.

const bannerForm = document.getElementById('bannerForm');
const bannerText = document.getElementById('bannerText');
const bannerCount = document.getElementById('bannerCount');
const bannerNow = document.getElementById('bannerNow');
const bannerSaveBtn = document.getElementById('bannerSaveBtn');
const bannerClearBtn = document.getElementById('bannerClearBtn');
const pauseToggle = document.getElementById('pauseToggle');
const pauseLabel = document.getElementById('pauseLabel');
const reachCountEl = document.getElementById('reachCount');
const broadcastForm = document.getElementById('broadcastForm');
const broadcastText = document.getElementById('broadcastText');
const broadcastBtn = document.getElementById('broadcastBtn');
const wordForm = document.getElementById('wordForm');
const wordInput = document.getElementById('wordInput');
const wordResultEl = document.getElementById('wordResult');

const PAUSED_FALLBACK = 'New games are paused for a few minutes. Try again soon!';

let siteSettings = null; // { announcement, paused }, as the server has them

// The settings come with the Live tab's overview
async function loadControls() {
  try {
    const reply = await api('overview');
    setSession(reply.session.ends);
    siteSettings = reply.settings;
    reachCountEl.textContent = reply.totals.players
      ? `${plural(reply.totals.players, 'player')} in rooms, plus anyone on the home page or playing solo`
      : 'nobody is in a room right now, but anyone on the home page or playing solo will see it';
    if (document.activeElement !== bannerText) bannerText.value = siteSettings.announcement;
    showSettings();
  } catch (err) {
    showAlert(err.message);
  }
}

function showSettings() {
  const { announcement, paused } = siteSettings;
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
  wordResultEl.replaceChildren(el('p.word-line', el('span.spinner', { 'aria-hidden': 'true' }), ' Checking…'));
  try {
    const { result } = await api(`word?q=${encodeURIComponent(query)}`);
    wordResultEl.replaceChildren(...(result ? wordAnswer(result) : [el('p.word-line', 'Type at least two letters.')]));
  } catch (err) {
    wordResultEl.replaceChildren(el('p.word-line.bad', err.message));
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
