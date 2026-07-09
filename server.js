require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const authLib = require('./lib/auth');
const sheets = require('./lib/sheets');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-cambiar',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Crear admin por defecto en cada inicio
try { authLib.crearAdminSiNoExiste(process.env.ADMIN_PASSWORD || 'admin123'); }
catch(e) { console.error('Error creando admin:', e.message); }

app.use((req, res, next) => {
  res.locals.usuario = req.session.usuario || null;
  next();
});

function requireLogin(req, res, next) {
  if (!req.session.usuario) return res.redirect('/login');
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.usuario || req.session.usuario.rol !== 'admin') return res.redirect('/login');
  next();
}

// Helper para obtener mes de gastos
function getMesGastos(di) {
  var mesActivo = String(di['Mes activo'] || '').trim();
  var p = mesActivo.split('-');
  var anio = parseInt(p[0]), mesNum = parseInt(p[1]);
  var mesGasNum = mesNum === 1 ? 12 : mesNum - 1;
  var mesGasAnio = mesNum === 1 ? anio - 1 : anio;
  var meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  return { mesNum, anio, mesGasNum, mesGasAnio, mesLabel: meses[mesGasNum-1] + ' ' + mesGasAnio, mesTxt: String(mesGasAnio) + '-' + String(mesGasNum).padStart(2, '0'), meses };
}

// ── RUTAS PÚBLICAS ──────────────────────────────────────────

app.get('/', (req, res) => {
  if (req.session.usuario) {
    if (req.session.usuario.rol === 'admin') return res.redirect('/admin');
    return res.redirect('/mi-liquidacion');
  }
  res.redirect('/login');
});

app.get('/login', (req, res) => { res.render('login', { error: null }); });

app.post('/login', (req, res) => {
  var result = authLib.login(req.body.uf, req.body.password);
  if (!result.ok) return res.render('login', { error: result.error });
  req.session.usuario = result.usuario;
  if (result.usuario.rol === 'admin') return res.redirect('/admin');
  res.redirect('/mi-liquidacion');
});

app.get('/registrar', (req, res) => { res.render('registrar', { error: null, ok: false }); });

app.post('/registrar', async (req, res) => {
  try {
    var ufs = await sheets.leerUFs();
    var uf = String(req.body.uf).trim();
    var dni = String(req.body.dni).replace(/\D/g, '');
    var match = ufs.find(function(u) {
      return u.uf === uf && String(u.cuit || '').replace(/\D/g, '').indexOf(dni) !== -1;
    });
    if (!match) return res.render('registrar', { error: 'No se encontró la UF ' + uf + ' con ese DNI/CUIT.', ok: false });
    var result = authLib.registrar(uf, dni, match.propietario);
    if (!result.ok) return res.render('registrar', { error: result.error, ok: false });
    res.render('registrar', { error: null, ok: true });
  } catch(e) { res.render('registrar', { error: 'Error: ' + e.message, ok: false }); }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ── RUTAS CONSORCISTA ───────────────────────────────────────

app.get('/mi-liquidacion', requireLogin, async (req, res) => {
  try {
    var di = await sheets.leerDatosInicio();
    var mg = getMesGastos(di);
    var liq = await sheets.leerLiquidacionMensual(mg.mesGasNum, mg.mesGasAnio);
    var miDato = liq.datos.find(function(d) { return d.uf === req.session.usuario.uf; });
    res.render('liquidacion', {
      dato: miDato, mesLabel: mg.mesLabel, solapa: liq.nombre, error: liq.error || null,
      dia1: di['Día 1er vencimiento'] || '6', dia2: di['Día 2do vencimiento'] || '13',
      mesVenc: mg.mesNum, anioVenc: mg.anio
    });
  } catch(e) { res.render('liquidacion', { dato:null, mesLabel:'', solapa:'', error:e.message, dia1:'',dia2:'',mesVenc:'',anioVenc:'' }); }
});

app.get('/mis-pagos', requireLogin, async (req, res) => {
  try {
    var liqFinal = await sheets.leerLiquidacionFinal();
    var misDatos = liqFinal.filter(function(d) { return String(d.uf).trim() === req.session.usuario.uf; });
    res.render('historial', { pagos: misDatos, error: null });
  } catch(e) { res.render('historial', { pagos: [], error: e.message }); }
});

app.get('/gastos', requireLogin, async (req, res) => {
  try {
    var di = await sheets.leerDatosInicio();
    var mg = getMesGastos(di);
    var todosGastos = await sheets.leerGastos(mg.mesTxt);

    // Separar ordinarios, Santander e impuestos, y extraordinarios
    var gastos = [];
    var impuestos = [];
    var gastosExtra = [];
    todosGastos.forEach(function(g) {
      var prov = String(g.proveedor || '').toLowerCase();
      var cat = String(g.categoria || '').toLowerCase();
      if (cat.indexOf('extraordin') !== -1) {
        gastosExtra.push(g);
      } else if (prov.indexOf('santander') !== -1) {
        impuestos.push(g);
      } else {
        gastos.push(g);
      }
    });

    // Cash Flow del mes
    var cfData = await sheets.leerCashFlow();
    var mesNorm = (mg.meses[mg.mesGasNum-1] || '').toLowerCase();
    var cashflow = cfData.find(function(cf) {
      var t = String(cf.mes || '').toLowerCase();
      return t.indexOf(mesNorm) !== -1 && t.indexOf(String(mg.mesGasAnio)) !== -1;
    }) || null;

    res.render('gastos', { gastos: gastos, impuestos: impuestos, gastosExtra: gastosExtra, cashflow: cashflow, mesLabel: mg.mesLabel, error: null });
  } catch(e) { res.render('gastos', { gastos:[], impuestos:[], gastosExtra:[], cashflow:null, mesLabel:'', error:e.message }); }
});

// ── RUTAS ADMIN ─────────────────────────────────────────────

app.get('/admin', requireAdmin, async (req, res) => {
  try {
    var di = await sheets.leerDatosInicio();
    var cf = await sheets.leerCashFlow();
    var usuarios = authLib.listarUsuarios();
    var pendientes = authLib.listarPendientes();
    res.render('admin-dashboard', { di:di, cashflow:cf, usuarios:usuarios, pendientes:pendientes, error:null, msg:null });
  } catch(e) { res.render('admin-dashboard', { di:{}, cashflow:[], usuarios:[], pendientes:[], error:e.message, msg:null }); }
});

app.post('/admin/activar', requireAdmin, (req, res) => {
  authLib.activarUsuario(req.body.uf, req.body.password);
  res.redirect('/admin');
});

app.get('/admin/liquidacion', requireAdmin, async (req, res) => {
  try {
    var di = await sheets.leerDatosInicio();
    var mg = getMesGastos(di);
    var liq = await sheets.leerLiquidacionMensual(mg.mesGasNum, mg.mesGasAnio);
    res.render('admin-liquidacion', { liq:liq, mesLabel:mg.mesLabel, error:null });
  } catch(e) { res.render('admin-liquidacion', { liq:{datos:[]}, mesLabel:'', error:e.message }); }
});

app.listen(PORT, function() { console.log('Consorcio Web en http://localhost:' + PORT); });
