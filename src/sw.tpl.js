/* Service worker de Mesa de Juegos (PWA; plantilla: build.js rellena versión y listas → public/sw.js)
   - Instalación: guarda el núcleo («/»), el manifiesto y los iconos. Al activarse descarga en segundo plano todos los juegos
     y la copia «offline-<idioma>.html», así la app instalada funciona sin conexión sin pulsar nada.
   - Núcleo («/» y «/game/*»): red primero (con 4 s de espera si hay copia) y la copia en caché como respaldo sin conexión.
     Cualquier dirección de juego o «/?…» sin red recibe el mismo núcleo guardado.
   - Módulos («/m/*», con hash en el nombre = inmutables) e iconos: caché primero.
   - «offline-<l>.html»: red primero y copia en caché como respaldo (para «Descarga offline» sin red); solo la del idioma.
   - Mensaje {t:'all', l}: fuerza la descarga de todos los módulos (responde por el puerto).
   - Idiomas: los módulos de un idioma solo se precargan para los idiomas guardados («/__langs» en la caché «mj-meta»; el de
     la app en «/__lang»). El cliente manda {t:'lang', l, keep}: en el navegador (keep=false) queda solo l y se borran los demás;
     en la app instalada (keep=true) l se añade sin borrar los otros y, si es nuevo y ya había otro, se avisa a las ventanas
     con {t:'langadded', l, others} para que la persona elija conservarlo o borrarlo ({t:'drop', l}). Hasta saber el idioma
     (primera visita) no se precarga ningún módulo de idioma. Son de un idioma: los diccionarios de la interfaz
     («/m/lang-xx.*», «/m/xx-<módulo>.*») y las variantes de contenido («/m/<m>-xx.*», p. ej. scdict-en; entonces «/m/<m>.*»
     es la española). El español es el idioma fuente: no tiene diccionarios de interfaz.
   - Avisos (Web Push, salas online): «push» muestra la notificación {title, body, url, tag} salvo que la app esté a la vista;
     al tocarla se enfoca la pestaña abierta o se abre url (la app vuelve sola a la sala con la sesión guardada).
   No intercepta WebSockets (/ws/*) ni /api/*: las salas online siguen requiriendo conexión; las salas por QR (WebRTC en la red local) no la necesitan. */
const V = '__VERSION__', CORE = 'mj-core-' + V, MOD = 'mj-mods';
const MODS = __MODS__;
const SHELL = __SHELL__;
const WAIT = 4000;

/* idioma de los diccionarios: «/m/lang-en.<hash>.js» o «/m/en-<módulo>.<hash>.js» → 'en'; '' si no es un diccionario */
const DICT = /^\/m\/(?:lang-([a-z]{2})|([a-z]{2})-[a-z0-9-]+)\.[0-9a-f]+\.js$/, MID = /^\/m\/([a-z0-9-]+)\.[0-9a-f]+\.js$/;
const IDS = new Set(MODS.map(u => (MID.exec(u) || [])[1]).filter(Boolean));
const dictLang = u => {
  const m = DICT.exec(u); if (m) return m[1] || m[2];
  const id = (MID.exec(u) || [])[1]; if (!id) return '';
  const v = /^(.+)-([a-z]{2})$/.exec(id); if (v && IDS.has(v[1])) return v[2];
  return [...IDS].some(x => x.startsWith(id + '-') && /^[a-z]{2}$/.test(x.slice(id.length + 1))) ? 'es' : '';
};
const META = 'mj-meta';
const meta = async (k, v) => { const c = await caches.open(META); if (v === undefined) { const r = await c.match(k); return r ? r.text() : null; } await c.put(k, new Response(v)); };
const getLang = async () => (await meta('/__lang')) || '';
const getLangs = async () => { try { const a = JSON.parse((await meta('/__langs')) || 'null'); if (Array.isArray(a)) return a; } catch (err) { /* sin lista */ } const l = await getLang(); return l ? [l] : []; };
const fill = async () => {
  const c = await caches.open(MOD), langs = await getLangs(), ok = l => !l || langs.includes(l);
  for (const r of await c.keys()) if (!ok(dictLang(new URL(r.url).pathname))) await c.delete(r);
  for (const u of MODS) { if (!ok(dictLang(u))) continue; if (!(await c.match(u))) { const r = await fetch(u); if (r.ok) await c.put(u, r); } }
  const k = await caches.open(CORE), offs = langs.map(l => '/offline-' + l + '.html');
  for (const r of await k.keys()) { const p = new URL(r.url).pathname; if (/^\/offline(-[a-z]{2})?\.html$/.test(p) && !offs.includes(p)) await k.delete(r); }
  for (const off of offs) if (!(await k.match(off))) { const r = await fetch(off); if (r.ok) await k.put(off, r); }
};
/* fija el idioma de la app; keep = conservar los otros ya guardados (app instalada). Devuelve los otros si l es nuevo */
const useLang = async (l, keep) => {
  const cur = await getLangs(), next = keep ? (cur.includes(l) ? cur : cur.concat(l)) : [l];
  await meta('/__lang', l); await meta('/__langs', JSON.stringify(next));
  return keep && !cur.includes(l) ? cur.slice() : [];
};
const tell = async m => { for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage(m); };

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
  if (/^\/offline-[a-z]{2}\.html$/.test(p)) {
    e.respondWith((async () => {
      try {
        const r = await fetch(req);
        if (r.ok) (await caches.open(CORE)).put(p, r.clone());
        return r;
      } catch (err) {
        const hit = await caches.match(p);
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
  const d = e.data || {};
  if (d.t === 'lang' && /^[a-z]{2}$/.test(d.l)) {
    e.waitUntil((async () => {
      const before = JSON.stringify([await getLang(), await getLangs()]);
      const others = await useLang(d.l, !!d.keep);
      if (JSON.stringify([await getLang(), await getLangs()]) === before) return;
      try { await fill(); } catch (err) { return; /* sin red: se completará después */ }
      if (others.length) await tell({ t: 'langadded', l: d.l, others });
    })());
    return;
  }
  /* la persona no quiere conservar otro idioma en el dispositivo (nunca el de la app) */
  if (d.t === 'drop' && /^[a-z]{2}$/.test(d.l)) {
    e.waitUntil((async () => { if (d.l === (await getLang())) return; await meta('/__langs', JSON.stringify((await getLangs()).filter(x => x !== d.l))); await fill(); })());
    return;
  }
  if (d.t !== 'all') return;
  const port = e.ports && e.ports[0], l = /^[a-z]{2}$/.test(d.l || '') ? d.l : '';
  e.waitUntil((l ? useLang(l, !!d.keep) : Promise.resolve()).then(fill).then(() => { if (port) port.postMessage({ ok: true, n: MODS.length }); }).catch(() => { if (port) port.postMessage({ ok: false }); }));
});
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (err) { d = {}; }
  e.waitUntil((async () => {
    const cl = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (cl.some(c => c.visibilityState === 'visible')) return;   /* la app ya está a la vista: no hace falta avisar */
    await self.registration.showNotification(String(d.title || 'Mesa de Juegos'), {
      body: String(d.body || ''), tag: String(d.tag || 'mj'), renotify: true, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
      data: { url: typeof d.url === 'string' && d.url.charAt(0) === '/' ? d.url : '/' }
    });
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const cl = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const c = cl.find(x => new URL(x.url).origin === location.origin);
    if (c) { try { await c.focus(); return; } catch (err) { /* no se pudo enfocar: se abre otra */ } }
    await self.clients.openWindow(url);
  })());
});
