// English only: the language toggle was removed, so there is one dictionary
// and t() is a plain lookup. Keys stay in use across the UI modules.
const strings = {
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
  // Reads as the mirror of confirm_delete_playlist above, and says the part
  // that is easy to get wrong: this one does take the audio, everywhere.
  confirm_delete: 'Delete this song? It leaves your library and every playlist it is in.',
  // The song panel (ui/song-panel.js): editing a track's details, and the two
  // ways that panel can be refused. song_title/song_artist/save/cancel/
  // delete_song/confirm_delete above are shared with the add-song dialog and
  // the playlist dialogs - only the wording those do not already carry is new.
  edit_details: 'Edit details',
  delete: 'Delete',
  saving: 'Saving…',
  song_details_required: 'Fill in the title and the artist',
  save_failed: 'Could not save the changes',
  delete_song_failed: 'Could not delete the song',
};

export function t(key) {
  return strings[key] ?? key;
}
