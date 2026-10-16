/* Web Push sin dependencias (WebCrypto): cifrado «aes128gcm» (RFC 8291 / RFC 8188) y firma VAPID (RFC 8292, ES256).
   Claves: secreto VAPID_JWK = clave privada P-256 en formato JWK (JSON). La pública se deriva de sus x/y.
   Generar: node -e "const k=require('crypto').generateKeyPairSync('ec',{namedCurve:'prime256v1'});console.log(JSON.stringify(k.privateKey.export({format:'jwk'})))" */

const enc = new TextEncoder();
const b64u = buf => {
  const b = new Uint8Array(buf); let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = s => {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const r = atob(s), o = new Uint8Array(r.length);
  for (let i = 0; i < r.length; i++) o[i] = r.charCodeAt(i);
  return o;
};
const cat = (...a) => { const n = a.reduce((k, x) => k + x.length, 0), o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

/* claves VAPID del entorno (null si no están configuradas: las notificaciones quedan desactivadas) */
let cache = null;
export async function vapid(env) {
  if (cache && cache.raw === env.VAPID_JWK) return cache;
  if (!env.VAPID_JWK) return null;
  let jwk; try { jwk = JSON.parse(env.VAPID_JWK); } catch (e) { return null; }
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) return null;
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const pub = b64u(cat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y)));
  cache = { raw: env.VAPID_JWK, key, pub };
  return cache;
}

async function jwt(v, aud, sub) {
  const h = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const c = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, v.key, enc.encode(h + '.' + c));
  return h + '.' + c + '.' + b64u(sig);
}

const hkdf = async (salt, ikm, info, len) => {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
};

/* cifra el contenido para una suscripción {endpoint, keys:{p256dh, auth}} (un único registro) */
async function encrypt(sub, text) {
  const ua = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const as = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(auth, shared, cat(enc.encode('WebPush: info\0'), ua, as), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, cat(enc.encode(text), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);   /* tamaño de registro 4096 */
  return cat(salt, rs, new Uint8Array([as.length]), as, ct);
}

/* envía un aviso; devuelve el código HTTP del servicio de push (201 = aceptado; 404/410 = suscripción caducada) */
export async function sendPush(v, sub, payload, subject) {
  const ep = new URL(sub.endpoint);
  const body = await encrypt(sub, JSON.stringify(payload));
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '600', urgency: 'high',
      authorization: 'vapid t=' + (await jwt(v, ep.origin, subject)) + ', k=' + v.pub
    },
    body
  });
  return r.status;
}

/* solo se envía a servicios de push conocidos (el servidor no debe hacer peticiones a direcciones arbitrarias) */
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com', 'push.apple.com', 'notify.windows.com'];
export function validSub(s) {
  if (!s || typeof s !== 'object' || typeof s.endpoint !== 'string' || s.endpoint.length > 1024 || !s.keys || typeof s.keys !== 'object') return null;
  let u; try { u = new URL(s.endpoint); } catch (e) { return null; }
  if (u.protocol !== 'https:' || !PUSH_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) return null;
  const p = String(s.keys.p256dh || ''), a = String(s.keys.auth || '');
  if (!/^[A-Za-z0-9_-]{86,88}$/.test(p) || !/^[A-Za-z0-9_-]{20,24}$/.test(a)) return null;
  if (unb64u(p).length !== 65 || unb64u(a).length !== 16) return null;
  return { endpoint: s.endpoint, keys: { p256dh: p, auth: a } };
}
