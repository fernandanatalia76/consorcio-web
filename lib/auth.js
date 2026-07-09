const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'db', 'database.sqlite');
let db;

function getDB() {
  if (!db) {
    db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uf TEXT NOT NULL UNIQUE,
        dni TEXT NOT NULL,
        password TEXT,
        propietario TEXT,
        rol TEXT DEFAULT 'consorcista',
        activo INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }
  return db;
}

// Registrar un nuevo usuario (consorcista pide acceso)
function registrar(uf, dni, propietario) {
  const d = getDB();
  const existe = d.prepare('SELECT id FROM usuarios WHERE uf = ?').get(uf);
  if (existe) return { ok: false, error: 'Ya existe un usuario para la UF ' + uf };
  d.prepare('INSERT INTO usuarios (uf, dni, propietario, rol, activo) VALUES (?, ?, ?, ?, ?)')
    .run(uf, dni, propietario || '', 'consorcista', 0);
  return { ok: true, mensaje: 'Solicitud registrada. El administrador te asignará una contraseña.' };
}

// Admin activa un usuario asignándole contraseña
function activarUsuario(uf, password) {
  const d = getDB();
  const hash = bcrypt.hashSync(password, 10);
  const r = d.prepare('UPDATE usuarios SET password = ?, activo = 1 WHERE uf = ?').run(hash, uf);
  if (r.changes === 0) return { ok: false, error: 'UF no encontrada' };
  return { ok: true };
}

// Login
function login(uf, password) {
  const d = getDB();
  const user = d.prepare('SELECT * FROM usuarios WHERE uf = ?').get(uf);
  if (!user) return { ok: false, error: 'UF no encontrada' };
  if (!user.activo) return { ok: false, error: 'Tu cuenta aún no fue activada por el administrador' };
  if (!user.password) return { ok: false, error: 'Todavía no tenés contraseña asignada' };
  if (!bcrypt.compareSync(password, user.password)) return { ok: false, error: 'Contraseña incorrecta' };
  return { ok: true, usuario: { id: user.id, uf: user.uf, propietario: user.propietario, rol: user.rol } };
}

// Listar usuarios pendientes (para el admin)
function listarPendientes() {
  return getDB().prepare('SELECT * FROM usuarios WHERE activo = 0').all();
}

// Listar todos los usuarios
function listarUsuarios() {
  return getDB().prepare('SELECT id, uf, dni, propietario, rol, activo, created_at FROM usuarios ORDER BY uf').all();
}

// Verificar si es admin
function esAdmin(session) {
  return session && session.usuario && session.usuario.rol === 'admin';
}

// Crear admin si no existe
function crearAdminSiNoExiste(password) {
  const d = getDB();
  const admin = d.prepare('SELECT id FROM usuarios WHERE rol = ?').get('admin');
  if (!admin) {
    const hash = bcrypt.hashSync(password, 10);
    d.prepare('INSERT INTO usuarios (uf, dni, password, propietario, rol, activo) VALUES (?, ?, ?, ?, ?, ?)')
      .run('admin', '00000000', hash, 'Administrador', 'admin', 1);
  }
}

module.exports = {
  registrar, activarUsuario, login, listarPendientes, listarUsuarios,
  esAdmin, crearAdminSiNoExiste
};
