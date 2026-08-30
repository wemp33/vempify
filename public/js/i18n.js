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
    playlist_options: 'Playlist options',
    rename: 'Rename',
    rename_playlist: 'Rename playlist',
    save: 'Save',
    delete_playlist: 'Delete playlist',
    // Says what survives as well as what goes: deleting a playlist here only
    // takes the grouping, never the audio.
    confirm_delete_playlist: 'Delete this playlist? The songs stay in your library.',
    playlist_name_taken: 'You already have a playlist with that name',
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
    add_song: 'Add song',
    choose_file: 'Choose file',
    song_title: 'Title',
    song_artist: 'Artist',
    upload: 'Upload',
    uploading: 'Uploading…',
    upload_failed: 'Upload failed',
    upload_duplicate: 'That song is already in your library',
    upload_bad_format: 'That file is not an audio format Vempify can read',
    delete_song: 'Delete song',
    confirm_delete: 'Remove this song from your library?',
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
    playlist_options: 'Opcje playlisty',
    rename: 'Zmień nazwę',
    rename_playlist: 'Zmień nazwę playlisty',
    save: 'Zapisz',
    delete_playlist: 'Usuń playlistę',
    confirm_delete_playlist: 'Usunąć tę playlistę? Utwory zostaną w bibliotece.',
    playlist_name_taken: 'Masz już playlistę o tej nazwie',
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
    add_song: 'Dodaj utwór',
    choose_file: 'Wybierz plik',
    song_title: 'Tytuł',
    song_artist: 'Wykonawca',
    upload: 'Wyślij',
    uploading: 'Wysyłanie…',
    upload_failed: 'Nie udało się wysłać pliku',
    upload_duplicate: 'Ten utwór jest już w Twojej bibliotece',
    upload_bad_format: 'Ten plik nie jest formatem audio, który Vempify potrafi odczytać',
    delete_song: 'Usuń utwór',
    confirm_delete: 'Usunąć ten utwór z biblioteki?',
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
