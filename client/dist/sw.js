const CACHE_NAME = 'chore-quest-v3';
const APP_SHELL = ['/', '/manifest.webmanifest', '/icon.svg', '/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin || new URL(event.request.url).pathname.startsWith('/api/')) return;
  event.respondWith(caches.open(CACHE_NAME).then(async (cache) => {
    try {
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    } catch {
      return (await cache.match(event.request)) || (await cache.match('/'));
    }
  }));
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { payload = { body: event.data?.text() || 'A chore is ready!' }; }
  event.waitUntil(self.registration.showNotification(payload.title || 'Chore Quest', {
    body: payload.body || 'It’s your turn to help!',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: 'chore-turn',
    data: { url: payload.url || '/' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destination = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => client.url === destination);
    if (existing) return existing.focus();
    return self.clients.openWindow(destination);
  }));
});
