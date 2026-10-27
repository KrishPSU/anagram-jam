// Typing on a real keyboard: letters pick a matching tile, Backspace takes the last one back,
// Enter checks a full answer and Space shuffles. (The on-screen QWERTY keyboard was replaced by
// tappable tiles in game.js.)

document.addEventListener('keydown', (event) => {
  // Leave browser shortcuts (Cmd/Ctrl+R, Cmd+L, ...) alone, and only type while a level is on screen
  if (event.metaKey || event.ctrlKey || event.altKey || !isPlaying()) return;

  if (/^[a-z]$/i.test(event.key)) {
    event.preventDefault();
    typeLetter(event.key.toUpperCase());
  } else if (event.key === 'Backspace') {
    event.preventDefault();
    undoLetter();
  } else if (event.key === 'Enter') {
    // preventDefault so a focused tile button isn't "clicked" as well
    event.preventDefault();
    submitAnswer();
  } else if (event.key === ' ') {
    event.preventDefault();
    shuffleTiles();
  }
});
