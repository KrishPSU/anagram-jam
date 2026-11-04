// Minimal service worker: no static asset caching, just passthrough - and it shows reminders to play (see push.js).

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

// A reminder (see push.js), which comes whether or not the game is open
self.addEventListener('push', (event) => {
  const { title, body, url } = event.data.json();
  event.waitUntil(self.registration.showNotification(title, { body, icon: '/icon-192.png?v=2', tag: 'reminder', data: { url } }));
});

// Tapped: to that page, if it's open already
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url } = event.notification.data;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find(client => new URL(client.url).pathname.startsWith(url));
      return open ? open.focus() : clients.openWindow(url);
    })
  );
});
