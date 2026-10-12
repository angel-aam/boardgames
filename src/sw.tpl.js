/* Service worker de Mesa de Juegos (plantilla; build.js rellena versión y lista de módulos → public/sw.js)
   - Núcleo («/» y «/game/*»): red primero y copia en caché como respaldo sin conexión.
   - Módulos («/m/*», con hash en el nombre = inmutables): caché primero.
   - Mensaje {t:'all'}: descarga todos los módulos para jugar sin conexión (responde por el puerto).
   No intercepta WebSockets (/ws/*) ni /api/*: las salas online siguen requiriendo conexión. */
const V = '__VERSION__', CORE = 'mj-core-' + V, MOD = 'mj-mods';
const MODS = __MODS__;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CORE).then(c => c.add(new Request('/', { cache: 'reload' }))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('mj-core-') && k !== CORE) await caches.delete(k);
    const c = await caches.open(MOD);
    for (const r of await c.keys()) if (MODS.indexOf(new URL(r.url).pathname) < 0) await c.delete(r);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.indexOf('/m/') === 0) {
    e.respondWith(caches.open(MOD).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok) c.put(req, r.clone());
      return r;
    }));
    return;
  }
  if (req.mode === 'navigate' && (url.pathname === '/' || url.pathname.indexOf('/game/') === 0)) {
    e.respondWith((async () => {
      try {
        const r = await fetch(req);
        if (r.ok) (await caches.open(CORE)).put('/', r.clone());
        return r;
      } catch (err) {
        const hit = await caches.match('/');
        if (hit) return hit;
        throw err;
      }
    })());
  }
});
self.addEventListener('message', e => {
  if (!e.data || e.data.t !== 'all') return;
  const port = e.ports && e.ports[0];
  e.waitUntil((async () => {
    const c = await caches.open(MOD);
    for (const u of MODS) if (!(await c.match(u))) { const r = await fetch(u); if (r.ok) await c.put(u, r); }
    if (port) port.postMessage({ ok: true, n: MODS.length });
  })().catch(() => { if (port) port.postMessage({ ok: false }); }));
});
