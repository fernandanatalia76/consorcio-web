var bcrypt = require('bcryptjs');
var sheets = require('./sheets');

// Login - admin siempre funciona sin depender de Sheets
async function login(uf, pw) {
  if (uf === 'admin') {
    var adminPw = process.env.ADMIN_PASSWORD || 'admin123';
    if (pw === adminPw) return {ok:true, usuario:{uf:'admin', propietario:'Administrador', rol:'admin'}};
    return {ok:false, error:'Contraseña incorrecta'};
  }
  var usuarios = await sheets.leerUsuarios();
  var x = usuarios.find(function(u){return u.uf===uf;});
  if (!x) return {ok:false, error:'UF no encontrada. ¿Ya te registraste?'};
  if (!x.activo) return {ok:false, error:'Tu cuenta aún no fue activada por el administrador'};
  if (!x.password) return {ok:false, error:'Sin contraseña asignada'};
  if (!bcrypt.compareSync(pw, x.password)) return {ok:false, error:'Contraseña incorrecta'};
  return {ok:true, usuario:{uf:x.uf, propietario:x.propietario, rol:x.rol, email:x.email}};
}

// Registrar consorcista
async function registrar(uf, cuit, propietario, email) {
  var usuarios = await sheets.leerUsuarios();
  if (usuarios.find(function(u){return u.uf===uf;})) return {ok:false, error:'Ya existe un usuario para la UF '+uf};
  await sheets.agregarUsuario({uf:uf, cuit:cuit, propietario:propietario, email:email, password:'', rol:'consorcista', activo:false});
  return {ok:true};
}

// Admin activa usuario con contraseña
async function activarUsuario(uf, pw) {
  var usuarios = await sheets.leerUsuarios();
  var x = usuarios.find(function(u){return u.uf===uf;});
  if (!x) return {ok:false, error:'UF no encontrada'};
  x.password = bcrypt.hashSync(pw, 10);
  x.activo = true;
  await sheets.guardarUsuario(x.fila, x);
  return {ok:true, email:x.email};
}

// Admin desactiva usuario
async function desactivarUsuario(uf) {
  var usuarios = await sheets.leerUsuarios();
  var x = usuarios.find(function(u){return u.uf===uf;});
  if (!x) return {ok:false, error:'UF no encontrada'};
  if (x.rol === 'admin') return {ok:false, error:'No se puede dar de baja al admin'};
  x.activo = false;
  x.password = '';
  await sheets.guardarUsuario(x.fila, x);
  return {ok:true};
}

// Admin blanquea clave de consorcista
async function blanquearClave(uf, nuevaClave) {
  var usuarios = await sheets.leerUsuarios();
  var x = usuarios.find(function(u){return u.uf===uf;});
  if (!x) return {ok:false, error:'UF no encontrada'};
  x.password = bcrypt.hashSync(nuevaClave, 10);
  await sheets.guardarUsuario(x.fila, x);
  return {ok:true, email:x.email};
}

async function listarPendientes() {
  var u = await sheets.leerUsuarios();
  return u.filter(function(x){return !x.activo;});
}

async function listarUsuarios() {
  return await sheets.leerUsuarios();
}

module.exports = {login:login, registrar:registrar, activarUsuario:activarUsuario, desactivarUsuario:desactivarUsuario, blanquearClave:blanquearClave, listarPendientes:listarPendientes, listarUsuarios:listarUsuarios};
