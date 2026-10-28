// The Stats tab: players, rounds, solo runs and rooms over the last 7 or 30 days, in this browser's time zone, and by
// hour of the day. The server adds them up from hourly counts (see statsReport in admin.js). Read when the tab opens,
// or the range changes - not polled.

const STAT_METRICS = {
  players: { title: 'Players each day', one: 'player', many: 'players' },
  rounds: { title: 'Rounds played each day', one: 'round', many: 'rounds' },
  solo: { title: 'Solo runs each day', one: 'solo run', many: 'solo runs' },
  rooms: { title: 'Rooms created each day', one: 'room', many: 'rooms' },
};

const statsTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const dailyChartEl = document.getElementById('dailyChart');
const hourChartEl = document.getElementById('hourChart');
const dailyTableEl = document.getElementById('dailyTable');
const statsNoteEl = document.getElementById('statsNote');

let statsDays = 30;
let statsMetric = 'players';
let report = null;
let statsLoading = false;

document.getElementById('statsSub').textContent = `Days and hours in your time (${statsTimeZone})`;

async function loadStats() {
  if (statsLoading) return;
  statsLoading = true;
  // While it loads, the charts keep their last drawing, dimmed
  document.getElementById('panel-stats').classList.add('is-loading');
  try {
    report = await api(`stats?days=${statsDays}&tz=${encodeURIComponent(statsTimeZone)}`);
    renderStats();
  } catch (err) {
    showAlert(err.message);
  } finally {
    statsLoading = false;
    document.getElementById('panel-stats').classList.remove('is-loading');
  }
}

const sum = (rows, metric) => rows.reduce((n, row) => n + row[metric], 0);
// 'YYYY-MM-DD' is a day in the chosen time zone already, so it's read as UTC to stay that day
const dayDate = (day) => new Date(day + 'T12:00:00Z');
const dayLabel = (day, options) => dayDate(day).toLocaleDateString(undefined, { timeZone: 'UTC', ...options });

function renderStats() {
  const { daily, hourly, players } = report;
  const today = daily[daily.length - 1];
  const tile = (id, value, todayValue) => {
    document.getElementById(id).textContent = value.toLocaleString();
    document.getElementById(id + 'Today').textContent = `Today: ${todayValue.toLocaleString()}`;
  };
  tile('statPlayers', players, today.players);
  tile('statRounds', sum(daily, 'rounds'), today.rounds);
  tile('statSolo', sum(daily, 'solo'), today.solo);
  tile('statRooms', sum(daily, 'rooms'), today.rooms);

  const metric = STAT_METRICS[statsMetric];
  document.getElementById('dailyTitle').textContent = metric.title;
  const every = daily.length > 10 ? 5 : 1;
  columnChart(dailyChartEl, daily.map((row, i) => ({
    value: row[statsMetric],
    label: (daily.length - 1 - i) % every === 0 ? dayLabel(row.day, daily.length > 10 ? { month: 'short', day: 'numeric' } : { weekday: 'short', day: 'numeric' }) : '',
    tip: dayLabel(row.day, { weekday: 'short', month: 'short', day: 'numeric' }),
    unit: (n) => (n === 1 ? metric.one : metric.many),
  })));

  const hourName = (hour) => new Date(Date.UTC(2000, 0, 1, hour)).toLocaleTimeString(undefined, { hour: 'numeric', timeZone: 'UTC' });
  columnChart(hourChartEl, hourly.map((row, hour) => ({
    value: row.rounds + row.solo,
    label: hour % 6 === 0 ? hourName(hour) : '',
    tip: `${hourName(hour)} – ${hourName((hour + 1) % 24)} · ${plural(row.rounds, 'round')}, ${plural(row.solo, 'solo run')}`,
    unit: (n) => (n === 1 ? 'game' : 'games'),
  })));

  // Every number on the charts, readable without hovering
  dailyTableEl.replaceChildren(
    el('thead', el('tr', el('th', 'Day'), el('th', 'Players'), el('th', 'Rounds'), el('th', 'Solo runs'), el('th', 'Rooms'))),
    el('tbody', [...daily].reverse().map(row => el('tr',
      el('td', dayLabel(row.day, { weekday: 'short', month: 'short', day: 'numeric' })),
      el('td', row.players), el('td', row.rounds), el('td', row.solo), el('td', row.rooms),
    ))),
  );

  const anything = daily.some(row => row.players || row.rounds || row.solo || row.rooms);
  statsNoteEl.textContent = anything
    ? 'Players are different people (by browser) across rooms and solo. Counting started when this dashboard went live, so older games aren’t in here.'
    : 'Nothing counted yet. Counting started when this dashboard went live, so games from before then aren’t in here.';
}


// ---------- The chart ----------

// A column chart of one series, drawn to fit its box: items are { value, label (under the column, '' for none), tip,
// unit(n) }. Each column shows its number on hover or focus.
function columnChart(container, items) {
  const width = Math.max(240, container.clientWidth);
  const height = container.clientHeight || 220;
  const pad = { top: 10, right: 6, bottom: 26, left: 34 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...items.map(item => item.value));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const y = (value) => pad.top + innerH - (value / top) * innerH;
  const band = innerW / items.length;
  const barW = Math.max(2, Math.min(24, band - 2));

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Column chart. Use Tab to read each column, or open the table.' });
  const grid = svgEl('g', { class: 'grid' });
  for (let value = 0; value <= top; value += step) {
    grid.append(
      svgEl('line', { x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value), class: value === 0 ? 'baseline' : '' }),
      svgText(compact(value), { x: pad.left - 8, y: y(value) + 4, 'text-anchor': 'end', class: 'tick' }),
    );
  }
  svg.append(grid);

  const tip = el('div.chart-tip', { hidden: true, role: 'presentation' });
  items.forEach((item, i) => {
    const cx = pad.left + band * i + band / 2;
    const h = (item.value / top) * innerH;
    const bar = item.value ? svgEl('path', { d: roundedTop(cx - barW / 2, y(item.value), barW, h), class: 'bar' }) : null;
    if (bar) svg.append(bar);
    if (item.label) svg.append(svgText(item.label, { x: cx, y: height - 8, 'text-anchor': 'middle', class: 'tick' }));

    // The whole column's strip is the target, not just the bar
    const hit = svgEl('rect', { x: pad.left + band * i, y: pad.top, width: band, height: innerH, class: 'hit', tabindex: 0, 'aria-label': `${item.tip}: ${plural(item.value, item.unit(1), item.unit(2))}` });
    const show = () => {
      if (bar) bar.classList.add('on');
      tip.replaceChildren(el('b', item.value.toLocaleString() + ' ' + item.unit(item.value)), el('span', item.tip));
      tip.hidden = false;
      const left = Math.min(Math.max(cx, 70), width - 70);
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(y(item.value), pad.top + 20) - 8}px`;
    };
    const hide = () => {
      if (bar) bar.classList.remove('on');
      tip.hidden = true;
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', show);
    hit.addEventListener('blur', hide);
    svg.append(hit);
  });

  container.replaceChildren(svg, tip);
  container.chartItems = items;
  container.drawnWidth = container.clientWidth;
  // Leaving the chart (or scrolling it out from under the pointer) never leaves a tooltip behind
  container.onpointerleave = () => {
    tip.hidden = true;
    svg.querySelectorAll('.bar.on').forEach(bar => bar.classList.remove('on'));
  };
}

window.addEventListener('scroll', () => {
  document.querySelectorAll('.chart-tip').forEach(tip => { tip.hidden = true; });
  document.querySelectorAll('.chart .bar.on').forEach(bar => bar.classList.remove('on'));
}, { passive: true });

// 1, 2, 5, 10, 20, 50... - whichever gives about three gridlines
function niceStep(max) {
  const rough = max / 3;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map(m => m * power).find(s => s >= rough) || 10 * power;
  return Math.max(1, Math.round(step));
}

const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n % 1000 ? 1 : 0)}K` : String(n));

// A column with its top corners rounded (4px) and a square foot on the baseline
function roundedTop(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== '' && value !== null) node.setAttribute(key, value);
  return node;
}

function svgText(text, attrs) {
  const node = svgEl('text', attrs);
  node.textContent = text;
  return node;
}

// Drawn again to fit when the window changes size
const chartResize = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const items = entry.target.chartItems;
    if (items && Math.abs(entry.contentRect.width - (entry.target.drawnWidth || 0)) > 4) {
      entry.target.drawnWidth = entry.contentRect.width;
      columnChart(entry.target, items);
    }
  }
});
[dailyChartEl, hourChartEl].forEach(chart => chartResize.observe(chart));


// ---------- Controls ----------

document.getElementById('rangeSeg').addEventListener('click', (e) => {
  const button = e.target.closest('[data-days]');
  if (!button || Number(button.dataset.days) === statsDays) return;
  statsDays = Number(button.dataset.days);
  e.currentTarget.querySelectorAll('[data-days]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  loadStats();
});

document.getElementById('metricSeg').addEventListener('click', (e) => {
  const button = e.target.closest('[data-metric]');
  if (!button) return;
  statsMetric = button.dataset.metric;
  e.currentTarget.querySelectorAll('[data-metric]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  if (report) renderStats();
});

registerTab('stats', {
  open: loadStats,
});
