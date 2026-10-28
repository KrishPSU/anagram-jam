// Short sound effects made with the Web Audio API (no audio files), plus phone vibration. The game page's music
// (create-room/js/audio.js) plays through the same audio context. Everything follows the mute button
// ('muteAudio' in localStorage).

const sfx = (() => {
  let ctx;

  const muted = () => localStorage.getItem('muteAudio') === 'true';

  // iPhones: play through the silent switch, like the music did back when it was an <audio> element (Web Audio
  // would otherwise go quiet whenever the switch is on silent)
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch {}

  function context() {
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      ctx = new AudioCtx();
    }
    return ctx;
  }

  // Browsers only let a page make sound once it has been tapped or typed on - and iPhones only count a finger
  // that has lifted (touchend, click), not one going down. Phones also take the sound away when something else
  // wants it (a call, another app), so this keeps listening rather than stopping after the first tap.
  function wake() {
    if (muted()) return;
    const c = context();
    if (c && c.state !== 'running') c.resume().catch(() => {});
  }
  ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'].forEach(evt => window.addEventListener(evt, wake, { capture: true, passive: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wake();
  });

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

  return {
    context,
    muted,
    setMuted,
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
    buzz: (pattern) => {
      if (!muted() && navigator.vibrate) navigator.vibrate(pattern);
    },
  };
})();
