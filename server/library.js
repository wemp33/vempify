import { Router } from 'express';
import { readLibrary } from './storage.js';

const router = Router();

router.get('/library', async (req, res) => {
  try {
    // readLibrary() answers an empty library for a data directory that has
    // none yet, so a first boot on a fresh volume serves 200, not 500.
    res.json(await readLibrary());
  } catch {
    res.status(500).json({ error: 'Failed to read library' });
  }
});

export default router;
