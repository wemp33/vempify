const DEBOUNCE_MS = 150;
const COMBINING_MARKS = /[\u0300-\u036f]/g;

function normalize(str) {
  return str
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function renderSearch(inputEl, getAllTracks, onResults) {
  let timer = null;

  inputEl.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const query = normalize(inputEl.value);
      const tracks = getAllTracks();
      const filtered = tracks.filter((track) => {
        const haystack = normalize(`${track.title} ${track.artist}`);
        return haystack.includes(query);
      });
      onResults(filtered);
    }, DEBOUNCE_MS);
  });
}
