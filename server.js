require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const authLib = require('./lib/auth');
const sheets = require('./lib/sheets');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-cambiar',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 horas
}));

// Crear admin por defecto
authLib.crearAdminSiNoExiste(process.env.ADMIN_PASSWORD || 'admin123');

// Middleware: pasar usuario a todas las vistas
app.use((req, res, next) => {
  res.locals.usuario = req.session.usuario || null;
  next();
});

// Middleware: requerir login
function requireLogin(req, res, next) {
  if (!req.session.usuario) return res.redirect('/login');
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.usuario || req.session.usuario.rol !== 'admin') return res.redirect('/login');
  next();
}

// ── RUTAS PÚBLICAS ──────────────────────────────────────────

app.get('/', (req, res) => {
  if (req.session.usuario) {
    if (req.session.usuario.rol === 'admin') return res.redirect('/admin');
    return res.redirect('/mi-liquidacion');
  }
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { uf, password } = req.body;
  const result = authLib.login(uf, password);
  if (!result.ok) return res.render('login', { error: result.error });
  req.session.usuario = result.usuario;
  if (result.usuario.rol === 'admin') return res.redirect('/admin');
  res.redirect('/mi-liquidacion');
});

app.get('/registrar', (req, res) => {
  res.render('registrar', { error: null, ok: false });
});

app.post('/registrar', async (req, res) => {
  const { uf, dni } = req.body;
  // Validar que la UF+DNI exista en la solapa UF
  try {
    const ufs = await sheets.leerUFs();
    const match = ufs.find(u => u.uf === uf && String(u.cuit || '').replace(/\D/g, '').indexOf(String(dni).replace(/\D/g, '')) !== -1);
    if (!match) return res.render('registrar', { error: 'No se encontró la UF ' + uf + ' con ese DNI/CUIT en el sistema. Contactá al administrador.', ok: false });
    const result = authLib.registrar(uf, dni, match.propietario);
    if (!result.ok) return res.render('registrar', { error: result.error, ok: false });
    res.render('registrar', { error: null, ok: true });
  } catch(e) {
    res.render('registrar', { error: 'Error de conexión: ' + e.message, ok: false });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ── RUTAS CONSORCISTA ───────────────────────────────────────

app.get('/mi-liquidacion', requireLogin, async (req, res) => {
  try {
    const di = await sheets.leerDatosInicio();
    const mesActivo = String(di['Mes activo'] || '').trim();
    let mesNum, anio;
    if (mesActivo instanceof Date || (!isNaN(Number(mesActivo)) && Number(mesActivo) > 40000)) {
      const d = mesActivo instanceof Date ? mesActivo : new Date(Date.UTC(1899,11,30) + Number(mesActivo)*86400000);
      mesNum = d.getMonth() + 1; anio = d.getFullYear();
    } else {
      const p = String(mesActivo).split('-');
      anio = parseInt(p[0]); mesNum = parseInt(p[1]);
    }
    // Mes de gastos = mes anterior
    const mesGasNum = mesNum === 1 ? 12 : mesNum - 1;
    const mesGasAnio = mesNum === 1 ? anio - 1 : anio;

    const liq = await sheets.leerLiquidacionMensual(mesGasNum, mesGasAnio);
    const miUF = req.session.usuario.uf;
    const miDato = liq.datos.find(d => d.uf === miUF);

    const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                   'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

    res.render('liquidacion', {
      dato: miDato,
      mesLabel: meses[mesGasNum-1] + ' ' + mesGasAnio,
      solapa: liq.nombre,
      error: liq.error || null,
      dia1: di['Día 1er vencimiento'] || '6',
      dia2: di['Día 2do vencimiento'] || '13',
      mesVenc: mesNum, anioVenc: anio
    });
  } catch(e) {
    res.render('liquidacion', { dato: null, mesLabel: '', solapa: '', error: e.message, dia1:'',dia2:'',mesVenc:'',anioVenc:'' });
  }
});

app.get('/mis-pagos', requireLogin, async (req, res) => {
  try {
    const liqFinal = await sheets.leerLiquidacionFinal();
    const miUF = req.session.usuario.uf;
    const misDatos = liqFinal.filter(d => String(d.uf).trim() === miUF);
    res.render('historial', { pagos: misDatos, error: null });
  } catch(e) {
    res.render('historial', { pagos: [], error: e.message });
  }
});

app.get('/gastos', requireLogin, async (req, res) => {
  try {
    const di = await sheets.leerDatosInicio();
    const mesActivo = String(di['Mes activo'] || '');
    const p = mesActivo.split('-');
    const mesNum = parseInt(p[1]); const anio = parseInt(p[0]);
    const mesGasNum = mesNum === 1 ? 12 : mesNum - 1;
    const mesGasAnio = mesNum === 1 ? anio - 1 : anio;
    const mesTxt = String(mesGasAnio) + '-' + String(mesGasNum).padStart(2, '0');

    const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                   'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

    const gastos = await sheets.leerGastos(mesTxt);

    // Cash Flow del mes para el resumen
    const cfData = await sheets.leerCashFlow();
    const mesNorm = (meses[mesGasNum-1] || '').toLowerCase();
    const cashflow = cfData.find(cf => {
      const t = String(cf.mes || '').toLowerCase();
      return t.includes(mesNorm) && t.includes(String(mesGasAnio));
    }) || null;

    // Gastos extraordinarios (categoría "Extraordinario" en la misma solapa)
    const gastosExtra = gastos.filter(g => String(g.categoria || '').toLowerCase().includes('extraordin'));
    const gastosOrdinarios = gastos.filter(g => !String(g.categoria || '').toLowerCase().includes('extraordin'));

    res.render('gastos', { gastos: gastosOrdinarios, gastosExtra, cashflow, mesLabel: meses[mesGasNum-1] + ' ' + mesGasAnio, error: null });
  } catch(e) {
    res.render('gastos', { gastos: [], gastosExtra: [], cashflow: null, mesLabel: '', error: e.message });
  }
});

// ── RUTAS ADMIN ─────────────────────────────────────────────

app.get('/admin', requireAdmin, async (req, res) => {
  try {
    const di = await sheets.leerDatosInicio();
    const cf = await sheets.leerCashFlow();
    const usuarios = authLib.listarUsuarios();
    const pendientes = authLib.listarPendientes();
    res.render('admin-dashboard', { di, cashflow: cf, usuarios, pendientes, error: null, msg: null });
  } catch(e) {
    res.render('admin-dashboard', { di: {}, cashflow: [], usuarios: [], pendientes: [], error: e.message, msg: null });
  }
});

app.post('/admin/activar', requireAdmin, (req, res) => {
  const { uf, password } = req.body;
  authLib.activarUsuario(uf, password);
  res.redirect('/admin');
});

app.get('/admin/liquidacion', requireAdmin, async (req, res) => {
  try {
    const di = await sheets.leerDatosInicio();
    const mesActivo = String(di['Mes activo'] || '');
    const p = mesActivo.split('-');
    const mesNum = parseInt(p[1]); const anio = parseInt(p[0]);
    const mesGasNum = mesNum === 1 ? 12 : mesNum - 1;
    const mesGasAnio = mesNum === 1 ? anio - 1 : anio;
    const liq = await sheets.leerLiquidacionMensual(mesGasNum, mesGasAnio);
    const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                   'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    res.render('admin-liquidacion', { liq, mesLabel: meses[mesGasNum-1] + ' ' + mesGasAnio, error: null });
  } catch(e) {
    res.render('admin-liquidacion', { liq: { datos: [] }, mesLabel: '', error: e.message });
  }
});

// ── INICIAR SERVIDOR ────────────────────────────────────────

app.listen(PORT, () => {
  console.log('Consorcio Web corriendo en http://localhost:' + PORT);
});
