# CLAUDE.md — Mesa de Juegos (servidor `boardgames`)

Contexto para agentes IA. Idioma del producto y de los comentarios: **español**.

## Qué es
Suite de juegos de mesa/cartas/puzles en **un solo HTML** (UI en español, móvil primero, funciona offline) + este servidor opcional para **salas online**. Este repo = Cloudflare Worker `boardgames` + Durable Objects que sirven el HTML y retransmiten mensajes WebSocket. **No conoce ningún juego ni guarda datos**: el anfitrión (asiento 0) ejecuta el motor y es autoritativo; el servidor solo reenvía.

## Estructura
| Ruta | Rol |
|:-|:-|
| `src/worker.js` | Worker + clases `Room` y `Lobby` (Durable Objects, SQLite). |
| `wrangler.jsonc` | Config: nombre `boardgames`, assets `./public` (binding `ASSETS`), DO `ROOM`/`LOBBY`, migración `v1`, observabilidad, var `ALLOWED_ORIGINS`. |
| `public/mesa-de-juegos.html` | **FUENTE** del juego (≈1 MB, sin minificar, con el comentario de contexto largo del producto). Es copia de `dist/juegos.html` del proyecto del juego. No se publica (`public/.assetsignore`). |
| `public/index.html` | **GENERADO** por `build.js` (núcleo sin módulos + `window.MJ_MODS`); en `.gitignore`. **Nunca editar ni versionar.** |
| `public/m/<id>.<hash>.js` | **GENERADO**: un fichero por módulo perezoso, minificado; hash sha256(10) en el nombre → inmutable (`_headers`: caché 1 año). |
| `public/sw.js` | **GENERADO** desde `src/sw.tpl.js` (versión = hash de núcleo+módulos). No escribir los marcadores `__X__` en comentarios de la plantilla (el reemplazo toca el primero). |
| `public/offline.html` | **GENERADO**: todo en un solo HTML (módulos en línea) para «Descargar offline». |
| `build.js` | terser + html-minifier-terser; reparte módulos y genera los 4 ficheros anteriores. Quita TODOS los comentarios. |
| `public/_headers` | Caché: `/m/*` inmutable, `/sw.js` no-cache. |

## Comandos
- `npm install`
- `npm run build` → genera `index.html`, `m/`, `sw.js`, `offline.html`.
- `npm run dev` → `wrangler dev` (el hook `build` de `wrangler.jsonc` ejecuta `node build.js` antes).
- `npm run deploy` → `wrangler deploy` (mismo hook) (URL `https://boardgames.<subdominio>.workers.dev`).
- `npx wrangler tail` → logs en vivo.
- Actualizar el juego: reemplazar `public/mesa-de-juegos.html` por la nueva versión y `git push`: Workers Builds ejecuta `wrangler deploy` → hook `build` → genera todo → despliega. No hay que subir nada generado.

## Carga y offline (build dividido)
- Con `MJ_MODS` presente, `Mods.load(id)` descarga `/m/<id>.<hash>.js` bajo demanda (el diccionario `scdict`, 360 KB, solo para scrabble/wordle/ahorcado). Sin `MJ_MODS` (fuente, `offline.html`, artefacto) los módulos van en línea en `<script type="text/plain" data-mod>`.
- El service worker solo se registra en modo ruta (`MJ_PATHS`): `/` y `/game/*` red primero con respaldo en caché; `/m/*` caché primero; no toca `/ws/*` ni `/api/*`. «Guardar juegos en este dispositivo» (`ACTS.cacheall`) envía `{t:'all'}` y cachea los 41 módulos para jugar sin conexión.
- Salvedad: una pestaña abierta antes de un despliegue puede dar 404 en módulos con hash antiguo hasta recargar.

## Worker (`src/worker.js`)
Rutas: `GET /` y `GET /game/<id>` (`[a-z0-9-]{1,24}`) → `index.html` con `window.MJ_PATHS=1` inyectado (HTMLRewriter; `assets.run_worker_first: ["/","/game/*"]` en `wrangler.jsonc`); `/game` → 302 a `/` · `GET /api/ping` → `mesa-ok` · `GET /ws/room/<codigo>` (1–8 letras, minúsculas; un DO `Room` por código) · `GET /ws/lobby` (un único DO `Lobby`) · resto → `env.ASSETS`.
- Valida `Origin` con `ALLOWED_ORIGINS` (coma-separado; vacío = cualquiera; `null` = HTML abierto desde archivo; mismo host siempre vale).
- Límites: 8 jugadores/sala, 128 KB/mensaje, 40 msg/s por conexión (ráfaga 80, token bucket en el attachment del socket), 2 KB en Lobby, 40 salas listadas.
- Hibernación WebSocket: estado por conexión en `serializeAttachment` (`id` de 8 hex, `tok`, `ts`, `info`). `ping` → `pong` por auto-respuesta (sin despertar el DO).
- Protocolo Room (JSON): servidor→cliente `{t:'hello',me,peers}` · `{t:'join',peer}` · `{t:'leave',peer}` · `{t:'m',from,to,m}`; cliente→servidor `{to:'*'|id, m:{…}}` (`m` objeto, no array).
- Protocolo Lobby: cliente→servidor `{t:'adv', info:{rk,hn,c,st,gm}}` (`rk` `^[a-z]{1,8}$`, `hn` ≤14 sin control, `c` 0–8, `st` 0 abierta/1 en juego, `gm` `^[a-z0-9-]{1,24}$`); servidor→cliente `{t:'hello',me}` y `{t:'rooms',rooms:[{peer,presence}]}` (solo `st===0`). La sala desaparece al cerrarse la conexión del anfitrión.
- Mantener compatibilidad: el cliente (`SrvNet` en `net.js` del HTML) depende de este protocolo.

## Enlaces directos por juego
`/game/<id>` (id = `Hub.catalog[].id`). Cliente: `urlGame()`/`syncURL()` en hub.js; se lee al arrancar (`bootHub`, espera a DOMContentLoaded para cargar el módulo) y `show()` mantiene URL y `document.title` con `replaceState`. Sin `MJ_PATHS` (archivo, visor, otra web) usa el hash `#/game/<id>`. La descarga offline quita la bandera. Al añadir un juego basta registrarlo en el catálogo: su enlace existe solo.

## Observabilidad
`wrangler.jsonc → observability`: `enabled`, `logs` (`invocation_logs`, muestreo 1) y `traces` (muestreo 1). Usar `console.log/warn/error` en el worker; se ven en Cloudflare → Workers → `boardgames` → Observability o con `wrangler tail`. Ajustar `head_sampling_rate` si el tráfico crece (coste/cuota).

## Cliente (resumen del HTML)
- Cliente → servidor: `SrvNet` (en `net.js`) actúa como backend de `ClaudeNet` cuando no existe la capacidad `room` de claude.ai (`ClaudeNet.srv=true`). Descubre la URL del servidor por orden: `?srv=URL` (se guarda en `localStorage hub.srv`) → `MJ_SERVER_URL` (build: `MJ_SERVER=https://… node build.js`) → mismo origen.
- Transportes intercambiables (`send, broadcast, close, onmsg, onleave, hostId`): `ClaudeNet`/`SrvNet` (online) y `LocalNet` (WebRTC sin conexión, emparejado por QR/código).
- Arquitectura del HTML: `<style>` → `<body>` (pantallas `#home #gmenu #lobby #pair #stage`) → `<script>` núcleo (core/base, modules, sound, theme, history, saves, net, rooms, lobby, session, hub, games/catalog; acaba en `bootHub()`) → bloques `<script type="text/plain" data-mod="X" data-deps="a,b">` perezosos (`Mods.load('X')`; deben terminar con `Mods.ok("X")`).
- Catálogo: tablero (ajedrez, damas, reversi, puntos y cajas = 2–4 jugadores con IA, SVG, `pbPick`/`pbSolve`, backgammon, dominó, hundir la flota, hive, parchís, rummi), cartas (brisca, chinchón, tute, parejas = memoria 2–4 jugadores con IA y salas (acciones `{t:'f',i}` y `{t:'h'}` idempotente para ocultar el fallo; la vista solo envía las cartas visibles), solitario, texas = Texas Hold'em torneo 2–8 con IA, baraja `poker`), puzles (sudoku, nonogramas = clásico y modo Color (niveles 4–7 de `NN_LV`, `nnMakeC`/`nonogramaColorMount`), hanoi = Torres de Hanoi 3–7 discos, atasco = bloques deslizantes 6×6 con puzzles generados, hilos = conectar parejas de colores llenando el tablero, crucigrama = sin definiciones, lista de palabras a colocar en un tablero generado por cruces (`cgGen`), retomat = Reto matemático (ecuaciones a ∘ b = c cruzadas, banco de números, `rmGen`/`rmEq`), buscaminas = 5 niveles (8×10 a 14×26, primer toque seguro, banderas por pulsación larga o modo 🚩, chord, pista), flechas = 6 niveles (12×17 a 26×40, con scroll), serpientes con punta de flecha que salen del tablero si su camino está libre; `fxGen` coloca cada flecha con su salida libre de las anteriores y `fxTune` (dar la vuelta/añadir flechas, comprobando con `fxEval` que se resuelve) baja el % de flechas libres al empezar según el nivel: 27 % en Fácil a 3 % en Genio (`tf` en `FX_LV`); siempre resoluble), palabras (criptograma = descifrar frases por sustitución (`crCipher`; banco `CR_PH` de ~450 refranes, dichos y citas de dominio público con atribución `texto|autor`; no repite hasta agotar el nivel con el store `criptograma-seen`; sin `scdict`), juegos con el diccionario `scdict`: boggle (rejilla 4×4/5×5 con tiempo, arrastrar letras vecinas, resumen con las palabras que faltaron), scrabble, wordle, ahorcado, nudos = crucigrama sin pistas con zonas de letras; categorías en `HOME_CATS`); también existen tangram, cuatro (4 en raya) y mahjong en el HTML. Compartidos: baraja, poker, qr, pair, scdict, teclado, dados.
- Contrato de juego: `Hub.register({id,name,blurb,min,max,bots,options,rules,createEngine(players,saved,opts),mount(el,ctx)})`; un jugador: `single`+`mountSingle`. Motor puro JSON (`turn, over, view(i), act(i,a), bot, save, result`); toda regla vive en el motor del anfitrión.
- Estilo: tema azul, variables CSS (claro/oscuro con `data-theme`), prefijo de clases por juego, sin scroll en pantalla de juego. `localStorage` siempre vía `store.get/set`.
- Para tocar un módulo del HTML: buscar `data-mod="ID"` (perezosos) o `/* CTX ARCHIVO:` (núcleo). Detalle completo en el comentario de cabecera de `public/mesa-de-juegos.html` (§1–§11).

## Reglas de trabajo
1. Editar siempre el fuente `public/mesa-de-juegos.html`, nunca los ficheros generados.
2. Si cambias arquitectura, contrato de juego, claves de almacenamiento o módulos, actualiza el comentario de contexto del HTML y este fichero en la misma tarea (la minificación elimina los comentarios; el fuente los conserva).
3. Cambios de un juego solo tocan ese juego; reutilizar módulos compartidos, no copiar código.
4. Cambios en `worker.js`: validar toda entrada de red, no confiar en el cliente, no añadir lógica de juego ni persistencia sin pedirlo.
5. Renombrar el worker cambia la URL y crea un worker nuevo (los DO antiguos no se migran). Al añadir clases DO, añadir una migración nueva en `wrangler.jsonc` (`new_sqlite_classes`); no editar la `v1`.
6. Probado solo en local con `wrangler dev`; no en Cloudflare real.


## Salas online: visibilidad
La sala se crea Pública (listada en «Sala online», por defecto) o Privada (solo con código). Preferencia en `store` `hub.vis` (0/1); el anfitrión puede cambiarla en el lobby (`ACTS.togvis`). `H.priv` suprime `advertise()`; unirse por código funciona siempre.

## Salas online: reconexión automática
- Sesión de sala en `store` `hub.sess` (`{code,role,game,nick,sid,ts}`, TTL 12 h): `saveSess()` al crear/unirse/empezar, `clearSess()` en `leaveAll`. Al invitado se le guarda el nombre que la sala le asignó (p. ej. «Jugador 2»), necesario para recuperar su asiento.
- Corte de socket (móvil bloqueado, cambio de app, red): `SrvNet.open` marca `t.dead` y llama `t.onlost`; `onLost` reintenta con backoff hasta 150 s y `adoptTr` retoma la misma sala (anfitrión: reconcilia invitados y re-publica estado/anuncio; invitado: vuelve a enviar `join` hasta que responde el anfitrión). `netWake` sondea (`t.probe`, ping/pong) en `visibilitychange`, `online` y `pageshow`. Banner `#netb`.
- Si cae el anfitrión, los invitados esperan (`H.hostWait`, hasta ~80 s) en vez de salir. Cierre voluntario: el anfitrión envía `{t:'bye'}` antes de cerrar y los invitados salen con aviso.
- Reabrir el navegador: `bootHub` → `autoRejoin(sess)`. Invitado: `joinOnline(code,true)`. Anfitrión: reabre la partida guardada (`sid`) con el mismo código (`H.rejoinCode`) y `H.autoStart` la reanuda cuando vuelven todos los humanos. Si falla, se cae al menú normal. El código manual sigue funcionando siempre.
- Reentrada por nombre: `takeSeat` (asiento humano sin `was`) y sustitución del mismo nick en el lobby. Debilidad aceptada: el invitado acepta `st`/`lo` de cualquier emisor de la sala.
- Id de dispositivo: `DID` (`store` `hub.did`, creado una vez por navegador) va en `join` (`d`). El anfitrión lo guarda en `H.guests` y un mismo `d` con otra conexión sustituye a la anterior (lobby) o hereda su asiento (partida): evita doble plaza por doble clic, recarga o reconexión. `joinOnline` ignora clics mientras `H.joining`. Dos pestañas del mismo navegador comparten `d` (la última sustituye a la primera).
- Dónde vive todo: la sesión (`hub.sess`), el id y las partidas guardadas están en el `localStorage` de cada dispositivo; Cloudflare no guarda nada.

## Scrabble: dirección de colocación
`nextCell()` decide la casilla siguiente (con 1 ficha infiere la dirección —`V.dir` solo es un respaldo—; con 2+ la marcan las fichas). `render()` pinta la pista (`.sc-c.nx`, recuadro parpadeante). Tocar una casilla vacía (`setTarget`) fija `V.tcell`: la siguiente ficha tocada del atril va ahí (`tgtOk()`), después se sigue con `nextCell()`. Volver a tocarla la desmarca; `V.tcell` se reinicia al colocar, recoger o cambiar el atril.

## Versión de la app
`APP_NAME`/`APP_VER` (justo antes de `ACTS`, hub.js) se muestran al pie del menú (`.mnu-ver`). Subir `APP_VER` en cada entrega (semver: nuevas funciones → minor, arreglos → patch).


## Juegos híbridos (solo + sala) y reloj del anfitrión
- Un juego con `single` **y** `createEngine` (p. ej. Boggle) muestra el menú de solitario y debajo «Con más jugadores» (`renderSingleMenu(true)` + `roomCardsHTML()`, las tarjetas de sala online/offline extraídas de `renderGMenu`).
- Juegos sin `bots` (Boggle en sala): el lobby no ofrece «Añadir IA» ni «Sustituir por IA».
- Motor con reloj propio: métodos opcionales `nextTick()` (timestamp absoluto o 0) y `tick()`; el anfitrión los programa en `scheduleTick()` (desde `afterAct`, limpiado en `resetRoom`). Marcas absolutas (`start`/`end`) para que sobrevivan a guardar/reanudar.
- Boggle en sala: `BgRoomGame` (opts `size`, `dup`), acción `{t:'w',w}`; `view(i)` oculta la rejilla hasta `start` (cuenta atrás `BG_PRE` 4 s) y los puntos ajenos hasta `over`; `res` trae todas las palabras al terminar. Cada palabra aceptada provoca pushState a todos los asientos (cada uno recibe solo su vista).

## Reutilizar módulos compartidos (norma del usuario)
- Los juegos nuevos deben reutilizar lo compartido: teclado (`teclado`, QWERTY español con Ñ; el usuario siempre quiere disposición QWERTY, igual que Wordle/Ahorcado), diccionario (`scdict`) y los colores/tema claro-oscuro del hub (variables CSS). No crear teclados ni diccionarios propios.
