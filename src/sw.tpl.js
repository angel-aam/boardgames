/* Service worker de Mesa de Juegos (PWA; plantilla: build.js rellena versión y listas → public/sw.js)
   - Instalación: guarda el núcleo («/»), el manifiesto y los iconos. Al activarse descarga en segundo plano todos los juegos
     y la copia «offline.html», así la app instalada funciona sin conexión sin pulsar nada.
   - Núcleo («/» y «/game/*»): red primero (con 4 s de espera si hay copia) y la copia en caché como respaldo sin conexión.
     Cualquier dirección de juego o «/?…» sin red recibe el mismo núcleo guardado.
   - Módulos («/m/*», con hash en el nombre = inmutables) e iconos: caché primero.
   - «offline.html»: red primero y copia en caché como respaldo (para «Descarga offline» sin red).
   - Mensaje {t:'all'}: fuerza la descarga de todos los módulos (responde por el puerto).
   No intercepta WebSockets (/ws/*) ni /api/*: las salas online siguen requiriendo conexión; las salas por QR (WebRTC en la red local) no la necesitan. */
const V = '__VERSION__', CORE = 'mj-core-' + V, MOD = 'mj-mods';
const MODS = __MODS__;
const SHELL = __SHELL__;
const WAIT = 4000;

const fill = async () => {
  const c = await caches.open(MOD);
  for (const u of MODS) if (!(await c.match(u))) { const r = await fetch(u); if (r.ok) await c.put(u, r); }
  const k = await caches.open(CORE);
  if (!(await k.match('/offline.html'))) { const r = await fetch('/offline.html'); if (r.ok) await k.put('/offline.html', r); }
};

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CORE);
    await c.add(new Request('/', { cache: 'reload' }));
    for (const u of SHELL) { try { await c.add(u); } catch (err) { /* un icono que falle no impide instalar */ } }
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('mj-core-') && k !== CORE) await caches.delete(k);
    const c = await caches.open(MOD);
    for (const r of await c.keys()) if (MODS.indexOf(new URL(r.url).pathname) < 0) await c.delete(r);
    await self.clients.claim();
    try { await fill(); } catch (err) { /* sin red ahora: se completará al abrir cada juego o con «Guardar juegos» */ }
  })());
});
const timeout = (ms, v) => new Promise(r => setTimeout(() => r(v), ms));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const p = url.pathname;
  if (p.indexOf('/m/') === 0 || p.indexOf('/icons/') === 0) {
    e.respondWith(caches.match(req).then(async hit => {
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok && p.indexOf('/m/') === 0) (await caches.open(MOD)).put(req, r.clone());
      return r;
    }));
    return;
  }
  if (p === '/manifest.webmanifest') {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }
  if (p === '/offline.html') {
    e.respondWith((async () => {
      try {
        const r = await fetch(req);
        if (r.ok) (await caches.open(CORE)).put('/offline.html', r.clone());
        return r;
      } catch (err) {
        const hit = await caches.match('/offline.html');
        if (hit) return hit;
        throw err;
      }
    })());
    return;
  }
  if (req.mode === 'navigate' && (p === '/' || p.indexOf('/game/') === 0)) {
    e.respondWith((async () => {
      const hit = await caches.match('/');
      const net = fetch(req).then(r => { if (r.ok) caches.open(CORE).then(c => c.put('/', r.clone())); return r; });
      if (!hit) return net;
      /* con copia guardada: si la red tarda o falla se abre al instante lo guardado */
      try { return (await Promise.race([net, timeout(WAIT, hit)])) || hit; } catch (err) { return hit; }
    })());
  }
});
self.addEventListener('message', e => {
  if (!e.data || e.data.t !== 'all') return;
  const port = e.ports && e.ports[0];
  e.waitUntil(fill().then(() => { if (port) port.postMessage({ ok: true, n: MODS.length }); }).catch(() => { if (port) port.postMessage({ ok: false }); }));
});
