// Everything you can do to one song, in one panel.
//
// This started life as playlist-picker.js - a modal listing the user's
// playlists with a membership toggle per row - and it still opens the same
// way, on a left swipe of a track row. It is no longer only a picker: the same
// card now also edits the song's title and artist and deletes it, because a
// second gesture and a second panel for "the other things you can do to this
// song" would be two ways to say one thing.
//
// Mounted into #modal-root, which lives OUTSIDE .app-shell so the "is-blurred"
// class on the shell never blurs the modal itself.
//
// Opening and closing are shared: the enter animation comes from app.css
// (any .modal-backdrop > .modal-card rises on insert), and the outside-tap
// dismissal plus the exit animation come from ui/modal.js - see the long
// comment there for why a plain click listener on the dim area was dead on
// iOS and what replaced it.
//
// Three views, one card. The header stays put and the BODY is swapped:
//
//   default -> playlist rows, then "Edit details" and "Delete song"
//   edit    -> two fields and Cancel/Save, in place of the whole body
//   confirm -> the foot only, swapped for "Delete this song?" + Cancel/Delete
//
// Nothing here stacks a second modal on top of the first. A dialog opening
// over a dialog on a phone leaves the user two dim layers deep with two ways
// out, and main.js opens nothing at all while #modal-root has a child.

import { bindDismiss, dismissModal } from './modal.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Ids have to be unique per open panel: a label's htmlFor and the card's
// aria-labelledby both point at nodes by id, and a panel dismissed mid-
// animation is briefly still in the document while the next one arrives.
let panelSeq = 0;

// ---------------------------------------------------------------------------
// Icons - hand-drawn, like every other glyph in the app.

function svgBase(className) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (className) svg.setAttribute('class', className);
  return svg;
}

// Stroked outline in currentColor, so a glyph takes the colour of the control
// it is dropped into - which is how the bin turns --accent-2 on the delete row
// without a rule of its own.
function strokeIcon(size, className) {
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
  const svg = svgBase('modal-close__icon');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  for (const points of ['6,6 18,18', '18,6 6,18']) {
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', points);
    line.style.fill = 'none';
    line.style.stroke = 'currentColor';
    line.style.strokeWidth = '2';
    line.style.strokeLinecap = 'round';
    svg.appendChild(line);
  }
  return svg;
}

// Filled state: check icon inside an accent circle. Empty state: hollow circle.
function checkCircle(checked) {
  const svg = svgBase(checked ? 'playlist-check is-checked' : 'playlist-check');

  const circle = document.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '10');
  if (checked) {
    circle.style.fill = 'var(--accent)';
    circle.style.stroke = 'none';
  } else {
    circle.style.fill = 'none';
    circle.style.stroke = 'var(--muted)';
    circle.style.strokeWidth = '2';
  }
  svg.appendChild(circle);

  if (checked) {
    const tick = document.createElementNS(SVG_NS, 'polyline');
    tick.setAttribute('points', '7.5,12.5 10.5,15.5 16.5,9');
    tick.style.fill = 'none';
    // The one colour that is guaranteed to read on the accent fill, whatever
    // the accent is set to.
    tick.style.stroke = 'var(--on-accent)';
    tick.style.strokeWidth = '2.5';
    tick.style.strokeLinecap = 'round';
    tick.style.strokeLinejoin = 'round';
    svg.appendChild(tick);
  }

  return svg;
}

// A pencil over a line - the same nib the playlist rename menu draws, because
// both mean "change the name of the thing you are looking at".
function pencilIcon() {
  const svg = strokeIcon(18, 'song-action__icon');
  const nib = document.createElementNS(SVG_NS, 'path');
  nib.setAttribute('d', 'M16.4 3.6a2 2 0 0 1 2.8 2.8L9.4 16.2 5.5 17.5l1.3-3.9z');
  svg.appendChild(nib);
  const rule = document.createElementNS(SVG_NS, 'line');
  rule.setAttribute('x1', '5');
  rule.setAttribute('y1', '20.5');
  rule.setAttribute('x2', '19');
  rule.setAttribute('y2', '20.5');
  svg.appendChild(rule);
  return svg;
}

// A bin: lid, body, two staves.
function trashIcon() {
  const svg = strokeIcon(18, 'song-action__icon');
  const lid = document.createElementNS(SVG_NS, 'path');
  lid.setAttribute('d', 'M4 6.5h16M9.5 6.5V4.5h5v2');
  svg.appendChild(lid);
  const body = document.createElementNS(SVG_NS, 'path');
  body.setAttribute('d', 'M6.5 6.5 7.5 20h9l1-13.5');
  svg.appendChild(body);
  for (const x of [10.5, 13.5]) {
    const stave = document.createElementNS(SVG_NS, 'line');
    stave.setAttribute('x1', String(x));
    stave.setAttribute('y1', '10');
    stave.setAttribute('x2', String(x));
    stave.setAttribute('y2', '16.5');
    svg.appendChild(stave);
  }
  return svg;
}

// ---------------------------------------------------------------------------
// Small builders

function actionsRow(cancelText, confirmText, { destructive = false } = {}) {
  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'modal-btn pressable';
  cancelBtn.textContent = cancelText;

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'modal-btn modal-btn--primary pressable';
  confirmBtn.textContent = confirmText;
  if (destructive) confirmBtn.classList.add('modal-btn--destructive');

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
  return { actions, cancelBtn, confirmBtn };
}

function errorLine() {
  const error = document.createElement('div');
  error.className = 'modal-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  return error;
}

// What to put in front of the user when a save or a delete comes back
// refused.
//
// A rejection carrying a numeric .status came from the server, and the server
// is the only party that knows WHY - "Title cannot be empty", "Track not
// found" - so its own line is the useful one. A rejection with no status is
// the network dropping out, and "Failed to fetch" / "Load failed" /
// "NetworkError when attempting to fetch resource" tells the user nothing;
// that case gets the plain sentence instead.
function failureText(err, fallbackKey, t) {
  const message = err && typeof err.message === 'string' ? err.message.trim() : '';
  if (err && typeof err.status === 'number' && message) return message;
  return t(fallbackKey);
}

// ---------------------------------------------------------------------------

export function openSongPanel({
  mount,
  track,
  playlists,
  isMember,
  onToggle,
  onSave,
  onDelete,
  t
}) {
  const uid = `song-panel-${++panelSeq}`;
  const shell = document.querySelector('.app-shell');

  // The panel's own copy of the two editable fields. Updated after a save so
  // that if the edit view is opened again in the same session it starts from
  // what was actually stored, not from the values the panel opened with.
  let details = {
    title: track && track.title ? track.title : '',
    artist: track && track.artist ? track.artist : ''
  };

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const card = document.createElement('div');
  card.className = 'modal-card song-panel';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', `${uid}-title`);

  function close() {
    // Unblur with the panel, not after it: the two motions have to read as one
    // gesture, so the shell sharpens while the card is still on its way out.
    if (shell) shell.classList.remove('is-blurred');
    dismissModal(backdrop);
  }

  bindDismiss(backdrop, close);

  // --- header (shared by every view) ----------------------------------------

  const header = document.createElement('div');
  header.className = 'modal-header';

  const headings = document.createElement('div');
  headings.className = 'modal-headings';

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.id = `${uid}-title`;

  const subtitle = document.createElement('div');
  subtitle.className = 'modal-subtitle';
  subtitle.textContent = details.title;

  headings.appendChild(title);
  headings.appendChild(subtitle);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'modal-close pressable';
  closeBtn.setAttribute('aria-label', t('close'));
  closeBtn.style.minWidth = '44px';
  closeBtn.style.minHeight = '44px';
  closeBtn.appendChild(closeIcon());
  closeBtn.addEventListener('click', close);

  header.appendChild(headings);
  header.appendChild(closeBtn);
  card.appendChild(header);

  // The swappable half. A plain wrapper with no class of its own - it exists
  // so a view change is one emptying and one refill, never a rebuild of the
  // card (which would restart the rise animation) or a second modal.
  const body = document.createElement('div');
  card.appendChild(body);

  // -------------------------------------------------------------------------
  // Default view: playlist membership, then the two song actions.

  function renderPlaylists() {
    if (!playlists || playlists.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'modal-hint';
      hint.textContent = t('add_playlist');
      body.appendChild(hint);
      return;
    }

    const list = document.createElement('ul');
    list.className = 'picker-list';

    for (const playlist of playlists) {
      const item = document.createElement('li');
      item.className = 'picker-item';

      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'picker-row pressable';
      row.style.minHeight = '44px';

      const name = document.createElement('span');
      name.className = 'picker-row__name';
      name.textContent = playlist.name;

      let check = checkCircle(Boolean(isMember(playlist.name)));
      row.appendChild(name);
      row.appendChild(check);

      let busy = false;
      row.addEventListener('click', () => {
        if (busy) return;
        busy = true;
        Promise.resolve(onToggle(playlist.name))
          .then((nowMember) => {
            // The resolved value is the truth - render whatever the server
            // said the membership now is.
            const next = checkCircle(Boolean(nowMember));
            row.replaceChild(next, check);
            check = next;
          })
          .catch(() => {
            /* toggle failed - leave the row as it was */
          })
          .finally(() => {
            busy = false;
          });
      });

      item.appendChild(row);
      list.appendChild(item);
    }

    body.appendChild(list);
  }

  function actionButton(labelText, icon, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'song-action pressable';
    button.appendChild(icon);
    const label = document.createElement('span');
    label.className = 'song-action__label';
    label.textContent = labelText;
    button.appendChild(label);
    button.addEventListener('click', onClick);
    return button;
  }

  // The foot below the divider. Two states: the two actions, or the delete
  // confirmation that one of them swaps in.
  function renderFootActions(foot) {
    foot.innerHTML = '';

    if (typeof onSave === 'function') {
      foot.appendChild(actionButton(t('edit_details'), pencilIcon(), renderEditView));
    }

    if (typeof onDelete === 'function') {
      const deleteBtn = actionButton(t('delete_song'), trashIcon(), () =>
        renderDeleteConfirm(foot)
      );
      deleteBtn.classList.add('song-action--danger');
      foot.appendChild(deleteBtn);
    }
  }

  // Never on a single tap. The first tap only ASKS - exactly as deleting a
  // playlist does from the chip menu - and only the second one calls through.
  // Losing a song is losing the audio file itself, so the confirming button is
  // the outlined one and Cancel keeps the focus.
  function renderDeleteConfirm(foot) {
    foot.innerHTML = '';

    const hint = document.createElement('div');
    hint.className = 'modal-hint song-confirm__text';
    hint.textContent = t('confirm_delete');
    foot.appendChild(hint);

    const named = document.createElement('div');
    named.className = 'modal-subtitle song-confirm__name';
    named.textContent = details.title;
    foot.appendChild(named);

    const error = errorLine();
    foot.appendChild(error);

    const { actions, cancelBtn, confirmBtn } = actionsRow(t('cancel'), t('delete'), {
      destructive: true
    });
    foot.appendChild(actions);

    cancelBtn.addEventListener('click', () => {
      renderFootActions(foot);
      // Back to where the finger was, not to the top of the card.
      const back = foot.querySelector('.song-action--danger');
      if (back) back.focus({ preventScroll: true });
    });

    let busy = false;
    confirmBtn.addEventListener('click', () => {
      if (busy) return;
      busy = true;
      cancelBtn.disabled = true;
      confirmBtn.disabled = true;
      error.hidden = true;
      Promise.resolve(onDelete())
        // The song is gone; there is nothing left in here to look at.
        .then(() => close())
        .catch((err) => {
          error.textContent = failureText(err, 'delete_song_failed', t);
          error.hidden = false;
          busy = false;
          cancelBtn.disabled = false;
          confirmBtn.disabled = false;
        });
    });

    // The safe choice is the default one.
    cancelBtn.focus({ preventScroll: true });
  }

  function renderDefaultView() {
    body.innerHTML = '';
    title.textContent = t('choose_playlists');
    subtitle.textContent = details.title;

    renderPlaylists();

    // Only draw the divider and the foot if there is anything to put in it.
    if (typeof onSave === 'function' || typeof onDelete === 'function') {
      const foot = document.createElement('div');
      foot.className = 'song-foot';
      body.appendChild(foot);
      renderFootActions(foot);
    }
  }

  // -------------------------------------------------------------------------
  // Edit view: the same card, a different body.

  function renderEditView() {
    body.innerHTML = '';
    title.textContent = t('edit_details');

    // .upload-label and .modal-input are the app's field pair - the add-song
    // dialog is built from them - so the two forms that type a title and an
    // artist look like one form in two places instead of two designs.
    function field(id, labelText, value, autocapitalize) {
      const label = document.createElement('label');
      label.className = 'upload-label';
      label.htmlFor = id;
      label.textContent = labelText;

      const input = document.createElement('input');
      input.type = 'text';
      input.id = id;
      input.className = 'modal-input';
      input.value = value;
      input.placeholder = labelText;
      input.autocomplete = 'off';
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('autocapitalize', autocapitalize);
      input.setAttribute('enterkeyhint', 'done');
      input.maxLength = 120;

      body.appendChild(label);
      body.appendChild(input);
      return input;
    }

    const titleInput = field(`${uid}-title-input`, t('song_title'), details.title, 'sentences');
    const artistInput = field(`${uid}-artist-input`, t('song_artist'), details.artist, 'words');

    const error = errorLine();
    body.appendChild(error);

    const { actions, cancelBtn, confirmBtn } = actionsRow(t('cancel'), t('save'));
    body.appendChild(actions);

    function showError(message) {
      error.textContent = message;
      error.hidden = false;
      // On a short screen the card scrolls; a refusal the user cannot see
      // reads as the button doing nothing at all.
      error.scrollIntoView({ block: 'nearest' });
    }

    let busy = false;

    function submit() {
      if (busy) return;

      const nextTitle = titleInput.value.trim();
      const nextArtist = artistInput.value.trim();

      // Refused here rather than at the server: the server rejects an empty
      // field too, but a round trip to be told what the panel already knows is
      // a round trip for nothing.
      if (!nextTitle || !nextArtist) {
        showError(t('song_details_required'));
        (nextTitle ? artistInput : titleInput).focus();
        return;
      }

      // Nothing typed that was not already there. No request, no refresh of
      // the library behind - just put the panel back.
      if (nextTitle === details.title && nextArtist === details.artist) {
        renderDefaultView();
        return;
      }

      busy = true;
      cancelBtn.disabled = true;
      confirmBtn.disabled = true;
      confirmBtn.textContent = t('saving');
      error.hidden = true;

      Promise.resolve(onSave({ title: nextTitle, artist: nextArtist }))
        .then(() => {
          details = { title: nextTitle, artist: nextArtist };
          // Saved and applied: the row behind has already been repainted by
          // the caller, so the panel has nothing further to say.
          close();
        })
        .catch((err) => {
          // Stay in the edit view with the typed values intact - a refusal
          // that threw the text away would be a second thing to fix.
          showError(failureText(err, 'save_failed', t));
          busy = false;
          cancelBtn.disabled = false;
          confirmBtn.disabled = false;
          confirmBtn.textContent = t('save');
        });
    }

    cancelBtn.addEventListener('click', () => {
      if (busy) return;
      renderDefaultView();
    });
    confirmBtn.addEventListener('click', submit);

    for (const input of [titleInput, artistInput]) {
      input.addEventListener('input', () => {
        error.hidden = true;
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') submit();
      });
    }

    // The body changed height; a card that had been scrolled down would open
    // the form part-way through it.
    card.scrollTop = 0;
    titleInput.focus();
    titleInput.select();
  }

  // -------------------------------------------------------------------------

  renderDefaultView();

  backdrop.appendChild(card);
  mount.appendChild(backdrop);
  if (shell) shell.classList.add('is-blurred');

  return close;
}
