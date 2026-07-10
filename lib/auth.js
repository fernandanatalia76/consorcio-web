var bcrypt = require('bcryptjs');
var sheets = require('./sheets');

// ---- Admin: la clave se guarda como una fila especial (uf='admin', rol='admin')
//      en la solapa "Usuarios", asi persiste entre reinicios de Render.
//      Si no existe esa fila, se usa ADMIN_PASSWORD como respaldo. ----

async function login(uf, pw) {
  if (uf === 'admin') {
    var usuarios = await sheets.leerUsuarios();
    var adminRow = usuarios.find(function (u) { return u.uf === 'admin'; });
    if (adminRow && adminRow.password) {
      if (bcrypt.compareSync(pw, adminRow.password)) {
        return { ok: true, usuario: { uf: 'admin', propietario: 'Administrador', rol: 'admin' } };
      }
      return { ok: false, error: 'Contraseña incorrecta' };
    }
    // Sin fila admin todavia -> respaldo por variable de entorno
    var adminPw = process.env.ADMIN_PASSWORD || 'admin123';
    if (pw === adminPw) return { ok: true, usuario: { uf: 'admin', propietario: 'Administrador', rol: 'admin' } };
    return { ok: false, error: 'Contraseña incorrecta' };
  }

  var usuarios2 = await sheets.leerUsuarios();
  var x = usuarios2.find(function (u) { return u.uf === uf; });
  if (!x) return { ok: false, error: 'UF no encontrada. ¿Ya te registraste?' };
  if (x.rol === 'admin') return { ok: false, error: 'UF no encontrada.' };
  if (!x.activo) return { ok: false, error: 'Tu cuenta aún no fue activada por el administrador' };
  if (!x.password) return { ok: false, error: 'Sin contraseña asignada' };
  if (!bcrypt.compareSync(pw, x.password)) return { ok: false, error: 'Contraseña incorrecta' };
  return { ok: true, usuario: { uf: x.uf, propietario: x.propietario, rol: x.rol, email: x.email } };
}

// Cambia (y persiste) la contraseña del admin.
async function cambiarPasswordAdmin(nuevaPw) {
  if (!nuevaPw || nuevaPw.length < 4) return { ok: false, error: 'La contraseña debe tener al menos 4 caracteres' };
  var hash = bcrypt.hashSync(nuevaPw, 10);
  var usuarios = await sheets.leerUsuarios();
  var adminRow = usuarios.find(function (u) { return u.uf === 'admin'; });
  if (adminRow) {
    adminRow.password = hash;
    adminRow.rol = 'admin';
    adminRow.activo = true;
    await sheets.guardarUsuario(adminRow.fila, adminRow);
  } else {
    await sheets.agregarUsuario({ uf: 'admin', cuit: '', propietario: 'Administrador', email: process.env.ADMIN_EMAIL || '', password: hash, rol: 'admin', activo: true });
  }
  // Mantenemos la variable de entorno del proceso en sync (por si se relee en la sesion actual)
  process.env.ADMIN_PASSWORD = nuevaPw;
  return { ok: true };
}

async function registrar(uf, cuit, propietario, email) {
  var usuarios = await sheets.leerUsuarios();
  if (usuarios.find(function (u) { return u.uf === uf; })) return { ok: false, error: 'Ya existe un usuario para la UF ' + uf };
  await sheets.agregarUsuario({ uf: uf, cuit: cuit, propietario: propietario, email: email, password: '', rol: 'consorcista', activo: false });
  return { ok: true };
}

async function activarUsuario(uf, pw) {
  var usuarios = await sheets.leerUsuarios();
  var x = usuarios.find(function (u) { return u.uf === uf; });
  if (!x) return { ok: false, error: 'UF no encontrada' };
  x.password = bcrypt.hashSync(pw, 10);
  x.activo = true;
  await sheets.guardarUsuario(x.fila, x);
  return { ok: true, email: x.email };
}

async function desactivarUsuario(uf) {
  var usuarios = await sheets.leerUsuarios();
  var x = usuarios.find(function (u) { return u.uf === uf; });
  if (!x) return { ok: false, error: 'UF no encontrada' };
  if (x.rol === 'admin') return { ok: false, error: 'No se puede dar de baja al admin' };
  x.activo = false;
  x.password = '';
  await sheets.guardarUsuario(x.fila, x);
  return { ok: true };
}

async function blanquearClave(uf, nuevaClave) {
  var usuarios = await sheets.leerUsuarios();
  var x = usuarios.find(function (u) { return u.uf === uf; });
  if (!x) return { ok: false, error: 'UF no encontrada' };
  if (x.rol === 'admin') return { ok: false, error: 'Usá "Cambiar contraseña de admin"' };
  x.password = bcrypt.hashSync(nuevaClave, 10);
  x.activo = true;
  await sheets.guardarUsuario(x.fila, x);
  return { ok: true, email: x.email };
}

async function eliminarUsuario(uf) {
  var usuarios = await sheets.leerUsuarios();
  var x = usuarios.find(function (u) { return u.uf === uf; });
  if (!x) return { ok: false, error: 'UF no encontrada' };
  if (x.rol === 'admin') return { ok: false, error: 'No se puede eliminar al admin' };
  await sheets.eliminarFilaUsuario(x.fila);
  return { ok: true };
}

async function listarPendientes() {
  var u = await sheets.leerUsuarios();
  return u.filter(function (x) { return !x.activo && x.rol !== 'admin'; });
}

async function listarUsuarios() {
  var u = await sheets.leerUsuarios();
  return u.filter(function (x) { return x.rol !== 'admin'; });
}

module.exports = {
  login: login, registrar: registrar, activarUsuario: activarUsuario,
  desactivarUsuario: desactivarUsuario, blanquearClave: blanquearClave,
  eliminarUsuario: eliminarUsuario,
  cambiarPasswordAdmin: cambiarPasswordAdmin,
  listarPendientes: listarPendientes, listarUsuarios: listarUsuarios
};
