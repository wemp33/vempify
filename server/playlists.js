// Server-side playlists.
//
// They used to live only in the browser's IndexedDB, which meant the phone and
// the laptop each had their own private set. Now they live on the volume in
// <DATA_DIR>/playlists.json and every device reads the same list.
//
// Mounted under /api behind the password gate (index.js puts requireAuth ahead
// of this router), so nothing here re-checks the session.

import express, { Router } from 'express';
import { readPlaylists, writePlaylistsAtomic } from './storage.js';

const router = Router();

// Names and a list of ids: a few hundred bytes even for a big playlist. The
// limit is here so a runaway client cannot post a megabyte of JSON.
const BODY_LIMIT = '16kb';

// --- serialising playlist writes --------------------------------------------

// Same reasoning as tracks.js's library lock: read-modify-write on one JSON
// file is not safe against overlap. Two renames landing together would both
// read the old file and the second write would drop the first change. Every
// mutation queues behind the last.
//
// Exported because deleting a track has to edit this file too, and it must
// take its turn in the same queue rather than racing the router.
let mutationQueue = Promise.resolve();

export function withPlaylistLock(fn) {
  const run = mutationQueue.then(fn, fn);
  // Keep the chain alive even when a mutation rejects.
  mutationQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// --- helpers ----------------------------------------------------------------

// The user typed the name, so " Rock " and "rock" are the same playlist to
// them. Comparison is trimmed and case-insensitive everywhere; the ORIGINAL
// casing is what gets stored and shown.
function key(name) {
  return String(name).trim().toLowerCase();
}

function cleanName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function findIndexByName(playlists, name) {
  const wanted = key(name);
  return playlists.findIndex((playlist) => key(playlist.name) === wanted);
}

// GET answers in creation order. The file itself is kept in insertion order,
// and Array#sort is stable, so playlists created within the same millisecond
// (the migration posts a burst of them) keep the order they arrived in.
function sorted(playlists) {
  return [...playlists].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

// The body parser is mounted on this router only. Registering it globally would
// swallow the raw upload body in tracks.js and the login form's urlencoded POST.
const jsonBody = express.json({ limit: BODY_LIMIT });

function nameFromBody(req) {
  return cleanName(req.body?.name);
}

// --- GET /api/playlists -----------------------------------------------------

router.get('/playlists', async (req, res) => {
  try {
    const { playlists } = await readPlaylists();
    res.json({ playlists: sorted(playlists) });
  } catch (err) {
    console.error(`[vempify] could not read playlists: ${err.stack || err.message}`);
    res.status(500).json({ error: 'Failed to read playlists' });
  }
});

// --- POST /api/playlists ----------------------------------------------------

router.post('/playlists', jsonBody, async (req, res) => {
  const name = nameFromBody(req);
  if (!name) {
    res.status(400).json({ error: 'A playlist name is required.' });
    return;
  }

  try {
    const created = await withPlaylistLock(async () => {
      const data = await readPlaylists();
      if (findIndexByName(data.playlists, name) !== -1) {
        const conflict = new Error(`A playlist called "${name}" already exists.`);
        conflict.status = 409;
        throw conflict;
      }
      const playlist = { name, trackIds: [], createdAt: Date.now() };
      data.playlists.push(playlist);
      await writePlaylistsAtomic(data);
      return playlist;
    });
    res.status(201).json(created);
  } catch (err) {
    if (err.status === 409) {
      res.status(409).json({ error: err.message });
      return;
    }
    console.error(`[vempify] could not create playlist: ${err.stack || err.message}`);
    res.status(500).json({ error: 'Could not create that playlist.' });
  }
});

// --- PATCH /api/playlists/:name ---------------------------------------------

router.patch('/playlists/:name', jsonBody, async (req, res) => {
  const nextName = nameFromBody(req);
  if (!nextName) {
    res.status(400).json({ error: 'A playlist name is required.' });
    return;
  }

  try {
    const renamed = await withPlaylistLock(async () => {
      const data = await readPlaylists();
      const index = findIndexByName(data.playlists, req.params.name);
      if (index === -1) return null;

      // A collision only counts against a DIFFERENT playlist, which is what
      // makes "Rock" -> "rock" legal: the only match is the row being renamed.
      const clash = findIndexByName(data.playlists, nextName);
      if (clash !== -1 && clash !== index) {
        const conflict = new Error(`A playlist called "${nextName}" already exists.`);
        conflict.status = 409;
        throw conflict;
      }

      data.playlists[index].name = nextName;
      await writePlaylistsAtomic(data);
      return data.playlists[index];
    });

    if (!renamed) {
      res.status(404).json({ error: 'No such playlist.' });
      return;
    }
    res.status(200).json(renamed);
  } catch (err) {
    if (err.status === 409) {
      res.status(409).json({ error: err.message });
      return;
    }
    console.error(`[vempify] could not rename playlist: ${err.stack || err.message}`);
    res.status(500).json({ error: 'Could not rename that playlist.' });
  }
});

// --- DELETE /api/playlists/:name --------------------------------------------

router.delete('/playlists/:name', async (req, res) => {
  try {
    const removed = await withPlaylistLock(async () => {
      const data = await readPlaylists();
      const index = findIndexByName(data.playlists, req.params.name);
      if (index === -1) return false;
      data.playlists.splice(index, 1);
      await writePlaylistsAtomic(data);
      return true;
    });

    if (!removed) {
      res.status(404).json({ error: 'No such playlist.' });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`[vempify] could not delete playlist: ${err.stack || err.message}`);
    res.status(500).json({ error: 'Could not delete that playlist.' });
  }
});

// --- PUT /api/playlists/:name/tracks/:trackId -------------------------------

// One idempotent-looking verb for both directions, because the UI is a
// checkbox: the client does not have to know the current membership to flip it.
router.put('/playlists/:name/tracks/:trackId', async (req, res) => {
  const { trackId } = req.params;
  if (!trackId) {
    res.status(400).json({ error: 'A track id is required.' });
    return;
  }

  try {
    const result = await withPlaylistLock(async () => {
      const data = await readPlaylists();
      const index = findIndexByName(data.playlists, req.params.name);
      if (index === -1) return null;

      const playlist = data.playlists[index];
      const at = playlist.trackIds.indexOf(trackId);
      let member;
      if (at === -1) {
        playlist.trackIds.push(trackId);
        member = true;
      } else {
        playlist.trackIds.splice(at, 1);
        member = false;
      }
      await writePlaylistsAtomic(data);
      return { member };
    });

    if (!result) {
      res.status(404).json({ error: 'No such playlist.' });
      return;
    }
    res.status(200).json(result);
  } catch (err) {
    console.error(`[vempify] could not update playlist membership: ${err.stack || err.message}`);
    res.status(500).json({ error: 'Could not update that playlist.' });
  }
});

// A malformed or oversized JSON body is a client bug, not a server failure -
// answer it as JSON so the client shows a message instead of an Express stack
// trace. Scoped to this router.
router.use('/playlists', (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    res.status(413).json({ error: 'That request is too large.' });
    return;
  }
  console.error(`[vempify] playlist request failed: ${err?.stack || err?.message || err}`);
  res.status(400).json({ error: 'The request could not be read.' });
});

// --- used by the track delete route -----------------------------------------

// Deleting a song has to drop its id from every playlist, or the playlist
// renders a phantom row that plays nothing. Takes the same lock as the routes
// above so it cannot race a rename or a membership toggle.
// -> the number of playlists that actually changed.
export function removeTrackFromPlaylists(trackId) {
  return withPlaylistLock(async () => {
    const data = await readPlaylists();
    let touched = 0;
    for (const playlist of data.playlists) {
      const before = playlist.trackIds.length;
      playlist.trackIds = playlist.trackIds.filter((id) => id !== trackId);
      if (playlist.trackIds.length !== before) touched++;
    }
    if (touched > 0) await writePlaylistsAtomic(data);
    return touched;
  });
}

export default router;
