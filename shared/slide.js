// Moving between the screens of one page - a Daily Jam word and today's list, a solo run and its results, a room's round,
// its results and the lobby - the way pages slide between each other (the View Transitions part of /shared/theme.css).
//
// update switches the page over to the new screen. The browser takes a picture of the screen as it is first, so update
// runs a moment later rather than straight away, and anything that has to happen on the new screen goes in it. Where
// the browser can't animate it (or motion is turned off) it just runs. how: 'forward' (the new screen slides in from the
// right), 'back' (the screen you're on slides away to the right), or 'curtain-drop' and 'curtain-lift' (a room's
// results coming down over the round, and going back up off the lobby - see create-room/css/results.css).
// Resolves once it's all over.

let slideRunning = null; // the one moving now - starting another finishes it at once

// Whether the screens will really move
function canSlide() {
  return !!document.startViewTransition && !document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function slideScreen(update, how = 'forward') {
  const root = document.documentElement;
  if (!canSlide()) {
    update();
    return Promise.resolve();
  }
  root.dataset.slide = how;
  const transition = document.startViewTransition(update);
  slideRunning = transition;
  // Cut short by another one (ready), or update failing (it's logged below once)
  transition.ready.catch(() => {});
  transition.updateCallbackDone.catch(() => {});
  return transition.finished
    .catch(err => console.error(err))
    .finally(() => {
      if (slideRunning === transition) {
        slideRunning = null;
        delete root.dataset.slide;
      }
    });
}
