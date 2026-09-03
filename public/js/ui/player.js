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
    setPlaybackState('playing');
    updatePositionState();
  });
  audio.addEventListener('pause', () => {
    if (primingToken) return;
    // unload() empties the element, and emptying it pauses it. That pause
    // event is delivered a task later, by which time there is nothing loaded
    // for it to describe - and the handler below would put the platform back to
    // 'paused', re-raising the lock-screen card for a song that was just
    // deleted. currentTrack is null in exactly that window and no other.
    if (!currentTrack) return;
    if (onPlayStateChange) onPlayStateChange(false);
    // A paused session has to keep announcing itself. iOS infers "there is media
    // here" from an element that is actually playing; the instant it pauses,
    // nothing else tells the platform the session is still alive, so it tears
    // the Now Playing card down and stops delivering remote commands. Declaring
    // 'paused' - while metadata stays assigned - is the only way to say "still
    // loaded, just stopped". Re-registering the handlers keeps the lock-screen
    // buttons answering after the pause, and pinning the position here freezes
    // the scrubber at the real offset instead of the last timeupdate tick.
    setPlaybackState('paused');
    updatePositionState();
    registerMediaSessionHandlers();
  });
  audio.addEventListener('error', () => {
    if (primingToken) return;
    // Starting a new track clears audio.error, so an event left over from the
    // previous source must not be allowed to contradict the track now playing.
    if (!audio.error) return;
    // A fatal media error - a dropped stream, a decode failure - stops playback
    // WITHOUT pausing the element: no 'pause' event fires and audio.paused stays
    // false (verified in Chromium: MEDIA_ERR_DECODE mid-track leaves paused ===
    // false forever). Nothing else would ever retract the 'playing' claim, so
    // the lock screen would sit there showing the track running over silence and
    // the in-app button would stay a pause icon. Say what is true: still loaded,
    // no longer playing - which also leaves the card there to retry from.
    if (onPlayStateChange) onPlayStateChange(false);
    setPlaybackState('paused');
    registerMediaSessionHandlers();
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

  // 'none' belongs only to a session with nothing loaded at all - never to an
  // ordinary pause, which is exactly what made the card vanish. Older WebKit
  // throws on values it does not know rather than ignoring them.
  function setPlaybackState(value) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = value;
    } catch {
      /* playbackState unsupported in this browser */
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
      attempt.then(
        () => {
          // The 'play' event is the normal source of truth, but it only fires
          // on a paused->playing edge. If primeAudio's muted play() is still in
          // flight the element is already unpaused, so the real play() resolves
          // without an event and the UI would keep showing a stale stopped
          // state - which now also means the row keeps a play triangle over a
          // song that is audibly running. Reassert from the element itself;
          // onPlayStateChange is idempotent, so the ordinary path is unharmed.
          if (!audio.paused && !primingToken) {
            if (onPlayStateChange) onPlayStateChange(true);
            setPlaybackState('playing');
          }
        },
        () => {
          if (onPlayStateChange) onPlayStateChange(false);
          // Rejected play(): a track is loaded but silent, so the session is
          // paused - not playing, and not gone.
          if (!primingToken) setPlaybackState('paused');
        }
      );
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
    // The lock-screen card is stamped when a track starts, which is normally
    // the only moment its details can change. Editing a song's title or artist
    // is the exception: the id, the file and this element are all untouched, so
    // no play() happens to re-stamp it and the card would keep the old name
    // until the next song. main.js calls this instead. Inert unless the track
    // handed in IS the loaded one, so an edit to some other song can never
    // conjure a Now Playing card for something nobody started.
    refreshMetadata(track) {
      if (!track || !currentTrack || track.id !== currentTrack.id) return;
      currentTrack = track;
      setMediaSessionMetadata(track);
    },
    // The loaded song no longer exists - it was deleted out from under the
    // player. Pausing alone is not enough: the element would keep the dead src,
    // so the scrubber would go on reporting a position into a file the server
    // has dropped, and the lock-screen card would keep offering a play button
    // whose only possible outcome is a 404. This puts the session back to the
    // state it boots in - nothing loaded, no card, 'none' - which is the one
    // honest description of it.
    unload() {
      // Cleared FIRST: the pause below is delivered asynchronously, and the
      // 'pause' handler reads this to know the event describes nothing.
      currentTrack = null;
      try {
        audio.pause();
      } catch {
        /* nothing to pause */
      }
      // removeAttribute + load(), never src = ''. An empty string resolves
      // against the document URL, so the element would fetch the PAGE and
      // raise a decode error on the HTML it got back.
      audio.removeAttribute('src');
      try {
        audio.load();
      } catch {
        /* best effort - the element is already empty */
      }
      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.metadata = null;
        } catch {
          /* MediaMetadata unsupported in this browser */
        }
      }
      setPlaybackState('none');
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
  // Nothing is loaded yet - the one honest use of 'none'. The muted priming
  // cycle that may follow is invisible to the platform (see primeAudio), so the
  // card only appears once a real track starts.
  setPlaybackState('none');

  return player;
}
