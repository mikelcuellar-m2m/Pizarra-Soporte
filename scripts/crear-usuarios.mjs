// Crea usuarios en lote en el despliegue de Pizarra Soporte.
//
// Uso (PowerShell):
//   $env:PIZARRA_URL="https://TU-DOMINIO"
//   $env:ADMIN_PASSWORD="tu-clave-admin"
//   node scripts/crear-usuarios.mjs
//
// Los correos se leen de scripts/emails.txt (uno por línea).
// Genera una contraseña fuerte para cada uno, los crea vía el panel admin
// y escribe la lista email+contraseña en scripts/credenciales.csv para repartir.
//
// NOTA: emails.txt y credenciales.csv están en .gitignore (no se suben al repo).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.PIZARRA_URL || '').replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

if (!BASE || !ADMIN_PASSWORD) {
  console.error('Faltan variables: define PIZARRA_URL y ADMIN_PASSWORD.');
  process.exit(1);
}

const emailsFile = join(__dirname, 'emails.txt');
if (!existsSync(emailsFile)) {
  console.error(`No existe ${emailsFile}. Crea el archivo con un correo por línea.`);
  process.exit(1);
}

const emails = readFileSync(emailsFile, 'utf-8')
  .split(/\r?\n/).map(s => s.trim()).filter(Boolean).filter(e => !e.startsWith('#'));

if (!emails.length) { console.error('emails.txt está vacío.'); process.exit(1); }

// Generador de contraseñas fuertes sin caracteres ambiguos (0/O, 1/l/I).
function genPassword(len = 14) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#%+=?';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[randomInt(chars.length)];
  return out;
}

// Nombre a mostrar a partir del correo (parte antes de la @).
function nameFromEmail(email) {
  const local = email.split('@')[0].replace(/[._-]+/g, ' ');
  return local.replace(/\b\w/g, c => c.toUpperCase());
}

// --- Login admin ---
async function adminLogin() {
  const res = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login admin falló (${res.status}). Revisa ADMIN_PASSWORD y la URL.`);
  const cookie = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('No se recibió cookie de admin.');
  return cookie;
}

async function createUser(cookie, email, password) {
  const res = await fetch(`${BASE}/api/admin/users`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ email, password, name: nameFromEmail(email) }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, error: data.error };
}

async function main() {
  console.log(`Conectando a ${BASE} ...`);
  const cookie = await adminLogin();
  console.log('Admin autenticado. Creando usuarios...\n');

  const rows = [];
  for (const email of emails) {
    const password = genPassword();
    const r = await createUser(cookie, email, password);
    if (r.ok) {
      rows.push({ email, password });
      console.log(`  ✔ ${email}`);
    } else {
      console.log(`  ✖ ${email}  ->  ${r.error || 'error ' + r.status}`);
    }
  }

  if (rows.length) {
    const csv = 'correo,contraseña\n' + rows.map(r => `${r.email},${r.password}`).join('\n') + '\n';
    const outFile = join(__dirname, 'credenciales.csv');
    writeFileSync(outFile, csv, 'utf-8');
    console.log(`\n${rows.length} usuario(s) creado(s).`);
    console.log(`Credenciales guardadas en: ${outFile}`);
    console.log('\n--- Lista para repartir ---');
    rows.forEach(r => console.log(`${r.email}  ->  ${r.password}`));
    console.log('\n⚠ Borra credenciales.csv cuando termines de repartirlas.');
  } else {
    console.log('\nNo se creó ningún usuario nuevo.');
  }
}

main().catch(e => { console.error('\nError:', e.message); process.exit(1); });
