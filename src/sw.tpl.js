/* Service worker de Mesa de Juegos (PWA; plantilla: build.js rellena versión y listas → public/sw.js)
   - Instalación: guarda el núcleo («/»), el manifiesto y los iconos.
   - Precarga de todos los juegos (fill) SOLO en la app instalada (el cliente manda keep=true) o tras «Guardar juegos en este
     dispositivo» ({t:'all'}); queda recordado en «/__full». En el navegador cada juego se guarda al abrirlo (caché primero).
   - Núcleo («/» y «/game/*»): se abre al instante con la copia guardada y se actualiza en segundo plano (la próxima apertura
     usa la nueva). Sin copia, red. Cualquier dirección de juego o «/?…» recibe el mismo núcleo.
   - Versiones: al activarse se conservan también los módulos de la versión anterior («/__cur»), porque una pestaña abierta
     con el núcleo viejo aún los pide; si hay versión nueva se avisa a las ventanas con {t:'updated', b} (b = id del build).
   - Módulos («/m/*», con hash en el nombre = inmutables) e iconos: caché primero.
   - «offline-<l>.html»: solo bajo demanda (al pulsar «Descarga offline»): red primero y copia en caché como respaldo.
   - Mensaje {t:'all', l}: activa y hace la precarga completa (responde por el puerto).
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
const V = '__VERSION__', B = '__BUILD__', CORE = 'mj-core-' + V, MOD = 'mj-mods';
const MODS = __MODS__;
const SHELL = __SHELL__;

/* idioma de los diccionarios: «/m/lang-en.<hash>.js» o «/m/en-<módulo>.<hash>.js» → 'en'; '' si no es un diccionario */
const DICT = /^\/m\/(?:lang-([a-z]{2})|([a-z]{2})-[a-z0-9-]+)\.[0-9a-f]+\.js$/, MID = /^\/m\/([a-z0-9-]+)\.[0-9a-f]+\.js$/;
const IDS = new Set(MODS.map(u => (MID.exec(u) || [])[1]).filter(Boolean));
const dictLang = u => {
  const m = DICT.exec(u); if (m) return m[1] || m[2];
  const id = (MID.exec(u) || [])[1]; if (!id) return '';
  const v = /^(.+)-([a-z]{2})$/.exec(id); if (v && IDS.has(v[1])) return v[2];
  return [...IDS].some(x => x.startsWith(id + '-') && /^[a-z]{2}$/.test(x.slice(id.length + 1))) ? 'es' : '';
};
const isJs = r => r.ok && /javascript/i.test(r.headers.get('content-type') || '');
const META = 'mj-meta';
const meta = async (k, v) => { const c = await caches.open(META); if (v === undefined) { const r = await c.match(k); return r ? r.text() : null; } await c.put(k, new Response(v)); };
const getLang = async () => (await meta('/__lang')) || '';
const getLangs = async () => { try { const a = JSON.parse((await meta('/__langs')) || 'null'); if (Array.isArray(a)) return a; } catch (err) { /* sin lista */ } const l = await getLang(); return l ? [l] : []; };
/* borra lo de idiomas no guardados y, si la precarga completa está activada, baja los módulos que falten */
const fill = async () => {
  const c = await caches.open(MOD), langs = await getLangs(), ok = l => !l || langs.includes(l);
  for (const r of await c.keys()) if (!ok(dictLang(new URL(r.url).pathname))) await c.delete(r);
  const k = await caches.open(CORE), offs = langs.map(l => '/offline-' + l + '.html');
  for (const r of await k.keys()) { const p = new URL(r.url).pathname; if (/^\/offline(-[a-z]{2})?\.html$/.test(p) && !offs.includes(p)) await k.delete(r); }
  if ((await meta('/__full')) !== '1') return;
  for (const u of MODS) { if (!ok(dictLang(u))) continue; if (!(await c.match(u))) { const r = await fetch(u); if (isJs(r)) await c.put(u, r); } }
};
/* fija el idioma de la app; keep = conservar los otros ya guardados (app instalada). Devuelve los otros si l es nuevo */
const useLang = async (l, keep) => {
  const cur = await getLangs(), next = keep ? (cur.includes(l) ? cur : cur.concat(l)) : [l];
  await meta('/__lang', l); await meta('/__langs', JSON.stringify(next));
  if (keep) await meta('/__full', '1');   /* app instalada: todo guardado para jugar sin conexión */
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
    /* se conservan los módulos de esta versión y de la anterior (pestañas abiertas con el núcleo viejo) */
    let prev = []; try { prev = JSON.parse((await meta('/__cur')) || '[]'); } catch (err) { prev = []; }
    const keep = new Set(MODS.concat(Array.isArray(prev) && JSON.stringify(prev) !== JSON.stringify(MODS) ? prev : []));
    const c = await caches.open(MOD);
    for (const r of await c.keys()) if (!keep.has(new URL(r.url).pathname)) await c.delete(r);
    const had = await meta('/__build');
    await meta('/__cur', JSON.stringify(MODS)); await meta('/__build', B);
    await self.clients.claim();
    if (had && had !== B) await tell({ t: 'updated', b: B });
    try { await fill(); } catch (err) { /* sin red ahora: se completará al abrir cada juego o con «Guardar juegos» */ }
  })());
});
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
      if (p.indexOf('/m/') === 0) {
        /* un módulo que ya no existe puede llegar como index.html (SPA): se devuelve 404 y nunca se guarda */
        if (!isJs(r)) return new Response('', { status: 404 });
        (await caches.open(MOD)).put(req, r.clone());
      }
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
    /* al instante con la copia guardada; la red la actualiza en segundo plano para la próxima vez */
    let put = null;
    const net = fetch(req).then(r => { if (r.ok) { const cp = r.clone(); put = caches.open(CORE).then(c => c.put('/', cp)); } return r; });
    e.waitUntil(net.then(() => put).catch(() => {}));
    e.respondWith(caches.match('/').then(hit => hit || net));
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
  e.waitUntil((l ? useLang(l, !!d.keep) : Promise.resolve()).then(() => meta('/__full', '1')).then(fill).then(() => { if (port) port.postMessage({ ok: true, n: MODS.length }); }).catch(() => { if (port) port.postMessage({ ok: false }); }));
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
