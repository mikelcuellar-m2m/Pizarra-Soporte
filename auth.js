import bcrypt from 'bcryptjs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ===== Almacén de usuarios (data/users.json) =====
// Los usuarios los crea el administrador (no hay registro público).
// Las contraseñas se guardan SIEMPRE con hash bcrypt, nunca en texto plano.

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
      if (!e || !password) throw new Error('Correo y contraseña son obligatorios');
      if (users.some(u => u.email === e)) throw new Error('Ese usuario ya existe');
      const passHash = await bcrypt.hash(password, 10);
      const user = { email: e, name: (name || e).trim(), passHash, createdAt: new Date().toISOString() };
      users.push(user);
      save();
      return { email: user.email, name: user.name, createdAt: user.createdAt };
    },
    async setPassword(email, password) {
      const user = this.find(email);
      if (!user) throw new Error('Usuario no encontrado');
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
      const user = this.find(email);
      if (!user) return null;
      const ok = await bcrypt.compare(password, user.passHash);
      return ok ? { email: user.email, name: user.name } : null;
    },
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
