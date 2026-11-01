// The box after a word, got or not: the word, the share of today's players you did better than, your time against
// today's average, your streak, how everyone did, and a Share button for all of today's words you've finished. A
// finished word on today's list opens it again, with the numbers as they are by then.

const resultDialog = document.getElementById('resultDialog');
const resultEyebrowEl = document.getElementById('resultEyebrow');
const resultTitleEl = document.getElementById('resultTitle');
const resultWordEl = document.getElementById('resultWord');
const resultNoteEl = document.getElementById('resultNote');
const resultStatusEl = document.getElementById('resultStatus');
const resultStatusTextEl = document.getElementById('resultStatusText');
const resultRetryBtn = document.getElementById('resultRetry');
const resultNumbersEl = document.getElementById('resultNumbers');
const resultStandingEl = document.getElementById('resultStanding');
const resultTimeEl = document.getElementById('resultTime');
const resultMedianEl = document.getElementById('resultMedian');
const resultStreakEl = document.getElementById('resultStreak');
const resultCompareEl = document.getElementById('resultCompare');
const breakdownTitleEl = document.getElementById('breakdownTitle');
const barsEl = document.getElementById('bars');
const shareBtn = document.getElementById('shareBtn');

let shown = null; // { level, play } in the box
let asked = 0;    // the latest ask for numbers - a slow reply to an earlier one is ignored


// play: the finished go (see playFor in daily.js at the project root). result: today's numbers for it, or null to
// ask for them.
function showResult(level, play, result) {
  shown = { level, play };
  const name = LEVEL_NAMES[level];
  resultEyebrowEl.textContent = `Daily Jam #${today.number} · ${name}`;
  const tries = triesOf(play);
  resultTitleEl.textContent = !play.solved ? 'Out of tries' : tries === 1 ? 'Got it first try!' : `Got it in ${tries} tries!`;
  resultWordEl.className = `result-word ${play.solved ? 'got' : 'missed'}`;
  resultWordEl.replaceChildren(...[...play.word.toUpperCase()].map((letter) => el('span', 'tile', letter)));
  resultWordEl.style.setProperty('--letters', play.word.length);
  resultNoteEl.hidden = !play.solved || play.answer === play.word;
  resultNoteEl.textContent = `You found ${String(play.answer).toUpperCase()}, which counts too.`;
  shareBtn.textContent = 'Share';

  if (result) showNumbers(result);
  else loadNumbers();
  if (!resultDialog.open) resultDialog.showModal();
  resultDialog.querySelector('.result-card').scrollTop = 0;
}

async function loadNumbers() {
  const ask = ++asked;
  const { level, play } = shown;
  showNumbersWaiting(play);
  const reply = await request('daily-stats', { day, level, token: playerToken() }).catch(() => null);
  if (ask !== asked || !shown || shown.level !== level) return;
  if (!reply || reply.status !== 'ok') {
    resultNumbersEl.hidden = true;
    resultNumbersEl.removeAttribute('aria-busy');
    resultStatusEl.classList.remove('sr-only');
    resultStatusTextEl.textContent = "Couldn't get today's numbers.";
    resultRetryBtn.hidden = false;
    return;
  }
  setPlay(level, shown.play, reply.result);
  showNumbers(reply.result);
}

// Today's numbers on their way: the box laid out as it will be, so it doesn't change size when they come - with your
// time and which bar is yours, which this page knows already, and grey bars for the rest. The status line says what's
// happening to screen readers only.
function showNumbersWaiting(play) {
  resultRetryBtn.hidden = true;
  resultStatusEl.hidden = false;
  resultStatusEl.classList.add('sr-only');
  resultStatusTextEl.textContent = "Getting today's numbers…";
  resultNumbersEl.hidden = false;
  resultNumbersEl.setAttribute('aria-busy', 'true');

  resultStandingEl.classList.remove('great');
  resultStandingEl.replaceChildren(skel('15em'));
  resultTimeEl.textContent = formatTime(play.ms);
  resultMedianEl.replaceChildren(skel('2.4em'));
  const best = el('small', '', '');
  best.append(skel('3.6em'));
  resultStreakEl.replaceChildren(skel('2em'), best);
  // Only a word you got is compared with today's average
  resultCompareEl.hidden = !play.solved;
  resultCompareEl.replaceChildren(skel('17em'));

  breakdownTitleEl.textContent = "How today's players did";
  const widths = ['62%', '40%', '24%', '32%'];
  barsEl.replaceChildren(...barRows(play).map((row, i) => {
    const item = el('li', row.you ? 'you' : '', '');
    item.setAttribute('aria-hidden', 'true');
    const track = el('span', 'bar-track', '');
    track.append(skel(widths[i], 'skel-block'));
    item.append(el('span', 'bar-label', row.label), track, el('span', 'bar-you', row.you ? 'You' : ''));
    return item;
  }));
}

function showNumbers(result) {
  asked++;
  const { level, play } = shown;
  const name = LEVEL_NAMES[level];
  resultStatusEl.hidden = true;
  resultNumbersEl.hidden = false;
  resultNumbersEl.removeAttribute('aria-busy');

  // Better than how many - or, if you missed it, how many got it
  const got = result.got.reduce((sum, n) => sum + n, 0);
  resultStandingEl.textContent = play.solved
    ? result.first ? `You're the first to get today's ${name}!` : `Better than ${result.better}% of today's players`
    : result.first ? `You're the first to try today's ${name}.` : `${Math.round((100 * got) / result.players)}% of today's players got it`;
  resultStandingEl.classList.toggle('great', play.solved && (result.first || result.better >= 50));

  resultTimeEl.textContent = formatTime(play.ms);
  resultMedianEl.textContent = result.median === null ? '-' : formatTime(result.median);
  resultStreakEl.replaceChildren(`🔥 ${result.streak.current}`, el('small', '', `best ${result.streak.best}`));

  // Your time against the middle one - only when there's someone else's to go by
  resultCompareEl.hidden = !play.solved || result.median === null || result.players < 2;
  if (!resultCompareEl.hidden) {
    const off = result.median - play.ms;
    const seconds = Math.round(Math.abs(off) / 1000);
    const amount = seconds < 60 ? `${seconds} ${seconds === 1 ? 'second' : 'seconds'}` : formatTime(Math.abs(off));
    resultCompareEl.textContent = !seconds ? "Right on today's average" : `${amount} ${off > 0 ? 'faster' : 'slower'} than today's average`;
  }

  showBars(result, play);
}

// How everyone did: one bar each for got it on try 1, 2 and 3, and missed - yours picked out
function showBars(result, play) {
  breakdownTitleEl.textContent = `How today's ${result.players} ${result.players === 1 ? 'player' : 'players'} did`;
  const rows = barRows(play, result);
  const most = Math.max(1, ...rows.map(row => row.count));
  barsEl.replaceChildren(...rows.map((row) => {
    const item = el('li', row.you ? 'you' : '', '');
    item.setAttribute('aria-label', `${row.label}: ${row.count} ${row.count === 1 ? 'player' : 'players'}${row.you ? ', you' : ''}`);
    const bar = el('span', 'bar', '');
    bar.style.width = row.count ? `${Math.max(3, (100 * row.count) / most)}%` : '0';
    const track = el('span', 'bar-track', '');
    track.append(bar, el('span', 'bar-count', String(row.count)));
    item.append(el('span', 'bar-label', row.label), track, el('span', 'bar-you', row.you ? 'You' : ''));
    return item;
  }));
}

// The bars' rows: got it on try 1, 2 and 3, then missed, with yours picked out - and how many players each, once there
// are today's numbers to say (result)
function barRows(play, result) {
  const got = result ? result.got : Array(TRIES).fill(null);
  return [
    ...got.map((count, i) => ({ label: i ? `${i + 1} tries` : '1 try', count, you: play.solved && triesOf(play) === i + 1 })),
    { label: 'Missed', count: result ? result.missed : null, you: !play.solved },
  ];
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}


// Every word finished today, without giving any of them away:
//   Daily Jam #12
//   Easy 🟩 1/3 · 0:12
//   Medium 🟥🟩 2/3 · 0:41
//   Hard 🟥🟥🟥 X/3
//   www.anagramjam.com/daily
function shareText() {
  const lines = [`Daily Jam #${today.number}`];
  for (const { level, play } of today.levels) {
    if (!play || play.solved === null) continue;
    const squares = '🟥'.repeat(play.guesses.length) + (play.solved ? '🟩' : '');
    lines.push(`${LEVEL_NAMES[level]} ${squares} ${play.solved ? `${triesOf(play)}/${TRIES} · ${formatTime(play.ms)}` : `X/${TRIES}`}`);
  }
  lines.push(`${location.host}/daily`);
  return lines.join('\n');
}

// A phone's share sheet, or copied for pasting anywhere. (Toasts can't show over the box, so the button says how it went.)
shareBtn.addEventListener('click', async () => {
  const text = shareText();
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ text });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // they closed the share sheet
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    shareBtn.textContent = 'Copied! ✓';
  } catch {
    shareBtn.textContent = "Couldn't copy";
  }
  setTimeout(() => { shareBtn.textContent = 'Share'; }, 2500);
});

resultRetryBtn.addEventListener('click', loadNumbers);

// Tapping outside the box closes it
resultDialog.addEventListener('click', (event) => {
  if (event.target === resultDialog) resultDialog.close();
});

// Then it's back to today's list - moved on to tomorrow's words if it's past midnight
resultDialog.addEventListener('close', () => {
  shown = null;
  asked++;
  if (view === 'game' && onWord) return;
  backToDay();
});


// Same as confetti in solo/js/results.js: a few seconds of it, for getting the word
function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.getElementById('confetti');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;

  const colors = ['#ff5fa8', '#fbbf24', '#34d399', '#7c6cf0', '#22b8cf', '#ffffff'];
  const pieces = Array.from({ length: 140 }, () => ({
    x: Math.random() * canvas.width,
    y: -Math.random() * canvas.height * 0.6,
    w: (6 + Math.random() * 6) * dpr,
    h: (8 + Math.random() * 8) * dpr,
    vx: (Math.random() - 0.5) * 2.4 * dpr,
    vy: (2 + Math.random() * 3) * dpr,
    rotation: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 0.2,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));

  const start = performance.now();
  function frame(now) {
    const elapsed = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = elapsed > 3000 ? Math.max(0, 1 - (elapsed - 3000) / 1000) : 1;
    pieces.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.rotation += p.spin;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
    if (elapsed < 4000) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  requestAnimationFrame(frame);
}
