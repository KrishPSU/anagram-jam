// The System tab: which deployment is running, how the server and Redis are doing, and the sign-in's security - with
// anything worth fixing called out at the top.

const systemStateEl = document.getElementById('systemState');
const systemGridEl = document.getElementById('systemGrid');

async function loadSystem() {
  setState(systemStateEl, systemGridEl.hidden ? 'Loading…' : '', { loading: true });
  try {
    const [info, security] = await Promise.all([api('system'), api('activity?log=security')]);
    setSession(info.security.sessionEnds);
    renderSystem(info, security.entries);
    setState(systemStateEl, '');
    systemGridEl.hidden = false;
  } catch (err) {
    setState(systemStateEl, err.message, { error: true });
  }
}

// A <dl>'s rows from [label, value] pairs (a value can be an element; rows with no value are left out)
function facts(listEl, rows) {
  listEl.replaceChildren(...rows.filter(([, value]) => value !== null && value !== undefined && value !== '').flatMap(([label, value]) => [el('dt', label), el('dd', value)]));
}

function renderSystem({ deploy, server, security }, entries) {
  const commit = deploy.commit
    ? el('span', el('code', deploy.commit.slice(0, 7)), deploy.message ? ` ${deploy.message.split('\n')[0]}` : '')
    : 'Not on Vercel (running locally)';
  facts(document.getElementById('deployFacts'), [
    ['Commit', commit],
    ['Repository', deploy.repo && deploy.branch ? `${deploy.repo} · ${deploy.branch}` : deploy.repo],
    ['Environment', deploy.environment],
    ['Region', deploy.region],
    ['Deployment', deploy.url],
  ]);

  const redis = server.redis ? `${server.redis.latencyMs} ms a command · ${plural(server.redis.keys, 'key')}` : null;
  const up = server.uptime < 60 ? `${server.uptime}s` : server.uptime < 3600 ? `${Math.floor(server.uptime / 60)} min` : duration(server.uptime * 1000);
  facts(document.getElementById('serverFacts'), [
    ['Rooms kept in', server.storage],
    ['Redis', redis],
    ['Game page version', `${server.pageVersion} (pages from another version reload)`],
    ['This instance', `Up ${up} · ${server.memoryMb} MB`],
    ['Node', server.node],
  ]);

  const day = Date.now() - 24 * 60 * 60 * 1000;
  const wrong = entries.filter(e => e.type === 'wrong-password' && e.at > day).length;
  const lastSignIn = entries.filter(e => e.type === 'signed-in')[1]; // [0] is most likely this one
  const { address, everyone } = security.limits;
  facts(document.getElementById('securityFacts'), [
    ['This session', `Signed in ${ago(security.signedInAt)}, ends ${when(security.sessionEnds)}`],
    ['This browser', security.trustedDevice ? 'A known device: other people’s wrong guesses can’t lock it out' : 'Not a known device yet (it will be after you sign in on it)'],
    ['Previous sign-in', lastSignIn ? `${ago(lastSignIn.at)} · ${[lastSignIn.device, lastSignIn.place, lastSignIn.ip].filter(Boolean).join(' · ')}` : null],
    ['Wrong passwords', `${wrong.toLocaleString()} in the last 24 hours`],
    ['Guess limits', `${address.tries} tries per address every ${address.windowMs / 60000} min · ${everyone.tries} an hour from new devices altogether (${security.everyone.tries} used this hour)`],
  ]);

  const warnings = [];
  if (security.shortPassword) {
    warnings.push(['Your admin password is short.', 'Under 14 characters can be guessed with enough tries. Four or five random words (like "maple-orbit-kettle-swim") is long and easy to type.']);
  }
  if (!security.sharedSecret) {
    warnings.push(['Sessions only work on one server instance.', 'There’s no Redis address or ADMIN_SESSION_SECRET for every instance to sign them with. Fine locally; on Vercel, set ADMIN_SESSION_SECRET to a long random string.']);
  }
  if (wrong >= 10) {
    warnings.push([`${wrong} wrong passwords in the last day.`, 'Someone may be guessing. They’re capped (see the limits below), but a long password is what keeps them out for good. Details are under Activity → Sign-ins & changes.']);
  }
  document.getElementById('securityWarnings').replaceChildren(...warnings.map(([title, text]) => el('p.warning', el('b', title), ' ', text)));
}

document.getElementById('systemRefreshBtn').addEventListener('click', loadSystem);

document.getElementById('signOutAllBtn').replaceWith(confirmButton({
  key: 'sign-out-everywhere',
  label: 'Sign out everywhere else',
  armedLabel: 'Sign them all out?',
  className: 'btn btn-glass btn-sm',
  onConfirm: async () => {
    try {
      await api('sign-out-everywhere', {});
      showAlert('Every other session is signed out. This one carries on.', 'success');
      loadSystem();
    } catch (err) {
      showAlert(err.message);
    }
  },
}));

registerTab('system', {
  open: loadSystem,
});
