// Short sound effects made with the Web Audio API (no audio files), plus phone vibration. The game page's music
// (create-room/js/audio.js) plays through the same audio context. Everything follows the mute button
// ('muteAudio' in localStorage).

const sfx = (() => {
  let ctx;

  const muted = () => localStorage.getItem('muteAudio') === 'true';

  // No iPhone has navigator.vibrate, but the iPhone app (mobile/) has the phone's own haptics through Capacitor's
  // Haptics plugin. An app installed before the plugin was added doesn't have it, so this checks.
  const cap = window.Capacitor;
  const haptics = cap && cap.isPluginAvailable && cap.isPluginAvailable('Haptics') ? cap.Plugins.Haptics : null;

  // iPhones: the game's sound is the kind a game has ('ambient'), not the kind a music player has ('playback', which
  // this used to ask for). So the silent switch silences it, it plays alongside whatever the phone is already playing
  // rather than stopping it, and the phone doesn't put up its media player (lock screen, Control Center) for it.
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'ambient';
  } catch {}

  // In the iPhone app, whether the phone is already playing something of its own - a song, a podcast. Then the game's
  // music stays off and leaves it be (audio.js), and the sound effects still play over it, as iPhone games do. The app
  // tells it (OtherAudioPlugin.swift, there from build 6): asked as the page starts, and told again whenever the app
  // comes back to the front. A browser can't know, so there the music plays along with it.
  const otherAudio = cap && cap.isPluginAvailable && cap.isPluginAvailable('OtherAudio') ? cap.Plugins.OtherAudio : null;
  let yielding = false;
  function setYielding(playing) {
    if (yielding === !!playing) return;
    yielding = !!playing;
    window.dispatchEvent(new Event('otheraudiochange'));
  }
  // Resolves once it's known (straight away outside the app), so the music isn't fetched and decoded for nothing
  const known = !otherAudio ? Promise.resolve() : otherAudio.check().then(({ playing }) => setYielding(playing)).catch(() => {});
  if (otherAudio) otherAudio.addListener('change', ({ playing }) => setYielding(playing));

  function context() {
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      ctx = new AudioCtx();
      ctx.addEventListener('statechange', () => window.dispatchEvent(new Event('soundchange')));
    }
    return ctx;
  }

  // Whether sound is really coming out. It's on unless muted, but that means nothing until a page has been tapped.
  const sounding = () => !muted() && !!ctx && ctx.state === 'running';

  // Browsers only let a page make sound once it has been tapped or typed on - and iPhones only count a finger
  // that has lifted (touchend, click), not one going down. Phones also take the sound away when something else
  // wants it (a call, another app), so this keeps listening rather than stopping after the first tap.
  // The mute button's own presses are left to its click (audio.js): woken here, the press that was meant to start the
  // sound would find it on already, and mute it.
  function wake(event) {
    if (away || muted() || event?.target?.closest?.('#mute-button')) return;
    const c = context();
    if (c && c.state !== 'running') c.resume().catch(() => {});
  }
  ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'].forEach(evt => window.addEventListener(evt, wake, { capture: true, passive: true }));

  // Out of sight, out of earshot: the sound stops the moment the page isn't the one in front - the app closed or
  // swapped for another, the phone locked, another tab - and picks up where it was on coming back. Left alone, an
  // iPhone keeps a page's sound going after the app has gone. (The app also says so itself, with 'pause' and 'resume'
  // on the document, which covers a phone that's slow to call the page hidden.)
  let away = document.hidden;
  function leave() {
    away = true;
    if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
  }
  function comeBack() {
    if (document.hidden) return;
    away = false;
    if (ctx) wake();
  }
  document.addEventListener('visibilitychange', () => (document.hidden ? leave() : comeBack()));
  document.addEventListener('pause', leave);
  document.addEventListener('resume', comeBack);
  window.addEventListener('pagehide', leave);
  window.addEventListener('pageshow', comeBack);

  // Muted, the context is suspended rather than left running in silence: on a phone, a running one keeps other
  // apps' audio paused
  function setMuted(on) {
    localStorage.setItem('muteAudio', on ? 'true' : 'false');
    if (!on) wake();
    else if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
  }

  // notes: [frequency, start offset (s), duration (s), wave, volume]
  function play(notes) {
    if (muted()) return;
    const c = context();
    if (!c) return;
    wake();
    notes.forEach(([freq, start, duration, type = 'triangle', volume = 0.15]) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      const t = c.currentTime + start;
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(volume, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.connect(gain).connect(c.destination);
      osc.start(t);
      osc.stop(t + duration + 0.02);
    });
  }

  // One tone sliding from one pitch to another: [from, to (Hz), start offset (s), duration (s), wave, volume]
  function glide([from, to, start, duration, type, volume]) {
    if (muted()) return;
    const c = context();
    if (!c) return;
    wake();
    const osc = c.createOscillator();
    const gain = c.createGain();
    const t = c.currentTime + start;
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + duration);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  // A rush of air: noise through a filter sweeping down from `from` Hz to `to` Hz, loudest at `peak` seconds in
  function rush(from, to, duration, peak, volume) {
    if (muted()) return;
    const c = context();
    if (!c) return;
    wake();
    const t = c.currentTime;
    const buffer = c.createBuffer(1, Math.ceil(c.sampleRate * duration), c.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    const noise = c.createBufferSource();
    noise.buffer = buffer;
    const filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 0.9;
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(to, t + duration);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + peak);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    noise.connect(filter).connect(gain).connect(c.destination);
    noise.start(t);
  }

  return {
    context,
    muted,
    sounding,
    setMuted,
    // The phone is playing something of its own, so the music leaves it be (iPhone app only) - and once that's known
    yielding: () => yielding,
    known,
    tap: () => play([[520, 0, 0.05, 'sine', 0.04]]),
    tick: () => play([[880, 0, 0.05, 'square', 0.03]]),
    beep: () => play([[660, 0, 0.14, 'sine', 0.15]]),
    go: () => play([[990, 0, 0.3, 'triangle', 0.18]]),
    join: () => play([[523, 0, 0.09], [784, 0.08, 0.14]]),
    correct: () => play([[660, 0, 0.1], [990, 0.09, 0.18]]),
    wrong: () => play([[220, 0, 0.16, 'sawtooth', 0.07], [180, 0.12, 0.2, 'sawtooth', 0.07]]),
    timeUp: () => play([[392, 0, 0.16], [262, 0.14, 0.28]]),
    win: () => play([[523, 0, 0.12], [659, 0.11, 0.12], [784, 0.22, 0.12], [1047, 0.33, 0.35]]),
    // Solo mode's hints: one earned (just after the right answer's sound), and one used
    powerUp: () => play([[1175, 0.2, 0.08, 'sine', 0.1], [1568, 0.27, 0.08, 'sine', 0.1], [2093, 0.34, 0.22, 'sine', 0.08]]),
    hint: () => play([[1047, 0, 0.1, 'sine', 0.1], [1568, 0.06, 0.18, 'sine', 0.07]]),
    // Practice mode's 🤷: here's the word
    shrug: () => play([[587, 0, 0.12, 'sine', 0.1], [440, 0.1, 0.26, 'sine', 0.08]]),
    // A room's round stopping dead when someone finishes (create-room/js/game.js), like a record being stopped
    freeze: () => glide([520, 70, 0, 0.45, 'triangle', 0.16]),
    // Then its results coming down on their curtain (create-room/js/results.js): the cloth rushing down, and the thump as
    // it lands, 0.58 s in (curtain-drop in create-room/css/results.css)
    curtain: () => {
      rush(2600, 260, 0.62, 0.42, 0.14);
      glide([110, 42, 0.58, 0.32, 'sine', 0.42]);
    },
    // A short buzz for a right answer, a pattern of them for a wrong one. In the app: a tap, or the phone's error buzz.
    buzz: (pattern) => {
      if (muted()) return;
      if (haptics) {
        const felt = Array.isArray(pattern) ? haptics.notification({ type: 'ERROR' }) : haptics.impact({ style: 'MEDIUM' });
        felt.catch(() => {});
      } else if (navigator.vibrate) {
        navigator.vibrate(pattern);
      }
    },
  };
})();
