
const mute_btn = document.getElementById('mute-button');

let mute_audio = false;

mute_btn.addEventListener('click', () => {
  mute_audio = !mute_audio;
  localStorage.setItem('muteAudio', mute_audio ? 'true' : 'false');
  const background_audio = document.getElementById('backgroundMusic');
  const game_audio = document.getElementById('gameMusic');
  if (mute_audio) {
    background_audio.muted = true;
    game_audio.muted = true;
    mute_btn.innerHTML = "🔇";
  } else {
    background_audio.muted = false;
    game_audio.muted = false;
    mute_btn.innerHTML = "🔊";
    // The browser may have blocked autoplay on load, so start this screen's track now
    const track = currentWords.length ? game_audio : background_audio;
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

  mute_audio = localStorage.getItem('muteAudio') === 'true';
  if (mute_audio) {
    mute_btn.innerHTML = "🔇";
  } else {
    mute_btn.innerHTML = "🔊";
  }

  const background_audio = document.getElementById('backgroundMusic');
  background_audio.muted = mute_audio;
  background_audio.play().catch((e) => {
    console.log("(LOAD) Audio play was prevented:", e);
  });
});



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