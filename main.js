import './style.css'
import { io } from 'socket.io-client'

const board = document.getElementById('board');
const addBtn = document.getElementById('add-btn');
const overlay = document.getElementById('overlay');
const colorMenu = document.getElementById('color-menu');

// Login / app gate
const loginScreen = document.getElementById('login-screen');
const loginForm = document.getElementById('login-form');
const loginEmail = document.getElementById('login-email');
const loginPassword = document.getElementById('login-password');
const loginError = document.getElementById('login-error');
const appEl = document.getElementById('app');
const userNameEl = document.getElementById('user-name');
const logoutBtn = document.getElementById('logout-btn');

let socket = null;
let notes = [];
let activeNote = null;
let activeNoteEl = null;
let started = false;

// ===== Arranque: comprobar sesión =====
async function boot() {
  try {
    const res = await fetch('/api/me');
    if (res.ok) {
      startApp(await res.json());
      return;
    }
  } catch { /* sin conexión: mostrar login igualmente */ }
  showLogin();
}

function showLogin() {
  appEl.hidden = true;
  loginScreen.hidden = false;
  loginEmail.focus();
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: loginEmail.value.trim(), password: loginPassword.value }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      loginError.textContent = data.error || 'No se pudo iniciar sesión';
      return;
    }
    startApp(await res.json());
  } catch {
    loginError.textContent = 'Error de conexión';
  } finally {
    btn.disabled = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
  window.location.reload();
});

function startApp(user) {
  loginScreen.hidden = true;
  appEl.hidden = false;
  userNameEl.textContent = user.name || user.email;

  if (started) return;
  started = true;

  socket = io();
  wireSocket();
}

// ===== Sincronización =====
function emitAdd(note) { socket.emit('note:add', note); }
function emitUpdate(patch) { socket.emit('note:update', patch); }
function emitDelete(id) { socket.emit('note:delete', id); }

function getEl(id) {
  return board.querySelector(`.post-it[data-id="${id}"]`);
}

function applyClassName(el, note) {
  const maximized = el.classList.contains('maximized') ? ' maximized' : '';
  el.className = `post-it ${note.color} ${note.priority || ''}${maximized}`;
  updateOverflow(el); // reconstruir className pierde has-overflow; recalcular
}

// Marca la nota si su texto no cabe en el tamaño pequeño (para mostrar
// la etiqueta "Pincha para ampliar"). No aplica en estado maximizado.
function updateOverflow(el) {
  if (!el) return;
  const ta = el.querySelector('textarea');
  if (!ta) return;
  const overflowing = !el.classList.contains('maximized') && ta.scrollHeight > ta.clientHeight + 2;
  el.classList.toggle('has-overflow', overflowing);
}

function wireSocket() {
  socket.on('notes:init', (serverNotes) => {
    notes = Array.isArray(serverNotes) ? serverNotes : [];
    renderNotes();
  });

  socket.on('note:added', (note) => {
    if (notes.some(n => n.id === note.id)) return;
    notes.push(note);
    if (!getEl(note.id)) board.appendChild(createNoteElement(note));
  });

  socket.on('note:updated', (patch) => {
    const note = notes.find(n => n.id === patch.id);
    if (!note) return;
    Object.assign(note, patch);

    const el = getEl(patch.id);
    if (!el) return;

    if (patch.x != null) el.style.left = `${patch.x}px`;
    if (patch.y != null) el.style.top = `${patch.y}px`;
    if (patch.color != null || patch.priority != null) applyClassName(el, note);

    if (patch.text != null) {
      const textarea = el.querySelector('textarea');
      if (textarea && document.activeElement !== textarea) textarea.value = patch.text;
      updateOverflow(el);
    }
  });

  socket.on('note:deleted', (id) => {
    notes = notes.filter(n => n.id !== id);
    const el = getEl(id);
    if (el) {
      el.style.transform = 'scale(0)';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
      if (el === activeNoteEl) closeMaximized();
    }
  });
}

// ===== Acciones locales =====
function deleteNote(id, el) {
  if (window.confirm('¿Deseas eliminar esta nota?')) {
    notes = notes.filter(n => n.id !== id);
    emitDelete(id);
    el.style.transform = 'scale(0)';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
    if (el === activeNoteEl) closeMaximized();
  }
}

function createNoteElement(note) {
  const el = document.createElement('div');
  el.className = `post-it ${note.color} ${note.priority || ''} new`;
  el.style.left = `${note.x}px`;
  el.style.top = `${note.y}px`;
  el.style.transform = `rotate(${note.rotate}deg)`;
  el.dataset.id = note.id;

  const content = document.createElement('textarea');
  content.className = 'content';
  content.value = note.text;
  content.placeholder = 'Escribe algo...';

  const deleteBtn = document.createElement('div');
  deleteBtn.className = 'delete-btn';
  deleteBtn.textContent = '×';
  deleteBtn.title = 'Eliminar nota';

  // Autor de la nota
  const author = document.createElement('div');
  author.className = 'note-author';
  author.textContent = note.author ? `— ${note.author}` : '';

  // Botón (solo icono) que aparece cuando el texto no cabe (ver updateOverflow)
  const expandHint = document.createElement('button');
  expandHint.type = 'button';
  expandHint.className = 'expand-hint';
  expandHint.title = 'Ampliar';
  expandHint.setAttribute('aria-label', 'Ampliar nota');
  expandHint.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
  expandHint.addEventListener('mousedown', (e) => e.stopPropagation());
  expandHint.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!el.classList.contains('maximized')) maximizeNote(el, note);
  });

  const controls = document.createElement('div');
  controls.className = 'note-controls';

  ['priority-red', 'priority-yellow', 'priority-green', ''].forEach(p => {
    const opt = document.createElement('div');
    opt.className = 'priority-option';
    if (p) opt.classList.add(`p-${p.split('-')[1]}`);
    else opt.classList.add('p-none');

    opt.addEventListener('mousedown', (e) => e.stopPropagation());
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      note.priority = p;
      el.className = `post-it ${note.color} ${note.priority || ''} maximized`;
      emitUpdate({ id: note.id, priority: p });
    });
    controls.appendChild(opt);
  });

  el.appendChild(content);
  el.appendChild(deleteBtn);
  el.appendChild(author);
  el.appendChild(expandHint);
  el.appendChild(controls);

  let isDragging = false;
  let hasMoved = false;
  let offsetX, offsetY;
  let deleteClicked = false;

  el.addEventListener('mousedown', (e) => {
    if (e.target.closest('.delete-btn')) {
      deleteClicked = true;
      e.preventDefault();
      return;
    }
    if (e.target.closest('.note-controls')) return;
    if (e.target.closest('.expand-hint')) return;
    if (el.classList.contains('maximized')) return;

    isDragging = true;
    hasMoved = false;
    el.style.transition = 'none';
    el.style.zIndex = '1000';

    const rect = el.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
  });

  const onMouseMove = (e) => {
    if (!isDragging) return;
    hasMoved = true;

    let x = e.clientX - offsetX - board.getBoundingClientRect().left;
    let y = e.clientY - offsetY - board.getBoundingClientRect().top;

    x = Math.max(-50, Math.min(x, board.clientWidth - 130));
    y = Math.max(-50, Math.min(y, board.clientHeight - 130));

    el.style.left = `${x}px`;
    el.style.top = `${y}px`;

    note.x = x;
    note.y = y;
  };

  const onMouseUp = (e) => {
    if (deleteClicked) {
      deleteClicked = false;
      if (e.target.closest('.delete-btn')) deleteNote(note.id, el);
      return;
    }
    if (isDragging) {
      isDragging = false;
      el.style.transition = '';
      el.style.zIndex = '';
      if (hasMoved) emitUpdate({ id: note.id, x: note.x, y: note.y });
      hasMoved = false;
    }
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  el.addEventListener('dblclick', (e) => {
    if (e.target.closest('.delete-btn')) return;
    if (e.target.closest('.note-controls')) return;
    if (el.classList.contains('maximized')) return;
    maximizeNote(el, note);
  });

  // Medir el desbordamiento una vez que el elemento está en el DOM.
  requestAnimationFrame(() => updateOverflow(el));

  return el;
}

function renderNotes() {
  board.querySelectorAll('.post-it').forEach(n => n.remove());
  notes.forEach(note => board.appendChild(createNoteElement(note)));
}

// === COLOR & PRIORITY SELECTION ===
let selectedColor = 'color-yellow';
let selectedPriority = '';

addBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  colorMenu.classList.toggle('visible');
});

document.querySelectorAll('.color-option').forEach(opt => {
  opt.addEventListener('click', (e) => {
    selectedColor = e.target.dataset.color;
    document.querySelectorAll('.color-option').forEach(o => o.style.border = '2px solid rgba(0,0,0,0.1)');
    e.target.style.border = '3px solid #333';
    addNote();
    colorMenu.classList.remove('visible');
  });
});

document.querySelectorAll('.color-menu .priority-option').forEach(opt => {
  opt.addEventListener('click', (e) => {
    selectedPriority = e.target.dataset.priority;
    document.querySelectorAll('.color-menu .priority-option').forEach(o => o.style.outline = 'none');
    e.target.style.outline = '2px solid #333';
  });
});

function addNote() {
  const id = Date.now();
  const x = Math.random() * (board.clientWidth - 200) + 20;
  const y = Math.random() * (board.clientHeight - 200) + 20;
  const rotate = Math.random() * 30 - 15;

  const newNote = { id, text: '', color: selectedColor, priority: selectedPriority, x, y, rotate };
  notes.push(newNote);
  emitAdd(newNote);

  const el = createNoteElement(newNote);
  board.appendChild(el);
  maximizeNote(el, newNote);
}

function maximizeNote(el, note) {
  activeNote = note;
  activeNoteEl = el;
  el.classList.add('maximized');
  overlay.classList.add('visible');

  const textarea = el.querySelector('textarea');
  textarea.focus();

  textarea.oninput = (e) => {
    note.text = e.target.value;
    emitUpdate({ id: note.id, text: note.text });
  };
}

function closeMaximized() {
  if (activeNoteEl) {
    activeNoteEl.classList.remove('maximized');
    overlay.classList.remove('visible');
    updateOverflow(activeNoteEl); // el texto pudo crecer mientras estaba ampliada
    activeNote = null;
    activeNoteEl = null;
  }
}

overlay.addEventListener('click', (e) => {
  if (e.target === overlay) {
    closeMaximized();
    colorMenu.classList.remove('visible');
  }
});

window.addEventListener('click', (e) => {
  if (!colorMenu.contains(e.target) && e.target !== addBtn) {
    colorMenu.classList.remove('visible');
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMaximized();
    colorMenu.classList.remove('visible');
  }
});

boot();
