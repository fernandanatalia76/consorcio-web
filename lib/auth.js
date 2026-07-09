var bcrypt = require('bcryptjs');
var fs = require('fs');
var path = require('path');

var DB_PATH = path.join('/tmp', 'consorcio-users.json');

function leerDB() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch(e) { return []; }
}

function guardarDB(users) {
  fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2));
}

function registrar(uf, dni, propietario) {
  var users = leerDB();
  if (users.find(function(u) { return u.uf === uf; })) return { ok: false, error: 'Ya existe un usuario para la UF ' + uf };
  users.push({ uf: uf, dni: dni, propietario: propietario || '', rol: 'consorcista', password: null, activo: false, created: new Date().toISOString() });
  guardarDB(users);
  return { ok: true };
}

function activarUsuario(uf, password) {
  var users = leerDB();
  var user = users.find(function(u) { return u.uf === uf; });
  if (!user) return { ok: false, error: 'UF no encontrada' };
  user.password = bcrypt.hashSync(password, 10);
  user.activo = true;
  guardarDB(users);
  return { ok: true };
}

function login(uf, password) {
  var users = leerDB();
  var user = users.find(function(u) { return u.uf === uf; });
  if (!user) return { ok: false, error: 'UF no encontrada' };
  if (!user.activo) return { ok: false, error: 'Tu cuenta aún no fue activada por el administrador' };
  if (!user.password) return { ok: false, error: 'Todavía no tenés contraseña asignada' };
  if (!bcrypt.compareSync(password, user.password)) return { ok: false, error: 'Contraseña incorrecta' };
  return { ok: true, usuario: { id: user.uf, uf: user.uf, propietario: user.propietario, rol: user.rol } };
}

function listarPendientes() {
  return leerDB().filter(function(u) { return !u.activo; });
}

function listarUsuarios() {
  return leerDB().map(function(u) { return { uf: u.uf, dni: u.dni, propietario: u.propietario, rol: u.rol, activo: u.activo, created_at: u.created }; });
}

function esAdmin(session) {
  return session && session.usuario && session.usuario.rol === 'admin';
}

function crearAdminSiNoExiste(password) {
  var users = leerDB();
  if (users.find(function(u) { return u.rol === 'admin'; })) return;
  users.push({ uf: 'admin', dni: '00000000', propietario: 'Administrador', rol: 'admin', password: bcrypt.hashSync(password, 10), activo: true, created: new Date().toISOString() });
  guardarDB(users);
  console.log('Admin creado con UF: admin');
}

module.exports = { registrar: registrar, activarUsuario: activarUsuario, login: login, listarPendientes: listarPendientes, listarUsuarios: listarUsuarios, esAdmin: esAdmin, crearAdminSiNoExiste: crearAdminSiNoExiste };
