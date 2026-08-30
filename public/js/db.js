const DB_NAME = 'vempify-db';
const DB_VERSION = 2;

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
      if (!db.objectStoreNames.contains('userPlaylists')) {
        db.createObjectStore('userPlaylists', { keyPath: 'name' });
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

// ---------------------------------------------------------------------------
// User playlists.
//
// These used to be where playlists LIVED; they now live on the server volume
// (see js/sources/playlists.js) so every device sees the same ones. The store
// below is kept deliberately: it is the source main.js migrates up on a
// device's first run against the new API, and the fallback that still lists
// something when the app opens with no connection. Nothing writes to it any
// more, and nothing deletes from it - it is the only backup of lists that were
// browser-local until the migration.

export function getUserPlaylists() {
  return getAll('userPlaylists').then((playlists) =>
    playlists.sort((a, b) => a.createdAt - b.createdAt)
  );
}

export function createUserPlaylist(name, nowMs) {
  const record = { name, trackIds: [], createdAt: nowMs };
  return initDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction('userPlaylists', 'readwrite');
        const request = tx.objectStore('userPlaylists').add(record);
        request.onerror = (event) => {
          event.preventDefault();
          const isTaken = request.error && request.error.name === 'ConstraintError';
          reject(isTaken ? new Error('exists') : request.error);
        };
        tx.oncomplete = () => resolve(record);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

export function deleteUserPlaylist(name) {
  return runTransaction('userPlaylists', 'readwrite', (store) => {
    store.delete(name);
  });
}

export function toggleTrackInUserPlaylist(name, trackId) {
  return initDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction('userPlaylists', 'readwrite');
        const store = tx.objectStore('userPlaylists');
        const getRequest = store.get(name);
        let isMember = false;
        getRequest.onsuccess = () => {
          const record = getRequest.result;
          if (!record) {
            reject(new Error('missing'));
            tx.abort();
            return;
          }
          const index = record.trackIds.indexOf(trackId);
          if (index === -1) {
            record.trackIds.push(trackId);
            isMember = true;
          } else {
            record.trackIds.splice(index, 1);
            isMember = false;
          }
          store.put(record);
        };
        tx.oncomplete = () => resolve(isMember);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}
