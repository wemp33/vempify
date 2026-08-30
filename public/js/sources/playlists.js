// Playlists live on the server volume, not in this browser: the phone and the
// laptop have to see the same lists. Everything below is a thin, honest wrapper
// around /api/playlists.
//
// Two rules the callers depend on:
//   - the playlist NAME is the identity (there are no ids), so every name that
//     goes into a URL is encoded here and decoded server-side;
//   - a failed call throws an Error carrying .status, so a caller can tell a
//     409 name clash ("that name is taken") from a real failure.

const BASE = '/api/playlists';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function fail(status, message) {
  const error = new Error(message || `Request failed: ${status}`);
  error.status = status;
  return error;
}

// credentials: 'same-origin' is explicit rather than implied: the app is a
// standalone PWA behind a cookie gate, and a fetch that quietly drops the
// cookie would read as an empty library instead of an expired session.
async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { credentials: 'same-origin', ...options });
  } catch (networkError) {
    // Offline or the server is unreachable. No status exists, so callers see a
    // plain Error and fall back to whatever they already had on screen.
    throw networkError;
  }

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

// POST and PATCH answer with the playlist itself; tolerate a { playlist }
// envelope too, so a wrapped response never lands in the store as undefined.
function asPlaylist(body, fallbackName) {
  if (body && typeof body.name === 'string') return body;
  if (body && body.playlist && typeof body.playlist.name === 'string') return body.playlist;
  return { name: fallbackName, trackIds: [], createdAt: Date.now() };
}

export async function listPlaylists() {
  const body = await request(BASE);
  const playlists = body && Array.isArray(body.playlists) ? body.playlists : [];
  // Guard the shape the whole UI indexes into: a playlist without trackIds
  // would throw the moment the picker asked whether a song is a member.
  return playlists
    .filter((playlist) => playlist && typeof playlist.name === 'string')
    .map((playlist) => ({
      ...playlist,
      trackIds: Array.isArray(playlist.trackIds) ? playlist.trackIds : []
    }));
}

export async function createPlaylist(name) {
  const body = await request(BASE, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name })
  });
  return asPlaylist(body, name);
}

export async function renamePlaylist(oldName, newName) {
  const body = await request(`${BASE}/${encodeURIComponent(oldName)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: newName })
  });
  return asPlaylist(body, newName);
}

export async function deletePlaylist(name) {
  await request(`${BASE}/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

// Adds the track if it is not in the playlist, removes it if it is. Returns the
// membership the SERVER ended up with - the picker paints that, never its own
// guess, so a rejected toggle cannot leave a checked row lying about.
export async function toggleTrack(name, trackId) {
  const body = await request(
    `${BASE}/${encodeURIComponent(name)}/tracks/${encodeURIComponent(trackId)}`,
    { method: 'PUT' }
  );
  return Boolean(body && body.member);
}
