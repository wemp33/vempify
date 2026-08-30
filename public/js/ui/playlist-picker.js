// Centered modal listing the user's playlists with a membership toggle per
// row. Mounted into #modal-root, which lives OUTSIDE .app-shell so the
// "is-blurred" class on the shell never blurs the modal itself.
//
// Opening and closing are shared: the enter animation comes from app.css
// (any .modal-backdrop > .modal-card rises on insert), and the outside-tap
// dismissal plus the exit animation come from ui/modal.js - see the long
// comment there for why a plain click listener on the dim area was dead on
// iOS and what replaced it.

import { bindDismiss, dismissModal } from './modal.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

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

export function openPlaylistPicker({ mount, track, playlists, isMember, onToggle, t }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const card = document.createElement('div');
  card.className = 'modal-card playlist-picker';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');

  const shell = document.querySelector('.app-shell');

  function close() {
    // Unblur with the panel, not after it: the two motions have to read as one
    // gesture, so the shell sharpens while the card is still on its way out.
    if (shell) shell.classList.remove('is-blurred');
    dismissModal(backdrop);
  }

  bindDismiss(backdrop, close);

  const header = document.createElement('div');
  header.className = 'modal-header';

  const headings = document.createElement('div');
  headings.className = 'modal-headings';

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = t('choose_playlists');

  const subtitle = document.createElement('div');
  subtitle.className = 'modal-subtitle';
  subtitle.textContent = track && track.title ? track.title : '';

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

  if (!playlists || playlists.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'modal-hint';
    hint.textContent = t('add_playlist');
    card.appendChild(hint);
  } else {
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

    card.appendChild(list);
  }

  backdrop.appendChild(card);
  mount.appendChild(backdrop);
  if (shell) shell.classList.add('is-blurred');

  return close;
}
