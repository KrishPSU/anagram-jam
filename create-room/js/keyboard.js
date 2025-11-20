// Get the answer input field
const answerInput = document.getElementById('answerInput');

// Get all keyboard buttons
const keyboardButtons = document.querySelectorAll('.key');

// Create a map of keyboard keys to button elements
const keyMap = new Map();
keyboardButtons.forEach(button => {
  const key = button.getAttribute('data-key');
  keyMap.set(key.toUpperCase(), button);
});

// Function to add letter to answer input
function addLetterToInput(letter) {
  if (answerInput && /^[A-Za-z]$/.test(letter)) {
    answerInput.value += letter.toUpperCase();
    // Trigger input event to maintain existing validation
    answerInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// Function to handle backspace
function handleBackspace() {
  if (answerInput) {
    answerInput.value = answerInput.value.slice(0, -1);
    answerInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// Function to handle enter
function handleEnter() {
  // This will be implemented later for submitting the answer
  // For now, just trigger the button click
  const enterButton = keyMap.get('ENTER');
  if (enterButton) {
    enterButton.click();
  }

  const userAnswer = inputAnswer.value.trim().toLowerCase();
  socket.emit('answerAttempt', { id: myId, name: localStorage.getItem('name'), roomCode: state.roomCode, level: currentLevel, answer: userAnswer, points: points });
}

// Listen for physical keyboard events
document.addEventListener('keydown', (event) => {
  // Prevent default behavior for letter keys when input is focused
  const key = event.key.toUpperCase();
  
  // Handle letter keys (A-Z)
  if (/^[A-Z]$/.test(key)) {
    event.preventDefault();
    const button = keyMap.get(key);
    if (button) {
      // Just click the button - the click handler will add the letter
      button.click();
    }
  }
  // Handle Backspace
  else if (event.key === 'Backspace') {
    event.preventDefault();
    const button = keyMap.get('BACKSPACE');
    if (button) {
      // Just click the button - the click handler will handle backspace
      button.click();
    }
  }
  // Handle Enter
  else if (event.key === 'Enter') {
    event.preventDefault();
    const button = keyMap.get('ENTER');
    if (button) {
      // Just click the button - the click handler will handle enter
      button.click();
    }
  }
});

// Add click handlers to keyboard buttons
keyboardButtons.forEach(button => {
  button.addEventListener('click', () => {
    const key = button.getAttribute('data-key');
    
    if (key === 'BACKSPACE') {
      handleBackspace();
    } else if (key === 'ENTER') {
      handleEnter();
    } else if (/^[A-Z]$/.test(key)) {
      addLetterToInput(key);
    }
  });
});

