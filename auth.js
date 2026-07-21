import bcrypt from 'bcryptjs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ===== Almacén de usuarios (data/users.json) =====
// Los usuarios los crea el administrador (no hay registro público).
// Las contraseñas se guardan SIEMPRE con hash bcrypt, nunca en texto plano.

export const MIN_PASSWORD_LENGTH = 8;

// Hash "señuelo": se compara contra él cuando el usuario NO existe, para que
// el tiempo de respuesta sea similar al de un usuario real y no se pueda
// enumerar cuentas midiendo la latencia.
const DUMMY_HASH = bcrypt.hashSync('timing-attack-mitigation-dummy', 10);

export function createUserStore(dataDir) {
  const USERS_FILE = join(dataDir, 'users.json');
  let users = [];

  function load() {
    try {
      if (existsSync(USERS_FILE)) {
        users = JSON.parse(readFileSync(USERS_FILE, 'utf-8'));
      }
    } catch (err) {
      console.error('[auth] Error cargando usuarios:', err);
      users = [];
    }
  }

  function save() {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  }

  const norm = (email) => String(email || '').trim().toLowerCase();

  load();

  return {
    list() {
      return users.map(u => ({ email: u.email, name: u.name, createdAt: u.createdAt }));
    },
    find(email) {
      const e = norm(email);
      return users.find(u => u.email === e) || null;
    },
    async create(email, password, name) {
      const e = norm(email);
      if (!e || typeof password !== 'string') throw new Error('Correo y contraseña son obligatorios');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('Correo no válido');
      if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`);
      if (users.some(u => u.email === e)) throw new Error('Ese usuario ya existe');
      const passHash = await bcrypt.hash(password, 10);
      const displayName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 80) : e;
      const user = { email: e, name: displayName, passHash, createdAt: new Date().toISOString() };
      users.push(user);
      save();
      return { email: user.email, name: user.name, createdAt: user.createdAt };
    },
    async setPassword(email, password) {
      const user = this.find(email);
      if (!user) throw new Error('Usuario no encontrado');
      if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`);
      }
      user.passHash = await bcrypt.hash(password, 10);
      save();
    },
    remove(email) {
      const e = norm(email);
      const before = users.length;
      users = users.filter(u => u.email !== e);
      if (users.length !== before) save();
      return users.length !== before;
    },
    async verify(email, password) {
      // Validar tipos: bcrypt.compare lanza si recibe algo que no es string
      // (esto tumbaba el proceso => DoS). Se comprueba siempre.
      if (typeof email !== 'string' || typeof password !== 'string') {
        await bcrypt.compare('x', DUMMY_HASH); // mantener tiempo constante
        return null;
      }
      const user = this.find(email);
      // Si el usuario no existe, se compara igualmente contra un hash señuelo
      // para que el tiempo de respuesta no delate qué correos son válidos.
      const hash = user ? user.passHash : DUMMY_HASH;
      const ok = await bcrypt.compare(password, hash);
      return (user && ok) ? { email: user.email, name: user.name } : null;
    },
  };
}

// ===== Limitador de intentos (anti fuerza bruta) =====
// En memoria: cuenta fallos por clave (IP y/o cuenta) y bloquea temporalmente.
export function createRateLimiter({ maxAttempts = 8, windowMs = 15 * 60 * 1000, lockMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map(); // key -> { count, first, lockedUntil }

  // Limpieza periódica de entradas caducadas (no retiene el proceso vivo).
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) {
      if ((v.lockedUntil || 0) < now && (v.first + windowMs) < now) hits.delete(k);
    }
  }, windowMs);
  if (sweep.unref) sweep.unref();

  return {
    // Devuelve { blocked, retryAfter(segundos) } sin registrar intento.
    check(key) {
      const now = Date.now();
      const v = hits.get(key);
      if (v && v.lockedUntil && v.lockedUntil > now) {
        return { blocked: true, retryAfter: Math.ceil((v.lockedUntil - now) / 1000) };
      }
      return { blocked: false, retryAfter: 0 };
    },
    // Registra un fallo; bloquea al superar el máximo dentro de la ventana.
    fail(key) {
      const now = Date.now();
      let v = hits.get(key);
      if (!v || (v.first + windowMs) < now) v = { count: 0, first: now, lockedUntil: 0 };
      v.count += 1;
      if (v.count >= maxAttempts) v.lockedUntil = now + lockMs;
      hits.set(key, v);
    },
    // Éxito: limpia el contador de esa clave.
    reset(key) { hits.delete(key); },
  };
}

// ===== Sesiones firmadas (cookie HMAC, sin estado en servidor) =====
// El secreto se persiste en disco si no se define SESSION_SECRET, de modo
// que las sesiones sobreviven a reinicios sin necesidad de configurarlo.

export function getSessionSecret(dataDir) {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const SECRET_FILE = join(dataDir, '.session-secret');
  try {
    if (existsSync(SECRET_FILE)) return readFileSync(SECRET_FILE, 'utf-8').trim();
    mkdirSync(dataDir, { recursive: true });
    const secret = randomBytes(48).toString('hex');
    writeFileSync(SECRET_FILE, secret);
    return secret;
  } catch (err) {
    console.error('[auth] No se pudo persistir el secreto de sesión, usando uno efímero:', err);
    return randomBytes(48).toString('hex');
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function createSessions(secret, { maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  function sign(payloadObj) {
    const payload = b64url(JSON.stringify({ ...payloadObj, exp: nowExp(maxAgeMs) }));
    const mac = createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  }

  function verify(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [payload, mac] = token.split('.');
    const expected = createHmac('sha256', secret).update(payload).digest('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
      if (!data.exp || data.exp < nowSeconds()) return null;
      return data;
    } catch {
      return null;
    }
  }

  return { sign, verify, maxAgeMs };
}

// nota: Date.now() no está disponible en scripts de Workflow, pero server.js
// es un proceso Node normal, así que aquí sí podemos usarlo.
function nowSeconds() { return Math.floor(Date.now() / 1000); }
function nowExp(maxAgeMs) { return nowSeconds() + Math.floor(maxAgeMs / 1000); }

// Parseo simple de cookies desde la cabecera (evita dependencias extra).
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
