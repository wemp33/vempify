const COVER_BASE = '/covers/';
const GESTURE_EVENTS = ['pointerdown', 'touchend', 'keydown'];

function coverMimeType(filename) {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}

function coverArtwork(track) {
  const cover = track && typeof track.cover === 'string' ? track.cover.trim() : '';
  if (!cover) return [];
  return [
    {
      src: COVER_BASE + encodeURIComponent(cover),
      sizes: '512x512',
      type: coverMimeType(cover)
    }
  ];
}

export function createPlayer({ onTimeUpdate, onEnded, onPlayStateChange } = {}) {
  const audio = new Audio();
  audio.preload = 'metadata';

  // While priming (see primeAudio) the element is deliberately muted and poked,
  // so its play/pause/timeupdate events describe nothing the UI should react to.
  let primingToken = null;
  let audioPrimed = false;

  audio.addEventListener('timeupdate', () => {
    if (primingToken) return;
    if (onTimeUpdate) onTimeUpdate(audio.currentTime, audio.duration || 0);
    updatePositionState();
  });
  audio.addEventListener('ended', () => {
    if (primingToken) return;
    if (onEnded) onEnded();
  });
  audio.addEventListener('play', () => {
    if (primingToken) return;
    if (onPlayStateChange) onPlayStateChange(true);
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
        artwork: coverArtwork(track)
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

    const duration = audio.duration;
    const position = audio.currentTime;
    if (!Number.isFinite(duration) || duration <= 0) return;
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

      audio.src = url;
      setMediaSessionMetadata(track);
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
      return audio.duration || 0;
    }
  };

  registerMediaSessionHandlers();

  return player;
}
