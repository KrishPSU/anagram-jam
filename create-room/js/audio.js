
const mute_btn = document.getElementById('mute-button');

let mute_audio = localStorage.getItem('muteAudio') === 'true';

// The mute button covers the music and the sound effects in shared/sfx.js
function showMuteState() {
  mute_btn.textContent = mute_audio ? "🔇" : "🔊";
  mute_btn.setAttribute('aria-pressed', mute_audio ? 'true' : 'false');
}

mute_btn.addEventListener('click', () => {
  mute_audio = !mute_audio;
  localStorage.setItem('muteAudio', mute_audio ? 'true' : 'false');
  const background_audio = document.getElementById('backgroundMusic');
  const game_audio = document.getElementById('gameMusic');
  showMuteState();
  if (mute_audio) {
    background_audio.muted = true;
    game_audio.muted = true;
  } else {
    background_audio.muted = false;
    game_audio.muted = false;
    // The browser may have blocked autoplay on load, so start this screen's track now
    const track = view === 'game' ? game_audio : background_audio;
    track.play().catch((e) => {
      console.log("(UNMUTE) Audio play was prevented:", e);
    });
  }
});

// document.addEventListener('click', () => {
//   background_audio.muted = mute_audio;

//   background_audio.play().catch((e) => {
//     console.log("(CLICK) Audio play was prevented:", e);
//   });
// }, { once: true });

window.addEventListener('load', () => {
  showMuteState();
  // You may already be back in a round by now
  if (view !== 'game') startLobbyAudio();
});

// The lobby's track, for the lobby and the results
function startLobbyAudio() {
  document.getElementById('gameMusic').pause();
  const background_audio = document.getElementById('backgroundMusic');
  background_audio.muted = mute_audio;
  if (!background_audio.paused) return; // already playing
  background_audio.play().catch((e) => {
    console.log("(LOBBY) Audio play was prevented:", e);
  });
}



function startGameAudio() {
  const background_audio = document.getElementById('backgroundMusic');
  background_audio.muted = true;
  background_audio.pause();
  const game_audio = document.getElementById('gameMusic');

  // Check `paused`, not `muted` - toggling mute in the lobby unmuted this track and it then never started
  if (!game_audio.paused) return; // already playing

  game_audio.muted = mute_audio;
  game_audio.play().catch((e) => {
    console.log("(START) Audio play was prevented:", e);
  });
}
