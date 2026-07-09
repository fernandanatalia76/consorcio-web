require('dotenv').config();
var express = require('express');
var session = require('express-session');
var path = require('path');
var authLib = require('./lib/auth');
var sheets = require('./lib/sheets');

var app = express();
var PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false, saveUninitialized: false
}));

authLib.crearAdminSiNoExiste(process.env.ADMIN_PASSWORD || 'admin123');

app.use(function(req, res, next) {
  res.locals.usuario = req.session.usuario || null;
  next();
});

function requireLogin(req, res, next) { if (!req.session.usuario) return res.redirect('/login'); next(); }
function requireAdmin(req, res, next) { if (!req.session.usuario || req.session.usuario.rol !== 'admin') return res.redirect('/login'); next(); }

app.get('/', function(req, res) {
  if (req.session.usuario) return res.redirect(req.session.usuario.rol === 'admin' ? '/admin' : '/mi-liquidacion');
  res.redirect('/login');
});
app.get('/login', function(req, res) { res.render('login', { error: null }); });
app.post('/login', function(req, res) {
  var r = authLib.login(req.body.uf, req.body.password);
  if (!r.ok) return res.render('login', { error: r.error });
  req.session.usuario = r.usuario;
  res.redirect(r.usuario.rol === 'admin' ? '/admin' : '/mi-liquidacion');
});
app.get('/registrar', function(req, res) { res.render('registrar', { error: null, ok: false }); });
app.post('/registrar', async function(req, res) {
  try {
    var uf = String(req.body.uf).trim();
    var cuit = String(req.body.cuit || '').replace(/\D/g, '');
    if (cuit.length !== 11) return res.render('registrar', { error: 'El CUIT debe tener exactamente 11 dígitos.', ok: false });
    var ufs = await sheets.leerUFs();
    var match = ufs.find(function(u) { return u.uf === uf && String(u.cuit || '').replace(/\D/g, '') === cuit; });
    if (!match) return res.render('registrar', { error: 'No se encontró la UF ' + uf + ' con ese CUIT en el sistema. Contactá al administrador.', ok: false });
    var r = authLib.registrar(uf, cuit, match.propietario, req.body.email);
    if (!r.ok) return res.render('registrar', { error: r.error, ok: false });
    // Notificar al admin por email que hay una solicitud nueva
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      try {
        var nodemailer = require('nodemailer');
        var transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        });
        await transporter.sendMail({
          from: process.env.SMTP_USER,
          to: process.env.ADMIN_EMAIL || process.env.SMTP_USER,
          subject: 'Nueva solicitud de acceso — UF ' + uf,
          text: 'Se registró una nueva solicitud de acceso al portal:\n\n' +
                'UF: ' + uf + '\n' +
                'Propietario: ' + (match.propietario || '') + '\n' +
                'CUIT: ' + cuit + '\n' +
                'Email: ' + (req.body.email || '') + '\n\n' +
                'Ingresá al panel de admin para activar la cuenta:\n' +
                (process.env.SITE_URL || 'https://consorcio-web.onrender.com') + '/admin'
        });
      } catch(e) { console.log('Error enviando notificación al admin:', e.message); }
    }
    res.render('registrar', { error: null, ok: true });
  } catch(e) { res.render('registrar', { error: e.message, ok: false }); }
});
app.get('/logout', function(req, res) { req.session.destroy(); res.redirect('/login'); });

app.get('/mi-liquidacion', requireLogin, async function(req, res) {
  try {
    var di = await sheets.leerDatosInicio();
    var p = String(di['Mes activo'] || '').split('-');
    var anio = parseInt(p[0]), mesNum = parseInt(p[1]);
    var mg = mesNum === 1 ? 12 : mesNum - 1, ma = mesNum === 1 ? anio - 1 : anio;
    var meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    var liq = await sheets.leerLiquidacionMensual(mg, ma);
    var dato = liq.datos.find(function(d) { return d.uf === req.session.usuario.uf; });
    res.render('liquidacion', { dato: dato, mesLabel: meses[mg-1]+' '+ma, error: liq.error||null, dia1: di['Día 1er vencimiento']||'6', dia2: di['Día 2do vencimiento']||'13', mesVenc: mesNum, anioVenc: anio });
  } catch(e) { res.render('liquidacion', { dato:null, mesLabel:'', error:e.message, dia1:'',dia2:'',mesVenc:'',anioVenc:'' }); }
});

app.get('/mis-pagos', requireLogin, async function(req, res) {
  try {
    var lf = await sheets.leerLiquidacionFinal();
    var mis = lf.filter(function(d) { return String(d.uf).trim() === req.session.usuario.uf; });
    res.render('historial', { pagos: mis, error: null });
  } catch(e) { res.render('historial', { pagos: [], error: e.message }); }
});

app.get('/gastos', requireLogin, async function(req, res) {
  try {
    var di = await sheets.leerDatosInicio();
    var p = String(di['Mes activo'] || '').split('-');
    var anio = parseInt(p[0]), mesNum = parseInt(p[1]);
    var mg = mesNum === 1 ? 12 : mesNum - 1, ma = mesNum === 1 ? anio - 1 : anio;
    var meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    var mesTxt = String(ma) + '-' + String(mg).padStart(2, '0');
    var gastos = await sheets.leerGastos(mesTxt);
    res.render('gastos', { gastos: gastos, mesLabel: meses[mg-1]+' '+ma, error: null });
  } catch(e) { res.render('gastos', { gastos: [], mesLabel: '', error: e.message }); }
});

app.get('/admin', requireAdmin, async function(req, res) {
  try {
    var di = await sheets.leerDatosInicio();
    var cf = await sheets.leerCashFlow();
    res.render('admin-dashboard', { di:di, cashflow:cf, usuarios:authLib.listarUsuarios(), pendientes:authLib.listarPendientes(), error:null, msg:null });
  } catch(e) { res.render('admin-dashboard', { di:{}, cashflow:[], usuarios:[], pendientes:[], error:e.message, msg:null }); }
});

app.post('/admin/activar', requireAdmin, async function(req, res) {
  var uf = req.body.uf;
  var pw = req.body.password;
  var email = req.body.email;
  authLib.activarUsuario(uf, pw);
  // Enviar contraseña por email si hay email y credenciales configuradas
  if (email && process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      var nodemailer = require('nodemailer');
      var transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      });
      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: email,
        subject: 'Tu acceso al portal del Consorcio',
        text: 'Hola,\n\nTu cuenta fue activada.\n\n' +
              'Ingresá a: ' + (process.env.SITE_URL || 'https://consorcio-web.onrender.com') + '\n' +
              'Usuario (N° de UF): ' + uf + '\n' +
              'Contraseña: ' + pw + '\n\n' +
              'Saludos,\nAdministración del Consorcio'
      });
    } catch(e) { console.log('Error enviando email:', e.message); }
  }
  res.redirect('/admin');
});

app.get('/admin/liquidacion', requireAdmin, async function(req, res) {
  try {
    var di = await sheets.leerDatosInicio();
    var p = String(di['Mes activo'] || '').split('-');
    var anio = parseInt(p[0]), mesNum = parseInt(p[1]);
    var mg = mesNum === 1 ? 12 : mesNum - 1, ma = mesNum === 1 ? anio - 1 : anio;
    var meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    var liq = await sheets.leerLiquidacionMensual(mg, ma);
    res.render('admin-liquidacion', { liq:liq, mesLabel:meses[mg-1]+' '+ma, error:null });
  } catch(e) { res.render('admin-liquidacion', { liq:{datos:[]}, mesLabel:'', error:e.message }); }
});

app.listen(PORT, function() { console.log('Consorcio Web en puerto ' + PORT); });
