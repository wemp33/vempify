/* Bump this on every change to a precached file: a device holding the older
   shell would otherwise keep serving it from cache. The activate handler
   below deletes every other vempify-shell-* cache, so the bump is what
   actually retires the stale copies.
   v7 adds the add-song dialog (/js/ui/upload.js); an installed phone still on
   v6 would fetch main.js from cache and fail to resolve the new import.
   v8 adds three modules main.js now imports - the server-backed playlist API
   (/js/sources/playlists.js), the shared row icons (/js/ui/rowicons.js) and
   the shared panel dismissal/exit motion (/js/ui/modal.js) - and carries the
   restyled CSS. A device still on v7 would serve the old main.js and the old
   app.css from cache and never see any of it.
   v10 carries the media-session fix in /js/ui/player.js: a phone still on v9
   would keep the cached module that never sets navigator.mediaSession
   .playbackState, so its lock screen would go on dropping the Now Playing card
   the moment a song is paused - the exact bug this bump ships the fix for.
   v13 replaces /js/ui/playlist-picker.js with /js/ui/song-panel.js, the panel
   that now also edits and deletes a song. A device still on v12 would serve the
   cached main.js, whose import of the old path no longer matches the module the
   app ships - and would have no copy of the new one to fall back on offline. */
const CACHE_NAME = 'vempify-shell-v13';

/* Every path here must actually exist under public/ - a 404 in the precache
   would otherwise poison the install. */
const SHELL_PATHS = [
  '/',
  '/app.css',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-32.png',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/js/main.js',
  '/js/state.js',
  '/js/db.js',
  '/js/i18n.js',
  '/js/sources/local.js',
  '/js/sources/playlists.js',
  '/js/ui/modal.js',
  '/js/ui/player.js',
  '/js/ui/rowicons.js',
  '/js/ui/swipe.js',
  '/js/ui/song-panel.js',
  '/js/ui/upload.js',
  '/js/ui/queue.js',
  '/js/ui/nowplaying.js',
  '/js/ui/search.js',
  '/js/ui/sidebar.js',
];

/* Never cached, never served from cache:
   /api/    - library JSON, must stay fresh
   /audio/  - range requests; a cached 206 would break seeking
   /covers/ - artwork served straight off disk
   /auth/, /login - the password gate. Caching a login page or an auth
                    redirect would strand the user on a stale screen. */
const BYPASS_PREFIXES = ['/api/', '/audio/', '/covers/', '/auth/', '/login'];

function isBypassed(pathname) {
  return BYPASS_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isCacheable(response) {
  return Boolean(
    response &&
      response.ok &&
      response.type === 'basic' &&
      // A redirect (e.g. / -> /login behind the password gate) must not be
      // stored as if it were the app shell.
      !response.redirected
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Cache each entry independently so one bad response cannot abort the
      // whole install and leave the app without a shell.
      Promise.allSettled(
        SHELL_PATHS.map(async (path) => {
          const response = await fetch(new Request(path, { cache: 'reload' }));
          if (!isCacheable(response)) throw new Error(`skipped ${path}`);
          await cache.put(path, response);
        })
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name.startsWith('vempify-shell-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isBypassed(url.pathname)) return;

  // Page loads go to the network first so a login redirect always wins;
  // the cached shell is only the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/', { ignoreSearch: true }).then(
          (cached) =>
            cached ||
            new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
        )
      )
    );
    return;
  }

  // Static shell assets: serve the cached copy immediately, but ALWAYS refetch
  // in the background and write the new response back (stale-while-revalidate).
  //
  // Plain cache-first was a trap. Navigations go to the network, so the HTML is
  // always current, while CSS and JS came from a cache that nothing ever
  // revalidated - so a device whose worker failed to update rendered new markup
  // against old styles indefinitely. iOS is particularly good at not updating a
  // worker in an installed PWA, so "the version bump will fix it" is not a
  // guarantee. This way the worst case is one stale load, self-healing on the
  // next, instead of a mismatch that persists until the cache is cleared by hand.
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      const fresh = fetch(request)
        .then((response) => {
          if (isCacheable(response)) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
