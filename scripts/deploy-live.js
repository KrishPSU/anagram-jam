// Puts this folder's main on the live site, www.anagramjam.com. That's the Vercel project that deploys
// github.com/KrishSChavan/anagram-jam - not this folder's origin (KrishPSU/anagram-jam) - so the live repo gets a commit
// of its own: main's files minus node_modules (this repo has it from its first commit; Vercel installs it from the
// lockfile), on top of what's live now. Then it waits for Vercel to say the deploy is done.
//
// Anything changed here that isn't committed yet is committed on main first, all of it as one commit - new files too,
// but never node_modules. It lists what it's about to commit and asks for the commit's message (Enter takes the one it
// suggests, Ctrl+C stops without committing anything).
//
//   npm run deploy                      commits what's changed, shows what's going live, pushes it, waits for Vercel
//   npm run deploy -- -m "Message"      the same, with that as the commit's message instead of asking
//   npm run deploy -- --dry-run         shows what would be committed and go live, and changes nothing
//
// It stops without pushing if the live repo has anything main never had - something put there some other way - so
// nothing is overwritten. Talking to the live repo uses the GitHub CLI's sign-in (gh, as KrishSChavan). main isn't
// pushed to origin - that's still `git push origin main`.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline/promises');

const LIVE_REPO = 'https://github.com/KrishSChavan/anagram-jam.git';
const LIVE_NAME = 'KrishSChavan/anagram-jam';
const SITE = 'https://www.anagramjam.com';
const LIVE_REF = 'refs/remotes/live-check/main'; // the live repo's main, as last fetched
const DEPLOY_BRANCH = 'live-deploy';              // and what this last put there, kept here to look at
const LOOK_BACK = 500;  // commits of main's history to search for what's live
const WAIT_MINUTES = 5; // Vercel's build normally takes about one

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
// -m "Message" or --message "Message"
const messageAt = args.findIndex(arg => arg === '-m' || arg === '--message');
const givenMessage = messageAt === -1 ? null : (args[messageAt + 1] || '').trim();

// git signed in through gh, which can reach the live repo (private, and another account from origin's)
const AS_GH = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Runs a command in this folder and returns what it printed. input: fed to it. env: its environment, if not this one's.
function run(command, args, { input, env } = {}) {
  return execFileSync(command, args, { cwd: path.join(__dirname, '..'), input, env, encoding: 'utf8', stdio: 'pipe' }).trimEnd();
}

const git = (...args) => run('git', args);
const short = (commit) => commit.slice(0, 7);

// A commit's files without node_modules, as a tree
function treeWithoutModules(commit) {
  const entries = git('ls-tree', '-z', commit).split('\0').filter(entry => entry && !entry.endsWith('\tnode_modules'));
  return run('git', ['mktree', '-z'], { input: entries.map(entry => entry + '\0').join('') });
}


// ---------- Committing what's changed ----------

// What's changed and not committed, outside node_modules, as `git status --short` lists it: [{ line, file }]
function changes() {
  return git('status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude)node_modules').split('\n').filter(Boolean)
    .map(line => ({ line, file: line.slice(3).split(' -> ').pop().replace(/^"|"$/g, '') }));
}

// "Change admin.js, daily.js and data.js", "Change admin.js, daily.js and 4 more files"
function suggestedMessage(changed) {
  const names = changed.map(c => c.file);
  if (names.length === 1) return `Change ${names[0]}`;
  if (names.length <= 3) return `Change ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Change ${names.slice(0, 2).join(', ')} and ${names.length - 2} more files`;
}

// The commit's message: -m's, or asked for (Enter takes the suggestion). Without anyone at the terminal to ask, the
// suggestion.
async function commitMessage(suggestion) {
  if (givenMessage) return givenMessage;
  if (!process.stdin.isTTY) return suggestion;
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(`Commit message (Enter for "${suggestion}"): `)).trim() || suggestion;
  } finally {
    prompt.close();
  }
}

// Commits everything changed (outside node_modules) on main, and resolves to main as it is then. A dry run commits
// nothing: it resolves to the commit it would have made, which no branch points to, so the rest can show what would go
// live with it.
async function commitChanges(changed) {
  const branch = git('branch', '--show-current');
  if (branch !== 'main') {
    console.error(`Stopped: there are uncommitted changes, and this is ${branch ? `the ${branch} branch` : 'no branch'}, not main - they'd be committed there.`);
    console.error('Switch to main first (git switch main), or commit them yourself.');
    process.exit(1);
  }

  console.log(dryRun ? 'Uncommitted changes, which a real run commits on main first:' : 'Committing these changes on main first:');
  changed.forEach(c => console.log(`  ${c.line}`));
  console.log('');
  if (dryRun) return previewCommit();

  const message = await commitMessage(suggestedMessage(changed));
  stageChanges();
  git('commit', '--quiet', '-m', message);
  const head = git('rev-parse', 'HEAD');
  console.log(`Committed ${short(head)}: ${message}\n`);
  return head;
}

// Stages everything (new files too - .gitignore keeps out .env and the like) but node_modules, which goes back to
// what main has. env: another index to stage in, as GIT_INDEX_FILE.
function stageChanges(env) {
  run('git', ['add', '--all'], { env });
  run('git', ['reset', '--quiet', 'main', '--', 'node_modules'], { env });
}

// The commit committing everything would make, without touching main or what's staged: it's put together in an index
// of its own
function previewCommit() {
  const index = path.join(os.tmpdir(), `anagram-jam-deploy-${process.pid}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    run('git', ['read-tree', 'main'], { env });
    stageChanges(env);
    const tree = run('git', ['write-tree'], { env });
    return run('git', ['commit-tree', tree, '-p', 'main', '-m', '(the uncommitted changes)']);
  } finally {
    fs.rmSync(index, { force: true });
  }
}


async function deploy() {
  let head = git('rev-parse', '--verify', 'main^{commit}');
  const changed = changes();
  if (changed.length) head = await commitChanges(changed);
  if (git('status', '--porcelain', '--', 'node_modules')) {
    console.log("Note: node_modules has changes. They're left out - Vercel installs packages from the lockfile.\n");
  }

  console.log(`Checking what ${SITE} is running…`);
  git(...AS_GH, 'fetch', '--quiet', LIVE_REPO, `+main:${LIVE_REF}`);
  const live = git('rev-parse', LIVE_REF);
  const liveTree = git('rev-parse', `${live}^{tree}`);
  const tree = treeWithoutModules(head);
  if (tree === liveTree) {
    console.log(`It's already up to date: main ${short(head)} is live.`);
    return;
  }

  // The newest commit on main that's what's live now - the ones after it are what's going live
  const history = git('rev-list', '--first-parent', `--max-count=${LOOK_BACK}`, head).split('\n');
  const since = history.findIndex(commit => treeWithoutModules(commit) === liveTree);
  if (since === -1) {
    console.error(`Stopped: the live repo (${LIVE_NAME}, at ${short(live)}) has changes that aren't on main, and this would undo them.`);
    console.error(`Bring them onto main first - see what they are with: git diff ${short(live)} main -- . ':!node_modules'`);
    process.exit(1);
  }
  const subjects = history.slice(0, since).map(commit => git('log', '-1', '--format=%s', commit));

  console.log(`\nGoing live (${subjects.length} ${subjects.length === 1 ? 'commit' : 'commits'} since what's up now):`);
  subjects.forEach(subject => console.log(`  ${subject}`));
  console.log(`\n${git('diff', '--stat', live, tree)}\n`);
  if (dryRun) {
    console.log('Dry run - nothing was pushed.');
    return;
  }

  const message = subjects.length === 1
    ? `${subjects[0]}, from KrishPSU/anagram-jam\n\nmain ${head}\n`
    : `Bring over ${subjects.length} commits from KrishPSU/anagram-jam\n\n${subjects.map(s => `- ${s}`).join('\n')}\n\nmain ${head}\n`;
  const commit = run('git', ['commit-tree', tree, '-p', live, '-F', '-'], { input: message });
  git('update-ref', `refs/heads/${DEPLOY_BRANCH}`, commit);

  console.log(`Pushing ${short(commit)} to ${LIVE_NAME}…`);
  try {
    // Not forced: if the live repo has moved on since the fetch above, this is turned down rather than overwriting it
    git(...AS_GH, 'push', '--quiet', LIVE_REPO, `${commit}:refs/heads/main`);
  } catch (err) {
    console.error(String(err.stderr || err.message).trim());
    console.error('\nThe push was turned down - nothing went live. If the live repo changed meanwhile, run this again.');
    process.exit(1);
  }
  git('update-ref', LIVE_REF, commit);

  console.log('Pushed. Waiting for Vercel…');
  const status = await waitForVercel(commit);
  if (status && status.state === 'success') {
    console.log(`\nLive: ${SITE} is running main ${short(head)}.`);
  } else if (status) {
    console.error(`\nVercel's deploy failed (${status.description}) - the site stays on what it was running before.`);
    console.error(status.target_url);
    process.exit(1);
  } else {
    console.log(`\nVercel hasn't finished after ${WAIT_MINUTES} minutes. See: https://github.com/${LIVE_NAME}/commits/main`);
  }
  if (!onOrigin(head)) console.log('\nmain isn\'t on origin yet - git push origin main');
}

// Vercel puts its deploy's progress on the commit, as a status named "Vercel". Resolves to the finished one, or null
// if it hasn't finished in time.
async function waitForVercel(commit) {
  const until = Date.now() + WAIT_MINUTES * 60 * 1000;
  let shown = '';
  while (Date.now() < until) {
    await sleep(5000);
    let status;
    try {
      // Newest first
      status = JSON.parse(run('gh', ['api', `repos/${LIVE_NAME}/commits/${commit}/statuses`])).find(s => s.context === 'Vercel');
    } catch {
      continue; // asked again in a moment
    }
    if (!status) continue;
    if (status.description !== shown) console.log(`  ${status.description}`);
    shown = status.description;
    if (status.state !== 'pending') return status;
  }
  return null;
}

// Whether origin has main, as of the last fetch from it
function onOrigin(commit) {
  try {
    git('merge-base', '--is-ancestor', commit, 'origin/main');
    return true;
  } catch {
    return false;
  }
}


deploy().catch((err) => {
  if (err.code === 'ENOENT') console.error('Needs git and the GitHub CLI (gh), signed in as KrishSChavan.');
  else console.error(String(err.stderr || err.message).trim());
  process.exit(1);
});
