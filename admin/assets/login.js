// The admin sign-in page. The password goes to the server (see admin.js), which answers with a session cookie this page
// can't see; then /admin loads again and is the dashboard.

const form = document.getElementById('signinForm');
const passwordInput = document.getElementById('password');
const peekBtn = document.getElementById('peekBtn');
const signinBtn = document.getElementById('signinBtn');
const errorEl = document.getElementById('signinError');

let lockedUntil = 0;
let lockTimer;

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

function setBusy(busy) {
  signinBtn.disabled = busy || Date.now() < lockedUntil;
  signinBtn.classList.toggle('is-loading', busy);
  signinBtn.querySelector('.btn-label').textContent = busy ? 'Signing in…' : 'Sign in';
}

// Too many wrong tries: the button stays off, counting down, until the server will listen again
function lockFor(ms) {
  lockedUntil = Date.now() + ms;
  clearInterval(lockTimer);
  const tick = () => {
    const left = lockedUntil - Date.now();
    if (left <= 0) {
      clearInterval(lockTimer);
      showError('');
      setBusy(false);
      return;
    }
    const minutes = Math.ceil(left / 60000);
    showError(`Too many wrong tries. Try again in ${minutes === 1 ? 'a minute' : `${minutes} minutes`}.`);
    signinBtn.disabled = true;
  };
  tick();
  lockTimer = setInterval(tick, 5000);
}

const REPLIES = {
  wrong: "That's not the password.",
  unset: "There's no admin password yet. Add an environment variable called ADMIN_PASSWORD to the server (on Vercel: the project's Settings → Environment Variables), then redeploy.",
  forbidden: 'Open this page straight from the site to sign in.',
};

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (signinBtn.disabled) return;
  const password = passwordInput.value;
  if (!password) {
    showError('Enter the password.');
    passwordInput.focus();
    return;
  }
  showError('');
  setBusy(true);
  let reply;
  try {
    const res = await fetch('/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    reply = await res.json();
  } catch {
    reply = null;
  }
  if (reply && reply.status === 'ok') {
    window.location.replace('/admin');
    return;
  }
  setBusy(false);
  if (reply && reply.status === 'locked') {
    lockFor(reply.retryIn);
  } else {
    showError(reply ? REPLIES[reply.status] || 'Something went wrong. Try again.' : "Couldn't reach the server. Try again.");
    form.classList.remove('shake');
    void form.offsetWidth; // restart the animation
    form.classList.add('shake');
  }
  passwordInput.select();
});

peekBtn.addEventListener('click', () => {
  const showing = passwordInput.type === 'text';
  passwordInput.type = showing ? 'password' : 'text';
  peekBtn.textContent = showing ? 'Show' : 'Hide';
  peekBtn.setAttribute('aria-pressed', String(!showing));
  peekBtn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  passwordInput.focus();
});
