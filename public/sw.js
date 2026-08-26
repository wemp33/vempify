/* Bumped to v3 with the traced logo: a device holding the v2 shell would keep
   serving the old placeholder mark from cache. The activate handler below
   deletes every other vempify-shell-* cache, so the bump is what actually
   retires the stale icons. */
const CACHE_NAME = 'vempify-shell-v3';

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
  '/js/ui/player.js',
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

  // Static shell assets: cache first, network as the fallback.
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => cached || fetch(request))
  );
});
