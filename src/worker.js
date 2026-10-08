/* Servidor de salas de «Mesa de Juegos» (Cloudflare Workers + Durable Objects).
   No conoce ningún juego: solo reenvía mensajes entre quienes están en la misma sala. El anfitrión sigue siendo quien aplica las reglas.
   Rutas:
     GET /api/ping            -> "mesa-ok" (el cliente comprueba que el servidor existe)
     GET /ws/room/<codigo>    -> WebSocket de una sala (un Durable Object por código)
     GET /ws/lobby            -> WebSocket del listado de salas abiertas (un único Durable Object)
     resto                    -> páginas estáticas de ./public
   Protocolo de sala (JSON):
     servidor -> cliente  {t:'hello', me, peers:[ids]} | {t:'join', peer} | {t:'leave', peer} | {t:'m', from, to, m}
     cliente  -> servidor {to:'*'|id, m:{...}}   (el texto «ping» recibe «pong» sin despertar al objeto) */
import { DurableObject } from 'cloudflare:workers';

const MAX_PEERS = 8;          /* jugadores por sala */
const MAX_MSG = 128 * 1024;   /* bytes por mensaje */
const RATE = 40;              /* mensajes por segundo y conexión (ráfaga 80) */
const BURST = 80;
const MAX_ROOMS_LISTED = 40;

const okOrigin = (req, env) => {
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return true;
  const o = req.headers.get('Origin') || 'null';
  try { if (o !== 'null' && new URL(o).host === new URL(req.url).host) return true; } catch (e) { /* origen raro */ }
  return list.includes(o);
};
const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/api/ping') return new Response('mesa-ok', { headers: cors });
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
    server.serializeAttachment({ id, tok: BURST, ts: Date.now() });
    const peers = others.map(s => (s.deserializeAttachment() || {}).id).filter(Boolean);
    send(server, { t: 'hello', me: id, peers });
    others.forEach(s => send(s, { t: 'join', peer: id }));
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_MSG) return;
    const a = ws.deserializeAttachment() || {};
    if (!allow(ws, a)) return;
    let d; try { d = JSON.parse(data); } catch (e) { return; }
    if (!d || typeof d !== 'object' || !d.m || typeof d.m !== 'object' || Array.isArray(d.m)) return;
    const to = d.to;
    if (to !== '*' && (typeof to !== 'string' || to.length > 16)) return;
    const out = JSON.stringify({ t: 'm', from: a.id, to, m: d.m });
    for (const s of this.ctx.getWebSockets()) {
      if (s === ws) continue;
      if (to === '*' || (s.deserializeAttachment() || {}).id === to) send(s, out);
    }
  }
  webSocketClose(ws) { this.left(ws); }
  webSocketError(ws) { this.left(ws); }
  left(ws) {
    const a = ws.deserializeAttachment() || {};
    try { ws.close(1000, 'bye'); } catch (e) { /* ya cerrado */ }
    this.ctx.getWebSockets().forEach(s => { if (s !== ws) send(s, { t: 'leave', peer: a.id }); });
  }
}

/* Listado de salas abiertas: cada anfitrión anuncia {rk, hn, c, st, gm}; al cerrarse su conexión desaparece */
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
    send(server, this.list());
    return new Response(null, { status: 101, webSocket: client });
  }
  list() {
    const rooms = [];
    for (const s of this.ctx.getWebSockets()) {
      const a = s.deserializeAttachment() || {};
      if (a.info && a.info.rk && a.info.st === 0) rooms.push({ peer: a.id, presence: a.info });
    }
    return { t: 'rooms', rooms: rooms.slice(0, MAX_ROOMS_LISTED) };
  }
  cast() { const o = JSON.stringify(this.list()); this.ctx.getWebSockets().forEach(s => send(s, o)); }
  webSocketMessage(ws, data) {
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
    this.cast();
  }
  webSocketClose(ws) { try { ws.close(1000, 'bye'); } catch (e) { /* ya cerrado */ } this.cast(); }
  webSocketError(ws) { this.cast(); }
}
