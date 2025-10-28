const alertEl = document.getElementById('alert');
const alertIcon = document.getElementById('alertIcon');
const alertMessage = document.getElementById('alertMessage');
const alertClose = document.getElementById('alertClose');

// Error Alert Functions
function showAlert(message, type='error') {
  alertMessage.textContent = message;

  switch (type) {
    case 'error':
      alertIcon.textContent = '❌';
      break;
    case 'warning':
      alertIcon.textContent = '⚠️';
      break;
    case 'success':
      alertIcon.textContent = '✅';
      break;
  }

  alertEl.classList.remove('error');
  alertEl.classList.remove('warning');
  alertEl.classList.remove('success');


  alertEl.classList.add('show');
  alertEl.classList.add(type);

  // Auto-hide after 5 seconds
  setTimeout(() => {
    hideAlert();
  }, 5000);
}

function hideAlert() {
  alertEl.classList.remove('show');
  alertEl.classList.remove('error');
  alertEl.classList.remove('warning');
  alertEl.classList.remove('success');
}

// Close button functionality
alertClose.addEventListener('click', hideAlert);