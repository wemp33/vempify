const GESTURE_EVENTS = ['pointerdown', 'touchend', 'keydown'];

// The lock screen / Dynamic Island always shows the app mark, never per-track
// album art - the user's explicit preference. /icons/ bypasses the auth gate,
// so iOS can fetch this without a session cookie.
const LOGO_ARTWORK = [
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
];

export function createPlayer({ onTimeUpdate, onEnded, onPlayStateChange } = {}) {
  const audio = new Audio();
  // 'auto' over 'metadata': the gap between tapping a row and hearing sound is
  // mostly the element deciding to fetch; let it buffer eagerly.
  audio.preload = 'auto';

  let currentTrack = null;

  // Safari reports Infinity (or garbage) for the duration of some containers,
  // fragmented MP4 especially, and setPositionState throws on non-finite
  // values - which left the lock-screen scrubber showing a bogus length. The
  // library's own durationSec is the fallback truth.
  function effectiveDuration() {
    const d = audio.duration;
    if (Number.isFinite(d) && d > 0) return d;
    const fallback = currentTrack && Number(currentTrack.durationSec);
    return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
  }

  // While priming (see primeAudio) the element is deliberately muted and poked,
  // so its play/pause/timeupdate events describe nothing the UI should react to.
  let primingToken = null;
  let audioPrimed = false;

  audio.addEventListener('timeupdate', () => {
    if (primingToken) return;
    if (onTimeUpdate) onTimeUpdate(audio.currentTime, effectiveDuration());
    updatePositionState();
  });
  audio.addEventListener('loadedmetadata', () => {
    if (primingToken) return;
    updatePositionState();
  });
  audio.addEventListener('ended', () => {
    if (primingToken) return;
    if (onEnded) onEnded();
  });
  audio.addEventListener('play', () => {
    if (primingToken) return;
    if (onPlayStateChange) onPlayStateChange(true);
    // iOS tends to ignore action handlers registered before the media session
    // first goes active, then falls back to its +/-15s seek buttons instead of
    // the prev/next arrows. Re-registering on every real play is what makes
    // the arrows stick.
    registerMediaSessionHandlers();
    updatePositionState();
  });
  audio.addEventListener('pause', () => {
    if (primingToken) return;
    if (onPlayStateChange) onPlayStateChange(false);
  });

  function setMediaSessionMetadata(track) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || '',
        artist: track.artist || '',
        album: track.album || '',
        artwork: LOGO_ARTWORK
      });
    } catch {
      /* MediaMetadata unsupported in this browser */
    }
  }

  // Feeds the iOS lock-screen scrubber. setPositionState throws on NaN (which is
  // what duration reads as until metadata lands) and on position > duration.
  function updatePositionState() {
    if (!('mediaSession' in navigator)) return;
    if (typeof navigator.mediaSession.setPositionState !== 'function') return;

    const duration = effectiveDuration();
    const position = audio.currentTime;
    if (duration <= 0) return;
    if (!Number.isFinite(position) || position < 0) return;

    const rate = Number.isFinite(audio.playbackRate) && audio.playbackRate > 0 ? audio.playbackRate : 1;

    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.min(position, duration),
        playbackRate: rate
      });
    } catch {
      /* setPositionState unsupported or rejected these values */
    }
  }

  function removeGestureListeners() {
    for (const type of GESTURE_EVENTS) {
      document.removeEventListener(type, handleFirstGesture);
    }
  }

  function finishPriming(token) {
    if (primingToken !== token) return;
    primingToken = null;
    audio.muted = false;
  }

  // Safari on iOS only unlocks an Audio element inside a user gesture, and it
  // will not adopt a freshly created element later in the session. Poking the
  // one element we own during the first gesture is what makes the programmatic
  // play() of auto-advance work on iPhone.
  function primeAudio() {
    if (audio.src || audio.currentSrc) return;

    const token = {};
    primingToken = token;

    try {
      audio.muted = true;
      audio.load();
      const attempt = audio.play();
      if (attempt && typeof attempt.then === 'function') {
        attempt.then(
          () => {
            if (primingToken === token) {
              try {
                audio.pause();
              } catch {
                /* nothing to pause */
              }
            }
            finishPriming(token);
          },
          () => finishPriming(token)
        );
      } else {
        try {
          audio.pause();
        } catch {
          /* nothing to pause */
        }
        finishPriming(token);
      }
    } catch {
      finishPriming(token);
    }
  }

  function handleFirstGesture() {
    if (audioPrimed) return;
    audioPrimed = true;
    removeGestureListeners();
    primeAudio();
  }

  for (const type of GESTURE_EVENTS) {
    document.addEventListener(type, handleFirstGesture, { once: true, passive: true });
  }

  // player.next/player.prev start as no-ops because this module has no queue
  // knowledge; main.js overwrites them with queue-aware logic, and these
  // media session handlers call through the same object so hardware/OS
  // controls stay wired to whatever main.js has assigned.
  function registerMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) return;
    const handlers = {
      play: () => player.resume(),
      pause: () => player.pause(),
      previoustrack: () => player.prev(),
      nexttrack: () => player.next(),
      seekto: (details) => {
        if (typeof details.seekTime === 'number') player.seek(details.seekTime);
      }
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        /* action unsupported in this browser */
      }
    }
    // Explicitly unregister the interval-seek actions: when iOS sees these it
    // shows +/-15s buttons on the lock screen instead of prev/next arrows.
    for (const action of ['seekbackward', 'seekforward']) {
      try {
        navigator.mediaSession.setActionHandler(action, null);
      } catch {
        /* action unsupported in this browser */
      }
    }
  }

  // iOS rejects play() with NotAllowedError when it does not consider the call
  // gesture-backed; report the real (stopped) state instead of leaving the UI
  // showing a pause button over silence.
  function attemptPlayback() {
    const attempt = audio.play();
    if (attempt && typeof attempt.then === 'function') {
      attempt.catch(() => {
        if (onPlayStateChange) onPlayStateChange(false);
      });
    }
  }

  const player = {
    play(track, url) {
      // A real track supersedes any in-flight priming cycle, and it unlocks the
      // element by itself - so retire the gesture hook rather than let it reset
      // the element mid-song later.
      primingToken = null;
      audioPrimed = true;
      removeGestureListeners();
      audio.muted = false;

      currentTrack = track;
      audio.src = url;
      setMediaSessionMetadata(track);
      registerMediaSessionHandlers();
      attemptPlayback();
    },
    pause() {
      audio.pause();
    },
    resume() {
      attemptPlayback();
    },
    next() {},
    prev() {},
    seek(seconds) {
      audio.currentTime = seconds;
      updatePositionState();
    },
    setVolume(v) {
      audio.volume = v;
    },
    getCurrentTime() {
      return audio.currentTime;
    },
    getDuration() {
      return effectiveDuration();
    }
  };

  registerMediaSessionHandlers();

  return player;
}
