import { getLang } from '../i18n.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// i18n.js has no queue-reorder keys, so the two labels this module needs live
// here rather than reaching into a dictionary it does not own.
const MOVE_LABELS = {
  en: { up: 'Move up in queue', down: 'Move down in queue' },
  pl: { up: 'Przesuń w górę kolejki', down: 'Przesuń w dół kolejki' }
};

function chevronIcon(direction) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'queue-move__icon');

  const chevron = document.createElementNS(SVG_NS, 'polyline');
  chevron.setAttribute('points', direction === 'up' ? '6,15 12,9 18,15' : '6,9 12,15 18,9');
  svg.appendChild(chevron);

  return svg;
}

export function renderQueue(container, queueTracks, currentIndex, onReorder, onSelectIndex) {
  container.innerHTML = '';

  const list = document.createElement('ul');
  list.className = 'queue-list';

  const labels = MOVE_LABELS[getLang()] || MOVE_LABELS.en;

  let dragIndex = null;

  function move(fromIndex, toIndex) {
    if (typeof onReorder !== 'function') return;
    if (toIndex < 0 || toIndex >= queueTracks.length || fromIndex === toIndex) return;
    const reordered = queueTracks.map((track) => track.id);
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    onReorder(reordered);
  }

  // HTML5 drag and drop does nothing under iOS Safari touch, so every row also
  // carries explicit move buttons. .queue-move is the hook app.css uses to hide
  // them on hover-capable, fine-pointer devices where dragging already works.
  function createMoveButton(direction, index, disabled) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `queue-move queue-move--${direction}`;
    button.dataset.direction = direction;
    button.setAttribute('aria-label', labels[direction]);
    button.title = labels[direction];
    button.draggable = false;
    button.style.minWidth = '44px';
    button.style.minHeight = '44px';
    button.style.touchAction = 'manipulation';

    if (disabled) {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
    }

    button.appendChild(chevronIcon(direction));

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;
      move(index, direction === 'up' ? index - 1 : index + 1);
    });

    return button;
  }

  queueTracks.forEach((track, index) => {
    const item = document.createElement('li');
    item.className = 'queue-item';
    if (index === currentIndex) item.classList.add('active');
    item.draggable = true;
    item.dataset.index = String(index);

    const title = document.createElement('span');
    title.className = 'queue-item-title';
    title.textContent = track.title;

    const artist = document.createElement('span');
    artist.className = 'queue-item-artist';
    artist.textContent = track.artist;

    item.appendChild(title);
    item.appendChild(artist);
    item.appendChild(createMoveButton('up', index, index === 0));
    item.appendChild(createMoveButton('down', index, index === queueTracks.length - 1));

    item.addEventListener('click', () => onSelectIndex(index));

    item.addEventListener('dragstart', (event) => {
      dragIndex = index;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
    });

    item.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    });

    item.addEventListener('drop', (event) => {
      event.preventDefault();
      const fromIndex = dragIndex !== null ? dragIndex : Number(event.dataTransfer.getData('text/plain'));
      const toIndex = index;
      dragIndex = null;
      if (Number.isNaN(fromIndex) || fromIndex === toIndex) return;

      move(fromIndex, toIndex);
    });

    item.addEventListener('dragend', () => {
      dragIndex = null;
    });

    list.appendChild(item);
  });

  container.appendChild(list);
}
