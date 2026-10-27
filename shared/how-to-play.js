// The "How to play" box, shared by the home page and the lobby. Any button with data-how-to-play opens it.
// Until someone has opened it once (in this browser), those buttons glow to catch a first-timer's eye.
// closeHowToPlay() puts it away, e.g. when a round's 3-2-1 starts.

(() => {
  const SEEN_KEY = 'seenHowToPlay';

  const tiles = (word, extra = '') => [...word].map(letter => `<span class="tile${extra}">${letter}</span>`).join('');

  const dialog = document.createElement('dialog');
  dialog.className = 'howto-dialog';
  dialog.setAttribute('aria-labelledby', 'howtoTitle');
  dialog.innerHTML = `
    <form class="howto-card card" method="dialog">
      <div class="howto-head">
        <h2 id="howtoTitle">How to play</h2>
        <button class="howto-close" aria-label="Close">×</button>
      </div>

      <ol class="howto-steps">
        <li>
          <h3>Make a room</h3>
          <p>Send your friends the 5-letter code or the invite link. You need at least 2 players.</p>
          <div class="howto-art" aria-hidden="true">${tiles('KQMTB')}</div>
        </li>
        <li>
          <h3>Everyone gets ready</h3>
          <p>The round starts as soon as everyone in the room taps <b>I'm&nbsp;ready</b>.</p>
          <div class="howto-art" aria-hidden="true">
            <span class="howto-chip ready">✓ Ready</span><span class="howto-chip ready">✓ Ready</span><span class="howto-arrow">→</span><b class="howto-go">GO!</b>
          </div>
        </li>
        <li>
          <h3>Unscramble 10 words</h3>
          <p>Tap the tiles, or type, to spell a word that uses every letter. Each word has 30 seconds. When time runs out, you move on to the next one.</p>
          <div class="howto-art" aria-hidden="true">
            ${tiles('TAC')}<span class="howto-arrow">→</span>${tiles('CAT', ' win')}<span class="howto-chip">⏱ 30s</span>
          </div>
        </li>
        <li>
          <h3>Score and win</h3>
          <p>The hidden word is worth 2 points. Any other real word made from the same letters is worth 1. <b>The round ends as soon as anyone gets through all 10 words, and the most points wins.</b> On a tie, whoever got to that score first wins.</p>
          <div class="howto-art" aria-hidden="true">
            <span class="howto-chip">CAT <b class="howto-pts">+2</b></span><span class="howto-chip">ACT <b class="howto-pts one">+1</b></span>
          </div>
        </li>
      </ol>

      <p class="howto-tip">Tip: tap a letter in your answer to put it back, or 🔄 to shuffle.</p>

      <button class="btn btn-primary">Got it</button>
    </form>
  `;
  document.body.appendChild(dialog);

  const buttons = [...document.querySelectorAll('[data-how-to-play]')];

  if (!localStorage.getItem(SEEN_KEY)) buttons.forEach(btn => btn.classList.add('is-new'));

  buttons.forEach(btn => btn.addEventListener('click', () => {
    localStorage.setItem(SEEN_KEY, '1');
    buttons.forEach(b => b.classList.remove('is-new'));
    dialog.showModal();
    // Open at the top even if it was scrolled down last time
    dialog.querySelector('.howto-card').scrollTop = 0;
  }));

  // Tapping outside the box closes it
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  window.closeHowToPlay = () => {
    if (dialog.open) dialog.close();
  };
})();
