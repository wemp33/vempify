// Where Vempify keeps everything that can change at runtime.
//
// Railway's container filesystem is ephemeral: anything written next to the
// code is destroyed on the next deploy, restart or crash. An upload endpoint
// writing into the repo's media/ would look like it worked and then silently
// lose the song. So every mutable byte - library.json, audio, cover art - lives
// under one data directory that is a mounted volume in production.
//
// This module is the single place that knows where that directory is. Nothing
// else should join paths against projectRoot/media or projectRoot/public-data.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

// The Railway volume's mount point. Present only in the deployed container.
const VOLUME_DIR = '/data';

// What the repo still ships, and what seedFromBundleIfEmpty() copies onto a
// brand-new volume exactly once.
const BUNDLED_LIBRARY = path.join(projectRoot, 'public-data', 'library.json');
const BUNDLED_MEDIA = path.join(projectRoot, 'media');

function isWritableDir(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Resolved once, at import, so every module that imports this agrees on the
// answer for the lifetime of the process.
function resolveDataDir() {
  const fromEnv = process.env.VEMPIFY_DATA_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return path.resolve(fromEnv.trim());
  }
  // Railway: the volume is mounted before the process starts.
  if (isWritableDir(VOLUME_DIR)) return VOLUME_DIR;
  // Local development: a gitignored directory beside the code.
  return path.join(projectRoot, '.localdata');
}

export const DATA_DIR = resolveDataDir();
export const libraryPath = path.join(DATA_DIR, 'library.json');
// Playlists live in their OWN file, deliberately not inside library.json:
// uploading a song and editing a playlist are separate read-modify-write
// cycles, and sharing one file would let either one clobber the other.
export const playlistsPath = path.join(DATA_DIR, 'playlists.json');
export const mediaDir = path.join(DATA_DIR, 'media');
export const coversDir = path.join(mediaDir, 'covers');

const EMPTY_LIBRARY = { tracks: [], playlists: [] };

// --- directories ------------------------------------------------------------

// Idempotent; called once at boot before anything reads or writes.
export function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(coversDir, { recursive: true });
  return DATA_DIR;
}

// --- library read / write ---------------------------------------------------

export async function readLibrary() {
  try {
    const raw = await fsp.readFile(libraryPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      tracks: Array.isArray(parsed?.tracks) ? parsed.tracks : [],
      playlists: Array.isArray(parsed?.playlists) ? parsed.playlists : [],
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { ...EMPTY_LIBRARY };
    throw err;
  }
}

// A half-written library.json bricks the app on the next boot, and Node gives
// no guarantee that a large writeFile lands in one piece. Writing to a temp
// file in the SAME directory and renaming over the target does: rename is
// atomic within a filesystem, so a reader sees either the old file or the new
// one. The "same directory" part is load-bearing - a temp file in os.tmpdir()
// would sit on a different filesystem, where rename degrades to copy+unlink.
//
// Shared by every JSON file on the volume, so playlists.json gets exactly the
// same durability guarantee as library.json without a second copy of this.
async function writeJsonAtomic(targetPath, value, tmpPrefix) {
  const payload = JSON.stringify(value, null, 2);
  const tmpPath = path.join(
    path.dirname(targetPath),
    `.${tmpPrefix}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );

  let handle;
  try {
    handle = await fsp.open(tmpPath, 'w');
    await handle.writeFile(payload, 'utf8');
    // Flush before the rename, or a crash right after can leave the renamed
    // file with the right name and no contents.
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.rename(tmpPath, targetPath);
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* already closed */
      }
    }
    try {
      await fsp.unlink(tmpPath);
    } catch {
      /* nothing to clean up */
    }
    throw err;
  }
}

export async function writeLibraryAtomic(library) {
  await writeJsonAtomic(
    libraryPath,
    {
      tracks: Array.isArray(library?.tracks) ? library.tracks : [],
      playlists: Array.isArray(library?.playlists) ? library.playlists : [],
    },
    'library'
  );
}

// --- playlists read / write -------------------------------------------------

// One playlist as it is allowed to exist on disk. Anything hand-edited into a
// shape we cannot use is normalised here rather than defended against at every
// call site; a row without a usable name is dropped outright.
function normalisePlaylist(entry) {
  const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
  if (!name) return null;
  const trackIds = Array.isArray(entry?.trackIds)
    ? entry.trackIds.filter((id) => typeof id === 'string' && id)
    : [];
  const createdAt = Number.isFinite(entry?.createdAt) ? entry.createdAt : 0;
  return { name, trackIds, createdAt };
}

// Missing file is the normal state of a fresh volume, not an error: an empty
// list is exactly right for "this user has never made a playlist".
export async function readPlaylists() {
  try {
    const raw = await fsp.readFile(playlistsPath, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.playlists) ? parsed.playlists : [];
    return { playlists: list.map(normalisePlaylist).filter(Boolean) };
  } catch (err) {
    if (err.code === 'ENOENT') return { playlists: [] };
    throw err;
  }
}

export async function writePlaylistsAtomic(data) {
  const list = Array.isArray(data?.playlists) ? data.playlists : [];
  await writeJsonAtomic(
    playlistsPath,
    { playlists: list.map(normalisePlaylist).filter(Boolean) },
    'playlists'
  );
}

// --- one-time seed ----------------------------------------------------------

function copyFileIfMissing(src, dest) {
  try {
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

function copyMediaTree(srcDir, destDir) {
  let copied = 0;
  let entries;
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copied += copyMediaTree(src, dest);
    } else if (entry.isFile() && entry.name !== '.gitkeep') {
      if (copyFileIfMissing(src, dest)) copied++;
    }
  }
  return copied;
}

// Carries the repo's bundled library and audio onto a fresh volume, once.
// Safe to run on every boot: the moment the volume holds a library.json this
// is a no-op, so a user's uploads can never be overwritten by whatever the
// image happens to ship.
export function seedFromBundleIfEmpty() {
  if (fs.existsSync(libraryPath)) {
    return false;
  }
  if (!fs.existsSync(BUNDLED_LIBRARY)) {
    console.log(`[vempify] no library at ${libraryPath} and no bundled library to seed from - starting empty`);
    return false;
  }

  ensureStorage();

  let copiedMedia = 0;
  // Guard against a data dir configured to be the project root itself, where
  // source and destination would be the same directory.
  if (path.resolve(BUNDLED_MEDIA) !== path.resolve(mediaDir)) {
    copiedMedia = copyMediaTree(BUNDLED_MEDIA, mediaDir);
  }

  // The library lands last: it is the flag that says "this volume is seeded",
  // so it must not exist until the audio it points at is already in place.
  fs.copyFileSync(BUNDLED_LIBRARY, libraryPath);

  let trackCount = 0;
  try {
    trackCount = JSON.parse(fs.readFileSync(libraryPath, 'utf8')).tracks?.length ?? 0;
  } catch {
    /* the count is only for the log line */
  }

  console.log(
    `[vempify] seeded ${DATA_DIR} from the bundled repo data: ${trackCount} track(s) in library.json, ${copiedMedia} media file(s) copied`
  );
  return true;
}

// --- ids --------------------------------------------------------------------

// The exact hash tools/ingest.mjs uses. Both ingestion paths - the CLI and the
// upload endpoint - must derive the same id from the same artist/title, or the
// same song ingested twice would land twice under different ids.
function fnv1aHex(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function fnv1aId(artist, title) {
  return fnv1aHex(`${String(artist).toLowerCase()}|${String(title).toLowerCase()}`);
}

// --- container sniffing -----------------------------------------------------

// An uploaded file's name and Content-Type are claims, not facts. yt-dlp and
// friends routinely hand back an MPEG-4/AAC stream named ".mp3", and
// music-metadata picks its parser from the hint it is given - so a lying name
// makes it read the file with the wrong parser: bogus codec, no duration.
// The first bytes settle what the file actually is. Same signature table as
// tools/ingest.mjs.

const ISO_BMFF_BRAND_OFFSET = 4; // "ftyp" sits at byte 4 of an ISO base media file

// -> { ext, mime } for a recognised container, or null when the bytes are not
// audio we can serve.
export function sniffContainer(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const head = Buffer.isBuffer(buffer) ? buffer.subarray(0, 16) : Buffer.from(buffer).subarray(0, 16);
  const ascii = head.toString('latin1');

  if (ascii.startsWith('fLaC')) return { ext: '.flac', mime: 'audio/flac' };
  if (ascii.startsWith('OggS')) return { ext: '.ogg', mime: 'audio/ogg' };
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') {
    return { ext: '.wav', mime: 'audio/wav' };
  }
  if (ascii.slice(ISO_BMFF_BRAND_OFFSET, ISO_BMFF_BRAND_OFFSET + 4) === 'ftyp') {
    // Audio-only MP4 is what a music library holds; .m4a keeps the served
    // Content-Type honest (audio/mp4) instead of claiming audio/mpeg.
    return { ext: '.m4a', mime: 'audio/mp4' };
  }
  // ID3v2 header, or a bare MPEG frame sync.
  if (ascii.startsWith('ID3')) return { ext: '.mp3', mime: 'audio/mpeg' };
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    return { ext: '.mp3', mime: 'audio/mpeg' };
  }

  return null;
}

// jpeg -> jpg, png -> png, anything else -> jpg. Mirrors tools/ingest.mjs.
export function pictureExtension(picture) {
  const format = String((picture && (picture.format || picture.mime)) || '').toLowerCase();
  if (format.includes('png')) return 'png';
  return 'jpg';
}

export default {
  DATA_DIR,
  libraryPath,
  playlistsPath,
  mediaDir,
  coversDir,
  ensureStorage,
  readLibrary,
  writeLibraryAtomic,
  readPlaylists,
  writePlaylistsAtomic,
  seedFromBundleIfEmpty,
  fnv1aId,
  sniffContainer,
  pictureExtension,
};
