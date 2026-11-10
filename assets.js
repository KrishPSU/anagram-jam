// How the game's own files (scripts, styles, music, icons) are sent, so pages load fast and are never stale after a
// deploy:
// - Every file's ETag comes from what's in it. Express's own is made from its size and date, and Vercel gives every file
//   the same date (2018), so an edit that kept a file's size (PAGE_VERSION 4 -> 5, say) looked unchanged and browsers
//   kept the old one.
// - The pages name each of their scripts and styles with a version made from its contents (/shared/theme.css?v=1a2b3c4d,
//   see sendPage), and a file asked for at its current version is kept by the browser (and Vercel's CDN) for a year
//   without asking again. A deploy that changes a file changes its version, so pages ask for the new one. Before this,
//   every page load checked each of its ~20 files with the server first.
// - The pages themselves are checked every time (no-cache), so a deploy reaches everyone on their next page.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const YEAR = 365 * 24 * 60 * 60;

// Where each address prefix's files are (as the express.static mounts in index.js). The root is the room page's
// folder first, then home's.
const ROOT = __dirname;
const MOUNTS = [
  ['/shared/', ['shared']],
  ['/solo/', ['solo']],
  ['/practice/', ['practice']],
  ['/daily/', ['daily']],
  ['/info/', ['info']],
  ['/account/', ['account']],
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

// For express.static's setHeaders, and sendFile: the ETag from the file's contents (send only makes its own when there
// isn't one), and a year's keeping when it was asked for at its current version
function setHeaders(res, file) {
  const hash = hashOf(file);
  if (!hash) return;
  res.setHeader('ETag', `"${hash}"`);
  const asked = res.req && res.req.query && res.req.query.v;
  if (asked && asked === hash.slice(0, 10)) res.setHeader('Cache-Control', `public, max-age=${YEAR}, s-maxage=${YEAR}, immutable`);
}

const staticOptions = (options = {}) => ({ ...options, setHeaders });

// res.sendFile with the same headers
function sendAsset(res, file) {
  const hash = hashOf(file);
  res.sendFile(file, hash ? { headers: { ETag: `"${hash}"` } } : {});
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

// A page, with each of its own scripts and styles named at their current version (not other sites', not
// /socket.io/, not ones that already have a ?v=)
function sendPage(res, pageFile) {
  let html;
  try {
    html = fs.readFileSync(pageFile, 'utf8');
  } catch {
    return res.status(404).type('text').send('Not found');
  }
  html = html.replace(/(<(?:script|link)\b[^>]*?\s(?:src|href)=")([^"?#]+\.(?:js|css))(")/g, (whole, start, ref, end) => {
    if (/^(?:[a-z]+:)?\/\//i.test(ref) || ref.startsWith('/socket.io/')) return whole;
    const file = fileFor(ref, pageFile);
    const version = file && versionOf(file);
    return version ? `${start}${ref}?v=${version}${end}` : whole;
  });
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(html);
}

module.exports = { staticOptions, sendAsset, sendPage };
