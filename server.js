import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data');
const DATA_FILE = join(DATA_DIR, 'notes.json');

// --- Estado central persistido ---
// Todas las notas se guardan aquí, son compartidas por todos (abierto, sin usuarios).
let notes = [];

function loadNotes() {
  try {
    if (existsSync(DATA_FILE)) {
      notes = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
      console.log(`[pizarra] ${notes.length} notas cargadas desde disco`);
    } else {
      // Semilla inicial la primera vez
      notes = [
        { id: 1, text: '¡Bienvenido! Esta pizarra es colaborativa: todos ven las mismas notas.', color: 'color-yellow', x: 50, y: 50, rotate: -8, priority: 'priority-red' },
        { id: 2, text: 'Haz clic en el botón + para elegir color y prioridad.', color: 'color-pink', x: 250, y: 80, rotate: 6, priority: '' },
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

// --- Servidor HTTP + estáticos ---
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Sirve el build de producción de Vite
app.use(express.static(join(__dirname, 'dist')));

// --- Sincronización en tiempo real ---
io.on('connection', (socket) => {
  // Al conectar, enviar todo el estado actual
  socket.emit('notes:init', notes);

  // Crear nota
  socket.on('note:add', (note) => {
    if (!note || note.id == null) return;
    if (notes.some(n => n.id === note.id)) return; // idempotente
    notes.push(note);
    saveNotes();
    socket.broadcast.emit('note:added', note); // al resto (el emisor ya la tiene)
  });

  // Actualizar nota (texto, color, prioridad, posición)
  socket.on('note:update', (patch) => {
    if (!patch || patch.id == null) return;
    const note = notes.find(n => n.id === patch.id);
    if (!note) return;
    Object.assign(note, patch);
    saveNotes();
    socket.broadcast.emit('note:updated', patch);
  });

  // Borrar nota
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
