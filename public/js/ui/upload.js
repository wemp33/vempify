// The "add song" dialog: pick an audio file, confirm title/artist, upload.
//
// Mounted into #modal-root (a SIBLING of .app-shell) and built from the same
// .modal-backdrop / .modal-card parts as playlist-picker.js and the
// new-playlist modal, so it dismisses the same way: a press on the dim area,
// Escape, or the close button, with .app-shell.is-blurred softening
// everything behind. Both of those - the dismissal and the exit animation -
// come from ui/modal.js so all four panels behave identically.
//
// The transfer runs on XMLHttpRequest rather than fetch: only XHR reports
// upload progress, and a 5-10MB file over a phone connection needs a real
// percentage rather than a spinner that might mean anything.

import { getLang } from '../i18n.js';
import { bindDismiss, dismissModal } from './modal.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// The server mounts express.raw with an 80mb limit. Checking here too turns
// what would come back as an opaque 413 (body-parser's own error page, not
// our JSON) into a message the user can act on before waiting out the upload.
const MAX_BYTES = 80 * 1024 * 1024;

// Messages the shared i18n key set does not carry - the same local-dictionary
// pattern queue.js uses for its move labels.
const LOCAL_MESSAGES = {
  no_file: { en: 'Choose a file first', pl: 'Najpierw wybierz plik' },
  no_meta: { en: 'Fill in the title and the artist', pl: 'Uzupełnij tytuł i wykonawcę' },
  too_big: { en: 'That file is larger than 80 MB', pl: 'Ten plik jest większy niż 80 MB' },
  no_file_chosen: { en: 'No file chosen', pl: 'Nie wybrano pliku' }
};

function local(key) {
  const entry = LOCAL_MESSAGES[key];
  if (!entry) return '';
  return entry[getLang()] ?? entry.en;
}

// ---------------------------------------------------------------------------
// Filename -> { artist, title }
//
// A port of the cleaning helpers in tools/ingest.mjs. Both paths must agree:
// a song added through this dialog should end up with the same title and
// artist - and therefore the same id - as the same file put through the CLI
// ingest. Keep the two in step.

// A trailing yt-dlp style video id, e.g. "Metropolis [eKneYiEU5g0]".
// Square brackets only: an 11-character round-bracket group is far more
// likely to be a real subtitle than a video id.
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
  'remastered?'
].join('|');

// The whole bracket group must be noise (possibly several noise phrases in a
// row, e.g. "Official Video HD"); anything else is left alone.
const NOISE_GROUP = new RegExp(
  `^(?:${NOISE_PHRASE})(?:\\s*[-–—/|,&]?\\s*(?:${NOISE_PHRASE}))*$`,
  'i'
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
    isNoiseGroup(round !== undefined ? round : square) ? ' ' : match
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

// "Slowdive - When the Sun Hits (Official Video) [dQw4w9WgXcQ].m4a"
//   -> { artist: 'Slowdive', title: 'When the Sun Hits' }
// The video-id suffix is stripped before the split so a bracketed id never
// ends up glued to the title, and a name with no " - " keeps the whole
// basename as the title with the artist left for the user to type.
export function splitFilename(filename) {
  const name = String(filename || '');
  const dot = name.lastIndexOf('.');
  const base = (dot > 0 ? name.slice(0, dot) : name).trim();
  const withoutId = tidySpacing(base.replace(YOUTUBE_ID_SUFFIX, ''));

  const sepIdx = withoutId.indexOf(' - ');
  if (sepIdx !== -1) {
    return {
      artist: cleanArtist(withoutId.slice(0, sepIdx).trim()),
      title: cleanTitle(withoutId.slice(sepIdx + 3).trim())
    };
  }
  return { artist: '', title: cleanTitle(withoutId) };
}

// ---------------------------------------------------------------------------
// Icons

function svgBase(className, size) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (className) svg.setAttribute('class', className);
  return svg;
}

function closeIcon() {
  const svg = svgBase('modal-close__icon', 18);
  for (const points of ['6,6 18,18', '18,6 6,18']) {
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', points);
    svg.appendChild(line);
  }
  return svg;
}

// A note over a small tray: "pick an audio file off the device".
function fileIcon() {
  const svg = svgBase('upload-file__icon', 18);

  const tray = document.createElementNS(SVG_NS, 'polyline');
  tray.setAttribute('points', '3,15 3,20 21,20 21,15');
  svg.appendChild(tray);

  const stem = document.createElementNS(SVG_NS, 'path');
  stem.setAttribute('d', 'M11 15V5l8-1.6V13');
  svg.appendChild(stem);

  for (const [cx, cy] of [
    [9, 15],
    [17, 13]
  ]) {
    const head = document.createElementNS(SVG_NS, 'ellipse');
    head.setAttribute('cx', String(cx));
    head.setAttribute('cy', String(cy));
    head.setAttribute('rx', '2');
    head.setAttribute('ry', '1.7');
    svg.appendChild(head);
  }

  return svg;
}

// ---------------------------------------------------------------------------

let dialogSeq = 0;

export function openUploadDialog({ mount, t, onUploaded }) {
  const uid = `upload-${++dialogSeq}`;
  const shell = document.querySelector('.app-shell');

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const card = document.createElement('div');
  card.className = 'modal-card upload-dialog';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', `${uid}-title`);

  // --- header --------------------------------------------------------------

  const header = document.createElement('div');
  header.className = 'modal-header';

  const headings = document.createElement('div');
  headings.className = 'modal-headings';

  const heading = document.createElement('div');
  heading.className = 'modal-title';
  heading.id = `${uid}-title`;
  heading.textContent = t('add_song');
  headings.appendChild(heading);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'modal-close pressable';
  closeBtn.setAttribute('aria-label', t('close'));
  closeBtn.appendChild(closeIcon());

  header.appendChild(headings);
  header.appendChild(closeBtn);
  card.appendChild(header);

  // --- file picker ---------------------------------------------------------
  // The native control is parked off-screen instead of display:none - a
  // hidden input is skipped by some engines when .click() is called on it -
  // and the visible button carries the label and the press feedback.

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'audio/*';
  fileInput.className = 'upload-file__input';
  fileInput.tabIndex = -1;
  fileInput.setAttribute('aria-hidden', 'true');

  const fileBtn = document.createElement('button');
  fileBtn.type = 'button';
  fileBtn.className = 'upload-file pressable';
  fileBtn.appendChild(fileIcon());
  const fileBtnLabel = document.createElement('span');
  fileBtnLabel.textContent = t('choose_file');
  fileBtn.appendChild(fileBtnLabel);

  const fileName = document.createElement('div');
  fileName.className = 'upload-filename is-empty';
  fileName.textContent = local('no_file_chosen');

  card.appendChild(fileInput);
  card.appendChild(fileBtn);
  card.appendChild(fileName);

  // --- metadata fields -----------------------------------------------------

  function makeField(id, labelText, autocapitalize) {
    const label = document.createElement('label');
    label.className = 'upload-label';
    label.htmlFor = id;
    label.textContent = labelText;

    const input = document.createElement('input');
    input.type = 'text';
    input.id = id;
    input.className = 'modal-input';
    input.placeholder = labelText;
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', autocapitalize);
    input.setAttribute('enterkeyhint', 'done');
    input.maxLength = 120;

    card.appendChild(label);
    card.appendChild(input);
    return input;
  }

  const titleInput = makeField(`${uid}-title-input`, t('song_title'), 'sentences');
  const artistInput = makeField(`${uid}-artist-input`, t('song_artist'), 'words');

  // --- progress ------------------------------------------------------------

  const progress = document.createElement('div');
  progress.className = 'upload-progress';
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  progress.setAttribute('aria-valuenow', '0');
  progress.hidden = true;

  const progressBar = document.createElement('div');
  progressBar.className = 'upload-progress__bar';
  progress.appendChild(progressBar);

  const status = document.createElement('div');
  status.className = 'upload-status';
  status.hidden = true;

  card.appendChild(progress);
  card.appendChild(status);

  // --- error + actions -----------------------------------------------------

  const error = document.createElement('div');
  error.className = 'modal-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'modal-btn pressable';
  cancelBtn.textContent = t('cancel');

  const uploadBtn = document.createElement('button');
  uploadBtn.type = 'button';
  uploadBtn.className = 'modal-btn modal-btn--primary pressable';
  uploadBtn.textContent = t('upload');

  actions.appendChild(cancelBtn);
  actions.appendChild(uploadBtn);

  card.appendChild(error);
  card.appendChild(actions);
  backdrop.appendChild(card);

  // --- behaviour -----------------------------------------------------------

  let request = null; // the in-flight XHR, or null

  function close() {
    // Dismissing mid-transfer aborts it rather than leaving the browser
    // pushing bytes at a dialog that no longer exists.
    if (request) {
      const inFlight = request;
      request = null;
      inFlight.abort();
    }
    if (shell) shell.classList.remove('is-blurred');
    dismissModal(backdrop);
  }

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
    // On a short screen the card scrolls; a refusal the user cannot see reads
    // as the button doing nothing at all.
    error.scrollIntoView({ block: 'nearest' });
  }

  function clearError() {
    error.hidden = true;
    error.textContent = '';
  }

  function setProgress(fraction) {
    const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    progressBar.style.width = `${pct}%`;
    progress.setAttribute('aria-valuenow', String(pct));
    status.textContent = `${t('uploading')} ${pct}%`;
  }

  function setBusy(busy) {
    uploadBtn.disabled = busy;
    cancelBtn.disabled = busy;
    fileBtn.disabled = busy;
    titleInput.disabled = busy;
    artistInput.disabled = busy;
    uploadBtn.textContent = busy ? t('uploading') : t('upload');
    progress.hidden = !busy;
    status.hidden = !busy;
    card.classList.toggle('is-uploading', busy);
  }

  // A press that both starts and ends on the dim area dismisses, and so does
  // Escape. A press that starts inside the card does not, however far the
  // finger travels before it lifts - dragging out of a half-filled form and
  // losing it was the old handler's other failure.
  bindDismiss(backdrop, close);
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);

  fileBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    clearError();
    if (!file) {
      fileName.textContent = local('no_file_chosen');
      fileName.classList.add('is-empty');
      return;
    }
    fileName.textContent = file.name;
    fileName.classList.remove('is-empty');

    // Prefill only what the user has not already written; the derived values
    // are a starting point, never an overwrite.
    const derived = splitFilename(file.name);
    if (titleInput.value.trim() === '' && derived.title) titleInput.value = derived.title;
    if (artistInput.value.trim() === '' && derived.artist) artistInput.value = derived.artist;
  });

  for (const input of [titleInput, artistInput]) {
    input.addEventListener('input', clearError);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
  }

  function messageFor(xhr) {
    // 409 and 415 are the two failures the user can actually do something
    // about, so they get their own translated wording rather than whatever
    // the server phrased it as.
    if (xhr.status === 409) return t('upload_duplicate');
    if (xhr.status === 415) return t('upload_bad_format');

    let serverMessage = '';
    try {
      const parsed = JSON.parse(xhr.responseText);
      if (parsed && typeof parsed.message === 'string') serverMessage = parsed.message;
      else if (parsed && typeof parsed.error === 'string') serverMessage = parsed.error;
    } catch {
      /* not JSON - fall back to the generic wording */
    }
    return serverMessage || t('upload_failed');
  }

  function submit() {
    if (request) return;

    const file = fileInput.files && fileInput.files[0];
    const title = titleInput.value.trim();
    const artist = artistInput.value.trim();

    if (!file) {
      showError(local('no_file'));
      return;
    }
    if (file.size > MAX_BYTES) {
      showError(local('too_big'));
      return;
    }
    if (!title || !artist) {
      showError(local('no_meta'));
      (title ? artistInput : titleInput).focus();
      return;
    }

    clearError();
    setBusy(true);
    setProgress(0);

    const url = `/api/tracks?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`;
    const xhr = new XMLHttpRequest();
    request = xhr;

    xhr.open('POST', url, true);
    // The server sniffs the container from the bytes, so this header only has
    // to be present: express.raw's type matcher ignores a request that
    // carries no Content-Type at all, and a File with no type sets none.
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) setProgress(event.loaded / event.total);
    });
    // Bytes are all sent; the server is now remuxing and writing. Hold the
    // bar full rather than letting it read as finished.
    xhr.upload.addEventListener('load', () => setProgress(1));

    xhr.addEventListener('load', () => {
      if (request !== xhr) return; // aborted and already torn down
      request = null;

      if (xhr.status === 201 || xhr.status === 200) {
        let track = null;
        try {
          track = JSON.parse(xhr.responseText);
        } catch {
          /* the upload landed even if the body did not parse */
        }
        close();
        if (typeof onUploaded === 'function') onUploaded(track);
        return;
      }

      // Leave the dialog open with the file and fields intact so the user can
      // correct a name and retry without picking the file again.
      setBusy(false);
      showError(messageFor(xhr));
    });

    xhr.addEventListener('error', () => {
      if (request !== xhr) return;
      request = null;
      setBusy(false);
      showError(t('upload_failed'));
    });

    xhr.addEventListener('abort', () => {
      if (request !== xhr) return;
      request = null;
      setBusy(false);
    });

    xhr.send(file);
  }

  uploadBtn.addEventListener('click', submit);

  mount.appendChild(backdrop);
  if (shell) shell.classList.add('is-blurred');

  return close;
}
