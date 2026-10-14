# Servidor online de Mesa de Juegos (Cloudflare Workers)

Un Worker + Durable Objects que (1) sirve el juego (`public/index.html`, generado) y (2) reenvía mensajes WebSocket entre jugadores. El anfitrión sigue siendo quien decide la partida; el servidor solo retransmite. No guarda datos.

## Desplegar
Requisitos: Node 18+ y tu cuenta de Cloudflare.

```
npm install
npx wrangler login     # abre el navegador, autoriza
npm run deploy         # wrangler deploy (el hook `build` minifica antes)
```
Al terminar muestra `https://boardgames.<tu-subdominio>.workers.dev`. Ábrelo: ya es la web completa con salas online (comprueba `/api/ping` → `mesa-ok`).

## Enlaces directos a cada juego
`https://<tu-dominio>/game/<id>` abre ese juego directamente (por ejemplo `/game/sudoku`, `/game/texas`, `/game/ajedrez`), ideal para marcadores. El worker sirve el mismo `index.html` para `/` y `/game/*` (`run_worker_first` en `wrangler.jsonc`) e inyecta `window.MJ_PATHS=1`; el cliente abre el juego y mantiene la URL y el título de la pestaña. Un id desconocido lleva al inicio. Sin servidor (archivo abierto, visor de Claude) el mismo enlace se escribe como `#/game/<id>`.
Ids: ajedrez, ahorcado, atasco, backgammon, brisca, chinchon, cuatro, damas, domino, flechas, flota, hanoi, hilos, hive, mahjong, nonograma, nudos, parejas, parchis, rummi, scrabble, solitario, sudoku, tangram, texas, tute, wordle.

## Actualizar el juego
El código fuente sin minificar vive en `public/mesa-de-juegos.html` (no se publica: lo excluye `public/.assetsignore`). Para actualizar:
1. Sustituye `public/mesa-de-juegos.html` por la nueva versión.
2. `git push` → Cloudflare (Workers Builds) ejecuta `wrangler deploy`, cuyo hook `build` (`node build.js`) genera `public/index.html`, `public/m/*.js`, `sw.js` y `offline.html`. En local: `npm run deploy`.

Solo generar: `npm run build`. Elimina todos los comentarios (el fuente los conserva). El núcleo pesa ≈120 KB (63 KB gzip); cada juego se descarga al abrirlo (`/m/<id>.<hash>.js`, caché inmutable) y un service worker permite jugar sin conexión tras pulsar «Guardar juegos en este dispositivo». «Descarga offline» baja `offline.html` (todo en un archivo).
`public/index.html` es un fichero generado: está en `.gitignore`, no se edita ni se versiona.

## Usarlo desde otra web (GitHub Pages, opcional) Pages (o el HTML offline)
Abre una vez `https://TU-PAGINA/?srv=https://boardgames.<subdominio>.workers.dev`; la dirección queda guardada en ese navegador. O fíjala al construir: `MJ_SERVER=https://… node build.js`.
Si quieres limitar quién puede conectar, edita `ALLOWED_ORIGINS` en `wrangler.jsonc` (p. ej. `"https://USUARIO.github.io,null"`; `null` es el HTML abierto desde archivo) y vuelve a desplegar.

## Notas
- Usa Durable Objects con SQLite (válido en el plan gratuito). Revisa los límites vigentes en la página de precios de Cloudflare.
- Límites del código: 8 jugadores por sala, 128 KB por mensaje, 40 msg/s por conexión.
- Reconexión: si el móvil se bloquea o se cambia de app, la sala se retoma sola (sesión guardada 12 h en el navegador). Al reabrir el navegador se vuelve a la sala sin código; el código sigue valiendo.
- Probado en local con `npx wrangler dev`; no en Cloudflare real.
- Si cambias el juego, ejecuta `node build.js` en el proyecto del juego, copia `dist/juegos.html` a `public/mesa-de-juegos.html` y lanza `npm run deploy`.
- Observabilidad (logs y trazas) activada en `wrangler.jsonc`; se consulta en el panel de Cloudflare → Workers → boardgames → Observability, o con `npx wrangler tail`.
- Renombrar el worker cambia la URL (`boardgames.*.workers.dev`) y crea un worker nuevo: los Durable Objects del anterior no se migran (aquí no guardan datos).
