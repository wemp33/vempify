// Text-only now-playing readout: title and artist, nothing else. No artwork,
// no gradients, no ambient backdrop - the app shows no per-song imagery.

export function renderNowPlaying(container, track) {
  // A null track means "nothing new to show": leave the previous content
  // alone, because playback may continue across list changes.
  if (!container || !track) return;

  container.innerHTML = '';

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
  container.appendChild(meta);
}
