// Minimal service worker: it shows reminders to play (see push.js), and that's all. It has no fetch handler on purpose:
// one that only passed every request on to the network still had to be started up before each page could load (and it
// stood between the admin page and its sign-in), for nothing - the browser does the same by itself.

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

// A reminder (see push.js), which comes whether or not the game is open. It takes the place of one still showing from
// another day, and renotify is what makes that alert them instead of swapping it silently.
self.addEventListener('push', (event) => {
  const { title, body, url } = event.data.json();
  event.waitUntil(self.registration.showNotification(title, { body, icon: '/icon-192.png?v=2', tag: 'reminder', renotify: true, data: { url } }));
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
