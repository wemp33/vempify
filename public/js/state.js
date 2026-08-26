const state = {
  tracks: [],
  playlists: [],
  currentPlaylistName: null,
  queue: [],
  currentIndex: -1,
  isPlaying: false,
  volume: 1,
  shuffle: false,
  repeat: 'off',
  lang: 'en',
};

const subscribers = new Set();

export const store = {
  getState() {
    return state;
  },
  setState(patch) {
    Object.assign(state, patch);
    for (const fn of subscribers) fn(state);
  },
  subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  },
};
