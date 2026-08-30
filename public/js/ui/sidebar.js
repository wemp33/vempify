// The bottom chip strip: "All songs", one chip per user playlist, and a "+"
// chip that creates a new playlist. Chips keep the .nav-item/.nav-list
// structure the mobile breakpoint already lays out as a horizontal strip,
// plus the .chip/.pressable hooks.
//
// The chip of the playlist you are LOOKING AT also carries a "..." button.
// Only that one: an options control on every chip would turn a five-playlist
// strip into ten targets, and renaming or deleting something you are not
// currently in is not a thing anyone reaches for. "All songs" never has one -
// it is not a playlist and cannot be renamed or deleted.
//
// A chip is a <button>, so "..." cannot be nested inside it. It is a sibling,
// absolutely positioned over the chip's right end (see .nav-tab in app.css),
// which leaves every existing chip rule untouched.

import { getLang } from '../i18n.js';
import { bindDismiss, dismissModal } from './modal.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Wording the shared key set does not carry, in the same local-dictionary
// shape queue.js and upload.js use.
const LOCAL_MESSAGES = {
  empty_name: { en: 'Enter a name', pl: 'Wpisz nazwę' },
  rename_failed: { en: 'Could not rename the playlist', pl: 'Nie udało się zmienić nazwy' },
  delete_failed: { en: 'Could not delete the playlist', pl: 'Nie udało się usunąć playlisty' }
};

function local(key) {
  const entry = LOCAL_MESSAGES[key];
  if (!entry) return '';
  return entry[getLang()] ?? entry.en;
}

// ---------------------------------------------------------------------------
// Icons

function strokeSvg(size) {
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
  return svg;
}

function plusIcon() {
  const svg = strokeSvg(18);
  svg.setAttribute('class', 'chip-add__icon');
  for (const points of ['12,5 12,19', '5,12 19,12']) {
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', points);
    svg.appendChild(line);
  }
  return svg;
}

// Three filled dots, horizontal - the same "more" glyph the platform uses.
function dotsIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const cx of [5, 12, 19]) {
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', String(cx));
    dot.setAttribute('cy', '12');
    dot.setAttribute('r', '2');
    svg.appendChild(dot);
  }
  return svg;
}

// A pencil over a line.
function renameIcon() {
  const svg = strokeSvg(17);
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
  const svg = strokeSvg(17);
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
// Chips

function createChip(isActive, onClick) {
  const li = document.createElement('li');
  li.className = 'nav-tab';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'nav-item chip pressable';
  if (isActive) button.classList.add('is-active');
  button.addEventListener('click', onClick);
  li.appendChild(button);
  return { li, button };
}

function createLabelChip(label, isActive, onClick) {
  const { li, button } = createChip(isActive, onClick);
  const labelEl = document.createElement('span');
  labelEl.className = 'nav-item__label';
  labelEl.textContent = label;
  button.appendChild(labelEl);
  return { li, button };
}

// ---------------------------------------------------------------------------
// Dialogs
//
// Both of these are the app's standard .modal-backdrop/.modal-card shape, so
// they inherit the panel styling, the rise-on-open animation from app.css and
// the shared dismissal from ui/modal.js. They mount into #modal-root when it
// exists - that container sits outside .app-shell, which is what lets the
// shell blur behind them - and fall back to <body> if it does not.

function modalMount() {
  return document.getElementById('modal-root') || document.body;
}

function buildDialog({ titleText, describedBy }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const card = document.createElement('div');
  card.className = 'modal-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  if (describedBy) card.setAttribute('aria-describedby', describedBy);

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = titleText;
  card.appendChild(title);

  const shell = document.querySelector('.app-shell');

  function close() {
    if (shell) shell.classList.remove('is-blurred');
    dismissModal(backdrop);
  }

  bindDismiss(backdrop, close);
  backdrop.appendChild(card);

  function show() {
    modalMount().appendChild(backdrop);
    if (shell) shell.classList.add('is-blurred');
  }

  return { backdrop, card, close, show };
}

function actionsRow(card, cancelText, confirmText, { destructive = false } = {}) {
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
  card.appendChild(actions);
  return { cancelBtn, confirmBtn };
}

// Rename: a prefilled field, Cancel/Save, and an inline refusal for an empty
// name or one another playlist already has. The dialog stays open on a
// refusal so the typed name is never thrown away.
function openRenameDialog(currentName, onRename, t) {
  const { card, close, show } = buildDialog({ titleText: t('rename_playlist') });

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'modal-input';
  input.value = currentName;
  input.placeholder = t('new_playlist_name');
  input.setAttribute('aria-label', t('new_playlist_name'));
  input.autocomplete = 'off';
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'sentences');
  input.setAttribute('enterkeyhint', 'done');
  input.maxLength = 60;
  card.appendChild(input);

  const error = document.createElement('div');
  error.className = 'modal-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  card.appendChild(error);

  const { cancelBtn, confirmBtn } = actionsRow(card, t('cancel'), t('save'));

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
  }

  let busy = false;
  function submit() {
    if (busy) return;
    const next = input.value.trim();
    if (!next) {
      showError(local('empty_name'));
      input.focus();
      return;
    }
    // Same name, same casing: nothing to do. (A pure case change IS a rename
    // and goes to the server, which allows it.)
    if (next === currentName) {
      close();
      return;
    }

    busy = true;
    confirmBtn.disabled = true;
    Promise.resolve(onRename(currentName, next))
      .then(() => close())
      .catch((err) => {
        // 409 is the server's "another playlist already has that name"; every
        // other failure is one the user can only retry.
        showError(err && err.status === 409 ? t('playlist_name_taken') : local('rename_failed'));
        busy = false;
        confirmBtn.disabled = false;
        input.focus();
        input.select();
      });
  }

  cancelBtn.addEventListener('click', close);
  confirmBtn.addEventListener('click', submit);
  input.addEventListener('input', () => {
    error.hidden = true;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });

  show();
  input.focus();
  input.select();
}

// Delete asks first, always. One tap on "..." then one on "Delete" must never
// be enough to lose a playlist.
function openDeleteDialog(name, onDelete, t) {
  const { card, close, show } = buildDialog({
    titleText: t('delete_playlist'),
    describedBy: 'playlist-delete-hint'
  });

  const hint = document.createElement('div');
  hint.className = 'modal-hint';
  hint.id = 'playlist-delete-hint';
  hint.style.textAlign = 'left';
  hint.textContent = t('confirm_delete_playlist');
  card.appendChild(hint);

  const named = document.createElement('div');
  named.className = 'modal-subtitle';
  named.style.padding = '0 6px';
  named.textContent = name;
  card.appendChild(named);

  const error = document.createElement('div');
  error.className = 'modal-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  card.appendChild(error);

  const { cancelBtn, confirmBtn } = actionsRow(card, t('cancel'), t('delete_playlist'), {
    destructive: true
  });

  let busy = false;
  cancelBtn.addEventListener('click', close);
  confirmBtn.addEventListener('click', () => {
    if (busy) return;
    busy = true;
    confirmBtn.disabled = true;
    Promise.resolve(onDelete(name))
      .then(() => close())
      .catch(() => {
        error.textContent = local('delete_failed');
        error.hidden = false;
        busy = false;
        confirmBtn.disabled = false;
      });
  });

  show();
  // Cancel takes the focus, not Delete: the safe choice is the default one.
  cancelBtn.focus();
}

// ---------------------------------------------------------------------------
// The options menu
//
// Mounted on <body> rather than inside the chip. On a phone the sidebar is a
// horizontally scrolling strip with overflow-y hidden, so a menu positioned
// inside it would be clipped off. Staying out of #modal-root matters too: the
// app opens no panel while that container has a child, and a transient menu
// must not lock the queue and the picker out.

function openChipMenu(anchor, { name, onRename, onDelete, t }) {
  const layer = document.createElement('div');
  layer.className = 'chip-menu-layer';

  const menu = document.createElement('div');
  menu.className = 'chip-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', t('playlist_options'));

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    layer.remove();
    document.removeEventListener('keydown', onKeyDown);
    anchor.setAttribute('aria-expanded', 'false');
    // Send the focus back where it came from, or a keyboard user is stranded
    // at the top of the document.
    if (anchor.isConnected) anchor.focus();
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close();
  }

  function item(label, icon, onPick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip-menu__item pressable';
    button.setAttribute('role', 'menuitem');
    button.appendChild(icon);
    const text = document.createElement('span');
    text.textContent = label;
    button.appendChild(text);
    button.addEventListener('click', () => {
      close();
      onPick();
    });
    return button;
  }

  menu.appendChild(item(t('rename'), renameIcon(), () => openRenameDialog(name, onRename, t)));
  menu.appendChild(
    item(t('delete_playlist'), trashIcon(), () => openDeleteDialog(name, onDelete, t))
  );

  // The same press rule the panels use: a tap that begins and ends on the
  // layer itself is "outside". Pointer events rather than click, because iOS
  // does not synthesise a click for a tap on a bare <div>.
  let pressId = null;
  layer.addEventListener('pointerdown', (event) => {
    pressId = event.target === layer ? event.pointerId : null;
  });
  layer.addEventListener('pointerup', (event) => {
    const startedOutside = pressId !== null && pressId === event.pointerId;
    pressId = null;
    if (startedOutside && event.target === layer) close();
  });
  layer.addEventListener('pointercancel', () => {
    pressId = null;
  });
  document.addEventListener('keydown', onKeyDown);

  layer.appendChild(menu);
  document.body.appendChild(layer);
  anchor.setAttribute('aria-expanded', 'true');

  // Placed only once it is in the document, because the clamp needs the
  // menu's real measured size. The chip strip lives at the bottom of the
  // screen on a phone, so below the chip is usually the wrong side: prefer
  // below, flip above when there is not room, and keep 8px off every edge.
  const gap = 6;
  const margin = 8;
  const rect = anchor.getBoundingClientRect();
  const size = menu.getBoundingClientRect();

  let top = rect.bottom + gap;
  if (top + size.height > window.innerHeight - margin) {
    top = rect.top - gap - size.height;
  }
  top = Math.max(margin, Math.min(top, window.innerHeight - margin - size.height));

  // Right-aligned to the "..." itself, which is what the menu belongs to.
  let left = rect.right - size.width;
  left = Math.max(margin, Math.min(left, window.innerWidth - margin - size.width));

  menu.style.top = `${Math.round(top)}px`;
  menu.style.left = `${Math.round(left)}px`;

  // Land the keyboard inside the menu. preventScroll matters: the app pins
  // the body, and letting focus scroll would shift the whole shell.
  menu.firstElementChild?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------

export function renderTabs(container, { playlists, activeName, onSelect, onAdd, onRename, onDelete, t }) {
  container.innerHTML = '';

  const list = document.createElement('ul');
  list.className = 'nav-list';

  const { li: allLi } = createLabelChip(t('all_songs'), activeName === null, () => onSelect(null));
  list.appendChild(allLi);

  for (const playlist of playlists) {
    const isActive = playlist.name === activeName;
    const { li, button } = createLabelChip(playlist.name, isActive, () => onSelect(playlist.name));

    // Only the playlist currently being viewed offers rename/delete, and only
    // when the caller supplied handlers for them.
    if (isActive && typeof onRename === 'function' && typeof onDelete === 'function') {
      li.classList.add('has-options');

      const options = document.createElement('button');
      options.type = 'button';
      options.className = 'chip-options pressable';
      // Named after the playlist, not just "Playlist options": a screen
      // reader then says which list the menu is about.
      options.setAttribute('aria-label', `${t('playlist_options')}: ${playlist.name}`);
      options.setAttribute('aria-haspopup', 'menu');
      options.setAttribute('aria-expanded', 'false');
      options.title = t('playlist_options');
      options.style.minWidth = '44px';
      options.style.minHeight = '44px';
      options.appendChild(dotsIcon());
      options.addEventListener('click', (event) => {
        // The chip underneath would otherwise re-select the playlist.
        event.stopPropagation();
        openChipMenu(options, { name: playlist.name, onRename, onDelete, t });
      });

      li.appendChild(options);
      button.setAttribute('aria-current', 'true');
    }

    list.appendChild(li);
  }

  const { li: addLi, button: addButton } = createChip(false, () => onAdd());
  addButton.classList.add('chip-add');
  addButton.setAttribute('aria-label', t('add_playlist'));
  addButton.title = t('add_playlist');
  addButton.appendChild(plusIcon());
  list.appendChild(addLi);

  container.appendChild(list);
}
