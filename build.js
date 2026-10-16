// Build de «Mesa de Juegos». Fuente: public/mesa-de-juegos.html (archivo único con módulos <script type="text/plain" data-mod>, sin tocar).
// Genera (todo en public/, ignorado por git):
//   index.html        núcleo + estilos + manifiesto window.MJ_MODS (lo que carga el navegador; sin módulos)
//   m/<id>.<hash>.js  un fichero por módulo, con hash del contenido (caché inmutable, ver _headers)
//   sw.js             service worker (plantilla src/sw.tpl.js): núcleo, iconos y módulos en caché para jugar sin conexión (PWA)
//   offline-<l>.html  todo en uno minificado de UN idioma (es/en) = lo que baja «Descarga offline» (funciona sin servidor);
//                     lleva window.MJ_LANGS=[l] y solo los módulos de ese idioma (ver modLang)
// Uso: node build.js (lo ejecuta `wrangler deploy`/`wrangler dev` por el hook "build" de wrangler.jsonc).
// Quita TODOS los comentarios (también los de contexto para IA): el fuente sin minificar conserva todo.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { minify as minHtml } from 'html-minifier-terser';
import { minify as minJs } from 'terser';

const SRC = 'public/mesa-de-juegos.html';
const html = readFileSync(SRC, 'utf8');
const before = Buffer.byteLength(html);
const sha = s => createHash('sha256').update(s).digest('hex');
const kb = n => (n / 1024).toFixed(1) + ' KB';

const jsOpts = { compress: true, mangle: true, format: { comments: false } };
const cmts = [...html.matchAll(/<!--[\s\S]*?-->/g)].map(m => [m.index, m.index + m[0].length]);
const inCmt = i => cmts.some(([a, b]) => i >= a && i < b); // el comentario de contexto cita <script …> como texto
const blocks = [...html.matchAll(/(<script type="text\/plain"([^>]*)>)([\s\S]*?)(<\/script>)/g)].filter(m => !inCmt(m.index));

// 1) Módulos: minificados con terser (html-minifier no toca los text/plain)
const mods = [];
for (const m of blocks) {
  const id = (m[2].match(/data-mod="([^"]+)"/) || [])[1];
  const deps = ((m[2].match(/data-deps="([^"]*)"/) || [])[1] || '').split(',').filter(Boolean);
  if (!id) throw new Error('módulo sin data-mod: ' + m[1]);
  const r = await minJs(m[3], jsOpts);
  if (r.error || typeof r.code !== 'string') throw new Error('terser falló en ' + id + ' ' + (r.error || ''));
  mods.push({ id, deps, code: r.code, m, hash: sha(r.code).slice(0, 10) });
}
const rebuild = fn => { let out = '', last = 0; for (const x of mods) { out += html.slice(last, x.m.index) + fn(x); last = x.m.index + x.m[0].length; } return out + html.slice(last); };
const htmlOpts = { collapseWhitespace: true, conservativeCollapse: false, removeComments: true, minifyCSS: true, minifyJS: jsOpts };

// 2) offline-<l>.html: todo en uno por idioma, con los módulos inline ya minificados
//    Idioma de un módulo: «lang-xx» y «xx-<m>» = diccionarios de la interfaz; «<m>-xx» = variante de contenido de <m> (p. ej. scdict-en)
//    y entonces <m> es la versión española. El resto vale para todos los idiomas. El español no lleva diccionarios de interfaz.
const LANGS = ['es', 'en'];
const ids = new Set(mods.map(x => x.id));
const modLang = id => {
  let m;
  if ((m = /^lang-([a-z]{2})$/.exec(id))) return m[1];
  if ((m = /^([a-z]{2})-/.exec(id))) return m[1];
  if ((m = /^(.+)-([a-z]{2})$/.exec(id)) && ids.has(m[1])) return m[2];
  if (LANGS.some(l => ids.has(id + '-' + l))) return 'es';
  return '';
};
const headAt = s => s.indexOf('<head>', s.lastIndexOf('-->', s.indexOf('<html')) + 1);
const offSize = {};
rmSync('public/offline.html', { force: true });
for (const l of LANGS) {
  let src = rebuild(x => { const ml = modLang(x.id); return ml && ml !== l ? '' : x.m[1] + x.code + x.m[4]; });
  const h = headAt(src);
  if (h < 0) throw new Error('no se encontró <head> en el fuente');
  src = src.slice(0, h + 6) + '<script>window.MJ_LANGS=' + JSON.stringify([l]) + '</script>' + src.slice(h + 6);
  const out = await minHtml(src, htmlOpts);
  writeFileSync(`public/offline-${l}.html`, out);
  offSize[l] = Buffer.byteLength(out);
}

// 3) módulos sueltos con hash + manifiesto
rmSync('public/m', { recursive: true, force: true });
mkdirSync('public/m', { recursive: true });
const manifest = {};
for (const x of mods) {
  const u = `/m/${x.id}.${x.hash}.js`;
  writeFileSync('public' + u, x.code);
  manifest[x.id] = { u, d: x.deps };
}

// 4) index.html: núcleo sin módulos + manifiesto en <head> (se lee al cargar un juego, no al arrancar)
let core = rebuild(() => '');
const hi = headAt(core);
if (hi < 0) throw new Error('no se encontró <head> en el fuente');
// PWA (solo en el servidor; offline.html no lleva manifiesto): manifiesto, color de barra e iconos
const pwa = '<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#2757d6"><link rel="icon" href="/icons/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Mesa de Juegos">';
core = core.slice(0, hi + 6) + pwa + '<script>window.MJ_MODS=' + JSON.stringify(manifest) + '</script>' + core.slice(hi + 6);
const index = await minHtml(core, htmlOpts);
writeFileSync('public/index.html', index);

// 5) service worker: la versión cambia con cualquier cambio de núcleo o de módulos
const urls = Object.values(manifest).map(v => v.u).sort();
const version = sha(index + urls.join() + readFileSync('public/manifest.webmanifest', 'utf8') + readFileSync('src/sw.tpl.js', 'utf8')).slice(0, 10);
const shell = ['/manifest.webmanifest', ...readdirSync('public/icons').map(f => '/icons/' + f)].sort();
const swSrc = readFileSync('src/sw.tpl.js', 'utf8');
const sw = swSrc.replace('__VERSION__', version).replace('__MODS__', JSON.stringify(urls)).replace('__SHELL__', JSON.stringify(shell));
writeFileSync('public/sw.js', sw);

const big = mods.slice().sort((a, b) => b.code.length - a.code.length).slice(0, 3).map(x => `${x.id} ${kb(x.code.length)}`).join(', ');
console.log(`${SRC} ${kb(before)} -> index.html ${kb(Buffer.byteLength(index))} (gzip ${kb(gzipSync(index).length)}) + ${mods.length} módulos (mayores: ${big}) · offline ${LANGS.map(l => l + ' ' + kb(offSize[l])).join(', ')} · sw ${version}`);
