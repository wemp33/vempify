import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const libraryPath = path.join(projectRoot, 'public-data', 'library.json');
const mediaDir = path.join(projectRoot, 'media');

const MIME_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

const router = Router();

router.get('/:id', async (req, res) => {
  let library;
  try {
    const raw = await readFile(libraryPath, 'utf8');
    library = JSON.parse(raw);
  } catch {
    res.status(404).json({ error: 'Library not found' });
    return;
  }

  const track = library.tracks?.find((t) => t.id === req.params.id);
  if (!track || !track.file) {
    res.status(404).json({ error: 'Track not found' });
    return;
  }

  const filePath = path.join(mediaDir, track.file);
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const fileSize = fileStat.size;
  const range = req.headers.range;

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
      return;
    }
    const start = match[1] ? parseInt(match[1], 10) : fileSize - parseInt(match[2], 10);
    const end = match[2] && match[1] ? parseInt(match[2], 10) : fileSize - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0 || end >= fileSize) {
      res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    res.status(206);
    res.set({
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': end - start + 1,
      'Content-Type': contentType,
    });
    createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.status(200);
    res.set({
      'Accept-Ranges': 'bytes',
      'Content-Length': fileSize,
      'Content-Type': contentType,
    });
    createReadStream(filePath).pipe(res);
  }
});

export default router;
