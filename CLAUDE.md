# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es

"Pizarra Soporte": pizarra colaborativa de post-its en tiempo real. Vanilla JS + Vite en el frontend, Node (Express + Socket.IO) en el backend. Login propio por usuario/contraseña (sin registro público) y notas compartidas por todos. Se despliega en Dokploy como contenedor Docker.

## Comandos

- `npm run dev` — servidor de desarrollo de Vite en `:5173` (HMR). Su `vite.config.js` **solo** hace proxy de `/socket.io` hacia `:3000`; las rutas `/api/*` (login, admin) NO están proxeadas, así que el flujo de login no funciona en `:5173`.
- `npm run build` — build de producción a `dist/`.
- `npm run start` — `node server.js` en `:3000`; sirve `dist/` + WebSocket + API. Requiere haber hecho `build` antes.

**Para probar la app completa (login + colaboración) en local**, usar el servidor Node, no el de Vite:
```
npm run build && ADMIN_PASSWORD=algo node server.js   # abrir http://localhost:3000
```

No hay tests ni linter configurados.

### Alta de usuarios (los crea el admin, no hay registro)
- Panel web: `/admin.html` (pide `ADMIN_PASSWORD`).
- En lote: `PIZARRA_URL=... ADMIN_PASSWORD=... node scripts/crear-usuarios.mjs`, que lee `scripts/emails.txt` (líneas `correo` o `correo,contraseña`) y crea las cuentas vía la API admin.

## Arquitectura

### ⚠️ Los archivos activos están en la RAÍZ, no en `src/`
`index.html` carga `/main.js` (raíz). El punto de entrada real es **`main.js`**, **`style.css`** e **`index.html`** de la raíz del repo. Los archivos `src/main.js`, `src/counter.js`, `src/style.css` son restos del boilerplate de Vite y **no se usan** — no editarlos esperando que afecten a la app.

### Modelo colaborativo (`server.js` + `main.js`)
- El servidor mantiene el array central `notes` en memoria y lo persiste en `data/notes.json`. Es la única fuente de verdad.
- Eventos Socket.IO: al conectar el cliente recibe `notes:init` (todas las notas); las acciones emiten `note:add` / `note:update` / `note:delete` y el servidor reenvía a los demás con `note:added` / `note:updated` / `note:deleted`.
- El cliente aplica cambios remotos de forma **granular** al DOM (no re-renderiza todo) para no interrumpir a quien arrastra o escribe; ver `wireSocket()` y `note:updated` en `main.js`.
- El **autor** de cada nota lo fija el servidor desde la sesión (`socket.data.user.name`); nunca se confía en el `author` que envía el cliente.

### Autenticación (`auth.js`)
- Usuarios en `data/users.json`, contraseñas con `bcrypt`. Sin registro público: los crea el admin.
- Sesiones **sin estado**: cookie HMAC firmada (`createSessions`), verificada en cada request y en el handshake del WebSocket (una conexión sin sesión válida se rechaza).
- Cookie de admin separada, autorizada con `ADMIN_PASSWORD`.
- Endurecimiento de seguridad ya aplicado — **no regresarlo**: rate limiter en memoria (`createRateLimiter`) en `/api/login` y `/api/admin/login`, validación de tipos antes de `bcrypt.compare` (evita DoS), hash señuelo `DUMMY_HASH` contra enumeración por tiempo, comparación en tiempo constante de la clave admin, y mínimo de longitud de contraseña.

### Persistencia
Todo el estado vive en `DATA_DIR` (por defecto `data/`, en producción `/app/data`): `notes.json`, `users.json` y `.session-secret`. Está en `.gitignore`. En Dokploy debe montarse un **volumen con nombre** en `/app/data`, si no los datos se pierden en cada redespliegue.

### Despliegue
Dockerfile multi-etapa (build con Vite → runtime Node). Escucha en el **puerto 3000**. Config por variables de entorno: `ADMIN_PASSWORD` (obligatoria para gestionar usuarios), `ALLOWED_DOMAIN` (opcional, restringe dominio de correo), `SESSION_SECRET` (opcional; si falta se genera y persiste en `DATA_DIR`), `COOKIE_SECURE` (por defecto `true` cuando `NODE_ENV=production`), `PORT`, `DATA_DIR`.

**Restricción de escala:** el estado (`notes`) y el rate limiter están en memoria y Socket.IO no usa adaptador compartido → ejecutar con **una sola réplica**. Con varias, cada una tendría datos distintos y los broadcasts no se propagarían entre ellas.

## Datos sensibles (repo público)
`scripts/emails.txt`, `scripts/credenciales.csv` y `data/` están en `.gitignore`. No commitear correos, contraseñas ni la carpeta de datos.
