// PostHog on the player pages (never the admin page): page views, clicks and session replays, so I can see where
// people get stuck. Only when the server has a key for it (/site-config.json, see /shared/config.js) - without one
// nothing loads, though the functions below are there to be called all the same.
//
// What's recorded is kept as light as the privacy policy says (/privacy): inputs are masked in replays, and a person
// is only ever known by their account id - the 'account' event from /shared/account.js identifies them while they're
// signed in and forgets them when they sign out. Never a name, never an email. "Turn off analytics on this device" on
// the privacy page calls analyticsOptOut(): PostHog remembers that itself in this browser, and so does this file, so
// the page can say so before PostHog has loaded - and so that it isn't even fetched afterwards.

(() => {
  const OFF_KEY = 'analyticsOff'; // localStorage, set by analyticsOptOut

  let identifiedAs = null; // the account id PostHog has been told on this page, if any

  const off = () => localStorage.getItem(OFF_KEY) === '1';

  // The real PostHog, once array.js has taken the stand-in's place (see load) - the stand-in can't answer questions
  const loaded = () => (window.posthog && window.posthog.__loaded ? window.posthog : null);

  // Known to PostHog as somebody, either from this page or from an earlier visit (it keeps that in this browser)
  function identified() {
    if (identifiedAs) return true;
    const posthog = loaded();
    if (!posthog) return false;
    try {
      return (typeof posthog._isIdentified === 'function' && posthog._isIdentified()) || posthog.get_property('$user_state') === 'identified';
    } catch {
      return false;
    }
  }

  // Telling it twice is fine (the same id again does nothing), and a call before PostHog has loaded is kept for it
  window.analyticsIdentify = (id) => {
    if (typeof id !== 'string' || !id || identifiedAs === id || off()) return;
    identifiedAs = id;
    if (window.posthog) window.posthog.identify(id);
  };

  // Back to nobody in particular - but only from somebody, since a reset of an anonymous visitor would make them a
  // new one on every page that finds them signed out
  window.analyticsReset = () => {
    if (!window.posthog || !identified()) return;
    identifiedAs = null;
    window.posthog.reset();
  };

  window.analyticsOptOut = () => {
    localStorage.setItem(OFF_KEY, '1');
    if (window.posthog) window.posthog.opt_out_capturing();
  };

  window.analyticsOptedOut = () => {
    if (off()) return true;
    const posthog = loaded();
    try {
      return !!posthog && posthog.has_opted_out_capturing();
    } catch {
      return false;
    }
  };

  window.addEventListener('account', (e) => {
    if (e.detail && e.detail.id) window.analyticsIdentify(e.detail.id);
    else window.analyticsReset();
  });

  // The privacy page's "Turn off analytics on this device" button. This script is deferred, so the page is parsed by
  // now and the button is there if the page has one; once it's been pressed (now or on an earlier visit) it says so.
  const optOutBtn = document.getElementById('analyticsOptOut');
  if (optOutBtn) {
    const show = () => {
      if (!window.analyticsOptedOut()) return;
      optOutBtn.textContent = 'Analytics are off on this device';
      optOutBtn.disabled = true;
    };
    optOutBtn.addEventListener('click', () => {
      window.analyticsOptOut();
      show();
    });
    show();
  }

  if (off()) return;

  siteConfig().then(({ posthog }) => {
    // off() again: the privacy page's button may have been pressed while the config was on its way
    if (posthog && !off() && !window.posthog) load(posthog.key, posthog.host);
  });

  // The official snippet, written out: a stand-in `posthog` that remembers every call made to it, then the real one
  // (array.js) reads the init call and the queued calls out of it and takes its place as window.posthog. So
  // everything here goes through window.posthog as it is at the time, never a kept reference.
  function load(key, host) {
    const METHODS = [
      'capture', 'register', 'register_once', 'register_for_session', 'unregister', 'unregister_for_session',
      'getFeatureFlag', 'getFeatureFlagPayload', 'isFeatureEnabled', 'reloadFeatureFlags',
      'updateEarlyAccessFeatureEnrollment', 'getEarlyAccessFeatures', 'on', 'onFeatureFlags', 'onSurveysLoaded',
      'onSessionId', 'getSurveys', 'getActiveMatchingSurveys', 'renderSurvey', 'canRenderSurvey',
      'canRenderSurveyAsync', 'identify', 'setPersonProperties', 'group', 'resetGroups',
      'setPersonPropertiesForFlags', 'resetPersonPropertiesForFlags', 'setGroupPropertiesForFlags',
      'resetGroupPropertiesForFlags', 'reset', 'get_distinct_id', 'getGroups', 'get_session_id',
      'get_session_replay_url', 'alias', 'set_config', 'startSessionRecording', 'stopSessionRecording',
      'sessionRecordingStarted', 'captureException', 'loadToolbar', 'get_property', 'getSessionProperty',
      'createPersonProfile', 'opt_in_capturing', 'opt_out_capturing', 'has_opted_in_capturing',
      'has_opted_out_capturing', 'clear_opt_in_out_capturing', 'debug', 'getPageViewId', 'captureTraceFeedback',
      'captureTraceMetric',
    ];

    const stub = [];
    stub._i = [];
    stub.people = [];
    stub.__SV = 1;
    stub.toString = (real) => `posthog${real ? '' : ' (stub)'}`;
    stub.people.toString = () => 'posthog.people (stub)';
    METHODS.forEach((name) => {
      stub[name] = (...args) => { stub.push([name, ...args]); };
    });
    stub.init = (token, config, name) => { stub._i.push([token, config, name]); };
    window.posthog = stub;

    stub.init(key, {
      api_host: host,
      person_profiles: 'identified_only',
      capture_pageview: true,
      autocapture: true,
      session_recording: { maskAllInputs: true },
    }, 'posthog');
    // Signed in before PostHog was asked for: it finds out as soon as it's here
    if (identifiedAs) stub.identify(identifiedAs);

    const script = document.createElement('script');
    script.async = true;
    script.src = `${host.replace(/\/+$/, '')}/static/array.js`;
    document.head.appendChild(script);
  }
})();
