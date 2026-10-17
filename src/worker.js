/* Servidor de salas de «Mesa de Juegos» (Cloudflare Workers + Durable Objects).
   No conoce ningún juego: solo reenvía mensajes entre quienes están en la misma sala. El anfitrión sigue siendo quien aplica las reglas.
   Rutas:
     GET /api/ping            -> "mesa-ok" (el cliente comprueba que el servidor existe)
     GET /api/push-key        -> clave pública VAPID (texto) para suscribirse a avisos; 404 si no hay secreto VAPID_JWK
     GET /ws/room/<codigo>    -> WebSocket de una sala (un Durable Object por código)
     GET /ws/lobby            -> WebSocket del listado de salas abiertas (un único Durable Object)
     GET /game/<id>           -> el mismo index.html (enlace directo a un juego para marcadores); el cliente abre <id>
     GET /game/<id>/<CÓDIGO>  -> ídem; enlace compartido de una sala online (el cliente se une o la crea)
     GET /                    -> index.html
     resto                    -> páginas estáticas de ./public
   Protocolo de sala (JSON):
     servidor -> cliente  {t:'hello', me, peers:[ids]} | {t:'join', peer} | {t:'leave', peer} | {t:'m', from, to, m}
     cliente  -> servidor {to:'*'|id, m:{...}}   (el texto «ping» recibe «pong» sin despertar al objeto)
   Avisos (Web Push, para quien tiene el móvil bloqueado o la app en segundo plano), mensajes al propio servidor de la sala:
     cliente  -> servidor {t:'psub', d, h, sub}   guarda (o borra con sub null) la suscripción del dispositivo d (h=1 anfitrión)
                          {t:'push', to:d|'host', k:'start'|'turn'|'join', gn, ge, gm, n}   avisa con un texto fijo según k,
                          en el idioma del destinatario (l del psub: 'es'|'en'; ge = nombre del juego en inglés)
     servidor -> cliente  {t:'pushed', k, ok}
     Las suscripciones se guardan en el almacenamiento del objeto de la sala y se borran 12 h después de quedar vacía.
   Listado de salas: si el anfitrión pierde la conexión (móvil bloqueado) su sala sigue listada GRACE ms marcada off:1. */
import { DurableObject } from 'cloudflare:workers';
import { vapid, sendPush, validSub } from './push.js';

const MAX_PEERS = 8;          /* jugadores por sala */
const MAX_MSG = 128 * 1024;   /* bytes por mensaje */
const RATE = 40;              /* mensajes por segundo y conexión (ráfaga 80) */
const BURST = 80;
const MAX_ROOMS_LISTED = 40;
const GRACE = 5 * 60 * 1000;          /* sala listada tras caerse la conexión del anfitrión */
const SUB_TTL = 12 * 3600 * 1000;     /* vida de las suscripciones de una sala vacía */
const MAX_SUBS = 16;                  /* suscripciones por sala */
const PUSH_GAP = 20 * 1000;           /* mínimo entre avisos al mismo dispositivo */
const PUSH_HOUR = 120;                /* avisos por sala y hora */
const DEV = /^[a-z0-9]{4,24}$/;
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, n);
/* textos fijos de los avisos: el cliente solo elige el tipo y aporta el nombre del juego y del jugador */
const PUSH_TXT = {
  start: (gn, n) => ({ title: '¡Empieza la partida!', body: gn + ': ' + (n ? n + ' ha empezado' : 'ha empezado') + ' la partida. Toca para volver.' }),
  turn: gn => ({ title: 'Te toca', body: gn + ': es tu turno.' }),
  join: (gn, n) => ({ title: 'Alguien quiere jugar', body: (n || 'Un jugador') + ' quiere entrar en tu sala de ' + gn + '.' })
};
const PUSH_TXT_EN = {
  start: (gn, n) => ({ title: 'The game is starting!', body: gn + ': ' + (n ? n + ' has started' : 'the game has started') + '. Tap to go back.' }),
  turn: gn => ({ title: 'Your turn', body: gn + ': it\'s your turn.' }),
  join: (gn, n) => ({ title: 'Someone wants to play', body: (n || 'A player') + ' wants to join your ' + gn + ' room.' })
};

const okOrigin = (req, env) => {
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return true;
  const o = req.headers.get('Origin') || 'null';
  try { if (o !== 'null' && new URL(o).host === new URL(req.url).host) return true; } catch (e) { /* origen raro */ }
  return list.includes(o);
};
const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };

/* Enlaces directos (/game/<id>, /game/<id>/<CÓDIGO>): los sirven los assets (not_found_handling SPA en wrangler.jsonc) con el
   mismo index.html, que ya lleva window.MJ_PATHS=1 desde build.js; el worker solo atiende /api/* y /ws/*. */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/api/ping') return new Response('mesa-ok', { headers: cors });
    if (url.pathname === '/api/push-key') {
      const v = await vapid(env);
      return v ? new Response(v.pub, { headers: cors }) : new Response('', { status: 404, headers: cors });
    }
    const m = url.pathname.match(/^\/ws\/(?:room\/([A-Za-z]{1,8})|(lobby))$/);
    if (!m) return env.ASSETS ? env.ASSETS.fetch(req) : new Response('No encontrado', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Se espera una conexión WebSocket', { status: 426 });
    if (!okOrigin(req, env)) return new Response('Origen no permitido', { status: 403 });
    const stub = m[1] ? env.ROOM.get(env.ROOM.idFromName(m[1].toLowerCase())) : env.LOBBY.get(env.LOBBY.idFromName('lobby'));
    return stub.fetch(req);
  }
};

/* Limitador de ritmo por conexión, guardado en el «attachment» del socket (sobrevive a la hibernación) */
function allow(ws, a) {
  const now = Date.now(), dt = Math.max(0, now - (a.ts || now)) / 1000;
  const tok = Math.min(BURST, (a.tok == null ? BURST : a.tok) + dt * RATE);
  a.ts = now;
  if (tok < 1) { a.tok = tok; ws.serializeAttachment(a); return false; }
  a.tok = tok - 1; ws.serializeAttachment(a); return true;
}
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8);
const send = (ws, o) => { try { ws.send(typeof o === 'string' ? o : JSON.stringify(o)); } catch (e) { /* conexión cerrada */ } };

function accept(self) {
  const pair = new WebSocketPair(), client = pair[0], server = pair[1];
  self.ctx.acceptWebSocket(server);
  return { client, server };
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  async fetch(req) {
    const others = this.ctx.getWebSockets();
    if (others.length >= MAX_PEERS) return new Response('Sala llena', { status: 403 });
    const { client, server } = accept(this);
    const id = newId();
    server.serializeAttachment({ id, tok: BURST, ts: Date.now(), o: new URL(req.url).origin });
    const peers = others.map(s => (s.deserializeAttachment() || {}).id).filter(Boolean);
    send(server, { t: 'hello', me: id, peers });
    others.forEach(s => send(s, { t: 'join', peer: id }));
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_MSG) return;
    const a = ws.deserializeAttachment() || {};
    if (!allow(ws, a)) return;
    let d; try { d = JSON.parse(data); } catch (e) { return; }
    if (d && d.t === 'psub') { await this.psub(ws, a, d); return; }
    if (d && d.t === 'push') { const ok = await this.push(a, d); send(ws, { t: 'pushed', k: d.k, ok }); return; }
    if (!d || typeof d !== 'object' || !d.m || typeof d.m !== 'object' || Array.isArray(d.m)) return;
    const to = d.to;
    if (to !== '*' && (typeof to !== 'string' || to.length > 16)) return;
    const out = JSON.stringify({ t: 'm', from: a.id, to, m: d.m });
    for (const s of this.ctx.getWebSockets()) {
      if (s === ws) continue;
      if (to === '*' || (s.deserializeAttachment() || {}).id === to) send(s, out);
    }
  }
  /* guarda o borra la suscripción de este dispositivo */
  async psub(ws, a, d) {
    if (typeof d.d !== 'string' || !DEV.test(d.d)) return;
    a.d = d.d; ws.serializeAttachment(a);
    const st = this.ctx.storage, key = 'ps:' + d.d;
    if (d.sub == null) { await st.delete(key); return; }
    const sub = validSub(d.sub);
    if (!sub) return;
    await st.put(key, { sub, h: d.h === 1 ? 1 : 0, l: d.l === 'en' ? 'en' : 'es', ts: Date.now() });
    const all = await st.list({ prefix: 'ps:' });
    if (all.size > MAX_SUBS) { const old = [...all].sort((x, y) => x[1].ts - y[1].ts).slice(0, all.size - MAX_SUBS); await st.delete(old.map(x => x[0])); }
    await st.setAlarm(Date.now() + SUB_TTL);
  }
  /* envía un aviso a otro dispositivo de la sala (nunca al propio); textos fijos, límites por destino y por hora */
  async push(a, d) {
    const v = await vapid(this.env);
    if (!v || !PUSH_TXT[d.k] || !a.d) return false;
    const st = this.ctx.storage;
    let key = '';
    if (d.to === 'host') {
      let best = null;
      for (const [k, x] of await st.list({ prefix: 'ps:' })) if (x.h && k !== 'ps:' + a.d && (!best || x.ts > best[1].ts)) best = [k, x];
      if (best) key = best[0];
    } else if (typeof d.to === 'string' && DEV.test(d.to) && d.to !== a.d) key = 'ps:' + d.to;
    const rec = key && await st.get(key);
    if (!rec) return false;
    const now = Date.now();
    if (now - (rec.last || 0) < PUSH_GAP) return false;
    const hr = Math.floor(now / 3600000), pc = (await st.get('pc')) || { h: hr, n: 0 };
    if (pc.h !== hr) { pc.h = hr; pc.n = 0; }
    if (pc.n >= PUSH_HOUR) return false;
    pc.n++; rec.last = now;
    await st.put({ pc, [key]: rec });
    const gm = typeof d.gm === 'string' && /^[a-z0-9-]{1,24}$/.test(d.gm) ? d.gm : '';
    const en = rec.l === 'en', mk = (en ? PUSH_TXT_EN : PUSH_TXT)[d.k];
    const txt = mk((en && clean(d.ge, 24)) || clean(d.gn, 24) || 'Mesa de Juegos', clean(d.n, 14));
    try {
      const code = await sendPush(v, rec.sub, Object.assign(txt, { url: gm ? '/game/' + gm : '/', tag: 'mj-' + d.k }), this.env.VAPID_SUBJECT || a.o || 'https://example.com');
      if (code === 404 || code === 410) await st.delete(key);
      if (code >= 300) console.warn('push', d.k, code);
      return code < 300;
    } catch (e) { console.error('push', e && e.message); return false; }
  }
  async alarm() {
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(Date.now() + SUB_TTL);
    else await this.ctx.storage.deleteAll();
  }
  webSocketClose(ws) { this.left(ws); }
  webSocketError(ws) { this.left(ws); }
  left(ws) {
    const a = ws.deserializeAttachment() || {};
    try { ws.close(1000, 'bye'); } catch (e) { /* ya cerrado */ }
    this.ctx.getWebSockets().forEach(s => { if (s !== ws) send(s, { t: 'leave', peer: a.id }); });
  }
}

/* Listado de salas abiertas: cada anfitrión anuncia {rk, hn, c, st, gm}. Si su conexión se cae sin retirar el anuncio
   (móvil bloqueado), la sala sigue listada GRACE ms con off:1 («g:<rk>» en el almacenamiento) o hasta que vuelva a anunciarse */
export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  async fetch(req) {
    const { client, server } = accept(this);
    const id = newId();
    server.serializeAttachment({ id, tok: BURST, ts: Date.now(), info: null });
    send(server, { t: 'hello', me: id });
    send(server, await this.list());
    return new Response(null, { status: 101, webSocket: client });
  }
  async list(skip) {
    const rooms = [], live = new Set(), now = Date.now();
    for (const s of this.ctx.getWebSockets()) {
      if (s === skip) continue;   /* la conexión que se está cerrando */
      const a = s.deserializeAttachment() || {};
      if (a.info && a.info.rk) live.add(a.info.rk);
      if (a.info && a.info.rk && a.info.st === 0) rooms.push({ peer: a.id, presence: a.info });
    }
    for (const [, g] of await this.ctx.storage.list({ prefix: 'g:' })) {
      if (g.exp > now && !live.has(g.info.rk)) rooms.push({ peer: g.peer, presence: Object.assign({}, g.info, { off: 1 }) });
    }
    return { t: 'rooms', rooms: rooms.slice(0, MAX_ROOMS_LISTED) };
  }
  async cast(skip) { const o = JSON.stringify(await this.list(skip)); this.ctx.getWebSockets().forEach(s => send(s, o)); }
  async alarm() {
    const now = Date.now(), st = this.ctx.storage;
    let next = 0;
    for (const [k, g] of await st.list({ prefix: 'g:' })) {
      if (g.exp <= now) await st.delete(k); else next = next ? Math.min(next, g.exp) : g.exp;
    }
    if (next) await st.setAlarm(next);
    await this.cast();
  }
  /* la conexión de un anfitrión con la sala abierta se ha caído: se mantiene listada un rato */
  async ghost(ws) {
    const a = ws.deserializeAttachment() || {};
    if (!a.info || !a.info.rk || a.info.st !== 0) return;
    const exp = Date.now() + GRACE, st = this.ctx.storage;
    await st.put('g:' + a.info.rk, { info: a.info, peer: a.id, exp });
    const cur = await st.getAlarm();
    if (!cur || cur > exp) await st.setAlarm(exp);
  }
  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > 2048) return;
    const a = ws.deserializeAttachment() || {};
    if (!allow(ws, a)) return;
    let d; try { d = JSON.parse(data); } catch (e) { return; }
    if (!d || d.t !== 'adv') return;
    const i = d.info;
    let info = null;
    if (i && typeof i.rk === 'string' && /^[a-z]{1,8}$/.test(i.rk)) {
      info = {
        rk: i.rk,
        hn: String(i.hn == null ? '' : i.hn).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 14) || 'Jugador',
        c: Math.max(0, Math.min(8, parseInt(i.c, 10) || 1)),
        st: i.st === 1 ? 1 : 0,
        gm: typeof i.gm === 'string' && /^[a-z0-9-]{1,24}$/.test(i.gm) ? i.gm : ''
      };
    }
    a.info = info; ws.serializeAttachment(a);
    if (info) await this.ctx.storage.delete('g:' + info.rk);   /* el anfitrión ha vuelto */
    await this.cast();
  }
  async webSocketClose(ws) { try { ws.close(1000, 'bye'); } catch (e) { /* ya cerrado */ } await this.ghost(ws); await this.cast(ws); }
  async webSocketError(ws) { await this.ghost(ws); await this.cast(ws); }
}
