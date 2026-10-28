// The Leaderboard tab: the whole solo board with each name as it was typed, a way to take someone off it, and exports.
// It's read when the tab opens and on Refresh, not polled.

const boardListEl = document.getElementById('boardList');
const boardStateEl = document.getElementById('boardState');
const boardSummaryEl = document.getElementById('boardSummary');
const boardSearch = document.getElementById('boardSearch');

let boardRows = null; // the last read, as solo.js's adminBoard gives it
let boardPlayers = 0;

async function loadBoard() {
  setState(boardStateEl, boardRows ? '' : 'Loading the leaderboard…', { loading: true });
  try {
    const reply = await api('leaderboard');
    if (reply.status !== 'ok') {
      setState(boardStateEl, "The leaderboard can't be reached right now (Supabase isn't answering). Try again in a bit.", { error: true });
      return;
    }
    boardRows = reply.top;
    boardPlayers = reply.players;
    setState(boardStateEl, '');
    renderBoard();
  } catch (err) {
    setState(boardStateEl, err.message, { error: true });
  }
}

function renderBoard() {
  const search = boardSearch.value.trim().toLowerCase();
  const rows = search ? boardRows.filter(row => row.name.toLowerCase().includes(search)) : boardRows;
  const hidden = boardRows.filter(row => row.hidden).length;
  boardSummaryEl.textContent = boardPlayers
    ? `${plural(boardPlayers, 'player')} on the board${hidden ? ` · ${hidden} showing as "Player"` : ''}`
    : '';
  if (!boardPlayers) setState(boardStateEl, 'Nobody is on the board yet.');
  else if (!rows.length) setState(boardStateEl, `No names with "${boardSearch.value.trim()}" in them.`);
  else setState(boardStateEl, '');
  boardListEl.replaceChildren(...rows.map(boardRow));
}

function boardRow(row) {
  const name = el('span.lb-name', { title: row.name }, row.name);
  const meta = [row.words === null ? 'Words not kept (a one-minute run)' : plural(row.words, 'word'), when(row.at)];
  const remove = confirmButton({
    key: `board:${row.id}`,
    label: 'Remove',
    armedLabel: 'Remove?',
    onConfirm: async () => {
      try {
        const reply = await api('leaderboard/remove', { id: row.id, name: row.name });
        if (reply.status !== 'ok') throw new Error("The leaderboard can't be reached right now.");
        showAlert(`${row.name} is off the leaderboard.`, 'success');
        await loadBoard();
      } catch (err) {
        showAlert(err.message);
      }
    },
  });
  return el(`li.lb-row${row.rank <= 3 ? '.lb-top' : ''}`,
    el('span.lb-place', row.rank),
    avatarEl(row.name),
    el('div.lb-main',
      el('span.lb-line', name, row.hidden ? el('span.chip.warn', { title: 'Everyone else sees this name as "Player"' }, 'Shows as Player') : null),
      el('span.lb-meta', meta.join(' · ')),
    ),
    el('span.lb-points', plural(row.points, 'pt')),
    remove,
  );
}

boardSearch.addEventListener('input', () => {
  if (boardRows) renderBoard();
});

document.getElementById('boardRefreshBtn').addEventListener('click', loadBoard);

// A spreadsheet would run a name starting with = + - or @ as a formula, so those get a ' in front
function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportRows() {
  return (boardRows || []).map(row => ({
    rank: row.rank,
    name: row.name,
    shownAs: row.hidden ? 'Player' : row.name,
    points: row.points,
    words: row.words,
    setAt: new Date(row.at).toISOString(),
    id: row.id,
  }));
}

const exportName = (ext) => `anagram-jam-leaderboard-${new Date().toISOString().slice(0, 10)}.${ext}`;

document.getElementById('exportCsvBtn').addEventListener('click', () => {
  if (!boardRows || !boardRows.length) return showAlert('There’s nothing on the board to export yet.', 'info');
  const rows = exportRows();
  const columns = Object.keys(rows[0]);
  const csv = [columns.join(','), ...rows.map(row => columns.map(c => csvCell(row[c])).join(','))].join('\n');
  download(exportName('csv'), 'text/csv', csv);
});

document.getElementById('exportJsonBtn').addEventListener('click', () => {
  if (!boardRows || !boardRows.length) return showAlert('There’s nothing on the board to export yet.', 'info');
  download(exportName('json'), 'application/json', JSON.stringify({ exportedAt: new Date().toISOString(), players: boardPlayers, rows: exportRows() }, null, 2));
});

registerTab('leaderboard', {
  open: loadBoard,
});
