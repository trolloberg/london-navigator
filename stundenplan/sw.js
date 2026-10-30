// Offline-Cache und Erinnerungen für Schedule. VERSION erhöhen, um Updates auszuliefern.
const VERSION = 'sp-v3.1.0'; // v3.1.0: Ausweichen beim Verschieben, Hineinlegen, Rückgängig/Wiederholen, keine Reste ausgefallener Blocker
const CORE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('sp-') && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(new URL('./', self.registration.scope).pathname)) return;
  e.respondWith(caches.open(VERSION).then(async c => {
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then(r => { if (r && r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const r = await net;
    return r || (req.mode === 'navigate' ? c.match('./index.html') : Response.error());
  }));
});

// Erinnerungen: Der Push-Server schickt nur die Uhrzeit. Name und Text kommen aus dem Plan auf dem Gerät.
function kv(key){
  return new Promise(res => {
    const r = indexedDB.open('schedule', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onerror = () => res(null);
    r.onsuccess = () => {
      const db = r.result;
      try { const g = db.transaction('kv').objectStore('kv').get(key); g.onsuccess = () => { res(g.result ?? null); db.close(); }; g.onerror = () => { res(null); db.close(); }; }
      catch (e) { res(null); db.close(); }
    };
  });
}
async function showPush(d){
  const reg = self.registration, opt = { icon: 'icon-192.png', badge: 'icon-192.png' };
  if (d.test){
    const t = await kv('test');
    return reg.showNotification((t && t.title) || 'Schedule', { ...opt, body: (t && t.body) || '', tag: 'test' });
  }
  const plan = (await kv('plan')) || [], at = +d.t || Date.now();
  let best = null;
  for (const x of plan){ const dt = Math.abs(x.t - at); if (dt <= 10 * 60e3 && (!best || dt < Math.abs(best.t - at))) best = x; }
  if (best){
    const all = plan.filter(x => Math.abs(x.t - best.t) < 60e3);
    const title = all.length > 1 ? all.map(x => x.title).join(' · ') : best.title;
    const body = all.length > 1 ? all.map(x => x.body.split(' · ')[0]).join(' · ') : best.body;
    return reg.showNotification(title, { ...opt, body, tag: best.tag, data: { t: best.t } });
  }
  const f = await kv('fallback');
  return reg.showNotification((f && f.title) || 'Schedule', { ...opt, body: (f && f.body) || '', tag: 'fallback' });
}
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(showPush(d || {}));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) if ('focus' in c) return c.focus();
    return self.clients.openWindow('./');
  })());
});
