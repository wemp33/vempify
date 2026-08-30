import {
  initDB,
  putTracks,
  getAllTracks,
  incrementPlayCount,
  getUserPlaylists,
  createUserPlaylist,
  toggleTrackInUserPlaylist
} from './db.js';
import { store } from './state.js';
import { t, setLang, getLang } from './i18n.js';
import { fetchLibrary, streamUrl } from './sources/local.js';
import { attachSwipe } from './ui/swipe.js';
import { openPlaylistPicker } from './ui/playlist-picker.js';
import { openUploadDialog } from './ui/upload.js';
import { renderQueuePanel, updateQueueBadge } from './ui/queue.js';
import { renderTabs } from './ui/sidebar.js';
import { renderNowPlaying } from './ui/nowplaying.js';
import { createPlayer } from './ui/player.js';
import { renderSearch } from './ui/search.js';

const HISTORY_CAP = 50;

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

async function boot() {
  await initDB();

  let tracks;
  try {
    const library = await fetchLibrary();
    tracks = library.tracks;
    await putTracks(tracks);
  } catch (error) {
    // The session behind the password gate expired. Falling back to the cache
    // would render a library whose audio the server now refuses to stream, so
    // send the user to the login page instead of faking a working app.
    if (isUnauthorized(error)) {
      window.location.replace('/login');
      return;
    }
    tracks = await getAllTracks();
  }

  // User playlists never touch the server - they live only in IndexedDB.
  const userPlaylists = await getUserPlaylists();

  store.setState({ tracks, userPlaylists, lang: getLang() });

  setupDom();
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

  document.getElementById('lang-toggle')?.addEventListener('click', () => {
    const newLang = getLang() === 'en' ? 'pl' : 'en';
    setLang(newLang);
    applyStaticI18n();
    renderTrackList(displayedTracks);
    store.setState({ lang: newLang });
  });

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

  const langToggleBtn = document.getElementById('lang-toggle');
  if (langToggleBtn) {
    langToggleBtn.setAttribute('title', t('language'));
    langToggleBtn.textContent = getLang().toUpperCase();
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

function updateTrackRowHighlight() {
  if (!mainEl) return;
  mainEl.querySelectorAll('.track-row').forEach((row) => {
    row.classList.toggle('is-playing', row.dataset.trackId === currentTrackId);
  });
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

function createPlayIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const triangle = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  triangle.setAttribute('class', 'solid');
  triangle.setAttribute('points', '8,5 19,12 8,19');
  svg.appendChild(triangle);
  return svg;
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
    playBtn.setAttribute('aria-label', `${t('play')}: ${track.title}`);
    playBtn.appendChild(createPlayIcon());
    playBtn.addEventListener('click', (event) => {
      // The whole row plays too - without this the tap would count twice.
      event.stopPropagation();
      playFromList(listIds, index);
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
      const nowMember = await toggleTrackInUserPlaylist(name, track.id);
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

async function refreshUserPlaylists() {
  const userPlaylists = await getUserPlaylists();
  store.setState({ userPlaylists });
}

function inlineMessage(kind) {
  const entry = INLINE_MESSAGES[kind] ?? INLINE_MESSAGES.failed;
  return entry[getLang()] ?? entry.en;
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
    if (shell) shell.classList.remove('is-blurred');
    backdrop.remove();
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
    createUserPlaylist(name, Date.now())
      .then(async () => {
        await refreshUserPlaylists();
        close();
      })
      .catch((err) => {
        showError(err && err.message === 'exists' ? 'exists' : 'failed');
        busy = false;
      });
  }

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
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
    const library = await fetchLibrary();
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
