const STORAGE_KEY = 'vempify-lang';

const dictionaries = {
  en: {
    search_placeholder: 'Search songs, artists, albums…',
    play: 'Play',
    pause: 'Pause',
    next: 'Next',
    prev: 'Previous',
    all_songs: 'All songs',
    add_playlist: 'Add playlist',
    new_playlist_name: 'Playlist name',
    create: 'Create',
    cancel: 'Cancel',
    queue: 'Queue',
    empty_queue: 'The queue is empty',
    added_to_queue: 'Added to queue',
    remove: 'Remove',
    choose_playlists: 'Choose playlists',
    close: 'Close',
    play_mode_random: 'Random',
    play_mode_order: 'In order',
    volume: 'Volume',
    language: 'Language',
    empty_library: 'Your library is empty.',
    now_playing: 'Now Playing',
  },
  pl: {
    search_placeholder: 'Szukaj utworów, wykonawców, albumów…',
    play: 'Odtwórz',
    pause: 'Wstrzymaj',
    next: 'Następny',
    prev: 'Poprzedni',
    all_songs: 'Wszystkie utwory',
    add_playlist: 'Dodaj playlistę',
    new_playlist_name: 'Nazwa playlisty',
    create: 'Utwórz',
    cancel: 'Anuluj',
    queue: 'Kolejka',
    empty_queue: 'Kolejka jest pusta',
    added_to_queue: 'Dodano do kolejki',
    remove: 'Usuń',
    choose_playlists: 'Wybierz playlisty',
    close: 'Zamknij',
    play_mode_random: 'Losowo',
    play_mode_order: 'Po kolei',
    volume: 'Głośność',
    language: 'Język',
    empty_library: 'Twoja biblioteka jest pusta.',
    now_playing: 'Teraz odtwarzane',
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
