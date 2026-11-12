// Mudviejų ratas — pranešimų service worker
const FS = 'https://firestore.googleapis.com/v1/projects/mudvieju-ratas/databases/(default)/documents';
const KEY = 'AIzaSyB-6u2upI9AeED4Xqa0oGJxYvm0QVPPr34';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
async function cfg() { try { const c = await caches.open('ratas-cfg'); const r = await c.match(new URL('cfg', self.registration.scope)); return r ? r.json() : null } catch (e) { return null } }
self.addEventListener('push', e => e.waitUntil((async () => {
  let title = 'Mudviejų ratas', body = 'Yra naujienų 💌';
  try {
    const c = await cfg();
    if (c && c.room && c.me) {
      const r = await fetch(`${FS}/rooms/${c.room}/inbox/${c.me}?key=${KEY}`, { cache: 'no-store' });
      if (r.ok) { const d = await r.json(), f = d.fields || {}; title = (f.title && f.title.stringValue) || title; body = (f.body && f.body.stringValue) || body }
    }
  } catch (err) {}
  await self.registration.showNotification(title, { body, icon: 'icon-192.png', badge: 'icon-192.png', tag: 'ratas', renotify: true });
})()));
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) if ('focus' in w) return w.focus();
    return self.clients.openWindow(self.registration.scope);
  }));
});
