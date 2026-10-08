// Minifica public/mesa-de-juegos.html (fuente, sin tocar) -> public/index.html (lo que se despliega).
// Uso: npm run minify. Quita TODOS los comentarios (también los de contexto para IA): el fuente sin minificar conserva todo.
import { readFileSync, writeFileSync } from 'node:fs';
import { minify as minHtml } from 'html-minifier-terser';
import { minify as minJs } from 'terser';

const SRC = 'public/mesa-de-juegos.html', OUT = 'public/index.html';
let html = readFileSync(SRC, 'utf8');
const before = Buffer.byteLength(html);

// Los módulos perezosos son <script type="text/plain" data-mod=…>: html-minifier no los toca, los minificamos aquí.
const jsOpts = { compress: true, mangle: true, format: { comments: false } };
const cmts = [...html.matchAll(/<!--[\s\S]*?-->/g)].map(m => [m.index, m.index + m[0].length]);
const inCmt = i => cmts.some(([a, b]) => i >= a && i < b); // el comentario de contexto cita <script …> como texto
const blocks = [...html.matchAll(/(<script type="text\/plain"[^>]*>)([\s\S]*?)(<\/script>)/g)].filter(m => !inCmt(m.index));
let out = '', last = 0;
for (const m of blocks) {
  out += html.slice(last, m.index);
  const r = await minJs(m[2], jsOpts);
  if (r.error || typeof r.code !== 'string') throw new Error('terser falló en ' + m[1] + ' ' + (r.error || ''));
  out += m[1] + r.code + m[3];
  last = m.index + m[0].length;
}
html = out + html.slice(last);

html = await minHtml(html, {
  collapseWhitespace: true, conservativeCollapse: false,
  removeComments: true,
  minifyCSS: true, minifyJS: jsOpts,
});
writeFileSync(OUT, html);
const after = Buffer.byteLength(html);
console.log(`${SRC} ${before} B -> ${OUT} ${after} B (${(100 - after / before * 100).toFixed(1)}% menos)`);
