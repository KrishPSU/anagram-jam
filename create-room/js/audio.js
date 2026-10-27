// The music: one track for the lobby and the results, another for the round (showView in lobby.js switches).
//
// It plays through the Web Audio API, on shared/sfx.js's audio context, rather than looping <audio> elements.
// Those left a gap and a click every time a track came around - every 11 seconds, with the lobby's - and phones
// only let one start from a tap: the round's track starts when the words arrive, so on phones it often didn't.
// A decoded track loops without a gap, and once any tap has woken the audio context, either can start any time.

const MUSIC = {
  lobby: '/music/anagram-jam-background-music.mp3',
  game: '/music/what you in joined sample.mp3',
};
const MUSIC_VOLUME = 0.8;   // headroom for the sound effects on top - the round's track peaks right at full scale
const FADE_SECONDS = 0.5;   // from one track to the other
const SEAM_SECONDS = 0.025; // each track's end crossfades into its start over this long, so the loop doesn't click

const mute_btn = document.getElementById('mute-button');

const tracks = {};  // name -> { buffer, loopStart } once loaded ('loading' until then)
let playing = null; // the track that's on: { name, source, gain }

// The mute button covers the music and the sound effects in shared/sfx.js
function showMuteState() {
  const muted = sfx.muted();
  mute_btn.textContent = muted ? "🔇" : "🔊";
  mute_btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
}

mute_btn.addEventListener('click', () => {
  sfx.setMuted(!sfx.muted());
  showMuteState();
  syncMusic();
});


// Plays the track for the screen you're on, fading over from the other one - or nothing, muted. Called whenever
// the screen changes (showView), the mute button is pressed, or a track has loaded.
function syncMusic() {
  const wanted = sfx.muted() ? null : (view === 'game' ? 'game' : 'lobby');
  if (playing && playing.name === wanted) return;
  if (playing) stopTrack(playing, wanted ? FADE_SECONDS : 0);
  playing = null;
  if (!wanted) return;

  const track = tracks[wanted];
  if (!track || track === 'loading') {
    loadMusic(); // and it starts once it has
    return;
  }
  const ctx = sfx.context();
  const source = ctx.createBufferSource();
  source.buffer = track.buffer;
  source.loop = true;
  source.loopStart = track.loopStart;
  source.loopEnd = track.buffer.duration;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(MUSIC_VOLUME, ctx.currentTime + FADE_SECONDS);
  source.connect(gain).connect(ctx.destination);
  // If no tap has woken the audio context yet, this starts with it
  source.start();
  playing = { name: wanted, source, gain };
}

function stopTrack({ source, gain }, fade) {
  const now = sfx.context().currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.linearRampToValueAtTime(0, now + fade);
  source.stop(now + fade);
}

// Both tracks, so the round's is ready the moment the round starts (unless muted - then they wait until they're wanted)
function loadMusic() {
  loadTrack('lobby');
  loadTrack('game');
}

// Fetched and decoded once
function loadTrack(name) {
  const ctx = sfx.context();
  if (tracks[name] || !ctx) return;
  tracks[name] = 'loading';
  fetch(MUSIC[name])
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    })
    // The callback form - Safari before 14.1 doesn't return a promise
    .then(data => new Promise((resolve, reject) => ctx.decodeAudioData(data, resolve, reject)))
    .then((buffer) => {
      tracks[name] = seamless(buffer);
      syncMusic();
    })
    .catch((err) => {
      delete tracks[name]; // tried again the next time it's wanted
      console.log(`Couldn't load the ${name} music:`, err);
    });
}

// Blends the track's start into its last SEAM_SECONDS, and loops back to just after that start: the end runs
// straight into the beginning, with no jump in the waveform to click. Otherwise the loop is the whole file - the
// lobby's track is cut to come around on the beat, and the round's opens with a quarter-second rest that does.
function seamless(buffer) {
  const n = Math.min(Math.round(SEAM_SECONDS * buffer.sampleRate), Math.floor(buffer.length / 2));
  const end = buffer.length - n;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const samples = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const t = ((i + 0.5) / n) * (Math.PI / 2);
      samples[end + i] = samples[end + i] * Math.cos(t) + samples[i] * Math.sin(t);
    }
  }
  return { buffer, loopStart: n / buffer.sampleRate };
}


showMuteState();
if (!sfx.muted()) loadMusic();
