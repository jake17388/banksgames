/*
 * Banks Games service worker.
 *
 * Strategy:
 *   - HTML documents (navigations): NETWORK FIRST, so a fresh deploy is picked
 *     up on the next load instead of being pinned to a stale shell forever.
 *   - Static assets (css/js/icons/manifest): CACHE FIRST, revalidated in the
 *     background so the second load is instant but never permanently stale.
 *   - Anything cross-origin (Firebase, gstatic CDN): NOT TOUCHED. Realtime
 *     Database uses long-lived streaming connections and must never be cached.
 *
 * Bump CACHE_VERSION whenever you want every client to drop its old cache.
 */

const CACHE_VERSION = 'v1';
const CACHE_NAME = `banksgames-${CACHE_VERSION}`;

// Relative to the service worker's location, which is the repo root, so these
// resolve correctly under the /banksgames/ subpath.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/router.js',
  './js/session.js',
  './js/db.js',
  './js/firebaseconfig.js',
  './js/home.js',
  './js/lobby.js',
  './js/games/registry.js',
  './js/games/mahjong/rules.js',
  './js/games/mahjong/ui.js',
  './icons/icon192.png',
  './icons/icon512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // addAll is all-or-nothing; add individually so one 404 cannot brick install.
      await Promise.all(
        APP_SHELL.map((url) => cache.add(url).catch((err) => {
          console.warn('[sw] could not pre-cache', url, err);
        }))
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('banksgames-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

function isHtmlRequest(request) {
  if (request.mode === 'navigate') return true;
  const accept = request.headers.get('accept') || '';
  return accept.includes('text/html');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Leave every cross-origin request alone: Firebase auth, the Realtime
  // Database socket, and the firebasejs CDN modules all live off-origin.
  if (url.origin !== self.location.origin) return;

  if (isHtmlRequest(request)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = (await cache.match(request)) || (await cache.match('./index.html')) || (await cache.match('./'));
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  if (cached) {
    // Refresh in the background; the current load still gets the fast path.
    network;
    return cached;
  }

  const response = await network;
  if (response) return response;
  return new Response('Offline and not cached.', { status: 504, statusText: 'Offline' });
}
