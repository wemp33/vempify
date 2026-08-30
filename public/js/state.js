const state = {
  tracks: [],
  userPlaylists: [],
  activePlaylist: null, // null = All songs, else playlist name
  context: [], // array of track ids: the listening context playback flows through
  contextIndex: -1, // position of the current song within context (-1 = nothing playing)
  queue: [], // array of track ids the user queued via swipe
  history: [], // recently played track ids, newest last, capped at 50
  playMode: 'order', // 'order' | 'random'
  isPlaying: false,
  volume: 1,
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
