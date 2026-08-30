import { initDB, putTracks, getAllTracks, incrementPlayCount, getUserPlaylists } from './db.js';
import { store } from './state.js';
import { t } from './i18n.js';
import { fetchLibrary, streamUrl } from './sources/local.js';
import {
  listPlaylists,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  toggleTrack
} from './sources/playlists.js';
import { attachSwipe } from './ui/swipe.js';
import { openPlaylistPicker } from './ui/playlist-picker.js';
import { openUploadDialog } from './ui/upload.js';
import { renderQueuePanel, updateQueueBadge } from './ui/queue.js';
import { renderTabs } from './ui/sidebar.js';
import { renderNowPlaying } from './ui/nowplaying.js';
import { createPlayer } from './ui/player.js';
import { renderSearch } from './ui/search.js';
import { playIcon, pauseIcon } from './ui/rowicons.js';
import { bindDismiss, dismissModal } from './ui/modal.js';

const HISTORY_CAP = 50;

// A device token outlives the session cookie: iOS gives a standalone PWA its
// own storage jar and evicts cookies from it aggressively, so the cookie alone
// cannot promise "type the password once per device". The token can silently
// buy a new cookie back (POST /auth/resume), and it is only ever a
// server-signed string - it is not the password and cannot be forged.
const DEVICE_TOKEN_KEY = 'vempify_device_token';

// Set once the local IndexedDB playlists have been pushed up to the server, or
// once this device has seen a server that already has playlists. Both cases
// mean "there is nothing left here to migrate".
const MIGRATION_KEY = 'vempify_playlists_migrated';

// Messages the shared i18n key set does not carry: the "+" modal's three
// validation lines, plus the toast that confirms an uploaded song landed.
const INLINE_MESSAGES = {
  empty: { en: 'Enter a name', pl: 'Wpisz nazwę' },
  exists: { en: 'That name is already taken', pl: 'Ta nazwa jest już zajęta' },
  failed: { en: 'Could not create the playlist', pl: 'Nie udało się utworzyć playlisty' },
  song_added: { en: 'Song added', pl: 'Dodano utwór' }
};

let sidebarEl = null;
let searchInput = null;
let mainEl = null;
let modalRoot = null;
let queueBtn = null;
let addSongBtn = null;
let nowPlayingInfoEl = null;
let player = null;

// The id of the track the audio element is loaded with. It lives outside the
// store's context/contextIndex on purpose: a queued song plays without moving
// the listening context, so "what is playing" and "where the context stands"
// are two different facts.
let currentTrackId = null;

// The track objects currently rendered in #main (playlist view or search
// results) - the list a row tap turns into the listening context.
let displayedTracks = [];

// fetchLibrary only throws Error("Failed to fetch library: <status>"), so match
// on that as well as on a status the source module may attach later.
function isUnauthorized(error) {
  if (!error) return false;
  if (error.status === 401 || error.statusCode === 401) return true;
  return typeof error.message === 'string' && /\b401\b/.test(error.message);
}

function trackById(id) {
  return store.getState().tracks.find((track) => track.id === id) ?? null;
}

function isSearching() {
  return Boolean(searchInput && searchInput.value.trim() !== '');
}

// ---------------------------------------------------------------------------
// Session: the device token that keeps the password from being asked twice

// localStorage throws outright in some privacy modes (and in a webview with
// site data blocked), so every touch of it is guarded. Losing the token is
// survivable - it only costs one password prompt - but an exception here would
// take the whole boot down with it.
function readStored(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable - carry on without persistence */
  }
}

function removeStored(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

// Trades the stored device token for a fresh session cookie. Resolves true only
// when the server actually set one.
async function resumeSession() {
  const token = readStored(DEVICE_TOKEN_KEY);
  if (!token) return false;

  try {
    const response = await fetch('/auth/resume', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    if (response.ok) return true;
    // The server looked at the token and refused it: it is dead weight now.
    // A 5xx or a network error is NOT the token's fault, so those keep it.
    if (response.status >= 400 && response.status < 500) removeStored(DEVICE_TOKEN_KEY);
  } catch {
    /* offline - keep the token and let the caller fail normally */
  }
  return false;
}

// Runs a request that needs a session; if it comes back 401 the stored device
// token gets one chance to re-authenticate, then the request is retried exactly
// once. This is what survives iOS evicting the cookie under an installed app.
async function withSession(run) {
  try {
    return await run();
  } catch (error) {
    if (!isUnauthorized(error)) throw error;
    if (!(await resumeSession())) throw error;
    return await run();
  }
}

// The login form posts and the server redirects, so there is no client-side
// "login succeeded" moment to hook. Instead: any boot that has a working
// session but no stored token mints one. Best effort - a failure here just
// means the next boot tries again.
async function ensureDeviceToken() {
  if (readStored(DEVICE_TOKEN_KEY)) return;
  try {
    const response = await fetch('/auth/device-token', { credentials: 'same-origin' });
    if (!response.ok) return;
    const body = await response.json();
    if (body && typeof body.token === 'string' && body.token) {
      writeStored(DEVICE_TOKEN_KEY, body.token);
    }
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Boot

async function boot() {
  await initDB();

  let tracks;
  let online = false;
  try {
    const library = await withSession(() => fetchLibrary());
    tracks = library.tracks;
    online = true;
    await putTracks(tracks);
  } catch (error) {
    // Still unauthorized after the device token had its turn: the password
    // really is needed. Falling back to the cache would render a library whose
    // audio the server now refuses to stream, so show the gate instead of
    // faking a working app.
    if (isUnauthorized(error)) {
      window.location.replace('/login');
      return;
    }
    tracks = await getAllTracks();
  }

  // Playlists now live on the server so every device sees the same ones; the
  // IndexedDB copies are the migration source and the offline fallback.
  const userPlaylists = online ? await syncPlaylists() : await getUserPlaylists();

  store.setState({ tracks, userPlaylists });

  setupDom();

  ensureDeviceToken();
}

// Reads the server's playlists and, exactly once per device, pushes up whatever
// only exists in IndexedDB. The local copies are never deleted - they are the
// only backup of lists that were browser-local until now.
async function syncPlaylists() {
  let serverPlaylists;
  try {
    serverPlaylists = await withSession(() => listPlaylists());
  } catch {
    return getUserPlaylists();
  }

  const alreadyMigrated = readStored(MIGRATION_KEY) === 'done';
  if (alreadyMigrated || serverPlaylists.length > 0) {
    // Seeing a populated server counts as migrated: without this, deleting
    // every playlist and reloading would resurrect the old local ones.
    if (!alreadyMigrated) writeStored(MIGRATION_KEY, 'done');
    return serverPlaylists;
  }

  let local = [];
  try {
    local = await getUserPlaylists(); // already ordered by createdAt
  } catch {
    local = [];
  }

  if (local.length === 0) {
    writeStored(MIGRATION_KEY, 'done');
    return serverPlaylists;
  }

  for (const playlist of local) {
    try {
      await createPlaylist(playlist.name);
    } catch (error) {
      // 409 means the name is already up there (a second device racing this
      // same migration); its tracks are still worth merging in. Anything else
      // is logged and skipped so one bad list cannot strand the others.
      if (error.status !== 409) {
        console.warn(`[vempify] could not migrate playlist "${playlist.name}"`, error);
        continue;
      }
    }

    for (const trackId of playlist.trackIds ?? []) {
      try {
        const member = await toggleTrack(playlist.name, trackId);
        // The toggle removed it, which means it was already there (a merged
        // name clash). Put it back.
        if (!member) await toggleTrack(playlist.name, trackId);
      } catch (error) {
        console.warn(`[vempify] could not migrate a track into "${playlist.name}"`, error);
      }
    }
  }

  writeStored(MIGRATION_KEY, 'done');

  // Re-read rather than trust the local shapes: the server is the truth now.
  try {
    return await listPlaylists();
  } catch {
    return local;
  }
}

function setupDom() {
  sidebarEl = document.getElementById('sidebar');
  searchInput = document.getElementById('search');
  mainEl = document.getElementById('main');
  modalRoot = document.getElementById('modal-root');
  queueBtn = document.getElementById('queue-btn');
  addSongBtn = document.getElementById('add-song-btn');
  nowPlayingInfoEl = document.querySelector('#now-playing .now-playing-track');

  player = createPlayer({
    onTimeUpdate: handleTimeUpdate,
    onEnded: () => player.next(),
    onPlayStateChange: (isPlaying) => store.setState({ isPlaying })
  });
  // createPlayer's media-session handlers call through these same slots, so
  // hardware/lock-screen prev/next stay wired to the logic below.
  player.next = () => advance();
  player.prev = () => goPrev();
  player.setVolume(store.getState().volume);

  store.subscribe(render);

  renderSearch(searchInput, () => store.getState().tracks, handleSearchResults);

  document.getElementById('play-pause')?.addEventListener('click', handlePlayPauseClick);
  document.getElementById('prev-btn')?.addEventListener('click', () => player.prev());
  document.getElementById('next-btn')?.addEventListener('click', () => player.next());
  document.getElementById('shuffle-btn')?.addEventListener('click', togglePlayMode);
  queueBtn?.addEventListener('click', openQueuePanel);
  addSongBtn?.addEventListener('click', openAddSongDialog);

  const seekInput = document.getElementById('seek');
  seekInput?.addEventListener('input', () => {
    player.seek(Number(seekInput.value));
    updateRangeFill(seekInput);
  });

  const volumeInput = document.getElementById('volume');
  if (volumeInput) {
    volumeInput.value = String(store.getState().volume);
    updateRangeFill(volumeInput);
    volumeInput.addEventListener('input', () => {
      const value = Number(volumeInput.value);
      player.setVolume(value);
      store.setState({ volume: value });
      updateRangeFill(volumeInput);
    });
  }

  applyStaticI18n();
  selectPlaylist(null);
}

function updateRangeFill(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const value = Number(input.value) || 0;
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--range-fill', `${pct}%`);
}

function handleTimeUpdate(currentTime, duration) {
  const seekInput = document.getElementById('seek');
  if (!seekInput || document.activeElement === seekInput) return;
  seekInput.max = String(duration || 0);
  seekInput.value = String(currentTime || 0);
  updateRangeFill(seekInput);
}

function handlePlayPauseClick() {
  if (!currentTrackId) return;
  if (store.getState().isPlaying) {
    player.pause();
  } else {
    player.resume();
  }
}

function applyStaticI18n() {
  if (searchInput) searchInput.placeholder = t('search_placeholder');

  document.getElementById('prev-btn')?.setAttribute('aria-label', t('prev'));
  document.getElementById('next-btn')?.setAttribute('aria-label', t('next'));
  document.getElementById('volume')?.setAttribute('aria-label', t('volume'));
  queueBtn?.setAttribute('aria-label', t('queue'));

  if (addSongBtn) {
    addSongBtn.setAttribute('aria-label', t('add_song'));
    addSongBtn.title = t('add_song');
  }

  const shuffleBtn = document.getElementById('shuffle-btn');
  if (shuffleBtn) {
    const mode = store.getState().playMode;
    shuffleBtn.setAttribute('aria-label', mode === 'random' ? t('play_mode_random') : t('play_mode_order'));
  }

  const playPauseBtn = document.getElementById('play-pause');
  if (playPauseBtn) {
    playPauseBtn.setAttribute('aria-label', store.getState().isPlaying ? t('pause') : t('play'));
  }
}

function render(state) {
  if (sidebarEl) {
    renderTabs(sidebarEl, {
      playlists: state.userPlaylists,
      activeName: state.activePlaylist,
      onSelect: selectPlaylist,
      onAdd: openNewPlaylistModal,
      // Both reject with the API error (which carries .status), so the sidebar
      // can tell a 409 name clash from a failure and word its inline message
      // accordingly.
      onRename: renameActivePlaylist,
      onDelete: deleteActivePlaylist,
      t
    });
  }

  if (nowPlayingInfoEl) {
    // A null track leaves the previous text alone - playback may continue
    // across list switches, so the bar never blanks out mid-song.
    renderNowPlaying(nowPlayingInfoEl, currentTrackId ? trackById(currentTrackId) : null);
  }

  if (queueBtn) updateQueueBadge(queueBtn, state.queue.length);

  updateTrackRowHighlight();

  const playPauseBtn = document.getElementById('play-pause');
  if (playPauseBtn) {
    playPauseBtn.setAttribute('aria-pressed', String(state.isPlaying));
    playPauseBtn.setAttribute('aria-label', state.isPlaying ? t('pause') : t('play'));
  }

  const shuffleBtn = document.getElementById('shuffle-btn');
  if (shuffleBtn) {
    const random = state.playMode === 'random';
    shuffleBtn.classList.toggle('is-active', random);
    shuffleBtn.setAttribute('aria-pressed', String(random));
    shuffleBtn.setAttribute('aria-label', random ? t('play_mode_random') : t('play_mode_order'));
  }

  warmNextTrack(state);
}

// Repaints everything a row shows about "what is playing right now": the
// highlight, and whether the leading button is a play triangle or the pause
// bars. Runs on every store notification, so it never rebuilds a row - only a
// button whose icon actually changed is touched.
function updateTrackRowHighlight() {
  if (!mainEl) return;
  const { isPlaying } = store.getState();
  mainEl.querySelectorAll('.track-row').forEach((row) => {
    const isCurrent = row.dataset.trackId === currentTrackId;
    row.classList.toggle('is-playing', isCurrent);
    const button = row.querySelector('.track-row__play');
    if (button) paintRowPlayButton(button, isCurrent && isPlaying);
  });
}

// The two shapes come from ui/rowicons.js - the same module the transport uses -
// so a row's pause bars can never drift from the bottom bar's.
function paintRowPlayButton(button, showPause) {
  const wanted = showPause ? 'pause' : 'play';
  if (button.dataset.icon === wanted) return;
  button.dataset.icon = wanted;
  button.replaceChildren(showPause ? pauseIcon() : playIcon());
  const title = button.dataset.trackTitle ?? '';
  button.setAttribute('aria-label', `${showPause ? t('pause') : t('play')}: ${title}`);
}

// ---------------------------------------------------------------------------
// Lists and rows

function activeListTracks(state) {
  if (state.activePlaylist === null) return state.tracks;
  const playlist = state.userPlaylists.find((p) => p.name === state.activePlaylist);
  if (!playlist) return [];
  // Keep the playlist's own order; skip ids whose track no longer exists.
  return playlist.trackIds.map((id) => trackById(id)).filter(Boolean);
}

function renderActiveList() {
  renderTrackList(activeListTracks(store.getState()));
}

function selectPlaylist(name) {
  store.setState({ activePlaylist: name });
  // A chip tap always shows that list - an in-progress search would otherwise
  // keep painting results over it.
  if (searchInput && searchInput.value !== '') searchInput.value = '';
  renderActiveList();
}

function handleSearchResults(results) {
  // The search module fires for a cleared input too (every track matches "");
  // that means "back to the active list", not "show everything".
  if (!isSearching()) {
    renderActiveList();
  } else {
    renderTrackList(results);
  }
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function renderTrackList(tracks) {
  if (!mainEl) return;
  displayedTracks = tracks;
  mainEl.innerHTML = '';

  if (tracks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = t('empty_library');
    mainEl.appendChild(empty);
    return;
  }

  const listIds = tracks.map((track) => track.id);

  const list = document.createElement('ul');
  list.className = 'track-list';

  tracks.forEach((track, index) => {
    const item = document.createElement('li');
    item.className = 'track-row pressable';
    if (track.matched === false) item.classList.add('unmatched');
    item.dataset.trackId = track.id;

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'track-row__play icon-btn pressable';
    playBtn.dataset.trackTitle = track.title;
    // Shows the pause bars while THIS row is the one playing, so the button is
    // always the action it performs.
    paintRowPlayButton(playBtn, track.id === currentTrackId && store.getState().isPlaying);
    playBtn.addEventListener('click', (event) => {
      // The whole row plays too - without this the tap would count twice.
      event.stopPropagation();
      toggleRowPlayback(listIds, index);
    });

    const main = document.createElement('div');
    main.className = 'track-row__main';

    const title = document.createElement('span');
    title.className = 'track-row__title';
    title.textContent = track.title;

    const artist = document.createElement('span');
    artist.className = 'track-row__artist';
    artist.textContent = track.artist;

    main.appendChild(title);
    main.appendChild(artist);

    const duration = document.createElement('span');
    duration.className = 'track-row__duration';
    duration.textContent = formatDuration(track.durationSec);

    item.appendChild(playBtn);
    item.appendChild(main);
    item.appendChild(duration);

    item.addEventListener('click', () => playFromList(listIds, index));

    // swipe.js suppresses the click that follows a completed drag, so a swipe
    // never also plays the row.
    attachSwipe(item, {
      onRight: () => addToQueue(track.id),
      onLeft: () => openPickerFor(track)
    });

    list.appendChild(item);
  });

  mainEl.appendChild(list);
  updateTrackRowHighlight();
}

// ---------------------------------------------------------------------------
// Playback

// Loads and plays one track. History gets the PREVIOUS current id (except when
// this play IS a history pop), so prev always walks back through what was
// actually heard - essential in random mode.
function playTrackById(id, { fromHistory = false } = {}) {
  const state = store.getState();
  const track = state.tracks.find((tr) => tr.id === id);
  if (!track || !track.file) return false;

  const prevId = currentTrackId;
  currentTrackId = id;

  const patch = {};
  if (!fromHistory && prevId) {
    patch.history = state.history.concat(prevId).slice(-HISTORY_CAP);
  }
  // Even an empty patch notifies subscribers, which repaints the now-playing
  // text and row highlight for the new currentTrackId.
  store.setState(patch);

  player.play(track, streamUrl(track.id));
  incrementPlayCount(track.id, Date.now());
  return true;
}

// Starting a song from a rendered list makes that list the listening context.
function playFromList(listIds, index) {
  const id = listIds[index];
  if (id == null) return;
  store.setState({ context: listIds.slice(), contextIndex: index });
  playTrackById(id);
}

// The row's leading button. On the track that is already loaded it acts as a
// transport control - pause, or resume from where it stopped - and on any other
// row it starts that track exactly as tapping the row does.
function toggleRowPlayback(listIds, index) {
  const id = listIds[index];
  if (id == null) return;

  if (id === currentTrackId) {
    if (store.getState().isPlaying) {
      player.pause();
    } else {
      player.resume();
    }
    return;
  }

  playFromList(listIds, index);
}

// A song ending never stops the music: queue head first, then endless order or
// random flow through the listening context. Queued songs do not move the
// context - when the queue drains, playback resumes from where the context
// stood.
function advance() {
  const state = store.getState();

  if (state.queue.length > 0) {
    const [head, ...rest] = state.queue;
    store.setState({ queue: rest });
    if (!playTrackById(head)) advance(); // unplayable entry: fall through to the next thing
    return;
  }

  const len = state.context.length;
  if (len === 0) return;

  if (state.playMode === 'order') {
    // Endless wrap; step over tracks that lost their file rather than stall.
    const base = state.contextIndex >= 0 ? state.contextIndex : -1;
    for (let step = 1; step <= len; step++) {
      const idx = (base + step) % len;
      store.setState({ contextIndex: idx });
      if (playTrackById(state.context[idx])) return;
    }
  } else {
    // Uniform pick excluding the current position - never the same track
    // twice in a row while the context has more than one entry.
    let idx;
    if (len === 1) {
      idx = 0;
    } else if (state.contextIndex >= 0 && state.contextIndex < len) {
      idx = Math.floor(Math.random() * (len - 1));
      if (idx >= state.contextIndex) idx += 1;
    } else {
      idx = Math.floor(Math.random() * len);
    }
    store.setState({ contextIndex: idx });
    playTrackById(state.context[idx]);
  }
}

function goPrev() {
  const state = store.getState();
  const history = state.history.slice();

  while (history.length > 0) {
    const id = history.pop();
    const track = state.tracks.find((tr) => tr.id === id);
    if (track && track.file) {
      const patch = { history };
      // If the revisited song sits in the context, move the context cursor to
      // it so a later "next" in order mode continues from there.
      const ctxIdx = state.context.indexOf(id);
      if (ctxIdx !== -1) patch.contextIndex = ctxIdx;
      store.setState(patch);
      playTrackById(id, { fromHistory: true });
      return;
    }
  }

  if (history.length !== state.history.length) store.setState({ history });
  if (currentTrackId) player.seek(0);
}

function togglePlayMode() {
  const next = store.getState().playMode === 'order' ? 'random' : 'order';
  store.setState({ playMode: next });
}

// A second, never-played element that quietly buffers whatever advance() would
// play next (queue head first, else the next context entry in order mode -
// random is unpredictable, so it skips warming). Combined with the immutable
// Cache-Control on /audio, the following track then starts from the local
// cache instead of a fresh cross-continent fetch.
const trackWarmer = new Audio();
trackWarmer.preload = 'auto';
trackWarmer.muted = true;

function warmNextTrack(state) {
  let nextId = null;
  if (state.queue.length > 0) {
    nextId = state.queue[0];
  } else if (state.playMode === 'order' && state.context.length > 0) {
    const idx = state.contextIndex >= 0 ? (state.contextIndex + 1) % state.context.length : 0;
    nextId = state.context[idx];
  } else {
    return;
  }

  const track = state.tracks.find((tr) => tr.id === nextId);
  if (!track || !track.file) return;
  const url = streamUrl(track.id);
  if (trackWarmer.src && trackWarmer.src.endsWith(url)) return;
  try {
    trackWarmer.src = url;
    trackWarmer.load();
  } catch {
    /* prefetch is best-effort */
  }
}

// ---------------------------------------------------------------------------
// Queue

function addToQueue(trackId) {
  const state = store.getState();
  // Duplicates are allowed, Spotify-style.
  store.setState({ queue: state.queue.concat(trackId) });
  showToast(t('added_to_queue'));
}

function openQueuePanel() {
  if (!modalRoot || modalRoot.childElementCount > 0) return;

  // Resolve ids to tracks; prune entries whose track vanished so the panel's
  // indices and the stored queue stay aligned.
  const state = store.getState();
  const resolvedTracks = [];
  const resolvedIds = [];
  for (const id of state.queue) {
    const track = trackById(id);
    if (track) {
      resolvedTracks.push(track);
      resolvedIds.push(id);
    }
  }
  if (resolvedIds.length !== state.queue.length) {
    store.setState({ queue: resolvedIds });
  }

  renderQueuePanel(modalRoot, resolvedTracks, {
    onReorder: (newIds) => {
      store.setState({ queue: Array.isArray(newIds) ? newIds.slice() : [] });
    },
    onRemove: (which) => {
      const queue = store.getState().queue.slice();
      const index = typeof which === 'number' ? which : queue.indexOf(which);
      if (index >= 0 && index < queue.length) {
        queue.splice(index, 1);
        store.setState({ queue });
      }
    },
    onPlayIndex: (index) => {
      const queue = store.getState().queue;
      const id = queue[index];
      if (id == null) return;
      // Playing an entry consumes it and everything queued before it.
      store.setState({ queue: queue.slice(index + 1) });
      playTrackById(id);
    },
    onClose: () => {},
    t
  });
}

// ---------------------------------------------------------------------------
// Playlists: picker (swipe left) and the "+" creation modal

function openPickerFor(track) {
  if (!modalRoot || modalRoot.childElementCount > 0) return;

  openPlaylistPicker({
    mount: modalRoot,
    track,
    playlists: store.getState().userPlaylists,
    isMember: (name) => {
      const playlist = store.getState().userPlaylists.find((p) => p.name === name);
      return Boolean(playlist && playlist.trackIds.includes(track.id));
    },
    onToggle: async (name) => {
      const nowMember = await withSession(() => toggleTrack(name, track.id));
      await refreshUserPlaylists();
      // If the list on screen is the playlist that just changed, repaint it so
      // the row appears/disappears immediately behind the modal.
      const state = store.getState();
      if (state.activePlaylist === name && !isSearching()) renderActiveList();
      return nowMember;
    },
    t
  });
}

// Pulls the server's list into the store. The extra patch rides along in the
// same notification so a rename can move the active chip without a repaint that
// briefly shows no chip selected at all.
async function refreshUserPlaylists(patch = {}) {
  let userPlaylists;
  try {
    userPlaylists = await withSession(() => listPlaylists());
  } catch (error) {
    if (isUnauthorized(error)) {
      window.location.replace('/login');
      return;
    }
    // A hiccup or a dropped connection: keep the chips that are on screen
    // rather than blanking the strip, but still apply the caller's patch.
    store.setState(patch);
    return;
  }
  store.setState({ userPlaylists, ...patch });
}

// Rename and delete are reached from the active chip's "..." menu, which owns
// the modal, the confirmation and the inline error. Both of these rethrow the
// API error untouched so that .status === 409 can be reported as "that name is
// taken" rather than as a generic failure.
async function renameActivePlaylist(oldName, newName) {
  // The menu only ever opens on the active chip, so a single-argument call
  // ("rename the active one to this") means the same thing.
  const from = typeof newName === 'string' ? oldName : store.getState().activePlaylist;
  const to = typeof newName === 'string' ? newName : oldName;
  if (!from || typeof to !== 'string') return;

  const updated = await withSession(() => renamePlaylist(from, to));
  const finalName = updated && updated.name ? updated.name : to;

  const wasActive = store.getState().activePlaylist === from;
  await refreshUserPlaylists(wasActive ? { activePlaylist: finalName } : {});
  if (wasActive && !isSearching()) renderActiveList();
}

async function deleteActivePlaylist(name) {
  const target = typeof name === 'string' ? name : store.getState().activePlaylist;
  if (!target) return;

  await withSession(() => deletePlaylist(target));

  const wasActive = store.getState().activePlaylist === target;
  await refreshUserPlaylists(wasActive ? { activePlaylist: null } : {});
  if (wasActive) {
    // Deleting the list that is on screen falls back to "All songs"; a live
    // search would otherwise keep painting results over it.
    if (searchInput && searchInput.value !== '') searchInput.value = '';
    renderActiveList();
  }
}

function inlineMessage(kind) {
  const entry = INLINE_MESSAGES[kind] ?? INLINE_MESSAGES.failed;
  return entry.en;
}

function openNewPlaylistModal() {
  if (!modalRoot || modalRoot.childElementCount > 0) return;

  const shell = document.querySelector('.app-shell');

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const card = document.createElement('div');
  card.className = 'modal-card new-playlist';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = t('add_playlist');

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'modal-input';
  input.placeholder = t('new_playlist_name');
  input.setAttribute('aria-label', t('new_playlist_name'));
  input.autocomplete = 'off';
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'sentences');
  input.setAttribute('enterkeyhint', 'done');
  input.maxLength = 60;

  const error = document.createElement('div');
  error.className = 'modal-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'modal-btn pressable';
  cancelBtn.textContent = t('cancel');

  const createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.className = 'modal-btn modal-btn--primary pressable';
  createBtn.textContent = t('create');

  actions.appendChild(cancelBtn);
  actions.appendChild(createBtn);

  card.appendChild(title);
  card.appendChild(input);
  card.appendChild(error);
  card.appendChild(actions);
  backdrop.appendChild(card);

  function close() {
    // Unblur with the panel, not after it: the shell sharpens while the card is
    // still on its way out, so the two motions read as one gesture. Same shape
    // as every other panel - ui/modal.js owns the exit animation and the
    // removal.
    if (shell) shell.classList.remove('is-blurred');
    dismissModal(backdrop);
  }

  function showError(kind) {
    error.textContent = inlineMessage(kind);
    error.hidden = false;
  }

  let busy = false;
  function submit() {
    if (busy) return;
    const name = input.value.trim();
    if (!name) {
      showError('empty');
      input.focus();
      return;
    }
    busy = true;
    withSession(() => createPlaylist(name))
      .then(async () => {
        await refreshUserPlaylists();
        close();
      })
      .catch((err) => {
        // 409 is the server's "that name is taken"; everything else is a
        // failure the user can only retry.
        showError(err && err.status === 409 ? 'exists' : 'failed');
        busy = false;
      });
  }

  // A press that starts AND ends on the dim area dismisses, and so does
  // Escape. Not a click listener: iOS never synthesises a click for a tap on a
  // plain <div>, which is why the old backdrop handler did nothing on a phone.
  bindDismiss(backdrop, close);
  cancelBtn.addEventListener('click', close);
  createBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
  input.addEventListener('input', () => {
    error.hidden = true;
  });

  modalRoot.appendChild(backdrop);
  if (shell) shell.classList.add('is-blurred');
  input.focus();
}

// ---------------------------------------------------------------------------
// Adding a song

function openAddSongDialog() {
  if (!modalRoot || modalRoot.childElementCount > 0) return;

  openUploadDialog({
    mount: modalRoot,
    t,
    onUploaded: (track) => {
      showToast(inlineMessage('song_added'));
      refreshLibrary(track);
    }
  });
}

// The server owns the library, so the stored track comes back by re-reading
// /api/library rather than being spliced in from the response alone: the
// duration it parsed and the cover it extracted are facts only the server
// has. IndexedDB is rewritten alongside the store so a later offline start
// still lists the new song.
async function refreshLibrary(addedTrack) {
  try {
    const library = await withSession(() => fetchLibrary());
    await putTracks(library.tracks);
    store.setState({ tracks: library.tracks });
  } catch (error) {
    if (isUnauthorized(error)) {
      window.location.replace('/login');
      return;
    }
    // The upload itself landed - only the re-read failed. Fall back to the
    // track object the server returned so the row still appears.
    if (addedTrack && addedTrack.id && !trackById(addedTrack.id)) {
      store.setState({ tracks: store.getState().tracks.concat(addedTrack) });
    }
  }

  // Show the list the new song is actually in: a playlist tab or a live
  // search would otherwise hide it behind a filter the user has to clear.
  selectPlaylist(null);
}

// ---------------------------------------------------------------------------
// Toast

let toastEl = null;
let toastHideTimer = null;
let toastRemoveTimer = null;

// One reused element; opacity is driven inline so it works no matter how the
// stylesheet chooses to place the pill.
function showToast(message) {
  if (toastHideTimer) clearTimeout(toastHideTimer);
  if (toastRemoveTimer) clearTimeout(toastRemoveTimer);

  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.style.pointerEvents = 'none';
    toastEl.style.transition = 'opacity 250ms ease';
    toastEl.style.opacity = '0';
    document.body.appendChild(toastEl);
  }

  toastEl.textContent = message;
  requestAnimationFrame(() => {
    if (toastEl) toastEl.style.opacity = '1';
  });

  toastHideTimer = setTimeout(() => {
    if (toastEl) toastEl.style.opacity = '0';
  }, 950);
  toastRemoveTimer = setTimeout(() => {
    toastEl?.remove();
    toastEl = null;
  }, 1250);
}

boot();
