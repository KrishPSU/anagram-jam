// Player avatars: an initial on a color picked from the name, so everyone sees the same color for a player

const AVATAR_COLORS = ['#7c6cf0', '#ff5fa8', '#22b8cf', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#0ea5e9'];

function playerColor(name) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function avatarEl(name) {
  const el = document.createElement('span');
  el.className = 'avatar';
  el.style.background = playerColor(name);
  // First character, kept whole even when it's an emoji
  el.textContent = ([...String(name || '?').trim()][0] || '?').toUpperCase();
  el.setAttribute('aria-hidden', 'true');
  return el;
}
