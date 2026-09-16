// Service worker: enables push notifications and offline app-shell caching
// for "Add to Home Screen". Deliberately minimal — this app always needs a
// live connection to see real inventory/requests, so we don't try to cache
// API responses, just the shell that lets the app boot and receive pushes.

const CACHE = 'ferrier-shell-v1';
const SHELL_FILES = ['/', '/styles.css', '/app.js', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Network-first for everything; fall back to the cached shell only when
  // fully offline, and only for shell files (never API calls).
  if (event.request.method !== 'GET' || event.request.url.includes('/api/')) return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

self.addEventListener('push', (event) => {
  let data = { title: 'Ferrier Field Inventory', body: 'You have a new alert.' };
  try { data = event.data.json(); } catch (e) { /* keep default */ }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Ferrier Field Inventory', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url || '/#admin' },
      tag: data.requestId || undefined,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/#admin';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus().then(() => client.navigate ? client.navigate(url) : null);
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
