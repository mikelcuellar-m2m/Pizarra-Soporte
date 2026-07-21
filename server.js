import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createUserStore, createSessions, getSessionSecret, parseCookies } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data');
const DATA_FILE = join(DATA_DIR, 'notes.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || '').trim().toLowerCase(); // opcional, p.ej. m2mdataglobal.com
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const COOKIE_NAME = 'pizarra_session';
const ADMIN_COOKIE = 'pizarra_admin';

mkdirSync(DATA_DIR, { recursive: true });

const users = createUserStore(DATA_DIR);
const sessions = createSessions(getSessionSecret(DATA_DIR));

if (!ADMIN_PASSWORD) {
  console.warn('[pizarra] ADMIN_PASSWORD no está definida: el panel /admin quedará deshabilitado hasta configurarla.');
}

// ===== Estado central de notas (compartido por todos) =====
let notes = [];

function loadNotes() {
  try {
    if (existsSync(DATA_FILE)) {
      notes = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
      console.log(`[pizarra] ${notes.length} notas cargadas desde disco`);
    } else {
      notes = [
        { id: 1, text: '¡Bienvenido! Esta pizarra es colaborativa: todos ven las mismas notas.', color: 'color-yellow', x: 50, y: 50, rotate: -8, priority: 'priority-red', author: 'Sistema' },
        { id: 2, text: 'Haz clic en el botón + para elegir color y prioridad.', color: 'color-pink', x: 250, y: 80, rotate: 6, priority: '', author: 'Sistema' },
      ];
      saveNotes();
    }
  } catch (err) {
    console.error('[pizarra] Error cargando notas, arrancando vacío:', err);
    notes = [];
  }
}

function saveNotes() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(DATA_FILE, JSON.stringify(notes, null, 2));
  } catch (err) {
    console.error('[pizarra] Error guardando notas:', err);
  }
}

loadNotes();

// ===== App HTTP =====
const app = express();
app.use(express.json());
const httpServer = createServer(app);
const io = new Server(httpServer);

// --- Helpers de cookies ---
function setCookie(res, name, value, maxAgeMs) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (COOKIE_SECURE) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function getUserFromReq(req) {
  const cookies = parseCookies(req.headers.cookie);
  const data = sessions.verify(cookies[COOKIE_NAME]);
  return data ? { email: data.email, name: data.name } : null;
}

function isAdmin(req) {
  const cookies = parseCookies(req.headers.cookie);
  const data = sessions.verify(cookies[ADMIN_COOKIE]);
  return !!(data && data.admin === true);
}

function domainOk(email) {
  if (!ALLOWED_DOMAIN) return true;
  return String(email).toLowerCase().endsWith('@' + ALLOWED_DOMAIN);
}

// ===== Rutas de autenticación =====
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = await users.verify(email, password);
  if (!user) return res.status(401).json({ error: 'Credenciales incorrectas' });
  setCookie(res, COOKIE_NAME, sessions.sign({ email: user.email, name: user.name }), sessions.maxAgeMs);
  res.json({ email: user.email, name: user.name });
});

app.post('/api/logout', (req, res) => {
  clearCookie(res, COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ error: 'No autenticado' });
  res.json(user);
});

// ===== Rutas de administración (crear/borrar usuarios) =====
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Panel de administración deshabilitado (falta ADMIN_PASSWORD)' });
  if (!isAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Panel deshabilitado: define ADMIN_PASSWORD' });
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Contraseña de administrador incorrecta' });
  setCookie(res, ADMIN_COOKIE, sessions.sign({ admin: true }), sessions.maxAgeMs);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  clearCookie(res, ADMIN_COOKIE);
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({ users: users.list(), allowedDomain: ALLOWED_DOMAIN || null });
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!domainOk(email)) return res.status(400).json({ error: `El correo debe ser del dominio @${ALLOWED_DOMAIN}` });
  try {
    const user = await users.create(email, password, name);
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/users/password', requireAdmin, async (req, res) => {
  const { email, password } = req.body || {};
  try {
    await users.setPassword(email, password);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/users', requireAdmin, (req, res) => {
  const email = req.query.email;
  const ok = users.remove(email);
  res.json({ ok });
});

// ===== Estáticos (build de Vite) =====
app.use(express.static(join(__dirname, 'dist')));

// ===== Sincronización en tiempo real (solo autenticados) =====
io.use((socket, next) => {
  const cookies = parseCookies(socket.handshake.headers.cookie);
  const data = sessions.verify(cookies[COOKIE_NAME]);
  if (!data) return next(new Error('unauthorized'));
  socket.data.user = { email: data.email, name: data.name };
  next();
});

io.on('connection', (socket) => {
  socket.emit('notes:init', notes);

  socket.on('note:add', (note) => {
    if (!note || note.id == null) return;
    if (notes.some(n => n.id === note.id)) return;
    // El autor lo fija el servidor a partir de la sesión (no se confía en el cliente).
    note.author = socket.data.user.name;
    notes.push(note);
    saveNotes();
    socket.broadcast.emit('note:added', note);
  });

  socket.on('note:update', (patch) => {
    if (!patch || patch.id == null) return;
    const note = notes.find(n => n.id === patch.id);
    if (!note) return;
    // No permitir cambiar el autor vía update.
    const { author, ...safe } = patch;
    Object.assign(note, safe);
    saveNotes();
    socket.broadcast.emit('note:updated', safe);
  });

  socket.on('note:delete', (id) => {
    const before = notes.length;
    notes = notes.filter(n => n.id !== id);
    if (notes.length !== before) {
      saveNotes();
      socket.broadcast.emit('note:deleted', id);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`[pizarra] Servidor escuchando en http://0.0.0.0:${PORT}`);
});
