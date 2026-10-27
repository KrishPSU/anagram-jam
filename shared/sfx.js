// Short sound effects made with the Web Audio API (no audio files), plus phone vibration.
// Both follow the mute button ('muteAudio' in localStorage).

const sfx = (() => {
  let ctx;

  const muted = () => localStorage.getItem('muteAudio') === 'true';

  function audio() {
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      ctx = new AudioCtx();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // Browsers only allow sound after the player has tapped or typed something
  ['pointerdown', 'keydown'].forEach(evt => window.addEventListener(evt, audio, { once: true, passive: true }));

  // notes: [frequency, start offset (s), duration (s), wave, volume]
  function play(notes) {
    if (muted()) return;
    const c = audio();
    if (!c) return;
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
    tap: () => play([[520, 0, 0.05, 'sine', 0.04]]),
    tick: () => play([[880, 0, 0.05, 'square', 0.03]]),
    beep: () => play([[660, 0, 0.14, 'sine', 0.15]]),
    go: () => play([[990, 0, 0.3, 'triangle', 0.18]]),
    join: () => play([[523, 0, 0.09], [784, 0.08, 0.14]]),
    correct: () => play([[660, 0, 0.1], [990, 0.09, 0.18]]),
    wrong: () => play([[220, 0, 0.16, 'sawtooth', 0.07], [180, 0.12, 0.2, 'sawtooth', 0.07]]),
    timeUp: () => play([[392, 0, 0.16], [262, 0.14, 0.28]]),
    win: () => play([[523, 0, 0.12], [659, 0.11, 0.12], [784, 0.22, 0.12], [1047, 0.33, 0.35]]),
    buzz: (pattern) => {
      if (!muted() && navigator.vibrate) navigator.vibrate(pattern);
    },
  };
})();
