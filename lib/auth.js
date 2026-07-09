var bcrypt = require('bcryptjs');
var fs = require('fs');
var DB_PATH = '/tmp/consorcio-users.json';

function leerDB() { try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch(e) { return []; } }
function guardarDB(u) { fs.writeFileSync(DB_PATH, JSON.stringify(u, null, 2)); }

function registrar(uf, cuit, prop, email) {
  var u = leerDB();
  if (u.find(function(x){return x.uf===uf;})) return {ok:false, error:'Ya existe usuario para UF '+uf};
  u.push({uf:uf, cuit:cuit, propietario:prop||'', email:email||'', rol:'consorcista', password:null, activo:false});
  guardarDB(u);
  return {ok:true};
}

function activarUsuario(uf, pw) {
  var u = leerDB();
  var x = u.find(function(x){return x.uf===uf;});
  if (!x) return {ok:false, error:'UF no encontrada'};
  x.password = bcrypt.hashSync(pw, 10);
  x.activo = true;
  guardarDB(u);
  return {ok:true};
}

function desactivarUsuario(uf) {
  var u = leerDB();
  var x = u.find(function(x){return x.uf===uf;});
  if (!x) return {ok:false, error:'UF no encontrada'};
  if (x.rol === 'admin') return {ok:false, error:'No se puede dar de baja al admin'};
  x.activo = false;
  x.password = null;
  guardarDB(u);
  return {ok:true};
}

function login(uf, pw) {
  // Admin siempre funciona sin depender del archivo
  if (uf === 'admin') {
    var adminPw = process.env.ADMIN_PASSWORD || 'admin123';
    if (pw === adminPw) return {ok:true, usuario:{id:'admin', uf:'admin', propietario:'Administrador', rol:'admin'}};
    return {ok:false, error:'Contraseña incorrecta'};
  }
  var u = leerDB();
  var x = u.find(function(x){return x.uf===uf;});
  if (!x) return {ok:false, error:'UF no encontrada'};
  if (!x.activo) return {ok:false, error:'Cuenta no activada'};
  if (!x.password) return {ok:false, error:'Sin contraseña asignada'};
  if (!bcrypt.compareSync(pw, x.password)) return {ok:false, error:'Contraseña incorrecta'};
  return {ok:true, usuario:{id:x.uf, uf:x.uf, propietario:x.propietario, rol:x.rol}};
}

function listarPendientes() { return leerDB().filter(function(x){return !x.activo;}); }
function listarUsuarios() { return leerDB(); }
function esAdmin(s) { return s && s.usuario && s.usuario.rol==='admin'; }

function crearAdminSiNoExiste(pw) {
  var u = leerDB();
  if (u.find(function(x){return x.rol==='admin';})) return;
  u.push({uf:'admin', dni:'0', propietario:'Administrador', rol:'admin', password:bcrypt.hashSync(pw,10), activo:true});
  guardarDB(u);
  console.log('Admin creado OK');
}

module.exports = {registrar:registrar, activarUsuario:activarUsuario, desactivarUsuario:desactivarUsuario, login:login, listarPendientes:listarPendientes, listarUsuarios:listarUsuarios, esAdmin:esAdmin, crearAdminSiNoExiste:crearAdminSiNoExiste};
