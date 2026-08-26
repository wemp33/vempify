const COVER_BASE = '/covers/';

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// "/covers/<file>" for a non-empty cover filename, null otherwise. encodeURIComponent
// never emits a double quote, so the result is always safe to drop into url("...").
export function coverUrl(cover) {
  if (typeof cover !== 'string') return null;
  const name = cover.trim();
  if (!name) return null;
  return COVER_BASE + encodeURIComponent(name);
}

// Deterministic per-track gradient: the same track always gets the same colours,
// so a coverless track still reads as "that one" across renders.
export function artworkGradient(seed) {
  const hash = hashString(String(seed ?? ''));
  const hue = hash % 360;
  const angle = Math.floor(hash / 360) % 360;
  return `linear-gradient(${angle}deg, hsl(${hue}, 70%, 45%), hsl(${(hue + 60) % 360}, 70%, 30%))`;
}

// One artwork tile, reused by the footer and by the main track list. The gradient
// is always painted on the tile itself, so it shows through while the cover is
// still loading and is what remains if the cover 404s.
export function createArtwork(track, className) {
  const art = document.createElement('div');
  art.className = className;
  art.style.background = artworkGradient(track && track.id);

  const url = coverUrl(track && track.cover);
  if (!url) return art;

  const img = document.createElement('img');
  img.className = 'artwork-img';
  img.alt = (track && (track.album || track.title)) || '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.style.width = '100%';
  img.style.height = '100%';
  img.style.display = 'block';
  img.style.objectFit = 'cover';
  img.style.borderRadius = 'inherit';
  // A missing cover file must never surface as a broken-image icon: drop the img
  // and let the gradient underneath stand in.
  img.addEventListener('error', () => img.remove(), { once: true });
  img.src = url;

  art.appendChild(img);
  return art;
}

// The blurred bar backdrop lives outside the track slot in the shell markup, so
// look for it in the surrounding footer first and only create one as a fallback.
function updateAmbientBackdrop(container, url) {
  const scope =
    (typeof container.closest === 'function' && container.closest('.now-playing')) ||
    container.parentElement ||
    container;

  let ambient = scope.querySelector('.ambient-bg');
  if (!ambient) {
    ambient = document.createElement('div');
    ambient.className = 'ambient-bg';
    ambient.setAttribute('aria-hidden', 'true');
    container.insertBefore(ambient, container.firstChild);
  }

  ambient.style.backgroundImage = url ? `url("${url}")` : '';
}

export function renderNowPlaying(container, track) {
  if (!container || !track) return;

  container.innerHTML = '';

  const artwork = createArtwork(track, 'now-playing-art');

  const meta = document.createElement('div');
  meta.className = 'now-playing-meta';

  const title = document.createElement('div');
  title.id = 'now-playing-title';
  title.className = 'now-playing-title';
  title.textContent = track.title;

  const artist = document.createElement('div');
  artist.id = 'now-playing-artist';
  artist.className = 'now-playing-artist';
  artist.textContent = track.artist;

  meta.appendChild(title);
  meta.appendChild(artist);

  container.appendChild(artwork);
  container.appendChild(meta);

  updateAmbientBackdrop(container, coverUrl(track.cover));
}
