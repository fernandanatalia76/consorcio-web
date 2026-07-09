require('dotenv').config();
var express = require('express');
var session = require('express-session');
var path = require('path');
var authLib = require('./lib/auth');
var sheets = require('./lib/sheets');
var mailer = require('./lib/mailer');

var app = express();
var PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({ secret: process.env.SESSION_SECRET || 'dev-secret', resave: false, saveUninitialized: false }));
app.use(function (req, res, next) { res.locals.usuario = req.session.usuario || null; next(); });

function requireLogin(req, res, next) { if (!req.session.usuario) return res.redirect('/login'); next(); }
function requireAdmin(req, res, next) { if (!req.session.usuario || req.session.usuario.rol !== 'admin') return res.redirect('/login'); next(); }

// ---- Helpers de moneda / estado de pago ----
// Convierte "$1.234,56" / "1.234,56" / "1234.56" a numero. Vacio -> 0.
function parseMonto(v) {
  if (v === null || v === undefined) return 0;
  var s = String(v).replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  // Formato argentino: '.' = miles, ',' = decimales
  if (s.indexOf(',') !== -1) {
    s = s.replace(/\./g, '').replace(',', '.');
  }
  var n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// Determina estado total / parcial / pendiente a partir de una fila de "Liquidacion final".
function calcularEstado(row) {
  var cobrado = parseMonto(row.montoCobrado);
  var pendiente = parseMonto(row.montoPendiente);
  var aPagar = parseMonto(row.total1) || (cobrado + pendiente);
  // Prioridad al texto explicito de la planilla si existe y es claro
  var txt = String(row.estado || '').toLowerCase();
  if (txt.indexOf('total') !== -1 || txt.indexOf('pagad') !== -1 || txt.indexOf('cancel') !== -1) {
    return { clave: 'total', label: 'Pagado' };
  }
  if (txt.indexOf('parcial') !== -1) return { clave: 'parcial', label: 'Parcial' };
  if (txt.indexOf('pendiente') !== -1 || txt.indexOf('impago') !== -1) return { clave: 'pendiente', label: 'Pendiente' };
  // Sino, calculamos con los montos
  if (cobrado <= 0) return { clave: 'pendiente', label: 'Pendiente' };
  if (pendiente > 0.5 || (aPagar > 0 && cobrado + 0.5 < aPagar)) return { clave: 'parcial', label: 'Parcial' };
  return { clave: 'total', label: 'Pagado' };
}

function getMesGastos(di) {
  var p = String(di['Mes activo'] || '').split('-');
  var anio = parseInt(p[0]), mesNum = parseInt(p[1]);
  var mg = mesNum === 1 ? 12 : mesNum - 1, ma = mesNum === 1 ? anio - 1 : anio;
  var meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  return { mesNum: mesNum, anio: anio, mesGasNum: mg, mesGasAnio: ma, mesLabel: meses[mg - 1] + ' ' + ma, mesTxt: String(ma) + '-' + String(mg).padStart(2, '0'), meses: meses };
}

// ==================== RUTAS PUBLICAS ====================
app.get('/', function (req, res) { if (req.session.usuario) return res.redirect(req.session.usuario.rol === 'admin' ? '/admin' : '/mi-liquidacion'); res.redirect('/login'); });
app.get('/login', function (req, res) { res.render('login', { error: null }); });
app.post('/login', async function (req, res) {
  try {
    var r = await authLib.login(req.body.uf, req.body.password);
    if (!r.ok) return res.render('login', { error: r.error });
    req.session.usuario = r.usuario;
    res.redirect(r.usuario.rol === 'admin' ? '/admin' : '/mi-liquidacion');
  } catch (e) { res.render('login', { error: 'Error de conexión con la planilla: ' + e.message }); }
});
app.get('/registrar', function (req, res) { res.render('registrar', { error: null, ok: false }); });
app.post('/registrar', async function (req, res) {
  try {
    var uf = String(req.body.uf).trim();
    var cuit = String(req.body.cuit || '').replace(/\D/g, '');
    if (cuit.length !== 11) return res.render('registrar', { error: 'El CUIT debe tener 11 dígitos.', ok: false });
    var ufs = await sheets.leerUFs();
    var match = ufs.find(function (u) { return u.uf === uf && String(u.cuit || '').replace(/\D/g, '') === cuit; });
    if (!match) return res.render('registrar', { error: 'UF ' + uf + ' con ese CUIT no encontrada.', ok: false });
    var r = await authLib.registrar(uf, cuit, match.propietario, req.body.email);
    if (!r.ok) return res.render('registrar', { error: r.error, ok: false });
    // Notificar al admin (no bloqueante)
    mailer.enviar(process.env.ADMIN_EMAIL || process.env.SMTP_USER,
      'Nueva solicitud — UF ' + uf,
      'UF: ' + uf + '\nPropietario: ' + (match.propietario || '') + '\nCUIT: ' + cuit + '\nEmail: ' + (req.body.email || '') +
      '\n\nActivar en: ' + (process.env.SITE_URL || 'https://consorcio-web.onrender.com') + '/admin');
    res.render('registrar', { error: null, ok: true });
  } catch (e) { res.render('registrar', { error: e.message, ok: false }); }
});
app.get('/logout', function (req, res) { req.session.destroy(function () { res.redirect('/login'); }); });

// ==================== CONSORCISTA ====================
app.get('/mi-liquidacion', requireLogin, async function (req, res) {
  try {
    var di = await sheets.leerDatosInicio();
    var mg = getMesGastos(di);
    var liq = await sheets.leerLiquidacionMensual(mg.mesGasNum, mg.mesGasAnio);
    var dato = liq.datos.find(function (d) { return d.uf === req.session.usuario.uf; });
    res.render('liquidacion', { dato: dato, mesLabel: mg.mesLabel, error: liq.error || null, dia1: di['Día 1er vencimiento'] || '6', dia2: di['Día 2do vencimiento'] || '13', mesVenc: mg.mesNum, anioVenc: mg.anio });
  } catch (e) { res.render('liquidacion', { dato: null, mesLabel: '', error: e.message, dia1: '', dia2: '', mesVenc: '', anioVenc: '' }); }
});

// Liquidacion completa (todas las UF) visible tambien para el consorcista
app.get('/liquidacion-completa', requireLogin, async function (req, res) {
  try {
    var di = await sheets.leerDatosInicio();
    var mg = getMesGastos(di);
    var liq = await sheets.leerLiquidacionMensual(mg.mesGasNum, mg.mesGasAnio);
    res.render('admin-liquidacion', { liq: liq, mesLabel: mg.mesLabel, error: liq.error || null, miUf: req.session.usuario.uf });
  } catch (e) { res.render('admin-liquidacion', { liq: { datos: [] }, mesLabel: '', error: e.message, miUf: req.session.usuario.uf }); }
});

app.get('/mis-pagos', requireLogin, async function (req, res) {
  try {
    var lf = await sheets.leerLiquidacionFinal();
    var mis = lf.filter(function (d) { return String(d.uf).trim() === req.session.usuario.uf; })
      .map(function (d) { d.estadoCalc = calcularEstado(d); return d; });
    res.render('historial', { pagos: mis, error: null });
  } catch (e) { res.render('historial', { pagos: [], error: e.message }); }
});

app.get('/gastos', requireLogin, async function (req, res) {
  try {
    var di = await sheets.leerDatosInicio();
    var mg = getMesGastos(di);
    var todosGastos = await sheets.leerGastos(mg.mesTxt);
    var gastos = [], impuestos = [];
    todosGastos.forEach(function (g) {
      if (String(g.proveedor || '').toLowerCase().indexOf('santander') !== -1) impuestos.push(g); else gastos.push(g);
    });
    var cfData = await sheets.leerCashFlow();
    var mesNorm = (mg.meses[mg.mesGasNum - 1] || '').toLowerCase();
    var cashflow = cfData.find(function (cf) { var t = String(cf.mes || '').toLowerCase(); return t.indexOf(mesNorm) !== -1 && t.indexOf(String(mg.mesGasAnio)) !== -1; }) || null;
    res.render('gastos', { gastos: gastos, impuestos: impuestos, cashflow: cashflow, mesLabel: mg.mesLabel, error: null });
  } catch (e) { res.render('gastos', { gastos: [], impuestos: [], cashflow: null, mesLabel: '', error: e.message }); }
});

// ==================== ADMIN ====================
app.get('/admin', requireAdmin, async function (req, res) {
  try {
    var di = await sheets.leerDatosInicio();
    var cf = await sheets.leerCashFlow();
    var usuarios = await authLib.listarUsuarios();
    var pendientes = await authLib.listarPendientes();
    res.render('admin-dashboard', { di: di, cashflow: cf, usuarios: usuarios, pendientes: pendientes, error: null, msg: req.query.msg || null });
  } catch (e) { res.render('admin-dashboard', { di: {}, cashflow: [], usuarios: [], pendientes: [], error: e.message, msg: null }); }
});

app.post('/admin/activar', requireAdmin, async function (req, res) {
  var r = await authLib.activarUsuario(req.body.uf, req.body.password);
  if (r.ok && r.email) {
    await mailer.enviar(r.email, 'Tu acceso al portal del Consorcio',
      'Hola,\n\nTu cuenta fue activada.\n\nIngresá a: ' + (process.env.SITE_URL || 'https://consorcio-web.onrender.com') +
      '\nUsuario (UF): ' + req.body.uf + '\nContraseña: ' + req.body.password + '\n\nSaludos,\nAdministración del Consorcio');
  }
  res.redirect('/admin?msg=Usuario+' + encodeURIComponent(req.body.uf) + '+activado');
});

app.post('/admin/desactivar', requireAdmin, async function (req, res) {
  await authLib.desactivarUsuario(req.body.uf);
  res.redirect('/admin?msg=Usuario+' + encodeURIComponent(req.body.uf) + '+dado+de+baja');
});

app.post('/admin/blanquear', requireAdmin, async function (req, res) {
  var r = await authLib.blanquearClave(req.body.uf, req.body.password);
  if (r.ok && r.email) {
    await mailer.enviar(r.email, 'Nueva contraseña — Portal del Consorcio',
      'Hola,\n\nTu contraseña fue actualizada.\n\nIngresá a: ' + (process.env.SITE_URL || 'https://consorcio-web.onrender.com') +
      '\nUsuario (UF): ' + req.body.uf + '\nNueva contraseña: ' + req.body.password + '\n\nSaludos,\nAdministración del Consorcio');
  }
  res.redirect('/admin?msg=Clave+blanqueada+para+UF+' + encodeURIComponent(req.body.uf));
});

app.post('/admin/cambiar-password', requireAdmin, async function (req, res) {
  var r = await authLib.cambiarPasswordAdmin(req.body.password);
  res.redirect('/admin?msg=' + encodeURIComponent(r.ok ? 'Contraseña de admin actualizada' : ('Error: ' + r.error)));
});

// Prueba de configuracion de email (item 3): verifica credenciales y manda un mail de prueba.
app.post('/admin/test-email', requireAdmin, async function (req, res) {
  var v = await mailer.verificar();
  if (!v.ok) return res.redirect('/admin?msg=' + encodeURIComponent('Email NO configurado: ' + v.error));
  var destino = req.body.destino || process.env.ADMIN_EMAIL || process.env.SMTP_USER;
  var r = await mailer.enviar(destino, 'Prueba de email — Portal del Consorcio',
    'Este es un email de prueba. Si lo recibiste, la configuración SMTP funciona correctamente.');
  res.redirect('/admin?msg=' + encodeURIComponent(r.ok ? ('Email de prueba enviado a ' + destino) : ('Error al enviar: ' + r.error)));
});

app.get('/admin/liquidacion', requireAdmin, async function (req, res) {
  try {
    var di = await sheets.leerDatosInicio();
    var mg = getMesGastos(di);
    var liq = await sheets.leerLiquidacionMensual(mg.mesGasNum, mg.mesGasAnio);
    res.render('admin-liquidacion', { liq: liq, mesLabel: mg.mesLabel, error: liq.error || null, miUf: null });
  } catch (e) { res.render('admin-liquidacion', { liq: { datos: [] }, mesLabel: '', error: e.message, miUf: null }); }
});

app.listen(PORT, function () { console.log('Consorcio Web en puerto ' + PORT); });
