const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'db', 'users.json');

function leerDB() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch(e) { return []; }
}

function guardarDB(users) {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2));
}

function registrar(uf, dni, propietario) {
  const users = leerDB();
  if (users.find(u => u.uf === uf)) return { ok: false, error: 'Ya existe un usuario para la UF ' + uf };
  users.push({ uf, dni, propietario: propietario || '', rol: 'consorcista', password: null, activo: false, created: new Date().toISOString() });
  guardarDB(users);
  return { ok: true, mensaje: 'Solicitud registrada. El administrador te asignará una contraseña.' };
}

function activarUsuario(uf, password) {
  const users = leerDB();
  const user = users.find(u => u.uf === uf);
  if (!user) return { ok: false, error: 'UF no encontrada' };
  user.password = bcrypt.hashSync(password, 10);
  user.activo = true;
  guardarDB(users);
  return { ok: true };
}

function login(uf, password) {
  const users = leerDB();
  const user = users.find(u => u.uf === uf);
  if (!user) return { ok: false, error: 'UF no encontrada' };
  if (!user.activo) return { ok: false, error: 'Tu cuenta aún no fue activada por el administrador' };
  if (!user.password) return { ok: false, error: 'Todavía no tenés contraseña asignada' };
  if (!bcrypt.compareSync(password, user.password)) return { ok: false, error: 'Contraseña incorrecta' };
  return { ok: true, usuario: { id: user.uf, uf: user.uf, propietario: user.propietario, rol: user.rol } };
}

function listarPendientes() {
  return leerDB().filter(u => !u.activo);
}

function listarUsuarios() {
  return leerDB().map(u => ({ uf: u.uf, dni: u.dni, propietario: u.propietario, rol: u.rol, activo: u.activo, created_at: u.created }));
}

function esAdmin(session) {
  return session && session.usuario && session.usuario.rol === 'admin';
}

function crearAdminSiNoExiste(password) {
  const users = leerDB();
  if (users.find(u => u.rol === 'admin')) return;
  users.push({ uf: 'admin', dni: '00000000', propietario: 'Administrador', rol: 'admin', password: bcrypt.hashSync(password, 10), activo: true, created: new Date().toISOString() });
  guardarDB(users);
}

module.exports = {
  registrar, activarUsuario, login, listarPendientes, listarUsuarios,
  esAdmin, crearAdminSiNoExiste
};
