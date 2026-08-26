const DB_NAME = 'vempify-db';
const DB_VERSION = 1;

let dbPromise = null;

export function initDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('tracks')) {
        db.createObjectStore('tracks', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('playlists')) {
        db.createObjectStore('playlists', { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains('playcounts')) {
        db.createObjectStore('playcounts', { keyPath: 'trackId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function runTransaction(storeName, mode, work) {
  return initDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const result = work(store);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

function putAll(storeName, items) {
  return runTransaction(storeName, 'readwrite', (store) => {
    store.clear();
    for (const item of items) store.put(item);
  });
}

function getAll(storeName) {
  return initDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })
  );
}

export function putTracks(tracks) {
  return putAll('tracks', tracks);
}

export function putPlaylists(playlists) {
  return putAll('playlists', playlists);
}

export function getAllTracks() {
  return getAll('tracks');
}

export function getAllPlaylists() {
  return getAll('playlists');
}

export function incrementPlayCount(trackId, nowMs) {
  return initDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction('playcounts', 'readwrite');
        const store = tx.objectStore('playcounts');
        const getRequest = store.get(trackId);
        getRequest.onsuccess = () => {
          const record = getRequest.result || { trackId, count: 0, lastPlayedAt: null };
          record.count += 1;
          record.lastPlayedAt = nowMs;
          store.put(record);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

export function getPlayCounts() {
  return getAll('playcounts');
}
