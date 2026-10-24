/* Service worker: aplikacija radi i bez interneta (osim prvog preuzimanja OCR jezika). */
const CACHE = 'skladiste-v1';
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Vanjski resursi (Tesseract, jezični paketi): prvo iz cachea, inače s mreže i spremi.
  if (url.origin !== location.origin) {
    e.respondWith(caches.open(CACHE + '-ext').then(async c => {
      const hit = await c.match(e.request); if (hit) return hit;
      const res = await fetch(e.request); if (res.ok || res.type === 'opaque') c.put(e.request, res.clone()); return res;
    }).catch(() => fetch(e.request)));
    return;
  }
  // Vlastiti resursi: mreža pa cache (da ažuriranja stignu), offline iz cachea.
  e.respondWith(fetch(e.request).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html'))));
});
