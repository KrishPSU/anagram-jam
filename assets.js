// How the game's own files (pages, scripts, styles, music, icons) are sent, so pages open fast and are never stale after
// a deploy:
// - Every file's ETag comes from what's in it. Express's own is made from its size and date, and Vercel gives every file
//   the same date (2018), so an edit that kept a file's size (PAGE_VERSION 4 -> 5, say) looked unchanged and browsers
//   kept the old one.
// - The pages name each of their scripts and styles with a version made from its contents (/shared/theme.css?v=1a2b3c4d,
//   see renderPage), and a file asked for at its current version is kept by the browser (and Vercel's CDN) for a year
//   without asking again. A deploy that changes a file changes its version, so pages ask for the new one.
// - The pages themselves have versions too (made from the page as it's sent, so from everything it loads), for the game's
//   own moves between them: /shared/slide.js asks for the page you're going to at its version (pageVersions, in
//   /site-config.json), gets it ready ahead of time, and then opening it doesn't wait on the network at all. Asked for
//   without one - typed in, a link, a reload - a page is checked with the server every time (no-cache), so a deploy
//   reaches everyone on their next page.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const YEAR = 365 * 24 * 60 * 60;
const KEEP = `public, max-age=${YEAR}, s-maxage=${YEAR}, immutable`;

// Where each address prefix's files are (as the express.static mounts in index.js, and /vendor/ in index.js). The root
// is the room page's folder first, then home's.
const ROOT = __dirname;
const MOUNTS = [
  ['/shared/', ['shared']],
  ['/solo/', ['solo']],
  ['/practice/', ['practice']],
  ['/daily/', ['daily']],
  ['/info/', ['info']],
  ['/account/', ['account']],
  ['/vendor/', [path.join('node_modules', 'socket.io', 'client-dist')]],
  ['/', ['create-room', 'home']],
];

// file -> { key (its size and date), hash }: worked out once per file (again if it changes, when running locally)
const hashes = new Map();

function hashOf(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const key = `${stat.size}:${stat.mtimeMs}`;
  const known = hashes.get(file);
  if (known && known.key === key) return known.hash;
  const hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  hashes.set(file, { key, hash });
  return hash;
}

const versionOf = (file) => {
  const hash = hashOf(file);
  return hash && hash.slice(0, 10);
};

// The ETag from the file's contents, and a year's keeping when it was asked for at its current version
function headersFor(req, file) {
  const hash = hashOf(file);
  if (!hash) return {};
  const headers = { ETag: `"${hash}"` };
  if (req && req.query && req.query.v === hash.slice(0, 10)) headers['Cache-Control'] = KEEP;
  return headers;
}

// For express.static's setHeaders (send only makes its own ETag and Cache-Control when there aren't any)
function setHeaders(res, file) {
  for (const [name, value] of Object.entries(headersFor(res.req, file))) res.setHeader(name, value);
}

const staticOptions = (options = {}) => ({ ...options, setHeaders });

// res.sendFile with the same headers
function sendAsset(res, file) {
  res.sendFile(file, { headers: headersFor(res.req, file) });
}

// The file an address in a page stands for: relative to the page's own folder, or through the mounts
function fileFor(ref, pageFile) {
  if (!ref.startsWith('/')) return path.join(path.dirname(pageFile), ref);
  for (const [prefix, dirs] of MOUNTS) {
    if (!ref.startsWith(prefix)) continue;
    for (const dir of dirs) {
      const file = path.join(ROOT, dir, ref.slice(prefix.length));
      if (hashOf(file)) return file;
    }
  }
  return null;
}

// A page as it's sent: each of its own scripts and styles named at their current version (not other sites', not ones
// that already have a ?v=). Null if there's no such page.
function renderPage(pageFile) {
  let html;
  try {
    html = fs.readFileSync(pageFile, 'utf8');
  } catch {
    return null;
  }
  return html.replace(/(<(?:script|link)\b[^>]*?\s(?:src|href)=")([^"?#]+\.(?:js|css))(")/g, (whole, start, ref, end) => {
    if (/^(?:[a-z]+:)?\/\//i.test(ref)) return whole;
    const file = fileFor(ref, pageFile);
    const version = file && versionOf(file);
    return version ? `${start}${ref}?v=${version}${end}` : whole;
  });
}

const pageVersion = (html) => crypto.createHash('sha1').update(html).digest('hex').slice(0, 10);

function sendPage(res, pageFile) {
  const html = renderPage(pageFile);
  if (html === null) return res.status(404).type('text').send('Not found');
  const version = pageVersion(html);
  res.set('ETag', `"page-${version}"`);
  res.set('Cache-Control', res.req.query.v === version ? KEEP : 'no-cache');
  res.type('html').send(html);
}

// Each page's version, by its address: { '/solo/': '1a2b3c4d5e', ... } for pages = { address: file }
function pageVersions(pages) {
  const versions = {};
  for (const [address, file] of Object.entries(pages)) {
    const html = renderPage(file);
    if (html !== null) versions[address] = pageVersion(html);
  }
  return versions;
}

module.exports = { staticOptions, sendAsset, sendPage, pageVersions };
