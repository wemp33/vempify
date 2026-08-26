import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import libraryRouter from './library.js';
import streamRouter from './stream.js';
import { authRouter, requireAuth } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

const app = express();

// Railway terminates TLS at its proxy and forwards over plain http, so req.secure
// and req.protocol are only correct once the first proxy hop is trusted.
app.set('trust proxy', 1);

// Order matters: the login routes must be reachable before the gate, and the
// gate must sit in front of every mount below it.
app.use(authRouter);
app.use(requireAuth);

app.use(express.static(path.join(projectRoot, 'public')));

// Cover art, keyed by track id and therefore content-addressed: safe to cache
// hard. Private, not public - these live behind the password gate and must not
// be parked in a shared proxy cache.
app.use(
  '/covers',
  express.static(path.join(projectRoot, 'media', 'covers'), {
    index: false,
    dotfiles: 'ignore',
    setHeaders(res) {
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    },
  })
);

app.use('/api', libraryRouter);
app.use('/audio', streamRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Vempify server listening on http://localhost:${PORT}`);
});
