const STORAGE_KEY = 'vempify-lang';

const dictionaries = {
  en: {
    search_placeholder: 'Search songs, artists, albums…',
    play: 'Play',
    pause: 'Pause',
    next: 'Next',
    prev: 'Previous',
    queue: 'Queue',
    now_playing: 'Now Playing',
    playlists: 'Playlists',
    liked_songs: 'Liked Songs',
    shuffle: 'Shuffle',
    repeat: 'Repeat',
    volume: 'Volume',
    language: 'Language',
    empty_library: 'Your library is empty.',
  },
  pl: {
    search_placeholder: 'Szukaj utworów, wykonawców, albumów…',
    play: 'Odtwórz',
    pause: 'Wstrzymaj',
    next: 'Następny',
    prev: 'Poprzedni',
    queue: 'Kolejka',
    now_playing: 'Teraz odtwarzane',
    playlists: 'Playlisty',
    liked_songs: 'Ulubione utwory',
    shuffle: 'Losowo',
    repeat: 'Powtarzaj',
    volume: 'Głośność',
    language: 'Język',
    empty_library: 'Twoja biblioteka jest pusta.',
  },
};

function readStoredLang() {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'pl' || stored === 'en' ? stored : 'en';
}

let currentLang = readStoredLang();

export function t(key) {
  return dictionaries[currentLang][key] ?? dictionaries.en[key] ?? key;
}

export function setLang(lang) {
  currentLang = lang === 'pl' ? 'pl' : 'en';
  localStorage.setItem(STORAGE_KEY, currentLang);
}

export function getLang() {
  return currentLang;
}
