const audio = document.getElementById('backgroundMusic');
audio.loop = true; // loop the music

document.addEventListener('click', () => {
  audio.play().catch((e) => {
    console.log("(CLICK) Audio play was prevented:", e);
  });
}, { once: true }); // only trigger once

window.addEventListener('load', () => {
  const audio = document.getElementById('backgroundMusic');
  audio.muted = false;
  audio.play().catch((e) => {
    console.log("(LOAD) Audio play was prevented:", e);
  });
});