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

// Devuelve todas las filas de usuarios que comparten el mismo email (case-insensitive)
// que la UF pasada. Si la UF no existe, arreglo vacio.
async function _hermanas(uf) {
  var usuarios = await sheets.leerUsuarios();
  var base = usuarios.find(function (u) { return u.uf === uf; });
  if (!base) return { base: null, hermanas: [] };
  var email = String(base.email || '').trim().toLowerCase();
  var hermanas = email
    ? usuarios.filter(function (u) { return u.rol !== 'admin' && String(u.email || '').trim().toLowerCase() === email; })
    : [base];
  return { base: base, hermanas: hermanas };
}

async function activarUsuario(uf, pw) {
  var info = await _hermanas(uf);
  if (!info.base) return { ok: false, error: 'UF no encontrada' };
  var hash = bcrypt.hashSync(pw, 10);
  var ufs = [];
  for (var i = 0; i < info.hermanas.length; i++) {
    var x = info.hermanas[i];
    x.password = hash;
    x.activo = true;
    await sheets.guardarUsuario(x.fila, x);
    ufs.push(x.uf);
  }
  return { ok: true, email: info.base.email, ufs: ufs };
}

async function desactivarUsuario(uf) {
  var info = await _hermanas(uf);
  if (!info.base) return { ok: false, error: 'UF no encontrada' };
  if (info.base.rol === 'admin') return { ok: false, error: 'No se puede dar de baja al admin' };
  var ufs = [];
  for (var i = 0; i < info.hermanas.length; i++) {
    var x = info.hermanas[i];
    x.activo = false;
    x.password = '';
    await sheets.guardarUsuario(x.fila, x);
    ufs.push(x.uf);
  }
  return { ok: true, ufs: ufs };
}

async function blanquearClave(uf, nuevaClave) {
  var info = await _hermanas(uf);
  if (!info.base) return { ok: false, error: 'UF no encontrada' };
  if (info.base.rol === 'admin') return { ok: false, error: 'Usá "Cambiar contraseña de admin"' };
  var hash = bcrypt.hashSync(nuevaClave, 10);
  var ufs = [];
  for (var i = 0; i < info.hermanas.length; i++) {
    var x = info.hermanas[i];
    x.password = hash;
    x.activo = true;
    await sheets.guardarUsuario(x.fila, x);
    ufs.push(x.uf);
  }
  return { ok: true, email: info.base.email, ufs: ufs };
}

async function eliminarUsuario(uf) {
  var info = await _hermanas(uf);
  if (!info.base) return { ok: false, error: 'UF no encontrada' };
  if (info.base.rol === 'admin') return { ok: false, error: 'No se puede eliminar al admin' };
  // Eliminar de mayor a menor fila para no correr los indices.
  var ordenadas = info.hermanas.slice().sort(function (a, b) { return b.fila - a.fila; });
  var ufs = [];
  for (var i = 0; i < ordenadas.length; i++) {
    await sheets.eliminarFilaUsuario(ordenadas[i].fila);
    ufs.push(ordenadas[i].uf);
  }
  return { ok: true, ufs: ufs };
}

function _ordenarPorUf(lista) {
  return lista.sort(function (a, b) {
    var na = parseInt(String(a.uf).replace(/\D/g, ''), 10);
    var nb = parseInt(String(b.uf).replace(/\D/g, ''), 10);
    if (isNaN(na) && isNaN(nb)) return String(a.uf).localeCompare(String(b.uf));
    if (isNaN(na)) return 1;
    if (isNaN(nb)) return -1;
    if (na !== nb) return na - nb;
    return String(a.uf).localeCompare(String(b.uf));
  });
}

// Agrupa filas con el mismo email (case-insensitive) en un solo registro.
// A cada registro le agrega ufsAgrupadas = ['33','41'] (ordenadas).
// El "principal" para acciones es el de UF mas baja (numerica).
function _agruparPorEmail(lista) {
  var grupos = {};
  lista.forEach(function (u) {
    var key = String(u.email || '').trim().toLowerCase();
    if (!key) key = '__uf_' + u.uf; // sin email: se agrupa solo consigo mismo
    if (!grupos[key]) grupos[key] = [];
    grupos[key].push(u);
  });
  var salida = [];
  Object.keys(grupos).forEach(function (k) {
    var g = _ordenarPorUf(grupos[k].slice());
    var principal = Object.assign({}, g[0]);
    principal.ufsAgrupadas = g.map(function (x) { return x.uf; });
    salida.push(principal);
  });
  return _ordenarPorUf(salida);
}

async function listarPendientes() {
  var u = await sheets.leerUsuarios();
  var pend = u.filter(function (x) { return !x.activo && x.rol !== 'admin'; });
  return _agruparPorEmail(pend);
}

async function listarUsuarios() {
  var u = await sheets.leerUsuarios();
  var noAdmin = u.filter(function (x) { return x.rol !== 'admin'; });
  return _agruparPorEmail(noAdmin);
}

module.exports = {
  login: login, registrar: registrar, activarUsuario: activarUsuario,
  desactivarUsuario: desactivarUsuario, blanquearClave: blanquearClave,
  eliminarUsuario: eliminarUsuario,
  cambiarPasswordAdmin: cambiarPasswordAdmin,
  listarPendientes: listarPendientes, listarUsuarios: listarUsuarios
};
