// Minimal service worker: no static asset caching, just passthrough.

self.addEventListener('install', (event) => {
  console.log('Service Worker: Installing (no static cache)...');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('Service Worker: Activating and clearing old caches...');
  event.waitUntil(
    caches.keys().then((cacheNames) => Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName))))
  );
  return self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Let non-GET requests and socket.io traffic pass through untouched
  if (request.method !== 'GET' || request.url.includes('/socket.io/')) {
    return;
  }

  event.respondWith(fetch(request));
});
