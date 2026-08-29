import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseBuffer, parseFile } from 'music-metadata';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.ogg']);

// Fragmented/DASH MP4s (the kind downloaders often emit, misnamed .mp3 or not)
// play badly in Safari's <audio>: bogus lock-screen duration, slow start,
// flaky seeking. A lossless `-c copy` remux to a plain faststart MP4 fixes all
// three, so when ffmpeg is on PATH every ISO-BMFF file gets remuxed on the way
// into media/ instead of copied. Without ffmpeg the copy still works - the
// player has a duration fallback - so this stays optional.
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

function isIsoBmff(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    fs.closeSync(fd);
    return head.toString('ascii', 4, 8) === 'ftyp';
  } catch {
    return false;
  }
}

function copyIntoMedia(srcPath, destPath, title) {
  if (isIsoBmff(srcPath) && hasFfmpeg()) {
    const result = spawnSync(
      'ffmpeg',
      ['-v', 'error', '-y', '-i', srcPath, '-c', 'copy', '-movflags', '+faststart', destPath],
      { stdio: 'ignore' }
    );
    if (result.status === 0 && fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
      return;
    }
    console.warn(`Warning: ffmpeg remux failed for ${title}; copying the original instead`);
  }
  fs.copyFileSync(srcPath, destPath);
}

function parseArgs(argv) {
  const args = { source: null, music: null, out: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--source') {
      args.source = argv[++i];
    } else if (arg === '--music') {
      args.music = argv[++i];
    } else if (arg === '--out') {
      args.out = argv[++i];
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    }
  }
  return args;
}

function fnv1aHex(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function makeId(artist, title) {
  return fnv1aHex(`${artist.toLowerCase()}|${title.toLowerCase()}`);
}

// --- metadata cleanup -------------------------------------------------------
// Small pure helpers. They run over every title/artist we emit, no matter
// whether the value arrived from an id3 tag, from a playlist source file, or
// from the filename fallback.

// A trailing yt-dlp style video id, e.g. "Metropolis [eKneYiEU5g0]".
// Exactly 11 characters from [A-Za-z0-9_-], in square brackets, at the end.
// Deliberately square-brackets-only: an 11-character round-bracket group is far
// more likely to be a real subtitle than a video id.
const YOUTUBE_ID_SUFFIX = /\s*\[[A-Za-z0-9_-]{11}\]\s*$/;

// Noise phrases that show up inside "(...)" or "[...]" on ripped video titles.
const NOISE_PHRASE = [
  '(?:official\\s+)?(?:music\\s+|lyrics?\\s+)?video',
  'official\\s+audio',
  'audio',
  'lyrics?',
  'visuali[sz]er',
  'full\\s+album',
  'hd',
  'hq',
  '4k',
  'remastered?',
].join('|');

// The whole bracket group must be noise (possibly several noise phrases in a
// row, e.g. "Official Video HD"); anything else is left alone.
const NOISE_GROUP = new RegExp(
  `^(?:${NOISE_PHRASE})(?:\\s*[-–—/|,&]?\\s*(?:${NOISE_PHRASE}))*$`,
  'i',
);

const BRACKET_GROUP = /\(([^()]*)\)|\[([^[\]]*)\]/g;

function isNoiseGroup(inner) {
  const s = String(inner).trim();
  if (!s) return true;
  if (/remaster/i.test(s)) {
    // "(2012 Remaster)" / "(Remastered 2012)" is real release information.
    // A bare "(Remastered)" is not.
    return !/\d{4}/.test(s);
  }
  return NOISE_GROUP.test(s);
}

// Collapse whitespace and drop leftovers the removals exposed: empty bracket
// pairs and dangling hyphens / en dashes / em dashes at either end.
function tidySpacing(s) {
  let out = String(s).replace(/\(\s*\)|\[\s*\]/g, ' ').replace(/\s+/g, ' ').trim();
  let prev;
  do {
    prev = out;
    out = out.replace(/^[\s\-–—]+/, '').replace(/[\s\-–—]+$/, '');
  } while (out !== prev);
  return out;
}

function cleanTitle(s) {
  if (typeof s !== 'string') return s;
  let out = s.replace(BRACKET_GROUP, (match, round, square) =>
    isNoiseGroup(round !== undefined ? round : square) ? ' ' : match,
  );
  out = tidySpacing(out);
  out = tidySpacing(out.replace(YOUTUBE_ID_SUFFIX, ''));
  // Never turn a real title into an empty string.
  return out || s;
}

function cleanArtist(s) {
  if (typeof s !== 'string') return s;
  let out = s
    // YouTube auto-generated channels: "Disuu - Topic" -> "Disuu".
    .replace(/\s*-\s*topic\s*$/i, '')
    // Label channels: "SomebodyVEVO" -> "Somebody".
    .replace(/\s*vevo\s*$/i, '');
  out = tidySpacing(out);
  return out || s;
}

// jpeg -> jpg, png -> png, anything else -> jpg.
function pictureExtension(picture) {
  const format = String((picture && (picture.format || picture.mime)) || '').toLowerCase();
  if (format.includes('png')) return 'png';
  return 'jpg';
}

// --- container sniffing -----------------------------------------------------
// A downloaded file's extension is a claim, not a fact. yt-dlp and friends
// routinely hand back an MPEG-4/AAC stream named ".mp3". music-metadata picks
// its parser from the extension, so a lying name makes it read the file with
// the wrong parser: bogus codec, bogus sample rate, and no duration at all.
// Reading the first few bytes settles what the file actually is.

const ISO_BMFF_BRAND_OFFSET = 4; // "ftyp" sits at byte 4 of an ISO base media file

// Enough bytes for every signature below.
const SNIFF_BYTES = 16;

function readHead(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(SNIFF_BYTES);
    const read = fs.readSync(fd, buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, read);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

// -> { ext, mimeType } for a recognised container, or null when unsure (in
// which case the caller keeps trusting the filename).
function sniffContainer(filePath) {
  const head = readHead(filePath);
  if (head.length < 12) return null;

  const ascii = head.toString('latin1');

  if (ascii.startsWith('fLaC')) return { ext: '.flac', mimeType: 'audio/flac' };
  if (ascii.startsWith('OggS')) return { ext: '.ogg', mimeType: 'audio/ogg' };
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') {
    return { ext: '.wav', mimeType: 'audio/wav' };
  }
  if (ascii.slice(ISO_BMFF_BRAND_OFFSET, ISO_BMFF_BRAND_OFFSET + 4) === 'ftyp') {
    // Audio-only MP4 is what a music library holds; .m4a keeps the served
    // Content-Type honest (audio/mp4) instead of claiming audio/mpeg.
    return { ext: '.m4a', mimeType: 'audio/mp4' };
  }
  // ID3v2 header, or a bare MPEG frame sync.
  if (ascii.startsWith('ID3')) return { ext: '.mp3', mimeType: 'audio/mpeg' };
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    return { ext: '.mp3', mimeType: 'audio/mpeg' };
  }

  return null;
}

function normalize(str) {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedKey(artist, title) {
  return `${normalize(artist)}|${normalize(title)}`;
}

async function scanMusicFolder(dir) {
  const results = [];
  async function walk(current) {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  }
  await walk(dir);
  return results;
}

function deriveFromFilename(filePath) {
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const sepIdx = base.indexOf(' - ');
  if (sepIdx !== -1) {
    return {
      artist: cleanArtist(base.slice(0, sepIdx).trim()),
      title: cleanTitle(base.slice(sepIdx + 3).trim()),
    };
  }
  // No " - " separator: the whole basename is the title, the artist is unknown.
  return { artist: '', title: cleanTitle(base.trim()) };
}

// Parse with the parser the bytes call for, not the one the filename implies.
// parseFile() streams and is the cheap path, so it stays the default; the
// whole-file parseBuffer() is used only when the extension is untrustworthy or
// when the streamed parse could not work out a duration.
async function readMetadata(filePath, sniffed) {
  const pathExt = path.extname(filePath).toLowerCase();
  const extLies = Boolean(sniffed) && sniffed.ext !== pathExt;

  if (!extLies) {
    try {
      const metadata = await parseFile(filePath);
      if (metadata?.format?.duration) return metadata;

      // Duration unknown: a VBR MPEG file with no Xing header only gives it up
      // after every frame has been walked.
      try {
        const scanned = await parseFile(filePath, { duration: true });
        if (scanned?.format?.duration) return scanned;
      } catch {
        /* keep whatever the first pass produced */
      }
      if (metadata) return metadata;
    } catch {
      /* fall through to the mime-hinted parse below */
    }
  }

  if (sniffed) {
    try {
      // parseBuffer takes the container as an explicit hint, which is the only
      // way to override the extension-based guess.
      return await parseBuffer(await fs.promises.readFile(filePath), {
        mimeType: sniffed.mimeType,
      });
    } catch {
      /* unreadable as the sniffed container either */
    }
  }

  return null;
}

async function readScannedFile(filePath) {
  let common = {};
  let format = {};

  const sniffed = sniffContainer(filePath);
  const metadata = await readMetadata(filePath, sniffed);
  if (metadata) {
    common = metadata.common || {};
    format = metadata.format || {};
  }
  // else: unreadable/corrupt tags - fall through to filename-derived metadata

  // Precedence: id3 tag, then filename fallback, then the defaults below.
  let title = cleanTitle(common.title ? String(common.title).trim() : '');
  let artist = cleanArtist(common.artist ? String(common.artist).trim() : '');
  const album = common.album ? String(common.album).trim() : '';

  if (!title || !artist) {
    const fallback = deriveFromFilename(filePath);
    if (!title) title = fallback.title;
    if (!artist) artist = fallback.artist;
  }
  if (!artist) artist = 'Unknown Artist';
  if (!title) title = path.basename(filePath, path.extname(filePath)).trim();

  const durationSec = Math.round(format.duration || 0);

  // Keep the first embedded image only, so a large library does not hold every
  // cover in memory. It is written out later, and only for matched tracks.
  const pictures = Array.isArray(common.picture) ? common.picture : [];
  const first = pictures[0];
  const picture = first && first.data && first.data.length > 0 ? first : null;

  return {
    filePath,
    // The extension the copy in media/ gets, and therefore the Content-Type
    // /audio/:id serves. Follow the bytes, not the original filename.
    ext: (sniffed && sniffed.ext) || path.extname(filePath).toLowerCase(),
    title,
    artist,
    album,
    durationSec,
    picture,
  };
}

function findMatch(sourceArtist, sourceTitle, scannedFiles) {
  const sourceKey = normalizedKey(sourceArtist, sourceTitle);
  for (const file of scannedFiles) {
    if (normalizedKey(file.artist, file.title) === sourceKey) {
      return file;
    }
  }
  const sourceNorm = normalize(`${sourceArtist} ${sourceTitle}`);
  for (const file of scannedFiles) {
    const fileNorm = normalize(`${file.artist} ${file.title}`);
    if (sourceNorm.includes(fileNorm) || fileNorm.includes(sourceNorm)) {
      return file;
    }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.source) {
    console.error('Error: --source <path to playlists.source.json> is required.');
    process.exit(1);
  }
  if (!args.music) {
    console.error('Error: --music <path to music folder> is required.');
    process.exit(1);
  }

  const sourcePath = path.resolve(args.source);
  const musicPath = path.resolve(args.music);
  const outPath = args.out
    ? path.resolve(args.out)
    : path.join(PROJECT_ROOT, 'public-data', 'library.json');

  if (!fs.existsSync(sourcePath)) {
    console.error(`Error: source file not found: ${sourcePath}`);
    process.exit(1);
  }
  if (!fs.existsSync(musicPath) || !fs.statSync(musicPath).isDirectory()) {
    console.error(`Error: music folder not found: ${musicPath}`);
    process.exit(1);
  }

  let sourceData;
  try {
    sourceData = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  } catch (err) {
    console.error(`Error: failed to parse source file: ${err.message}`);
    process.exit(1);
  }

  const sourcePlaylists = Array.isArray(sourceData.playlists) ? sourceData.playlists : [];

  const scannedPaths = await scanMusicFolder(musicPath);
  const scannedFiles = await Promise.all(scannedPaths.map(readScannedFile));

  const tracksById = new Map();
  const outputPlaylists = [];
  let matchedCount = 0;
  let totalCount = 0;
  const unmatched = [];
  const seenUnmatchedIds = new Set();

  for (const playlist of sourcePlaylists) {
    const trackIds = [];
    const playlistTracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
    for (const sourceTrack of playlistTracks) {
      totalCount++;
      const artist = cleanArtist(String(sourceTrack.artist || '').trim());
      const title = cleanTitle(String(sourceTrack.title || '').trim());
      const album = String(sourceTrack.album || '').trim();
      const id = makeId(artist, title);

      let trackEntry = tracksById.get(id);
      if (!trackEntry) {
        const match = findMatch(artist, title, scannedFiles);
        if (match) {
          trackEntry = {
            id,
            title,
            artist,
            album,
            durationSec: match.durationSec,
            file: `${id}${match.ext}`,
            // Filled in below when the embedded image is written out.
            cover: null,
            matched: true,
            _sourceFilePath: match.filePath,
            _picture: match.picture,
          };
        } else {
          trackEntry = {
            id,
            title,
            artist,
            album,
            durationSec: 0,
            file: null,
            cover: null,
            matched: false,
          };
        }
        tracksById.set(id, trackEntry);
      }

      // Count every playlist occurrence, not just first-seen ids, so the
      // summary ratio reflects all listed tracks rather than unique ones.
      if (trackEntry.matched) {
        matchedCount++;
      } else {
        if (!seenUnmatchedIds.has(id)) {
          seenUnmatchedIds.add(id);
          unmatched.push({ title, artist });
        }
      }
      trackIds.push(id);
    }
    outputPlaylists.push({ name: playlist.name, trackIds });
  }

  console.log(`Matched ${matchedCount}/${totalCount} tracks across ${outputPlaylists.length} playlists`);

  let withPicture = 0;
  for (const track of tracksById.values()) {
    if (track._picture) withPicture++;
  }
  console.log(`Embedded cover art found on ${withPicture} of ${tracksById.size} unique tracks`);

  if (unmatched.length > 0) {
    console.log('Unmatched tracks:');
    for (const { title, artist } of unmatched.slice(0, 20)) {
      console.log(`  - ${title} (${artist})`);
    }
  }

  if (args.dryRun) {
    return;
  }

  const mediaDir = path.join(PROJECT_ROOT, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  const coversDir = path.join(mediaDir, 'covers');
  let coversDirReady = false;

  const outputTracks = [];
  for (const track of tracksById.values()) {
    if (track.matched) {
      const destPath = path.join(mediaDir, track.file);
      copyIntoMedia(track._sourceFilePath, destPath, track.title);

      if (track._picture) {
        const coverName = `${track.id}.${pictureExtension(track._picture)}`;
        try {
          if (!coversDirReady) {
            fs.mkdirSync(coversDir, { recursive: true });
            coversDirReady = true;
          }
          fs.writeFileSync(path.join(coversDir, coverName), Buffer.from(track._picture.data));
          track.cover = coverName;
        } catch (err) {
          // A bad image should not abort the whole ingest; the track keeps cover: null.
          console.warn(`Warning: could not write cover for ${track.title}: ${err.message}`);
        }
      }
    }
    const { _sourceFilePath, _picture, ...cleanTrack } = track;
    outputTracks.push(cleanTrack);
  }

  const library = { tracks: outputTracks, playlists: outputPlaylists };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(library, null, 2), 'utf8');
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
