import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const libraryPath = path.join(__dirname, '..', 'public-data', 'library.json');

const router = Router();

router.get('/library', async (req, res) => {
  try {
    const raw = await readFile(libraryPath, 'utf8');
    res.json(JSON.parse(raw));
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(200).json({ tracks: [], playlists: [] });
    } else {
      res.status(500).json({ error: 'Failed to read library' });
    }
  }
});

export default router;
