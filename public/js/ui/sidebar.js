// The bottom chip strip: "All songs", one chip per user playlist, and a "+"
// chip that creates a new playlist. Chips keep the .nav-item/.nav-list
// structure the mobile breakpoint already lays out as a horizontal strip,
// plus the new .chip/.pressable hooks.

const SVG_NS = 'http://www.w3.org/2000/svg';

function plusIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'chip-add__icon');

  for (const points of ['12,5 12,19', '5,12 19,12']) {
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', points);
    svg.appendChild(line);
  }

  return svg;
}

function createChip(isActive, onClick) {
  const li = document.createElement('li');
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
  return li;
}

export function renderTabs(container, { playlists, activeName, onSelect, onAdd, t }) {
  container.innerHTML = '';

  const list = document.createElement('ul');
  list.className = 'nav-list';

  list.appendChild(createLabelChip(t('all_songs'), activeName === null, () => onSelect(null)));

  for (const playlist of playlists) {
    list.appendChild(
      createLabelChip(playlist.name, playlist.name === activeName, () => onSelect(playlist.name))
    );
  }

  const { li: addLi, button: addButton } = createChip(false, () => onAdd());
  addButton.classList.add('chip-add');
  addButton.setAttribute('aria-label', t('add_playlist'));
  addButton.title = t('add_playlist');
  addButton.appendChild(plusIcon());
  list.appendChild(addLi);

  container.appendChild(list);
}
