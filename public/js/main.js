import { initDB, putTracks, putPlaylists, getAllTracks, getAllPlaylists, incrementPlayCount } from './db.js';
import { store } from './state.js';
import { t, setLang, getLang } from './i18n.js';
import { fetchLibrary, streamUrl } from './sources/local.js';
import { renderSidebar } from './ui/sidebar.js';
import { renderSearch } from './ui/search.js';
import { renderQueue } from './ui/queue.js';
import { renderNowPlaying, createArtwork } from './ui/nowplaying.js';
import { createPlayer } from './ui/player.js';

const REPEAT_MODES = ['off', 'all', 'one'];

let sidebarEl = null;
let searchInput = null;
let mainListEl = null;
let queueListMount = null;
let queueHeadingEl = null;
let nowPlayingInfoEl = null;
let player = null;

let currentListTracks = [];
let shuffledOrder = null;
let shuffledPosition = -1;

// fetchLibrary only throws Error("Failed to fetch library: <status>"), so match
// on that as well as on a status the source module may attach later.
function isUnauthorized(error) {
  if (!error) return false;
  if (error.status === 401 || error.statusCode === 401) return true;
  return typeof error.message === 'string' && /\b401\b/.test(error.message);
}

async function boot() {
  await initDB();

  let tracks;
  let playlists;

  try {
    const library = await fetchLibrary();
    tracks = library.tracks;
    playlists = library.playlists;
    await putTracks(tracks);
    await putPlaylists(playlists);
  } catch (error) {
    // The session behind the password gate expired. Falling back to the cache
    // would render a library whose audio the server now refuses to stream, so
    // send the user to the login page instead of faking a working app.
    if (isUnauthorized(error)) {
      window.location.replace('/login');
      return;
    }
    tracks = await getAllTracks();
    playlists = await getAllPlaylists();
  }

  store.setState({ tracks, playlists, lang: getLang() });

  setupDom();
}

function setupDom() {
  sidebarEl = document.getElementById('sidebar');
  searchInput = document.getElementById('search');
  // The existing footer markup already has a fixed-size, styled slot for
  // the current track's art/title/artist - reuse it instead of injecting
  // new DOM (the footer is a fixed 92px, overflow:hidden bar with no room
  // for anything else, so a queue list is mounted inside #main instead).
  nowPlayingInfoEl = document.querySelector('#now-playing .now-playing-track');

  const mainEl = document.getElementById('main');
  mainEl.innerHTML = '';
  mainEl.style.display = 'flex';
  mainEl.style.gap = '24px';
  mainEl.style.alignItems = 'flex-start';

  mainListEl = document.createElement('div');
  mainListEl.style.flex = '1';
  mainListEl.style.minWidth = '0';

  const queuePanel = document.createElement('div');
  queuePanel.style.width = '280px';
  queuePanel.style.flexShrink = '0';
  queuePanel.style.borderLeft = '1px solid var(--border)';
  queuePanel.style.paddingLeft = '20px';

  queueHeadingEl = document.createElement('div');
  queueHeadingEl.className = 'nav-section__title';
  queueHeadingEl.textContent = t('queue');

  queueListMount = document.createElement('div');

  queuePanel.appendChild(queueHeadingEl);
  queuePanel.appendChild(queueListMount);

  mainEl.appendChild(mainListEl);
  mainEl.appendChild(queuePanel);

  player = createPlayer({
    onTimeUpdate: handleTimeUpdate,
    onEnded: () => player.next(),
    onPlayStateChange: (isPlaying) => store.setState({ isPlaying })
  });
  player.next = () => advance(1);
  player.prev = () => advance(-1);
  player.setVolume(store.getState().volume);

  store.subscribe(render);

  renderSearch(searchInput, () => store.getState().tracks, (results) => {
    currentListTracks = results;
    renderMainPanel(mainListEl, results);
  });

  document.getElementById('play-pause')?.addEventListener('click', handlePlayPauseClick);
  document.getElementById('prev-btn')?.addEventListener('click', () => player.prev());
  document.getElementById('next-btn')?.addEventListener('click', () => player.next());
  document.getElementById('shuffle-btn')?.addEventListener('click', toggleShuffle);
  document.getElementById('repeat-btn')?.addEventListener('click', cycleRepeat);

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
    renderMainPanel(mainListEl, currentListTracks);
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
  const state = store.getState();
  if (state.currentIndex < 0) return;
  if (state.isPlaying) {
    player.pause();
  } else {
    player.resume();
  }
}

function applyStaticI18n() {
  if (searchInput) searchInput.placeholder = t('search_placeholder');

  document.getElementById('prev-btn')?.setAttribute('aria-label', t('prev'));
  document.getElementById('next-btn')?.setAttribute('aria-label', t('next'));
  document.getElementById('shuffle-btn')?.setAttribute('aria-label', t('shuffle'));
  document.getElementById('repeat-btn')?.setAttribute('aria-label', t('repeat'));
  document.getElementById('volume')?.setAttribute('aria-label', t('volume'));

  const langToggleBtn = document.getElementById('lang-toggle');
  if (langToggleBtn) {
    langToggleBtn.setAttribute('title', t('language'));
    langToggleBtn.textContent = getLang().toUpperCase();
  }

  if (queueHeadingEl) queueHeadingEl.textContent = t('queue');

  const playPauseBtn = document.getElementById('play-pause');
  if (playPauseBtn) {
    playPauseBtn.setAttribute('aria-label', store.getState().isPlaying ? t('pause') : t('play'));
  }
}

function render(state) {
  renderSidebar(sidebarEl, state.playlists, selectPlaylist);

  const currentTrack = state.currentIndex >= 0 ? state.queue[state.currentIndex] ?? null : null;
  renderNowPlaying(nowPlayingInfoEl, currentTrack);
  renderQueue(queueListMount, state.queue, state.currentIndex, handleQueueReorder, handleQueueSelect);
  updateTrackRowHighlight(state);

  const playPauseBtn = document.getElementById('play-pause');
  if (playPauseBtn) {
    playPauseBtn.setAttribute('aria-pressed', String(state.isPlaying));
    playPauseBtn.setAttribute('aria-label', state.isPlaying ? t('pause') : t('play'));
  }

  document.getElementById('shuffle-btn')?.setAttribute('aria-pressed', String(state.shuffle));

  const repeatBtn = document.getElementById('repeat-btn');
  if (repeatBtn) {
    repeatBtn.setAttribute('aria-pressed', String(state.repeat !== 'off'));
    repeatBtn.dataset.mode = state.repeat;
  }
}

function updateTrackRowHighlight(state) {
  if (!mainListEl) return;
  const currentTrackId = state.currentIndex >= 0 ? state.queue[state.currentIndex]?.id ?? null : null;
  mainListEl.querySelectorAll('.track-row').forEach((row) => {
    row.classList.toggle('is-playing', row.dataset.trackId === currentTrackId);
  });
}

function resolvePlaylistTracks(state, name) {
  if (name === null) return state.tracks;
  const playlist = state.playlists.find((p) => p.name === name);
  if (!playlist) return [];
  const byId = new Map(state.tracks.map((track) => [track.id, track]));
  return playlist.trackIds.map((id) => byId.get(id)).filter(Boolean);
}

function replaceQueue(tracks, index, extraPatch = {}) {
  shuffledOrder = null;
  shuffledPosition = -1;
  store.setState({ queue: tracks.slice(), currentIndex: index, ...extraPatch });
}

function selectPlaylist(name) {
  const state = store.getState();
  const tracks = resolvePlaylistTracks(state, name);
  currentListTracks = tracks;
  replaceQueue(tracks, -1, { currentPlaylistName: name });
  renderMainPanel(mainListEl, tracks);
}

function playFromList(list, index) {
  currentListTracks = list;
  replaceQueue(list, index);
  playCurrent();
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function renderMainPanel(container, tracks) {
  container.innerHTML = '';

  if (tracks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = t('empty_library');
    container.appendChild(empty);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'track-list';

  tracks.forEach((track, index) => {
    const item = document.createElement('li');
    item.className = 'track-row';
    if (track.matched === false) item.classList.add('unmatched');
    item.dataset.trackId = track.id;

    const indexEl = document.createElement('span');
    indexEl.className = 'track-row__index';
    indexEl.textContent = String(index + 1);

    // Real cover when library.json carries one, deterministic gradient when it
    // does not - same helper the footer uses, so a track looks alike in both.
    const art = createArtwork(track, 'track-row__art');

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

    const album = document.createElement('span');
    album.className = 'track-row__album';
    album.textContent = track.album || '';

    const duration = document.createElement('span');
    duration.className = 'track-row__duration';
    duration.textContent = formatDuration(track.durationSec);

    item.appendChild(indexEl);
    item.appendChild(art);
    item.appendChild(main);
    item.appendChild(album);
    item.appendChild(duration);

    item.addEventListener('click', () => playFromList(tracks, index));

    list.appendChild(item);
  });

  container.appendChild(list);
}

function handleQueueSelect(index) {
  const state = store.getState();
  if (!state.queue[index]) return;
  shuffledOrder = null;
  shuffledPosition = -1;
  store.setState({ currentIndex: index });
  playCurrent();
}

function handleQueueReorder(newOrderedIds) {
  const state = store.getState();
  const currentTrackId = state.currentIndex >= 0 ? state.queue[state.currentIndex]?.id ?? null : null;
  const byId = new Map(state.queue.map((track) => [track.id, track]));
  const reordered = newOrderedIds.map((id) => byId.get(id)).filter(Boolean);
  const newIndex = currentTrackId ? reordered.findIndex((track) => track.id === currentTrackId) : -1;
  shuffledOrder = null;
  shuffledPosition = -1;
  store.setState({ queue: reordered, currentIndex: newIndex });
}

// A second, never-played element that quietly buffers the next queue entry
// while the current one plays. Combined with the immutable Cache-Control on
// /audio, the following track then starts from the local cache instead of a
// fresh cross-continent fetch.
const trackWarmer = new Audio();
trackWarmer.preload = 'auto';
trackWarmer.muted = true;

function warmNextTrack(state) {
  const next = state.queue[state.currentIndex + 1];
  if (!next || !next.file) return;
  const url = streamUrl(next.id);
  if (trackWarmer.src && trackWarmer.src.endsWith(url)) return;
  try {
    trackWarmer.src = url;
    trackWarmer.load();
  } catch {
    /* prefetch is best-effort */
  }
}

function playCurrent() {
  const state = store.getState();
  const track = state.queue[state.currentIndex];
  if (!track || !track.file) return;
  player.play(track, streamUrl(track.id));
  incrementPlayCount(track.id, Date.now());
  warmNextTrack(state);
}

function computeShuffledOrder(length, anchorIndex) {
  const indices = Array.from({ length }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  if (anchorIndex >= 0) {
    const pos = indices.indexOf(anchorIndex);
    if (pos > 0) [indices[0], indices[pos]] = [indices[pos], indices[0]];
  }
  return indices;
}

function ensureShuffledOrder(state) {
  if (!shuffledOrder || shuffledOrder.length !== state.queue.length) {
    shuffledOrder = computeShuffledOrder(state.queue.length, state.currentIndex);
    shuffledPosition = Math.max(0, shuffledOrder.indexOf(state.currentIndex));
  }
}

function toggleShuffle() {
  const state = store.getState();
  const enabling = !state.shuffle;
  if (enabling) {
    shuffledOrder = computeShuffledOrder(state.queue.length, state.currentIndex);
    shuffledPosition = Math.max(0, shuffledOrder.indexOf(state.currentIndex));
  } else {
    shuffledOrder = null;
    shuffledPosition = -1;
  }
  store.setState({ shuffle: enabling });
}

function cycleRepeat() {
  const state = store.getState();
  const nextMode = REPEAT_MODES[(REPEAT_MODES.indexOf(state.repeat) + 1) % REPEAT_MODES.length];
  store.setState({ repeat: nextMode });
}

function advance(direction) {
  const state = store.getState();
  if (state.queue.length === 0) return;

  if (state.shuffle) {
    ensureShuffledOrder(state);
    let pos = shuffledPosition + direction;
    if (pos < 0 || pos >= shuffledOrder.length) {
      if (state.repeat === 'off') return;
      if (state.repeat === 'one') {
        pos = shuffledPosition;
      } else {
        shuffledOrder = computeShuffledOrder(state.queue.length, -1);
        pos = 0;
      }
    }
    shuffledPosition = pos;
    store.setState({ currentIndex: shuffledOrder[pos] });
  } else {
    let newIndex = state.currentIndex + direction;
    if (newIndex < 0 || newIndex >= state.queue.length) {
      if (state.repeat === 'off') return;
      newIndex = state.repeat === 'one'
        ? state.currentIndex
        : ((newIndex % state.queue.length) + state.queue.length) % state.queue.length;
    }
    store.setState({ currentIndex: newIndex });
  }

  playCurrent();
}

boot();
