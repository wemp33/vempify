// The queue panel: a centered modal (same style family as the playlist
// picker) listing the queued tracks with move/remove controls. The panel
// keeps its own working copy of the list so every move or removal shows up
// immediately, while onReorder/onRemove keep the app state in sync.

import { getLang } from '../i18n.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// i18n.js has no queue-reorder keys, so the two labels this module needs live
// here rather than reaching into a dictionary it does not own.
const MOVE_LABELS = {
  en: { up: 'Move up in queue', down: 'Move down in queue' },
  pl: { up: 'Przesuń w górę kolejki', down: 'Przesuń w dół kolejki' }
};

function strokeSvg(className, size) {
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

function chevronIcon(direction) {
  const svg = strokeSvg('queue-move__icon', 16);
  const chevron = document.createElementNS(SVG_NS, 'polyline');
  chevron.setAttribute('points', direction === 'up' ? '6,15 12,9 18,15' : '6,9 12,15 18,9');
  svg.appendChild(chevron);
  return svg;
}

function crossIcon() {
  const svg = strokeSvg('queue-remove__icon', 16);
  for (const points of ['6,6 18,18', '18,6 6,18']) {
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', points);
    svg.appendChild(line);
  }
  return svg;
}

export function renderQueuePanel(mount, tracks, { onReorder, onRemove, onPlayIndex, onClose, t }) {
  const items = tracks.slice();
  const labels = MOVE_LABELS[getLang()] || MOVE_LABELS.en;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const card = document.createElement('div');
  card.className = 'modal-card queue-panel';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');

  const shell = document.querySelector('.app-shell');

  function close() {
    if (shell) shell.classList.remove('is-blurred');
    backdrop.remove();
    if (typeof onClose === 'function') onClose();
  }

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });

  const header = document.createElement('div');
  header.className = 'modal-header';

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = t('queue');

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'modal-close pressable';
  closeBtn.setAttribute('aria-label', t('close'));
  closeBtn.style.minWidth = '44px';
  closeBtn.style.minHeight = '44px';
  closeBtn.appendChild(crossIcon());
  closeBtn.addEventListener('click', close);

  header.appendChild(title);
  header.appendChild(closeBtn);
  card.appendChild(header);

  const list = document.createElement('ul');
  list.className = 'queue-list';
  card.appendChild(list);

  function iconButton(className, label, icon, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${className} pressable`;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.style.minWidth = '44px';
    button.style.minHeight = '44px';
    button.style.touchAction = 'manipulation';
    button.appendChild(icon);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;
      onClick();
    });
    return button;
  }

  function move(fromIndex, toIndex) {
    if (toIndex < 0 || toIndex >= items.length || fromIndex === toIndex) return;
    const [moved] = items.splice(fromIndex, 1);
    items.splice(toIndex, 0, moved);
    renderList();
    if (typeof onReorder === 'function') onReorder(items.map((track) => track.id));
  }

  function renderList() {
    list.innerHTML = '';

    if (items.length === 0) {
      const hint = document.createElement('li');
      hint.className = 'modal-hint';
      hint.textContent = t('empty_queue');
      list.appendChild(hint);
      return;
    }

    items.forEach((track, index) => {
      const item = document.createElement('li');
      item.className = 'queue-item';

      // The text block is a button of its own: tapping it plays this entry.
      const text = document.createElement('button');
      text.type = 'button';
      text.className = 'queue-item-text pressable';
      text.style.minHeight = '44px';

      const titleEl = document.createElement('span');
      titleEl.className = 'queue-item-title';
      titleEl.textContent = track.title;

      const artistEl = document.createElement('span');
      artistEl.className = 'queue-item-artist';
      artistEl.textContent = track.artist;

      text.appendChild(titleEl);
      text.appendChild(artistEl);
      text.addEventListener('click', () => {
        if (typeof onPlayIndex === 'function') onPlayIndex(index);
        // The played entry (and everything before it) leaves the queue, so
        // the static panel would go stale - close it instead.
        close();
      });

      const up = iconButton('queue-move queue-move--up', labels.up, chevronIcon('up'), () =>
        move(index, index - 1)
      );
      const down = iconButton('queue-move queue-move--down', labels.down, chevronIcon('down'), () =>
        move(index, index + 1)
      );
      if (index === 0) {
        up.disabled = true;
        up.setAttribute('aria-disabled', 'true');
      }
      if (index === items.length - 1) {
        down.disabled = true;
        down.setAttribute('aria-disabled', 'true');
      }

      const remove = iconButton('queue-remove', t('remove'), crossIcon(), () => {
        items.splice(index, 1);
        renderList();
        if (typeof onRemove === 'function') onRemove(index);
      });

      item.appendChild(text);
      item.appendChild(up);
      item.appendChild(down);
      item.appendChild(remove);
      list.appendChild(item);
    });
  }

  renderList();

  backdrop.appendChild(card);
  mount.appendChild(backdrop);
  if (shell) shell.classList.add('is-blurred');

  return close;
}

// Shows the header queue button with its count while the queue is non-empty,
// hides it entirely when the queue is empty.
export function updateQueueBadge(buttonEl, count) {
  if (!buttonEl) return;
  const badge = buttonEl.querySelector('.queue-count');
  if (count > 0) {
    if (badge) badge.textContent = String(count);
    buttonEl.removeAttribute('hidden');
  } else {
    if (badge) badge.textContent = '';
    buttonEl.setAttribute('hidden', '');
  }
}
