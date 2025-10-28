/**
 * Creates a countdown timer
 * @param {number} seconds - Number of seconds to count down from
 * @param {function} onTick - Callback function called each second with remaining time
 * @param {function} onComplete - Callback function called when timer reaches 0
 * @returns {object} Timer control object with start, pause, resume, reset, and stop methods
 */
function createCountdownTimer(seconds, onTick, onComplete) {
  let remainingTime = seconds;
  let intervalId = null;
  let isPaused = false;

  const tick = () => {
    if (remainingTime > 0) {
      remainingTime--;
      if (onTick) onTick(remainingTime);
      
      if (remainingTime === 0) {
        stop();
        if (onComplete) onComplete();
      }
    }
  };

  const start = () => {
    if (intervalId) return; // Already running
    intervalId = setInterval(tick, 1000);
    if (onTick) onTick(remainingTime);
  };

  const pause = () => {
    if (intervalId && !isPaused) {
      clearInterval(intervalId);
      intervalId = null;
      isPaused = true;
    }
  };

  const resume = () => {
    if (isPaused) {
      isPaused = false;
      start();
    }
  };

  const reset = () => {
    stop();
    remainingTime = seconds;
    if (onTick) onTick(remainingTime);
  };

  const stop = () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    isPaused = false;
  };

  const getTimeRemaining = () => remainingTime;

  return {
    start,
    pause,
    resume,
    reset,
    stop,
    getTimeRemaining
  };
}