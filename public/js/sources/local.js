export async function fetchLibrary() {
  const response = await fetch('/api/library');
  if (!response.ok) {
    throw new Error(`Failed to fetch library: ${response.status}`);
  }
  return response.json();
}

export function streamUrl(trackId) {
  return `/audio/${encodeURIComponent(trackId)}`;
}

// --- editing and removing a track -------------------------------------------
//
// Same contract as sources/playlists.js: a failed call throws an Error carrying
// .status, so the panel can tell a 404 (the track went away on another device)
// from a 400 (the user cleared a field) from a real failure, and show the
// server's own message inline.

const TRACKS = '/api/tracks';

function fail(status, message) {
  const error = new Error(message || `Request failed: ${status}`);
  error.status = status;
  return error;
}

// credentials: 'same-origin' is explicit rather than implied: the app is a
// standalone PWA behind a cookie gate, and a fetch that quietly dropped the
// cookie would read as a failed edit instead of an expired session.
async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });

  if (!response.ok) {
    let message = '';
    try {
      const body = await response.json();
      if (body && typeof body.error === 'string') message = body.error;
    } catch {
      /* the error body was not JSON - the status is enough */
    }
    throw fail(response.status, message);
  }

  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// Edits the displayed details of one track. `fields` is { title?, artist? };
// whatever is omitted is left as it was. The track's id never changes - it
// names the audio file and every playlist reference - so the caller can keep
// using the same id after this resolves.
export async function updateTrack(id, fields) {
  const body = {};
  if (typeof fields?.title === 'string') body.title = fields.title;
  if (typeof fields?.artist === 'string') body.artist = fields.artist;

  return request(`${TRACKS}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

// Removes the track, its audio file, its cover and its membership in every
// playlist. The server does the playlist cleanup; the client only has to
// re-read the library afterwards.
export async function deleteTrack(id) {
  await request(`${TRACKS}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
