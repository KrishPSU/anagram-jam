// One toast at a time, shared by every page: showAlert(message, type)
// type is 'error' (default), 'warning', 'success' or 'info'

(() => {
  const ICONS = { error: '❌', warning: '⚠️', success: '✅', info: '💬' };

  const stack = document.createElement('div');
  stack.className = 'toast-stack';
  stack.setAttribute('role', 'status');
  stack.setAttribute('aria-live', 'polite');

  const toast = document.createElement('div');
  toast.className = 'toast';
  const icon = document.createElement('span');
  const text = document.createElement('span');
  text.className = 'toast-text';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  toast.append(icon, text, close);
  stack.appendChild(toast);

  let hideTimeout;

  window.showAlert = (message, type = 'error') => {
    if (!stack.isConnected) document.body.appendChild(stack);
    icon.textContent = ICONS[type] || '';
    text.textContent = message;
    toast.className = 'toast show ' + type;
    // Restart the clock so an earlier toast's timer can't cut this one short
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(window.hideAlert, 4000);
  };

  window.hideAlert = () => {
    toast.classList.remove('show');
  };

  close.addEventListener('click', window.hideAlert);
})();
