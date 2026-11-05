// Offline support: the app shell loads without a connection; tasks live in the page's own storage
// and the outbox syncs when the connection returns. /api is never cached.
const CACHE = 'ticket-desk-v2';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/apple-touch-icon.png', '/icons/badge-96.png', '/vendor/qrcode.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    // Network first so updates arrive immediately; cached shell when offline.
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('/', copy)); }
      return res;
    }).catch(() => caches.match('/')));
    return;
  }
  const cacheable = url.origin === self.location.origin || /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(url.hostname);
  if (!cacheable) return;
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    });
    return hit || net;
  }));
});

// Notifications: guest tickets and the morning summary (sent by /api/guest and /api/digest).
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Ticket Desk', {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag,
    icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => new URL(c.url).origin === self.location.origin);
    if (open) return open.focus();          // focusing makes the app sync, so the new ticket shows up
    return self.clients.openWindow(target);
  }));
});
