// Guarda la app en el móvil para usarla sin cobertura. Con cobertura pide siempre la última versión
// (espera como mucho 2,5 s); sin ella, sirve la copia guardada.
const CACHE = 'smartball-3.0';
const FILES = ['./', './index.html', './manifest.webmanifest', './icon.svg',
  './fonts/anton-latin-400-normal.woff2', './fonts/atkinson-hyperlegible-latin-400-normal.woff2', './fonts/atkinson-hyperlegible-latin-700-normal.woff2'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('smartball-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const cached = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request, { cache: 'no-cache' }).then((r) => { if (r && r.ok) c.put(e.request, r.clone()); return r; });
    if (!cached) return net.catch(() => new Response('Sin conexión', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
    return Promise.race([net.catch(() => cached), new Promise((res) => setTimeout(() => res(cached), 2500))]);
  })());
});
