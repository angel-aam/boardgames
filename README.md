# Servidor online de Mesa de Juegos (Cloudflare Workers)

Un Worker + Durable Objects que (1) sirve el juego (`public/index.html`, generado) y (2) reenvía mensajes WebSocket entre jugadores. El anfitrión sigue siendo quien decide la partida; el servidor solo retransmite. No guarda datos.

## Desplegar
Requisitos: Node 18+ y tu cuenta de Cloudflare.

```
cd server
npm install
npx wrangler login     # abre el navegador, autoriza
npx wrangler deploy
```
Al terminar muestra `https://mesa-de-juegos.<tu-subdominio>.workers.dev`. Ábrelo: ya es la web completa con salas online (comprueba `/api/ping` → `mesa-ok`).

## Actualizar el juego
El código fuente sin minificar vive en `public/mesa-de-juegos.html` (no se publica: lo excluye `public/.assetsignore`). Para actualizar:
1. Sustituye `public/mesa-de-juegos.html` por la nueva versión.
2. `npm run deploy` → minifica a `public/index.html` y ejecuta `wrangler deploy`.

Solo minificar: `npm run minify`. Elimina todos los comentarios (también los de contexto para IA; el fuente los conserva) y reduce el HTML ~14 %. La opción «Descarga offline» del menú baja el `index.html` publicado, como `mesa-de-juegos.html`.
Para publicar sin minificar, usa `npx wrangler deploy` a secas tras copiar el fuente a `public/index.html`.

## Usarlo desde otra web (GitHub Pages, opcional) Pages (o el HTML offline)
Abre una vez `https://TU-PAGINA/?srv=https://mesa-de-juegos.<subdominio>.workers.dev`; la dirección queda guardada en ese navegador. O fíjala al construir: `MJ_SERVER=https://… node build.js`.
Si quieres limitar quién puede conectar, edita `ALLOWED_ORIGINS` en `wrangler.jsonc` (p. ej. `"https://USUARIO.github.io,null"`; `null` es el HTML abierto desde archivo) y vuelve a desplegar.

## Notas
- Usa Durable Objects con SQLite (válido en el plan gratuito). Revisa los límites vigentes en la página de precios de Cloudflare.
- Límites del código: 8 jugadores por sala, 128 KB por mensaje, 40 msg/s por conexión.
- Probado en local con `npx wrangler dev`; no en Cloudflare real.
- Si cambias el juego, ejecuta `node build.js` en la raíz y luego `npm run build && npx wrangler deploy`.
