const CACHE_NAME = 'yesplaymusic-v1';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  // Network-first for API endpoints
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/song/') ||
      url.pathname.startsWith('/login/') ||
      url.pathname.startsWith('/captcha/')) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first for static assets
  if (url.pathname.startsWith('/js/') ||
      url.pathname.startsWith('/css/') ||
      url.pathname.startsWith('/img/') ||
      url.pathname.startsWith('/fonts/')) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((resp) => {
          if (resp && resp.status === 200 && resp.type === 'basic') {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return resp;
        });
      })
    );
    return;
  }

  // Default: network-first for navigation, fallback to cache
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          return resp;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Cache-first for everything else
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return resp;
      });
    })
  );
});

// Keepalive message handler - prevents Tesla from killing the tab
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'KEEPALIVE') {
    event.waitUntil(
      fetch('/api/unblock?keepalive=1', {
        method: 'GET',
        headers: { 'Cache-Control': 'no-cache' },
      }).catch(() => {})
    );
  }
});

// Periodic sync for background music
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'keep-alive') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'SYNC_STATE' });
        });
      })
    );
  }
});
