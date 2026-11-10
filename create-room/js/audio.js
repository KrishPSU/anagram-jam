// The music: one track for the lobby and the results, another for the round (showView in lobby.js switches).
// Solo and practice use this file too: each page's round has its own track, named by `roundMusic` in the page's
// script (lobby.js, solo/js/solo.js, practice/js/practice.js), and solo's intro and results play the lobby's.
//
// It plays through the Web Audio API, on shared/sfx.js's audio context, rather than looping <audio> elements.
// Those left a gap and a click every time a track came around - every 11 seconds, with the old lobby's - and phones
// only let one start from a tap: the round's track starts when the words arrive, so on phones it often didn't.
// A decoded track loops without a gap, and once any tap has woken the audio context, either can start any time.

const MUSIC = {
  lobby: '/music/minimalist-synth-loop.m4a', // the rest: Minimalist Synth Loop 128 BPM
  room: '/music/anagram-rush.m4a',           // a room's round: Anagram Rush
  solo: '/music/octave-jump.m4a',            // a solo run: Octave Jump
  practice: '/music/anagram-rush-remix.m4a', // practice: Anagram Rush (Remix)
};
const MUSIC_VOLUME = 0.8;   // headroom for the sound effects on top - every track peaks right at full scale
const FADE_SECONDS = 0.5;   // from one track to the other
const SEAM_SECONDS = 0.025; // each track's end crossfades into its start over this long, so the loop doesn't click

const mute_btn = document.getElementById('mute-button');

const tracks = {};  // name -> { buffer, loopStart } once loaded ('loading' until then)
let playing = null; // the track that's on: { name, source, gain }
let musicHeld = false; // a room's round has just ended: quiet until its results are down (see holdMusic)

// The mute button covers the music and the sound effects in shared/sfx.js. It shows what you can hear: browsers keep a
// page silent until it's been tapped, so until then it's 🔇 even if you've never muted anything, and pressing it is
// what starts the music (as any other tap on the page does).
function showMuteState() {
  const silent = !sfx.sounding();
  mute_btn.textContent = silent ? "🔇" : "🔊";
  mute_btn.setAttribute('aria-pressed', silent ? 'true' : 'false');
}

mute_btn.addEventListener('click', () => {
  sfx.setMuted(sfx.sounding());
  showMuteState();
  syncMusic();
});

window.addEventListener('soundchange', showMuteState);


// Plays the track for the screen you're on, fading over from the other one - or nothing, muted. Called whenever
// the screen changes (showView), the mute button is pressed, or a track has loaded.
function syncMusic() {
  const wanted = sfx.muted() || (musicHeld && view !== 'lobby') ? null : (view === 'game' ? roundMusic : 'lobby');
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

// When a room's round ends, everything on the screen stops (game.js roundOver), and the music winds down with it like a
// record being stopped. It comes back once the results have landed (results.js) - or with the lobby, whichever is first.
function holdMusic(on) {
  musicHeld = on;
  if (on && playing) {
    const now = sfx.context().currentTime;
    playing.source.playbackRate.setValueAtTime(1, now);
    playing.source.playbackRate.linearRampToValueAtTime(0.3, now + 0.6);
    stopTrack(playing, 0.6);
    playing = null;
  }
  syncMusic();
}

function stopTrack({ source, gain }, fade) {
  const now = sfx.context().currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.linearRampToValueAtTime(0, now + fade);
  source.stop(now + fade);
}

// The round's track, so it's ready the moment the round starts, and the lobby's unless the page is all round
// (practice is). Unless muted - then they wait until they're wanted.
function loadMusic() {
  loadTrack(roundMusic);
  if (view !== 'game') loadTrack('lobby');
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
// straight into the beginning, with no jump in the waveform to click. Otherwise the loop is the whole file: each
// track is a whole song that ends and starts again from the top (the round tracks fade out, and their files end
// 0.3 s after the fade, the silence after it cut; the lobby's dies away in its last second).
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
