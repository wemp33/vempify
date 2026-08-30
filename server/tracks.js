// Adding and removing songs from the running app.
//
// Both routes sit behind the password gate (index.js mounts requireAuth ahead
// of this router) and both write through server/storage.js, so everything they
// create lands on the persistent volume rather than the ephemeral container
// filesystem.

import express, { Router } from 'express';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseBuffer } from 'music-metadata';
import {
  mediaDir,
  coversDir,
  readLibrary,
  writeLibraryAtomic,
  fnv1aId,
  sniffContainer,
  pictureExtension,
} from './storage.js';
import { removeTrackFromPlaylists } from './playlists.js';

const router = Router();

// 80mb covers a long lossless track; anything larger is not a song.
const UPLOAD_LIMIT = '80mb';

// --- serialising library writes ---------------------------------------------

// read-modify-write on a single JSON file is not safe against overlap: two
// uploads landing together would both read the old library and the second
// write would drop the first track. Every mutation queues behind the last.
let mutationQueue = Promise.resolve();

function withLibraryLock(fn) {
  const run = mutationQueue.then(fn, fn);
  // Keep the chain alive even when a mutation rejects.
  mutationQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// --- ffmpeg remux -----------------------------------------------------------

// Fragmented/DASH MP4s (what downloaders often emit) play badly in Safari's
// <audio>: bogus lock-screen duration, slow start, flaky seeking. A lossless
// `-c copy` remux to a plain faststart MP4 fixes all three. Optional: without
// ffmpeg the original bytes are stored and the player's duration fallback
// covers it. Same approach as tools/ingest.mjs.
let ffmpegChecked = false;
let ffmpegAvailable = false;

function hasFfmpeg() {
  if (!ffmpegChecked) {
    ffmpegChecked = true;
    try {
      ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
    } catch {
      ffmpegAvailable = false;
    }
  }
  return ffmpegAvailable;
}

// Writes `buffer` to destPath, remuxing first when it is worth it. The temp
// file lives in mediaDir so the fallback rename stays on one filesystem.
async function storeAudio(buffer, destPath, sniffed, title) {
  const tmpPath = path.join(
    mediaDir,
    `.upload.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  await fsp.writeFile(tmpPath, buffer);

  try {
    if (sniffed.ext === '.m4a' && hasFfmpeg()) {
      const result = spawnSync(
        'ffmpeg',
        ['-v', 'error', '-y', '-i', tmpPath, '-c', 'copy', '-movflags', '+faststart', destPath],
        { stdio: 'ignore' }
      );
      if (result.status === 0 && fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
        return;
      }
      console.warn(`[vempify] ffmpeg remux failed for "${title}"; storing the uploaded bytes instead`);
    }
    await fsp.rename(tmpPath, destPath);
    return;
  } finally {
    try {
      await fsp.unlink(tmpPath);
    } catch {
      /* already renamed away, or never created */
    }
  }
}

// --- helpers ----------------------------------------------------------------

function firstQueryValue(value) {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

async function removeIfPresent(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[vempify] could not delete ${filePath}: ${err.message}`);
    }
  }
}

// --- POST /api/tracks -------------------------------------------------------

// '*/*' does not mean "every request": body-parser matches the type against
// the Content-Type header, and a request that sends none matches nothing, so
// req.body would arrive undefined with the audio still unread on the wire.
// That is not hypothetical - a File whose .type the picker left empty makes
// XHR omit the header entirely. Naming a default before the parser runs keeps
// the '*/*' matcher and makes it mean what it looks like it means.
function defaultContentType(req, res, next) {
  if (!req.headers['content-type']) {
    req.headers['content-type'] = 'application/octet-stream';
  }
  next();
}

// express.raw is mounted HERE and only here. Registering it globally would
// swallow every other body on the server - including the login form's
// urlencoded POST, which would break the password gate itself.
router.post('/tracks', defaultContentType, express.raw({ type: '*/*', limit: UPLOAD_LIMIT }), async (req, res) => {
  const title = firstQueryValue(req.query.title).trim();
  const artist = firstQueryValue(req.query.artist).trim();

  if (!title || !artist) {
    res.status(400).json({ error: 'Both title and artist are required.' });
    return;
  }

  const buffer = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buffer || buffer.length === 0) {
    res.status(400).json({ error: 'No audio data was received.' });
    return;
  }

  // The extension and the declared Content-Type are never trusted; the bytes
  // decide what this file is and what it gets served as.
  const sniffed = sniffContainer(buffer);
  if (!sniffed) {
    res.status(415).json({
      error: 'That file is not a recognised audio format. MP3, M4A/MP4, FLAC, OGG and WAV are supported.',
    });
    return;
  }

  const id = fnv1aId(artist, title);

  try {
    const track = await withLibraryLock(async () => {
      const library = await readLibrary();
      const existing = library.tracks.find((t) => t.id === id);
      if (existing) {
        const conflict = new Error(
          `"${existing.title}" by ${existing.artist} is already in the library.`
        );
        conflict.status = 409;
        throw conflict;
      }

      // Duration and tags come from the uploaded bytes, parsed with the
      // container the sniff found rather than the one the filename claims.
      let album = '';
      let durationSec = 0;
      let picture = null;
      try {
        const metadata = await parseBuffer(buffer, { mimeType: sniffed.mime });
        const common = metadata?.common || {};
        const format = metadata?.format || {};
        durationSec = Math.round(format.duration || 0);
        album = common.album ? String(common.album).trim() : '';
        const pictures = Array.isArray(common.picture) ? common.picture : [];
        const first = pictures[0];
        picture = first && first.data && first.data.length > 0 ? first : null;
      } catch (err) {
        // Unreadable tags are not a reason to refuse a playable file; the
        // player falls back to the real duration once the audio loads.
        console.warn(`[vempify] could not read metadata for "${title}": ${err.message}`);
      }

      const file = `${id}${sniffed.ext}`;
      await storeAudio(buffer, path.join(mediaDir, file), sniffed, title);

      // A bad embedded image must never fail an otherwise good upload - the
      // track simply keeps cover: null.
      let cover = null;
      if (picture) {
        const coverName = `${id}.${pictureExtension(picture)}`;
        try {
          await fsp.mkdir(coversDir, { recursive: true });
          await fsp.writeFile(path.join(coversDir, coverName), Buffer.from(picture.data));
          cover = coverName;
        } catch (err) {
          console.warn(`[vempify] could not write cover for "${title}": ${err.message}`);
        }
      }

      const newTrack = { id, title, artist, album, durationSec, file, cover, matched: true };
      library.tracks.push(newTrack);
      await writeLibraryAtomic(library);
      return newTrack;
    });

    console.log(`[vempify] added "${track.title}" by ${track.artist} (${track.id}${path.extname(track.file)})`);
    res.status(201).json(track);
  } catch (err) {
    if (err.status === 409) {
      res.status(409).json({ error: err.message });
      return;
    }
    console.error(`[vempify] upload failed: ${err.stack || err.message}`);
    res.status(500).json({ error: 'Could not save that song. Please try again.' });
  }
});

// A body over the limit, or a raw-body read that fails midway, arrives here as
// an Express error. Answer it as JSON: the uploader shows the message inline.
router.use('/tracks', (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    res.status(413).json({ error: 'That file is too large. The limit is 80 MB.' });
    return;
  }
  console.error(`[vempify] upload request failed: ${err?.stack || err?.message || err}`);
  res.status(400).json({ error: 'The upload could not be read.' });
});

// --- DELETE /api/tracks/:id -------------------------------------------------

router.delete('/tracks/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const removed = await withLibraryLock(async () => {
      const library = await readLibrary();
      const index = library.tracks.findIndex((t) => t.id === id);
      if (index === -1) return null;

      const [track] = library.tracks.splice(index, 1);
      // A track id left behind in a playlist would render as a phantom row.
      for (const playlist of library.playlists) {
        if (Array.isArray(playlist.trackIds)) {
          playlist.trackIds = playlist.trackIds.filter((trackId) => trackId !== id);
        }
      }
      await writeLibraryAtomic(library);
      return track;
    });

    if (!removed) {
      res.status(404).json({ error: 'No such track.' });
      return;
    }

    // The user's own playlists live in their own file now, so the loop above
    // (which only cleans library.json's bundled playlists) is no longer the
    // whole job. A failure here leaves a phantom row rather than a broken
    // delete, so it is logged and the delete still reports success.
    try {
      await removeTrackFromPlaylists(id);
    } catch (err) {
      console.error(
        `[vempify] removed track ${id} but could not clean it out of playlists.json: ${err.stack || err.message}`
      );
    }

    // The files go after the library is safely written: an orphaned file is
    // harmless, a library row pointing at a deleted file is not.
    if (removed.file) await removeIfPresent(path.join(mediaDir, removed.file));
    if (removed.cover) await removeIfPresent(path.join(coversDir, removed.cover));

    console.log(`[vempify] removed "${removed.title}" by ${removed.artist} (${removed.id})`);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`[vempify] delete failed: ${err.stack || err.message}`);
    res.status(500).json({ error: 'Could not remove that song.' });
  }
});

export default router;
