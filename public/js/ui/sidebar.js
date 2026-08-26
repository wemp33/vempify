import { store } from '../state.js';
import { t } from '../i18n.js';

function createNavItem(label, isActive, onClick) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'nav-item';
  if (isActive) button.classList.add('is-active');

  const labelEl = document.createElement('span');
  labelEl.className = 'nav-item__label';
  labelEl.textContent = label;
  button.appendChild(labelEl);

  button.addEventListener('click', onClick);
  li.appendChild(button);
  return li;
}

export function renderSidebar(container, playlists, onSelectPlaylist) {
  container.innerHTML = '';

  const activeName = store.getState().currentPlaylistName;

  const likedList = document.createElement('ul');
  likedList.className = 'nav-list';
  likedList.appendChild(
    createNavItem(t('liked_songs'), activeName === null, () => onSelectPlaylist(null))
  );
  container.appendChild(likedList);

  const section = document.createElement('div');
  section.className = 'nav-section';

  const title = document.createElement('div');
  title.className = 'nav-section__title';
  title.textContent = t('playlists');
  section.appendChild(title);

  const playlistList = document.createElement('ul');
  playlistList.className = 'nav-list';
  for (const playlist of playlists) {
    playlistList.appendChild(
      createNavItem(playlist.name, playlist.name === activeName, () => onSelectPlaylist(playlist.name))
    );
  }
  section.appendChild(playlistList);

  container.appendChild(section);
}
