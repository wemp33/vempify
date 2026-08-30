import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import libraryRouter from './library.js';
import streamRouter from './stream.js';
import tracksRouter from './tracks.js';
import playlistsRouter from './playlists.js';
import { authRouter, requireAuth } from './auth.js';
import { DATA_DIR, coversDir, ensureStorage, seedFromBundleIfEmpty } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

// Everything mutable lives in the data directory - a mounted volume on Railway,
// .localdata/ during development. Both calls run before the first request can
// arrive: the directories must exist, and a brand-new volume gets the repo's
// bundled library and audio copied into it exactly once.
ensureStorage();
seedFromBundleIfEmpty();
console.log(`[vempify] data directory: ${DATA_DIR}`);

const app = express();

// Railway terminates TLS at its proxy and forwards over plain http, so req.secure
// and req.protocol are only correct once the first proxy hop is trusted.
app.set('trust proxy', 1);

// Order matters: the login routes must be reachable before the gate, and the
// gate must sit in front of every mount below it.
app.use(authRouter);
app.use(requireAuth);

// The service worker script must never be answered from the browser's HTTP
// cache. If it is, a device can keep re-installing an old worker - and since
// that worker serves CSS and JS from ITS cache while navigations go to the
// network, the result is fresh HTML rendered against stale CSS, which is
// exactly how the header buttons ended up spaced wrong on a real phone.
app.use(
  express.static(path.join(projectRoot, 'public'), {
    setHeaders(res, filePath) {
      if (filePath.endsWith(`${path.sep}sw.js`)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

// Cover art, keyed by track id and therefore content-addressed: safe to cache
// hard. Private, not public - these live behind the password gate and must not
// be parked in a shared proxy cache.
app.use(
  '/covers',
  express.static(coversDir, {
    index: false,
    dotfiles: 'ignore',
    setHeaders(res) {
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    },
  })
);

app.use('/api', libraryRouter);
// Upload and delete. Behind requireAuth like everything else under /api, and
// the only place a raw body parser is mounted.
app.use('/api', tracksRouter);
// Playlists, shared by every device. Mounted after tracksRouter so the raw
// body parser stays scoped to /api/tracks and never sees a playlist request.
app.use('/api', playlistsRouter);
app.use('/audio', streamRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Vempify server listening on http://localhost:${PORT}`);
});
