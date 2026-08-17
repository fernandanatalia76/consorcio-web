require('dotenv').config();
var express = require('express');
var session = require('express-session');
var path = require('path');
var authLib = require('./lib/auth');
var sheets = require('./lib/sheets');
var mailer = require('./lib/mailer');
var directorio = require('./lib/directorio');
var multer = require('multer');
var uploadArchivo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
var csvLiquidacion = require('./lib/csvLiquidacion');
var textoLiquidacion = require('./lib/textoLiquidacion');
var wordLiquidacion = require('./lib/wordLiquidacion');
var app = express();
var PORT = process.env.PORT || 3000;
app.set('view engine', 'ejs');
// FIX: Render está detrás de un proxy reverso — sin esto, req.ip
// devuelve la IP interna del proxy (la misma para todos los usuarios),
// lo que rompería el límite de intentos de login de acá abajo.
app.set('trust proxy', 1);

// ==================== LÍMITE DE INTENTOS DE LOGIN ====================
// Protección básica contra fuerza bruta: bloquea una IP 15 minutos
// después de 5 intentos de login fallidos seguidos.
var loginAttempts = {}; // { [ip]: { count, blockedUntil } }
var MAX_INTENTOS_LOGIN = 5;
var BLOQUEO_LOGIN_MS = 15 * 60 * 1000;
function chequearLimiteLogin(ip) {
  var a = loginAttempts[ip];
  if (!a || !a.blockedUntil) return { bloqueado: false };
  if (Date.now() < a.blockedUntil) {
    return { bloqueado: true, minutos: Math.ceil((a.blockedUntil - Date.now()) / 60000) };
  }
  delete loginAttempts[ip];
  return { bloqueado: false };
}
function registrarLoginFallido(ip) {
  if (!loginAttempts[ip]) loginAttempts[ip] = { count: 0, blockedUntil: null };
  loginAttempts[ip].count++;
  if (loginAttempts[ip].count >= MAX_INTENTOS_LOGIN) {
    loginAttempts[ip].blockedUntil = Date.now() + BLOQUEO_LOGIN_MS;
  }
}
function limpiarLoginFallido(ip) {
  delete loginAttempts[ip];
}
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({ secret: process.env.SESSION_SECRET || 'dev-secret', resave: false, saveUninitialized: false }));
app.use(function (req, res, next) { res.locals.usuario = req.session.usuario || null; next(); });
function requireLogin(req, res, next) {
  if (!req.session.usuario || !req.session.spreadsheetId) return res.redirect('/login');
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.usuario || req.session.usuario.rol !== 'admin' || !req.session.spreadsheetId) return res.redirect('/login');
  next();
}
function parseMonto(v) {
  if (v === null || v === undefined) return 0;
  var s = String(v).replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  if (s.indexOf(',') !== -1) {
    s = s.replace(/\./g, '').replace(',', '.');
  }
  var n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
function calcularEstado(row) {
  var cobrado = parseMonto(row.montoCobrado);
  var pendiente = parseMonto(row.montoPendiente);
  var aPagar = parseMonto(row.total1) || (cobrado + pendiente);
  var txt = String(row.estado || '').toLowerCase();
  if (txt.indexOf('total') !== -1 || txt.indexOf('pagad') !== -1 || txt.indexOf('cancel') !== -1) {
    return { clave: 'total', label: 'Pagado' };
  }
  if (txt.indexOf('parcial') !== -1) return { clave: 'parcial', label: 'Parcial' };
  if (txt.indexOf('pendiente') !== -1 || txt.indexOf('impago') !== -1) return { clave: 'pendiente', label: 'Pendiente' };
  if (cobrado <= 0) return { clave: 'pendiente', label: 'Pendiente' };
  if (pendiente > 0.5 || (aPagar > 0 && cobrado + 0.5 < aPagar)) return { clave: 'parcial', label: 'Parcial' };
  return { clave: 'total', label: 'Pagado' };
}
function getMesActivo(di) {
  var p = String(di['Mes activo'] || '').split('-');
  var anio = parseInt(p[0]), mesNum = parseInt(p[1]);
  var mgNum = (mesNum === 1) ? 12 : (mesNum - 1);
  var mgAnio = (mesNum === 1) ? (anio - 1) : anio;
  var meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  return {
    mesNum: mesNum, anio: anio,
    mesLabel: meses[mesNum - 1] + ' ' + anio,
    mesTxt: String(anio) + '-' + String(mesNum).padStart(2, '0'),
    mesGasNum: mgNum, mesGasAnio: mgAnio,
    mesGasLabel: meses[mgNum - 1] + ' ' + mgAnio,
    mesGasTxt: String(mgAnio) + '-' + String(mgNum).padStart(2, '0'),
    meses: meses
  };
}
function getMesGastos(di) {
  var a = getMesActivo(di);
  return Object.assign({}, a, { mesLabel: a.mesGasLabel, mesTxt: a.mesGasTxt });
}
var cacheGastosPorConsorcio = {};
var cacheLiqPorConsorcio = {};
function getCacheGastos(ssid) {
  if (!cacheGastosPorConsorcio[ssid]) {
    cacheGastosPorConsorcio[ssid] = { publicado: false, fechaHora: null, quienActualizo: null, datos: null };
  }
  return cacheGastosPorConsorcio[ssid];
}
function getCacheLiq(ssid) {
  if (!cacheLiqPorConsorcio[ssid]) {
    cacheLiqPorConsorcio[ssid] = { publicado: false, fechaHora: null, quienActualizo: null, datos: null };
  }
  return cacheLiqPorConsorcio[ssid];
}
(async function inicializarCaches() {
  try {
    var lista = await directorio.listarConsorcios();
    for (var i = 0; i < lista.length; i++) {
      var ssid = lista[i].spreadsheetId;
      try {
        var g = await sheets.leerCache(ssid, 'gastos');
        if (g && g.datos) {
          var cg = getCacheGastos(ssid);
          cg.publicado = true; cg.fechaHora = g.fecha; cg.datos = g.datos;
        }
      } catch (e) { console.log('[CACHE] No se pudo restaurar gastos de "' + lista[i].nombre + '":', e.message); }
      try {
        var l = await sheets.leerCache(ssid, 'liquidacion');
        if (l && l.datos) {
          var cl = getCacheLiq(ssid);
          cl.publicado = true; cl.fechaHora = l.fecha; cl.datos = l.datos;
        }
      } catch (e) { console.log('[CACHE] No se pudo restaurar liquidacion de "' + lista[i].nombre + '":', e.message); }
    }
    console.log('[CACHE] Precarga inicial completa para', lista.length, 'consorcio(s).');
  } catch (e) { console.log('[CACHE] Error precargando consorcios:', e.message); }
})();
app.get('/', function (req, res) { if (req.session.usuario) return res.redirect(req.session.usuario.rol === 'admin' ? '/admin' : '/mi-liquidacion'); res.redirect('/login'); });
app.get('/login', async function (req, res) {
  var c = req.query.c;
  if (!c) {
    var lista = await directorio.listarConsorcios();
    return res.render('login', { error: null, consorcios: lista, consorcioElegido: null });
  }
  var consorcio = await directorio.buscarPorSpreadsheetId(c);
  if (!consorcio) {
    var lista2 = await directorio.listarConsorcios();
    return res.render('login', { error: 'Consorcio no encontrado.', consorcios: lista2, consorcioElegido: null });
  }
  res.render('login', { error: null, consorcios: [], consorcioElegido: consorcio });
});
app.post('/login', async function (req, res) {
  try {
    var ip = req.ip;
    var limite = chequearLimiteLogin(ip);
    var consorcioId = req.body.consorcioId;
    var consorcio = await directorio.buscarPorSpreadsheetId(consorcioId);
    if (!consorcio) {
      var lista = await directorio.listarConsorcios();
      return res.render('login', { error: 'Consorcio inválido.', consorcios: lista, consorcioElegido: null });
    }
    if (limite.bloqueado) {
      return res.render('login', {
        error: 'Demasiados intentos fallidos. Probá de nuevo en ' + limite.minutos + ' minuto(s).',
        consorcios: [], consorcioElegido: consorcio
      });
    }
    var r = await authLib.login(consorcioId, req.body.uf, req.body.password, req.body.tipo);
    if (!r.ok) {
      registrarLoginFallido(ip);
      return res.render('login', { error: r.error, consorcios: [], consorcioElegido: consorcio });
    }
    limpiarLoginFallido(ip);
    req.session.usuario = r.usuario;
    req.session.spreadsheetId = consorcioId;
    req.session.consorcioNombre = consorcio.nombre;
    res.redirect(r.usuario.rol === 'admin' ? '/admin' : '/mi-liquidacion');
  } catch (e) {
    var lista3 = await directorio.listarConsorcios();
    res.render('login', { error: 'Error de conexión con la planilla: ' + e.message, consorcios: lista3, consorcioElegido: null });
  }
});
app.get('/registrar', async function (req, res) {
  var c = req.query.c;
  var consorcio = c ? await directorio.buscarPorSpreadsheetId(c) : null;
  if (!consorcio) return res.redirect('/login');
  res.render('registrar', { error: null, ok: false, consorcioId: consorcio.spreadsheetId, consorcioNombre: consorcio.nombre });
});
app.post('/registrar', async function (req, res) {
  try {
    var consorcioId = req.body.consorcioId;
    var consorcio = await directorio.buscarPorSpreadsheetId(consorcioId);
    if (!consorcio) return res.redirect('/login');
    var uf = String(req.body.uf).trim();
    var uf2 = String(req.body.uf2 || '').trim();
    var cuit = String(req.body.cuit || '').trim();
    var tipo = String(req.body.tipo || 'propietario').toLowerCase();
    if (tipo !== 'inquilino') tipo = 'propietario';
    var ufs = await sheets.leerUFs(consorcioId);
    var match = ufs.find(function (u) { return u.uf === uf; });
    if (!match) return res.render('registrar', { error: 'UF ' + uf + ' no encontrada.', ok: false, consorcioId: consorcioId, consorcioNombre: consorcio.nombre });
    var match2 = null;
    if (uf2) {
      if (uf2 === uf) return res.render('registrar', { error: 'La 2ª UF no puede ser igual a la primera.', ok: false, consorcioId: consorcioId, consorcioNombre: consorcio.nombre });
      match2 = ufs.find(function (u) { return u.uf === uf2; });
      if (!match2) return res.render('registrar', { error: '2ª UF ' + uf2 + ' no encontrada.', ok: false, consorcioId: consorcioId, consorcioNombre: consorcio.nombre });
    }
    var r = await authLib.registrar(consorcioId, uf, cuit, match.propietario, req.body.email, tipo);
    if (!r.ok) return res.render('registrar', { error: r.error, ok: false, consorcioId: consorcioId, consorcioNombre: consorcio.nombre });
    if (uf2) {
      var r2 = await authLib.registrar(consorcioId, uf2, cuit, match2.propietario, req.body.email, tipo);
      if (!r2.ok) return res.render('registrar', { error: '1ª UF cargada, pero la 2ª falló: ' + r2.error, ok: false, consorcioId: consorcioId, consorcioNombre: consorcio.nombre });
    }
    var listaUf = uf + (uf2 ? ' y ' + uf2 : '');
    mailer.enviar(process.env.ADMIN_EMAIL || process.env.SMTP_USER,
      'Nueva solicitud — ' + consorcio.nombre + ' — UF ' + listaUf + ' (' + tipo + ')',
      'Consorcio: ' + consorcio.nombre + '\nUF: ' + listaUf + '\nTipo: ' + tipo + '\nPropietario: ' + (match.propietario || '') + '\nCUIT: ' + cuit + '\nEmail: ' + (req.body.email || '') +
      '\n\nActivar en: ' + (process.env.SITE_URL || 'https://consorcio-web.onrender.com') + '/admin');
    res.render('registrar', { error: null, ok: true, consorcioId: consorcioId, consorcioNombre: consorcio.nombre });
  } catch (e) { res.render('registrar', { error: e.message, ok: false, consorcioId: req.body.consorcioId, consorcioNombre: '' }); }
});
app.get('/logout', function (req, res) { req.session.destroy(function () { res.redirect('/login'); }); });

// ==================== OLVIDÉ MI CONTRASEÑA ====================
function generarPasswordAleatoria() {
  return Math.random().toString(36).slice(-8);
}
app.get('/olvide-password', async function (req, res) {
  var c = req.query.c;
  var consorcio = c ? await directorio.buscarPorSpreadsheetId(c) : null;
  if (!consorcio) return res.redirect('/login');
  res.render('olvide-password', { error: null, ok: false, consorcioId: consorcio.spreadsheetId, consorcioNombre: consorcio.nombre });
});
app.post('/olvide-password', async function (req, res) {
  var consorcioId = req.body.consorcioId;
  var consorcio = await directorio.buscarPorSpreadsheetId(consorcioId);
  if (!consorcio) return res.redirect('/login');
  try {
    var uf = String(req.body.uf || '').trim();
    var tipo = String(req.body.tipo || 'propietario').toLowerCase();
    if (tipo !== 'inquilino') tipo = 'propietario';
    var emailIngresado = String(req.body.email || '').trim().toLowerCase();
    var usuarios = await sheets.leerUsuarios(consorcioId);
    var x = usuarios.find(function (u) { return u.uf === uf && (u.tipo || 'propietario') === tipo && u.rol !== 'admin'; });
    // FIX: por seguridad, siempre mostramos el mismo mensaje de éxito
    // exista o no la combinación UF+email — así no se puede usar este
    // formulario para "adivinar" qué UF están registradas.
    if (x && x.activo && x.email && String(x.email).trim().toLowerCase() === emailIngresado) {
      var nuevaPw = generarPasswordAleatoria();
      var r = await authLib.blanquearClave(consorcioId, uf, nuevaPw, tipo);
      if (r.ok && r.email) {
        var loginUrl = (process.env.SITE_URL || 'https://consorcio-web.onrender.com') + '/login?c=' + encodeURIComponent(consorcioId);
        var listaUf = (r.ufs && r.ufs.length > 1) ? r.ufs.join(' y ') : uf;
        await mailer.enviar(r.email, 'Nueva contraseña — ' + consorcio.nombre,
          'Hola,\n\nRecibimos tu pedido de restablecer la contraseña.\n\nIngresá a: ' + loginUrl +
          '\nUsuario (UF): ' + listaUf + '\nContraseña nueva: ' + nuevaPw +
          '\n\nSi vos no pediste esto, ignorá este mail y contactate con la administración.\n\nSaludos,\nAdministración del Consorcio');
      }
    }
    res.render('olvide-password', { error: null, ok: true, consorcioId: consorcioId, consorcioNombre: consorcio.nombre });
  } catch (e) {
    res.render('olvide-password', { error: e.message, ok: false, consorcioId: consorcioId, consorcioNombre: consorcio.nombre });
  }
});

// ==================== CAMBIAR MI CONTRASEÑA (consorcista logueado) ====================
app.get('/mi-cuenta/cambiar-password', requireLogin, function (req, res) {
  if (req.session.usuario.rol === 'admin') return res.redirect('/admin');
  res.render('cambiar-password', { error: null, ok: false });
});
app.post('/mi-cuenta/cambiar-password', requireLogin, async function (req, res) {
  if (req.session.usuario.rol === 'admin') return res.redirect('/admin');
  var ssid = req.session.spreadsheetId;
  var u = req.session.usuario;
  try {
    var r = await authLib.cambiarPasswordPropia(ssid, u.uf, u.tipo, req.body.actual, req.body.nueva);
    res.render('cambiar-password', { error: r.ok ? null : r.error, ok: r.ok });
  } catch (e) {
    res.render('cambiar-password', { error: e.message, ok: false });
  }
});
async function cargarLiquidacionDesdeSheets(ssid) {
  var di = await sheets.leerDatosInicio(ssid);
  var ma = getMesActivo(di);
  var liq = await sheets.leerLiquidacionMasReciente(ssid, ma.mesGasNum, ma.mesGasAnio);
  return {
    liq: liq,
    mesLabel: liq.mesLabel,
    dia1: di['Día 1er vencimiento'] || '6',
    dia2: di['Día 2do vencimiento'] || '13',
    mesVenc: ma.mesNum,
    anioVenc: ma.anio,
    error: liq.error || null
  };
}
// Arma el listado de deudores directo de la liquidación YA PUBLICADA en
// el portal (misma data que arma las tarjetas de "Mi Liquidación") — no
// depende de la solapa "Deudores" de Apps Script, así nunca queda
// desactualizado.
function calcularDeudoresDesdeLiquidacion(ssid) {
  var cacheLiq = getCacheLiq(ssid);
  if (!cacheLiq.publicado || !cacheLiq.datos || !cacheLiq.datos.liq || !cacheLiq.datos.liq.datos) return [];
  var lista = cacheLiq.datos.liq.datos.map(function (d) {
    var depto = d.depto || '';
    var esCochera = /desc|cub/i.test(depto);
    var tipoUnidad = esCochera ? 'Cochera' : (depto ? 'Depto' : '');
    // El número de cochera viene mezclado con la palabra "desc"/"cub"
    // (ej. "1 desc", "16cub") — nos quedamos solo con los dígitos.
    var mNum = /(\d+)/.exec(depto);
    var numeroUnidad = mNum ? mNum[1] : depto;
    return {
      uf: d.uf, depto: depto, tipoUnidad: tipoUnidad, numeroUnidad: numeroUnidad, propietario: d.propietario || '',
      deuda: parseMonto(d.deuda), aAbonar: parseMonto(d.venc1)
    };
  }).filter(function (d) { return d.deuda > 1; }); // tolerancia de $1 por redondeos
  lista.sort(function (a, b) { return b.deuda - a.deuda; });
  return lista;
}

app.get('/mi-liquidacion', requireLogin, async function (req, res) {
  var esAdmin = req.session.usuario.rol === 'admin';
  var ssid = req.session.spreadsheetId;
  var comunicados = [];
  try { comunicados = (await sheets.leerComunicados(ssid)).filter(function (c) { return c.activo; }).reverse(); } catch (e) { /* no bloquear */ }
  var deudores = calcularDeudoresDesdeLiquidacion(ssid).map(function (d) { return { tipoUnidad: d.tipoUnidad, numeroUnidad: d.numeroUnidad, deuda: d.deuda }; });
  var misUfs = req.session.usuario.ufsUsuario || [{ uf: req.session.usuario.uf, tipo: req.session.usuario.tipo || 'propietario' }];
  var cacheLiq = getCacheLiq(ssid);
  if (!cacheLiq.publicado) {
    return res.render('liquidacion', {
      datos: [], mesLabel: '', error: null,
      dia1: '', dia2: '', mesVenc: '', anioVenc: '',
      cache: { publicado: false, fechaHora: null, esAdmin: esAdmin },
      comunicados: comunicados, deudores: deudores
    });
  }
  var c = cacheLiq.datos;
  var ufsInfo = {};
  try {
    var ufsSheet = await sheets.leerUFs(ssid);
    ufsSheet.forEach(function (u) { ufsInfo[u.uf] = { depto: u.depto, tipoUf: u.tipo }; });
  } catch (e) { /* no bloquear */ }
  var datos = misUfs.map(function (u) {
    var dato = c.liq.datos.find(function (d) { return d.uf === u.uf; });
    var info = ufsInfo[u.uf] || {};
    return { uf: u.uf, tipo: u.tipo, depto: info.depto || '', tipoUf: info.tipoUf || '', dato: dato };
  });
  // FIX: mostrar primero la UF de departamento y recién después la de
  // cochera (si la persona tiene ambas), en vez del orden que venga.
  datos.sort(function (a, b) {
    var aEsCochera = /coch/i.test(a.tipoUf || '') ? 1 : 0;
    var bEsCochera = /coch/i.test(b.tipoUf || '') ? 1 : 0;
    return aEsCochera - bEsCochera;
  });
  res.render('liquidacion', {
    datos: datos, mesLabel: c.mesLabel, error: c.error,
    dia1: c.dia1, dia2: c.dia2, mesVenc: c.mesVenc, anioVenc: c.anioVenc,
    cache: { publicado: true, fechaHora: cacheLiq.fechaHora, esAdmin: esAdmin },
    comunicados: comunicados, deudores: deudores
  });
});
app.get('/liquidacion-completa', requireLogin, async function (req, res) {
  var esAdmin = req.session.usuario.rol === 'admin';
  var ssid = req.session.spreadsheetId;
  var misUfs = (req.session.usuario.ufsUsuario || [{ uf: req.session.usuario.uf }]).map(function (u) { return u.uf; });
  var cacheLiq = getCacheLiq(ssid);
  if (!cacheLiq.publicado) {
    return res.render('admin-liquidacion', {
      liq: { datos: [] }, mesLabel: '', error: null, misUfs: misUfs,
      cache: { publicado: false, fechaHora: null, esAdmin: esAdmin }
    });
  }
  var c = cacheLiq.datos;
  res.render('admin-liquidacion', {
    liq: c.liq, mesLabel: c.mesLabel, error: c.error, misUfs: misUfs,
    cache: { publicado: true, fechaHora: cacheLiq.fechaHora, esAdmin: esAdmin }
  });
});
app.post('/admin/liquidacion/actualizar', requireAdmin, async function (req, res) {
  var ssid = req.session.spreadsheetId;
  try {
    var d = await cargarLiquidacionDesdeSheets(ssid);
    var ahora = new Date();
    var cacheLiq = getCacheLiq(ssid);
    cacheLiq.publicado = true;
    cacheLiq.fechaHora = ahora;
    cacheLiq.quienActualizo = 'admin';
    cacheLiq.datos = d;
    try { await sheets.guardarCache(ssid, 'liquidacion', d, ahora); }
    catch (e) { console.log('[CACHE] Aviso: liquidacion publicada pero no se guardo en planilla:', e.message); }
    req.session.flash = { tipo: 'aviso', texto: 'Liquidación actualizada.' };
  } catch (e) {
    req.session.flash = { tipo: 'aviso', texto: 'Error al actualizar: ' + e.message };
  }
  res.redirect(req.body.origen || '/mi-liquidacion');
});
async function publicarLiquidacion(ssid, filasLiq, mesLabelParsed, quien) {
  var di = await sheets.leerDatosInicio(ssid);
  var ma = getMesActivo(di);
  var d = {
    liq: { mesLabel: mesLabelParsed || ma.mesGasLabel, nombre: '', datos: filasLiq, error: null },
    mesLabel: mesLabelParsed || ma.mesGasLabel,
    dia1: di['Día 1er vencimiento'] || '6',
    dia2: di['Día 2do vencimiento'] || '13',
    mesVenc: ma.mesNum,
    anioVenc: ma.anio,
    error: null
  };
  var ahora = new Date();
  var cacheLiq = getCacheLiq(ssid);
  cacheLiq.publicado = true;
  cacheLiq.fechaHora = ahora;
  cacheLiq.quienActualizo = quien;
  cacheLiq.datos = d;
  try { await sheets.guardarCache(ssid, 'liquidacion', d, ahora); }
  catch (e) { console.log('[CACHE] Aviso: liquidacion publicada pero no se guardo en planilla:', e.message); }
}
app.get('/admin/liquidacion/importar-csv', requireAdmin, function (req, res) {
  res.render('admin-importar-liquidacion', { error: null, ok: false, filas: 0, textoCrudo: null });
});
app.post('/admin/liquidacion/importar-csv', requireAdmin, uploadArchivo.single('csv'), async function (req, res) {
  var ssid = req.session.spreadsheetId;
  try {
    if (!req.file) {
      return res.render('admin-importar-liquidacion', { error: 'No se subió ningún archivo.', ok: false, filas: 0, textoCrudo: null });
    }
    var textoCSV = req.file.buffer.toString('utf8');
    var parsed = csvLiquidacion.parsearCSVLiquidacion(textoCSV);
    if (!parsed.ok) {
      return res.render('admin-importar-liquidacion', { error: parsed.error, ok: false, filas: 0, textoCrudo: parsed.textoCrudo || null });
    }
    await publicarLiquidacion(ssid, parsed.filas, parsed.mesLabel, 'admin (CSV)');
    res.render('admin-importar-liquidacion', { error: null, ok: true, filas: parsed.filas.length, textoCrudo: null });
  } catch (e) {
    res.render('admin-importar-liquidacion', { error: 'Error al procesar el CSV: ' + e.message, ok: false, filas: 0, textoCrudo: null });
  }
});
app.get('/admin/liquidacion/importar-texto', requireAdmin, function (req, res) {
  res.render('admin-importar-texto', { error: null, ok: false, preview: null, textoOriginal: '', mesLabel: null });
});
app.post('/admin/liquidacion/importar-texto/preview', requireAdmin, function (req, res) {
  var texto = req.body.texto || '';
  var parsed = textoLiquidacion.parsearTextoLiquidacion(texto);
  if (!parsed.ok) {
    return res.render('admin-importar-texto', { error: parsed.error, ok: false, preview: null, textoOriginal: texto, mesLabel: null });
  }
  res.render('admin-importar-texto', { error: null, ok: false, preview: parsed.filas, textoOriginal: texto, mesLabel: parsed.mesLabel });
});
app.post('/admin/liquidacion/importar-texto/confirmar', requireAdmin, async function (req, res) {
  var ssid = req.session.spreadsheetId;
  try {
    var texto = req.body.texto || '';
    var parsed = textoLiquidacion.parsearTextoLiquidacion(texto);
    if (!parsed.ok) {
      return res.render('admin-importar-texto', { error: parsed.error, ok: false, preview: null, textoOriginal: texto, mesLabel: null });
    }
    await publicarLiquidacion(ssid, parsed.filas, parsed.mesLabel, 'admin (texto)');
    res.render('admin-importar-texto', { error: null, ok: true, preview: null, textoOriginal: '', mesLabel: null, filas: parsed.filas.length });
  } catch (e) {
    res.render('admin-importar-texto', { error: 'Error al publicar: ' + e.message, ok: false, preview: null, textoOriginal: req.body.texto || '', mesLabel: null });
  }
});
app.get('/admin/liquidacion/importar-word', requireAdmin, function (req, res) {
  res.render('admin-importar-word', { error: null, ok: false, preview: null, mesLabel: null, filas: 0 });
});
app.post('/admin/liquidacion/importar-word', requireAdmin, uploadArchivo.single('word'), async function (req, res) {
  try {
    if (!req.file) {
      return res.render('admin-importar-word', { error: 'No se subió ningún archivo.', ok: false, preview: null, mesLabel: null, filas: 0 });
    }
    var parsed = await wordLiquidacion.parsearWordLiquidacion(req.file.buffer);
    if (!parsed.ok) {
      return res.render('admin-importar-word', { error: parsed.error, ok: false, preview: null, mesLabel: null, filas: 0 });
    }
    req.session.pendingLiqImport = { filas: parsed.filas, mesLabel: parsed.mesLabel };
    res.render('admin-importar-word', { error: null, ok: false, preview: parsed.filas, mesLabel: parsed.mesLabel, filas: 0 });
  } catch (e) {
    res.render('admin-importar-word', { error: 'Error al procesar el Word: ' + e.message, ok: false, preview: null, mesLabel: null, filas: 0 });
  }
});
app.post('/admin/liquidacion/importar-word/confirmar', requireAdmin, async function (req, res) {
  var ssid = req.session.spreadsheetId;
  try {
    var pending = req.session.pendingLiqImport;
    if (!pending || !pending.filas || !pending.filas.length) {
      return res.render('admin-importar-word', { error: 'No hay una vista previa pendiente — subí el archivo de nuevo.', ok: false, preview: null, mesLabel: null, filas: 0 });
    }
    await publicarLiquidacion(ssid, pending.filas, pending.mesLabel, 'admin (Word)');
    req.session.pendingLiqImport = null;
    res.render('admin-importar-word', { error: null, ok: true, preview: null, mesLabel: null, filas: pending.filas.length });
  } catch (e) {
    res.render('admin-importar-word', { error: 'Error al publicar: ' + e.message, ok: false, preview: null, mesLabel: null, filas: 0 });
  }
});
app.get('/mis-pagos', requireLogin, async function (req, res) {
  var ssid = req.session.spreadsheetId;
  try {
    var lf = await sheets.leerLiquidacionFinal(ssid);
    var mis = lf.filter(function (d) { return String(d.uf).trim() === req.session.usuario.uf; })
      .map(function (d) { d.estadoCalc = calcularEstado(d); return d; });
    res.render('historial', { pagos: mis, error: null });
  } catch (e) { res.render('historial', { pagos: [], error: e.message }); }
});
async function cargarGastosDesdeSheets(ssid) {
  var di = await sheets.leerDatosInicio(ssid);
  var mg = getMesGastos(di);
  var todosGastos = await sheets.leerGastos(ssid, null);
  // FIX: "Gastos Extraordinarios" es una solapa APARTE que el portal no
  // leía — igual que hace el PDF de Apps Script, se usa como fuente
  // principal de extraordinarios si tiene filas para este mes; si está
  // vacía, se sigue usando lo que haya en la solapa "Gastos" con
  // categoría Extraordinario (comportamiento de antes, sin cambios).
  var extraDedicada = [];
  try { extraDedicada = await sheets.leerGastosExtraordinarios(ssid, null); }
  catch (e) { console.log('[GASTOS] No se pudo leer Gastos Extraordinarios:', e.message); }
  var gastos = [], impuestos = [], recaudacionTrabajos = [];
  todosGastos.forEach(function (g) {
    var cat = String(g.categoria || '').toLowerCase();
    var est = String(g.estado || '').toLowerCase();
    if (est.indexOf('adelanto') === 0) { recaudacionTrabajos.push(g); return; }
    if (cat.indexOf('ingreso extraordinar') !== -1) { gastos.push(g); return; }
    // Si la solapa dedicada ya tiene datos de extraordinarios este mes,
    // no duplicamos con lo que haya quedado categorizado igual en
    // "Gastos" — se usa solo la fuente dedicada para esos casos.
    if (extraDedicada.length && cat.indexOf('extraordinari') !== -1) return;
    if (String(g.proveedor || '').toLowerCase().indexOf('santander') !== -1) impuestos.push(g); else gastos.push(g);
  });
  gastos = gastos.concat(extraDedicada);
  var cfData = await sheets.leerCashFlow(ssid);
  var mesNorm = (mg.meses[mg.mesGasNum - 1] || '').toLowerCase();
  var cashflow = cfData.find(function (cf) { var t = String(cf.mes || '').toLowerCase(); return t.indexOf(mesNorm) !== -1 && t.indexOf(String(mg.mesGasAnio)) !== -1; }) || null;
  if (!cashflow && cfData.length) cashflow = cfData[cfData.length - 1];
  var deudaProv = await sheets.leerDeudaProveedores(ssid);
  var totalGastos = await sheets.leerTotalGastos(ssid);
  if (cashflow) { cashflow.deudaProveedores = deudaProv; cashflow.totalGastos = totalGastos; cashflow.facturas = ''; }
  var cfExtraData = [];
  var cashflowExtra = null;
  try {
    cfExtraData = await sheets.leerCashFlowExtraordinarias(ssid);
    cashflowExtra = cfExtraData.find(function (cf) { var t = String(cf.mes || '').toLowerCase(); return t.indexOf(mesNorm) !== -1 && t.indexOf(String(mg.mesGasAnio)) !== -1; }) || null;
    if (!cashflowExtra && cfExtraData.length) cashflowExtra = cfExtraData[cfExtraData.length - 1];
  } catch (e) { console.log('[GASTOS] No se pudo leer Cash Flow Extraordinarias:', e.message); }
  return {
    gastos: gastos, impuestos: impuestos, recaudacionTrabajos: recaudacionTrabajos,
    cashflow: cashflow, cashflowHistorico: cfData,
    cashflowExtra: cashflowExtra, cashflowExtraHistorico: cfExtraData,
    mesLabel: mg.mesLabel
  };
}
// Sirve el archivo de una factura directo desde Drive, usando la cuenta
// de servicio del portal — así nadie tiene que loguearse en Google ni
// pedir acceso, el servidor ya tiene permiso de lectura.
app.get('/factura/:fileId', requireLogin, async function (req, res) {
  try {
    var archivo = await sheets.descargarArchivoDrive(req.params.fileId);
    res.set('Content-Type', archivo.mimeType || 'application/octet-stream');
    res.set('Content-Disposition', 'inline; filename="' + (archivo.nombre || 'factura').replace(/"/g, '') + '"');
    res.send(archivo.buffer);
  } catch (e) {
    res.status(404).send('No se pudo cargar la factura: ' + e.message);
  }
});
app.get('/gastos', requireLogin, async function (req, res) {
  var esAdmin = req.session.usuario.rol === 'admin';
  var ssid = req.session.spreadsheetId;
  var comunicados = [];
  try { comunicados = (await sheets.leerComunicados(ssid)).filter(function (c) { return c.activo; }).reverse(); } catch (e) { /* no bloquear */ }
  var cacheGastos = getCacheGastos(ssid);
  if (!cacheGastos.publicado) {
    return res.render('gastos', {
      gastos: [], impuestos: [], recaudacionTrabajos: [], cashflow: null, cashflowHistorico: [],
      cashflowExtra: null, cashflowExtraHistorico: [],
      mesLabel: '', error: null,
      cache: { publicado: false, fechaHora: null, quienActualizo: null, esAdmin: esAdmin },
      comunicados: comunicados
    });
  }
  var d = cacheGastos.datos;
  res.render('gastos', {
    gastos: d.gastos, impuestos: d.impuestos, recaudacionTrabajos: d.recaudacionTrabajos || [],
    cashflow: d.cashflow,
    cashflowHistorico: d.cashflowHistorico,
    cashflowExtra: d.cashflowExtra || null, cashflowExtraHistorico: d.cashflowExtraHistorico || [],
    mesLabel: d.mesLabel, error: null,
    cache: {
      publicado: true,
      fechaHora: cacheGastos.fechaHora,
      quienActualizo: cacheGastos.quienActualizo,
      esAdmin: esAdmin
    },
    comunicados: comunicados
  });
});
app.post('/admin/gastos/actualizar', requireAdmin, async function (req, res) {
  var ssid = req.session.spreadsheetId;
  try {
    var d = await cargarGastosDesdeSheets(ssid);
    var ahora = new Date();
    var cacheGastos = getCacheGastos(ssid);
    cacheGastos.publicado = true;
    cacheGastos.fechaHora = ahora;
    cacheGastos.quienActualizo = req.session.usuario.uf === 'admin' ? 'admin' : req.session.usuario.uf;
    cacheGastos.datos = d;
    try { await sheets.guardarCache(ssid, 'gastos', d, ahora); }
    catch (e) { console.log('[CACHE] Aviso: gastos publicados pero no se guardaron en planilla:', e.message); }
    req.session.flash = { tipo: 'aviso', texto: 'Datos de Gastos actualizados.' };
  } catch (e) {
    req.session.flash = { tipo: 'aviso', texto: 'Error al actualizar: ' + e.message };
  }
  res.redirect('/gastos');
});
app.get('/admin', requireAdmin, async function (req, res) {
  var ssid = req.session.spreadsheetId;
  try {
    var di = await sheets.leerDatosInicio(ssid);
    var cf = await sheets.leerCashFlow(ssid);
    var usuarios = await authLib.listarUsuarios(ssid);
    var pendientes = await authLib.listarPendientes(ssid);
    var flash = req.session.flash || null;
    req.session.flash = null;
    res.render('admin-dashboard', { di: di, cashflow: cf, usuarios: usuarios, pendientes: pendientes, error: null, msg: req.query.msg || null, flash: flash, consorcioNombre: req.session.consorcioNombre || '' });
  } catch (e) { res.render('admin-dashboard', { di: {}, cashflow: [], usuarios: [], pendientes: [], error: e.message, msg: null, flash: null, consorcioNombre: req.session.consorcioNombre || '' }); }
});
app.post('/admin/activar', requireAdmin, async function (req, res) {
  var ssid = req.session.spreadsheetId;
  var uf = req.body.uf, pw = req.body.password, tipo = req.body.tipo;
  var r = await authLib.activarUsuario(ssid, uf, pw, tipo);
  var mailInfo = { intentado: false, ok: false, error: null, email: r.email || null };
  if (r.ok && r.email) {
    mailInfo.intentado = true;
    var listaUf = (r.ufs && r.ufs.length > 1) ? r.ufs.join(' y ') : uf;
    var textoExtra = (r.ufs && r.ufs.length > 1)
      ? ('\nPodés ingresar con cualquiera de tus UF (' + listaUf + '), la contraseña es la misma.')
      : '';
    var loginUrl = (process.env.SITE_URL || 'https://consorcio-web.onrender.com') + '/login?c=' + encodeURIComponent(ssid);
    var m = await mailer.enviar(r.email, 'Tu acceso al portal del Consorcio',
      'Hola,\n\nTu cuenta fue activada.\n\nIngresá a: ' + loginUrl +
      textoExtra +
      '\nUsuario (UF): ' + (r.ufs ? r.ufs[0] : uf) + '\nTipo: ' + (r.tipo || tipo || 'propietario') + '\nContraseña: ' + pw + '\n\nSaludos,\nAdministración del Consorcio');
    mailInfo.ok = m.ok; mailInfo.error = m.error || null;
  }
  req.session.flash = { tipo: 'credenciales', accion: 'activado', uf: uf, ufs: r.ufs || [uf], password: pw, tipoUsuario: r.tipo || tipo || 'propietario', mail: mailInfo };
  res.redirect('/admin');
});
app.post('/admin/desactivar', requireAdmin, async function (req, res) {
  var ssid = req.session.spreadsheetId;
  var r = await authLib.desactivarUsuario(ssid, req.body.uf, req.body.tipo);
  var texto = (r.ok && r.ufs && r.ufs.length > 1)
    ? ('Usuario dado de baja: UF ' + r.ufs.join(' y ') + ' (' + (r.tipo || '') + ')')
    : ('Usuario ' + req.body.uf + ' (' + (req.body.tipo || '') + ') dado de baja');
  req.session.flash = { tipo: 'aviso', texto: texto };
  res.redirect('/admin');
});
app.post('/admin/eliminar', requireAdmin, async function (req, res) {
  var ssid = req.session.spreadsheetId;
  var r = await authLib.eliminarUsuario(ssid, req.body.uf, req.body.tipo);
  var texto;
  if (!r.ok) texto = 'Error: ' + r.error;
  else if (r.ufs && r.ufs.length > 1) texto = 'Usuarios eliminados: UF ' + r.ufs.join(' y ') + ' (' + (r.tipo || '') + ')';
  else texto = 'Usuario ' + req.body.uf + ' (' + (req.body.tipo || '') + ') eliminado';
  req.session.flash = { tipo: 'aviso', texto: texto };
  res.redirect('/admin');
});
app.post('/admin/blanquear', requireAdmin, async function (req, res) {
  var ssid = req.session.spreadsheetId;
  var uf = req.body.uf, pw = req.body.password, tipo = req.body.tipo;
  var r = await authLib.blanquearClave(ssid, uf, pw, tipo);
  var mailInfo = { intentado: false, ok: false, error: null, email: r.email || null };
  if (r.ok && r.email) {
    mailInfo.intentado = true;
    var listaUf = (r.ufs && r.ufs.length > 1) ? r.ufs.join(' y ') : uf;
    var textoExtra = (r.ufs && r.ufs.length > 1)
      ? ('\nPodés ingresar con cualquiera de tus UF (' + listaUf + '), la contraseña es la misma.')
      : '';
    var loginUrl = (process.env.SITE_URL || 'https://consorcio-web.onrender.com') + '/login?c=' + encodeURIComponent(ssid);
    var m = await mailer.enviar(r.email, 'Nueva contraseña — Portal del Consorcio',
      'Hola,\n\nTu contraseña fue actualizada.\n\nIngresá a: ' + loginUrl +
      textoExtra +
      '\nUsuario (UF): ' + (r.ufs ? r.ufs[0] : uf) + '\nTipo: ' + (r.tipo || tipo || 'propietario') + '\nNueva contraseña: ' + pw + '\n\nSaludos,\nAdministración del Consorcio');
    mailInfo.ok = m.ok; mailInfo.error = m.error || null;
  }
  req.session.flash = { tipo: 'credenciales', accion: 'blanqueada', uf: uf, ufs: r.ufs || [uf], password: pw, tipoUsuario: r.tipo || tipo || 'propietario', mail: mailInfo };
  res.redirect('/admin');
});
app.post('/admin/agregar-admin', requireAdmin, async function (req, res) {
  var ssid = req.session.spreadsheetId;
  try {
    var usuario = String(req.body.usuario || '').trim();
    var nombre = String(req.body.nombre || '').trim();
    var email = String(req.body.email || '').trim();
    var pw = generarPasswordAleatoria();
    var r = await authLib.agregarAdmin(ssid, usuario, pw, nombre, email);
    if (!r.ok) throw new Error(r.error);
    var mailInfo = { intentado: false, ok: false, error: null, email: email || null };
    if (email) {
      mailInfo.intentado = true;
      var loginUrl = (process.env.SITE_URL || 'https://consorcio-web.onrender.com') + '/login?c=' + encodeURIComponent(ssid);
      var m = await mailer.enviar(email, 'Acceso de administrador — ' + (req.session.consorcioNombre || 'Consorcio'),
        'Hola,\n\nSe creó tu acceso como administrador del portal de ' + (req.session.consorcioNombre || 'el consorcio') + '.\n\n' +
        'Ingresá a: ' + loginUrl + '\nUsuario: ' + usuario + '\nContraseña: ' + pw +
        '\n\nTe recomendamos cambiarla apenas ingreses.\n\nSaludos.');
      mailInfo.ok = m.ok; mailInfo.error = m.error || null;
    }
    req.session.flash = { tipo: 'credenciales', accion: 'activado', uf: usuario, ufs: [usuario], password: pw, tipoUsuario: 'administrador', mail: mailInfo };
  } catch (e) {
    console.log('[ADMIN] Error en /admin/agregar-admin:', e.message, e.stack);
    req.session.flash = { tipo: 'aviso', texto: 'Error: ' + e.message };
  }
  res.redirect('/admin');
});
app.post('/admin/cambiar-password', requireAdmin, async function (req, res) {
  var ssid = req.session.spreadsheetId;
  var r = await authLib.cambiarPasswordAdmin(ssid, req.body.password);
  res.redirect('/admin?msg=' + encodeURIComponent(r.ok ? 'Contraseña de admin actualizada' : ('Error: ' + r.error)));
});
app.post('/admin/test-email', requireAdmin, async function (req, res) {
  var v = await mailer.verificar();
  if (!v.ok) return res.redirect('/admin?msg=' + encodeURIComponent('Email NO configurado: ' + v.error));
  var destino = req.body.destino || process.env.ADMIN_EMAIL || process.env.SMTP_USER;
  var r = await mailer.enviar(destino, 'Prueba de email — Portal del Consorcio',
    'Este es un email de prueba. Si lo recibiste, la configuración SMTP funciona correctamente.');
  res.redirect('/admin?msg=' + encodeURIComponent(r.ok ? ('Email de prueba enviado a ' + destino) : ('Error al enviar: ' + r.error)));
});
// ==================== COMUNICADOS (avisos del administrador) ====================
// ==================== DEUDORES ====================
// Junta la solapa "Deudores" (generada por Apps Script al calcular la
// liquidación) con el email de cada UF (solapa "UF"), para poder
// mostrarlos y mandar recordatorios de pago.
async function cargarDeudoresConEmail(ssid) {
  var deudores = calcularDeudoresDesdeLiquidacion(ssid);
  var ufs = await sheets.leerUFs(ssid);
  var emailPorUf = {};
  ufs.forEach(function (u) { emailPorUf[u.uf] = u.email || ''; });
  return deudores.map(function (d) {
    return Object.assign({}, d, { email: emailPorUf[d.uf] || '' });
  });
}
app.get('/admin/deudores', requireAdmin, async function (req, res) {
  var ssid = req.session.spreadsheetId;
  try {
    var deudores = await cargarDeudoresConEmail(ssid);
    var flash = req.session.flash || null;
    req.session.flash = null;
    res.render('admin-deudores', { deudores: deudores, error: null, flash: flash });
  } catch (e) { res.render('admin-deudores', { deudores: [], error: e.message, flash: null }); }
});
app.post('/admin/deudores/enviar-recordatorio', requireAdmin, async function (req, res) {
  var ssid = req.session.spreadsheetId;
  try {
    var seleccionadas = req.body.ufs;
    if (!seleccionadas) throw new Error('No seleccionaste ninguna UF.');
    if (!Array.isArray(seleccionadas)) seleccionadas = [seleccionadas];
    var deudores = await cargarDeudoresConEmail(ssid);
    var nombreConsorcio = req.session.consorcioNombre || 'tu consorcio';
    var enviados = 0, sinEmail = 0, fallidos = 0;
    for (var i = 0; i < seleccionadas.length; i++) {
      var d = deudores.find(function (x) { return x.uf === seleccionadas[i]; });
      if (!d) continue;
      if (!d.email) { sinEmail++; continue; }
      var montoFmt = '$' + d.deuda.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      var r = await mailer.enviar(d.email,
        '⏰ Recordatorio de pago — ' + nombreConsorcio,
        'Hola,\n\nTe recordamos que la UF ' + d.uf + (d.depto ? (' (' + d.depto + ')') : '') + ' registra una deuda de ' + montoFmt + ' con ' + nombreConsorcio + '.\n\n' +
        'Te pedimos regularizar tu situación a la brevedad. Podés ver el detalle completo entrando al portal: ' + (process.env.SITE_URL || 'https://consorcio-web.onrender.com') +
        '\n\nAnte cualquier consulta, contactate con la administración.\n\nSaludos,\nAdministración del Consorcio');
      if (r.ok) enviados++; else fallidos++;
    }
    req.session.flash = { tipo: 'aviso', texto: 'Recordatorios enviados: ' + enviados + (sinEmail ? (' — sin email: ' + sinEmail) : '') + (fallidos ? (' — fallaron: ' + fallidos) : '') + '.' };
  } catch (e) {
    req.session.flash = { tipo: 'aviso', texto: 'Error: ' + e.message };
  }
  res.redirect('/admin/deudores');
});

app.get('/admin/comunicados', requireAdmin, async function (req, res) {
  var ssid = req.session.spreadsheetId;
  try {
    var lista = await sheets.leerComunicados(ssid);
    var flash = req.session.flash || null;
    req.session.flash = null;
    res.render('admin-comunicados', { comunicados: lista.slice().reverse(), error: null, flash: flash });
  } catch (e) { res.render('admin-comunicados', { comunicados: [], error: e.message, flash: null }); }
});
app.post('/admin/comunicados/nuevo', requireAdmin, async function (req, res) {
  var ssid = req.session.spreadsheetId;
  try {
    var mensaje = String(req.body.mensaje || '').trim();
    if (!mensaje) throw new Error('El mensaje no puede estar vacío.');
    var fecha = new Date().toLocaleDateString('es-AR');
    await sheets.agregarComunicado(ssid, mensaje, fecha);

    // Enviar también por mail a todos los consorcistas activos (sin
    // duplicar si una persona tiene más de una UF con el mismo email).
    var enviados = 0, fallidos = 0;
    try {
      var usuarios = await authLib.listarUsuarios(ssid);
      var emailsYaEnviados = {};
      var nombreConsorcio = req.session.consorcioNombre || 'tu consorcio';
      for (var i = 0; i < usuarios.length; i++) {
        var u = usuarios[i];
        var email = String(u.email || '').trim().toLowerCase();
        if (!u.activo || !email || emailsYaEnviados[email]) continue;
        emailsYaEnviados[email] = true;
        var r = await mailer.enviar(u.email,
          '📢 Comunicado de la administración — ' + nombreConsorcio,
          'Hola,\n\nLa administración de ' + nombreConsorcio + ' publicó el siguiente comunicado:\n\n' +
          mensaje +
          '\n\nPodés verlo también entrando al portal: ' + (process.env.SITE_URL || 'https://consorcio-web.onrender.com') +
          '\n\nSaludos,\nAdministración del Consorcio');
        if (r.ok) enviados++; else fallidos++;
      }
    } catch (eMail) { console.log('[COMUNICADOS] Error enviando mails:', eMail.message); }

    req.session.flash = { tipo: 'aviso', texto: 'Comunicado publicado. Mails enviados: ' + enviados + (fallidos ? (' (fallaron ' + fallidos + ')') : '') + '.' };
  } catch (e) {
    req.session.flash = { tipo: 'aviso', texto: 'Error al publicar: ' + e.message };
  }
  res.redirect('/admin/comunicados');
});
app.post('/admin/comunicados/desactivar', requireAdmin, async function (req, res) {
  var ssid = req.session.spreadsheetId;
  try {
    await sheets.desactivarComunicado(ssid, parseInt(req.body.fila, 10));
    req.session.flash = { tipo: 'aviso', texto: 'Comunicado retirado.' };
  } catch (e) {
    req.session.flash = { tipo: 'aviso', texto: 'Error: ' + e.message };
  }
  res.redirect('/admin/comunicados');
});

app.get('/admin/liquidacion', requireAdmin, function (req, res) {
  var ssid = req.session.spreadsheetId;
  var cacheLiq = getCacheLiq(ssid);
  if (!cacheLiq.publicado) {
    return res.render('admin-liquidacion', {
      liq: { datos: [] }, mesLabel: '', error: null, misUfs: [],
      cache: { publicado: false, fechaHora: null, esAdmin: true }
    });
  }
  var c = cacheLiq.datos;
  res.render('admin-liquidacion', {
    liq: c.liq, mesLabel: c.mesLabel, error: c.error, misUfs: [],
    cache: { publicado: true, fechaHora: cacheLiq.fechaHora, esAdmin: true }
  });
});
app.listen(PORT, function () { console.log('Consorcio Web en puerto ' + PORT); });
