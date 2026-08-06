var bcrypt = require('bcryptjs');
var sheets = require('./sheets');
// FIX (multi-consorcio): TODAS las funciones ahora reciben "ssid" (el ID
// de la planilla del consorcio elegido) como PRIMER parámetro, igual que
// en sheets.js — cada consorcio tiene su propia solapa "Usuarios"
// independiente.
async function login(ssid, uf, pw, tipo) {
  var usuarios0 = await sheets.leerUsuarios(ssid);
  // FIX: para el usuario "admin" clásico, buscamos SOLO por uf (como
  // siempre funcionó) sin exigir que el Rol esté exactamente en
  // "admin" — así no se rompe con filas viejas donde ese campo pueda
  // estar vacío o distinto. Para administradores ADICIONALES (usuario
  // propio, creados con "Agregar administrador"), sí exigimos rol='admin'.
  var adminRow = usuarios0.find(function (u) { return u.uf === uf && (u.rol === 'admin' || uf === 'admin'); });
  if (adminRow) {
    if (adminRow.password) {
      if (bcrypt.compareSync(pw, adminRow.password)) {
        return { ok: true, usuario: { uf: adminRow.uf, propietario: adminRow.propietario || 'Administrador', rol: 'admin' } };
      }
      return { ok: false, error: 'Contraseña incorrecta' };
    }
    // Fallback legado: la fila "admin" clásica sin clave propia todavía
    // seteada usa la variable de entorno ADMIN_PASSWORD.
    if (uf === 'admin') {
      var adminPwFallback = process.env.ADMIN_PASSWORD || 'admin123';
      if (pw === adminPwFallback) return { ok: true, usuario: { uf: 'admin', propietario: 'Administrador', rol: 'admin' } };
    }
    return { ok: false, error: 'Contraseña incorrecta' };
  }
  if (uf === 'admin') {
    // Todavía no existe ninguna fila "admin" en Usuarios: fallback legado.
    var adminPw = process.env.ADMIN_PASSWORD || 'admin123';
    if (pw === adminPw) return { ok: true, usuario: { uf: 'admin', propietario: 'Administrador', rol: 'admin' } };
    return { ok: false, error: 'Contraseña incorrecta' };
  }
  var tipoNorm = String(tipo || '').toLowerCase();
  if (tipoNorm !== 'inquilino') tipoNorm = 'propietario';
  var usuarios2 = await sheets.leerUsuarios(ssid);
  var candidatas = usuarios2.filter(function (u) { return u.uf === uf && u.rol !== 'admin'; });
  if (!candidatas.length) return { ok: false, error: 'UF no encontrada. ¿Ya te registraste?' };
  var x = candidatas.find(function (u) { return (u.tipo || 'propietario') === tipoNorm; });
  if (!x) return { ok: false, error: 'No hay ' + tipoNorm + ' registrado para la UF ' + uf };
  if (!x.activo) return { ok: false, error: 'Tu cuenta aún no fue activada por el administrador' };
  if (!x.password) return { ok: false, error: 'Sin contraseña asignada' };
  if (!bcrypt.compareSync(pw, x.password)) return { ok: false, error: 'Contraseña incorrecta' };
  var todas = await ufsDelUsuario(ssid, x.cuit);
  var ufsUsuario = todas
    .map(function (u) { return { uf: u.uf, tipo: u.tipo || 'propietario', propietario: u.propietario }; })
    .sort(function (a, b) {
      var na = parseInt(String(a.uf).replace(/\D/g, ''), 10);
      var nb = parseInt(String(b.uf).replace(/\D/g, ''), 10);
      return (isNaN(na) ? 0 : na) - (isNaN(nb) ? 0 : nb);
    });
  return {
    ok: true,
    usuario: {
      uf: x.uf, propietario: x.propietario, rol: x.rol, email: x.email, tipo: x.tipo,
      cuit: String(x.cuit || '').replace(/[^\d]/g, ''),
      ufsUsuario: ufsUsuario
    }
  };
}
async function cambiarPasswordAdmin(ssid, nuevaPw) {
  if (!nuevaPw || nuevaPw.length < 4) return { ok: false, error: 'La contraseña debe tener al menos 4 caracteres' };
  var hash = bcrypt.hashSync(nuevaPw, 10);
  var usuarios = await sheets.leerUsuarios(ssid);
  var adminRow = usuarios.find(function (u) { return u.uf === 'admin'; });
  if (adminRow) {
    adminRow.password = hash;
    adminRow.rol = 'admin';
    adminRow.activo = true;
    await sheets.guardarUsuario(ssid, adminRow.fila, adminRow);
  } else {
    await sheets.agregarUsuario(ssid, { uf: 'admin', cuit: '', propietario: 'Administrador', email: process.env.ADMIN_EMAIL || '', password: hash, rol: 'admin', activo: true });
  }
  return { ok: true };
}
async function registrar(ssid, uf, cuit, propietario, email, tipo) {
  var tipoNorm = String(tipo || '').toLowerCase();
  if (tipoNorm !== 'inquilino') tipoNorm = 'propietario';
  var usuarios = await sheets.leerUsuarios(ssid);
  var yaExiste = usuarios.find(function (u) {
    return u.uf === uf && (u.tipo || 'propietario') === tipoNorm && u.rol !== 'admin';
  });
  if (yaExiste) return { ok: false, error: 'Ya existe un ' + tipoNorm + ' registrado para la UF ' + uf };
  await sheets.agregarUsuario(ssid, { uf: uf, cuit: cuit, propietario: propietario, email: email, password: '', rol: 'consorcista', activo: false, tipo: tipoNorm });
  return { ok: true };
}
async function _hermanas(ssid, uf, tipo) {
  var tipoNorm = String(tipo || '').toLowerCase();
  if (tipoNorm !== 'inquilino') tipoNorm = 'propietario';
  var usuarios = await sheets.leerUsuarios(ssid);
  var base = usuarios.find(function (u) {
    return u.uf === uf && (u.tipo || 'propietario') === tipoNorm && u.rol !== 'admin';
  });
  if (!base) return { base: null, hermanas: [] };
  var cuit = String(base.cuit || '').replace(/[^\d]/g, '');
  var hermanas = cuit
    ? usuarios.filter(function (u) {
        return u.rol !== 'admin'
          && (u.tipo || 'propietario') === tipoNorm
          && String(u.cuit || '').replace(/[^\d]/g, '') === cuit;
      })
    : [base];
  return { base: base, hermanas: hermanas };
}
async function ufsDelUsuario(ssid, cuit) {
  if (!cuit) return [];
  var cuitLimpio = String(cuit).replace(/[^\d]/g, '');
  var usuarios = await sheets.leerUsuarios(ssid);
  var encontradas = usuarios.filter(function (u) {
    return u.rol !== 'admin' && u.activo
      && String(u.cuit || '').replace(/[^\d]/g, '') === cuitLimpio;
  });
  return encontradas;
}
async function activarUsuario(ssid, uf, pw, tipo) {
  var info = await _hermanas(ssid, uf, tipo);
  if (!info.base) return { ok: false, error: 'UF no encontrada' };
  var hash = bcrypt.hashSync(pw, 10);
  var ufs = [];
  for (var i = 0; i < info.hermanas.length; i++) {
    var x = info.hermanas[i];
    x.password = hash;
    x.activo = true;
    await sheets.guardarUsuario(ssid, x.fila, x);
    ufs.push(x.uf);
  }
  return { ok: true, email: info.base.email, ufs: ufs, tipo: info.base.tipo };
}
async function desactivarUsuario(ssid, uf, tipo) {
  var info = await _hermanas(ssid, uf, tipo);
  if (!info.base) return { ok: false, error: 'UF no encontrada' };
  if (info.base.rol === 'admin') return { ok: false, error: 'No se puede dar de baja al admin' };
  var ufs = [];
  for (var i = 0; i < info.hermanas.length; i++) {
    var x = info.hermanas[i];
    x.activo = false;
    x.password = '';
    await sheets.guardarUsuario(ssid, x.fila, x);
    ufs.push(x.uf);
  }
  return { ok: true, ufs: ufs, tipo: info.base.tipo };
}
async function blanquearClave(ssid, uf, nuevaClave, tipo) {
  var info = await _hermanas(ssid, uf, tipo);
  if (!info.base) return { ok: false, error: 'UF no encontrada' };
  if (info.base.rol === 'admin') return { ok: false, error: 'Usá "Cambiar contraseña de admin"' };
  var hash = bcrypt.hashSync(nuevaClave, 10);
  var ufs = [];
  for (var i = 0; i < info.hermanas.length; i++) {
    var x = info.hermanas[i];
    x.password = hash;
    x.activo = true;
    await sheets.guardarUsuario(ssid, x.fila, x);
    ufs.push(x.uf);
  }
  return { ok: true, email: info.base.email, ufs: ufs, tipo: info.base.tipo };
}
async function eliminarUsuario(ssid, uf, tipo) {
  var info = await _hermanas(ssid, uf, tipo);
  if (!info.base) return { ok: false, error: 'UF no encontrada' };
  if (info.base.rol === 'admin') return { ok: false, error: 'No se puede eliminar al admin' };
  var ordenadas = info.hermanas.slice().sort(function (a, b) { return b.fila - a.fila; });
  var ufs = [];
  for (var i = 0; i < ordenadas.length; i++) {
    await sheets.eliminarFilaUsuario(ssid, ordenadas[i].fila);
    ufs.push(ordenadas[i].uf);
  }
  return { ok: true, ufs: ufs, tipo: info.base.tipo };
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
function _agruparPorEmail(lista) {
  var salida = lista.map(function (u) {
    var copia = Object.assign({}, u);
    copia.ufsAgrupadas = [u.uf];
    return copia;
  });
  return _ordenarPorUf(salida);
}
async function listarPendientes(ssid) {
  var u = await sheets.leerUsuarios(ssid);
  var pend = u.filter(function (x) { return !x.activo && x.rol !== 'admin'; });
  return _agruparPorEmail(pend);
}
async function listarUsuarios(ssid) {
  var u = await sheets.leerUsuarios(ssid);
  var noAdmin = u.filter(function (x) { return x.rol !== 'admin'; });
  return _agruparPorEmail(noAdmin);
}
async function cambiarPasswordPropia(ssid, uf, tipo, passwordActual, passwordNueva) {
  var info = await _hermanas(ssid, uf, tipo);
  if (!info.base) return { ok: false, error: 'UF no encontrada' };
  if (!info.base.password || !bcrypt.compareSync(passwordActual, info.base.password)) {
    return { ok: false, error: 'La contraseña actual no es correcta' };
  }
  if (!passwordNueva || passwordNueva.length < 4) {
    return { ok: false, error: 'La contraseña nueva debe tener al menos 4 caracteres' };
  }
  var hash = bcrypt.hashSync(passwordNueva, 10);
  for (var i = 0; i < info.hermanas.length; i++) {
    var x = info.hermanas[i];
    x.password = hash;
    x.activo = true;
    await sheets.guardarUsuario(ssid, x.fila, x);
  }
  return { ok: true };
}
async function agregarAdmin(ssid, uf, password, nombre, email) {
  var uf2 = String(uf || '').trim();
  if (!uf2) return { ok: false, error: 'Falta el nombre de usuario' };
  if (uf2 === 'admin') return { ok: false, error: 'Ese nombre de usuario ya está reservado' };
  var usuarios = await sheets.leerUsuarios(ssid);
  var yaExiste = usuarios.find(function (u) { return u.uf === uf2; });
  if (yaExiste) return { ok: false, error: 'Ya existe un usuario con ese nombre' };
  var hash = bcrypt.hashSync(password, 10);
  await sheets.agregarUsuario(ssid, {
    uf: uf2, cuit: '', propietario: nombre || uf2, email: email || '',
    password: hash, rol: 'admin', activo: true, tipo: 'propietario'
  });
  return { ok: true };
}
module.exports = {
  login: login, registrar: registrar, activarUsuario: activarUsuario,
  desactivarUsuario: desactivarUsuario, blanquearClave: blanquearClave,
  eliminarUsuario: eliminarUsuario,
  cambiarPasswordAdmin: cambiarPasswordAdmin,
  cambiarPasswordPropia: cambiarPasswordPropia,
  agregarAdmin: agregarAdmin,
  listarPendientes: listarPendientes, listarUsuarios: listarUsuarios,
  ufsDelUsuario: ufsDelUsuario
};
