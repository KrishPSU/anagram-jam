const socket = io();

const playerNameInput = document.getElementById('playerName');
const roomCodeInput = document.getElementById('roomCode');
const modeButtons = document.querySelectorAll('.mode-button');
const startButton = document.getElementById('startButton');
const errorAlert = document.getElementById('errorAlert');
const errorMessage = document.getElementById('errorMessage');
const errorClose = document.getElementById('errorClose');
let selectedMode = null;

playerNameInput.value = localStorage.getItem('name') || '';

// Error Alert Functions
function showError(message) {
  errorMessage.textContent = message;
  errorAlert.classList.add('show');
  
  // Auto-hide after 5 seconds
  setTimeout(() => {
    hideError();
  }, 5000);
}

function hideError() {
  errorAlert.classList.remove('show');
}

// Close button functionality
errorClose.addEventListener('click', hideError);


// Handle mode selection
modeButtons.forEach(button => {
  button.addEventListener('click', function() {
    // Remove active state from all buttons
    modeButtons.forEach(btn => btn.style.transform = '');
    
    // Add active state to clicked button
    this.style.transform = 'translateY(-3px) scale(1.02)';
    
    selectedMode = this.dataset.mode;
    
    // Check if we can enable start button
    const hasName = playerNameInput.value.trim().length > 0;

    if (!hasName) {
      showError("Please enter your name first");
      return;
    }


    if (selectedMode === 'friends') {
      if (roomCodeInput.value.trim() == "") {
        showError("Enter a room code first");
        return;
      }
      socket.emit('joinRoom', { name: playerNameInput.value.trim(), roomCode: roomCodeInput.value.trim().toUpperCase() })
    } else if (selectedMode === 'create') {
      socket.emit('createRoom')
    }


  });
});



socket.on('roomCreated', (roomCode) => {
  openGamePage(roomCode);
  localStorage.setItem('leaderId', socket.id);
});

socket.on('roomJoined', (roomCode) => {
  openGamePage(roomCode);
});

socket.on('roomNotFound', (roomCode) => {
  showError("Room not found: " + roomCode);
});

function openGamePage(roomCode) {
  localStorage.setItem('name', playerNameInput.value.trim());
  document.location.href = "/game/" + roomCode;
}



// Add some interactive effects
playerNameInput.addEventListener('focus', function() {
  this.parentElement.style.transform = 'translateY(-2px)';
});

playerNameInput.addEventListener('blur', function() {
  this.parentElement.style.transform = 'translateY(0)';
});

// Add keyboard support
// document.addEventListener('keypress', function(e) {
//   if (e.key === 'Enter' && !startButton.disabled) {
//     startButton.click();
//   }
// });