const { google } = require('googleapis');

let sheetsClient = null;
let usuariosTabChecked = false;

function getCredentials() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.readonly'
    ]
  });
}

async function getSheets() {
  if (!sheetsClient) {
    sheetsClient = google.sheets({ version: 'v4', auth: getCredentials() });
  }
  return sheetsClient;
}

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID;

async function leerSolapa(nombre, rango) {
  const sheets = await getSheets();
  const range = rango ? "'" + nombre + "'!" + rango : "'" + nombre + "'";
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: range });
  return res.data.values || [];
}

async function escribirSolapa(nombre, rango, valores) {
  const sheets = await getSheets();
  const range = "'" + nombre + "'!" + rango;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: range,
    valueInputOption: 'RAW', requestBody: { values: valores }
  });
}

async function agregarFilas(nombre, valores) {
  const sheets = await getSheets();
  const range = "'" + nombre + "'";
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range: range,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: valores }
  });
}

// Se asegura de que exista la solapa "Usuarios" con su encabezado.
// Se ejecuta una sola vez por proceso (idempotente).
async function asegurarSolapaUsuarios() {
  if (usuariosTabChecked) return;
  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existe = (meta.data.sheets || []).some(function (s) {
    return s.properties && s.properties.title === 'Usuarios';
  });
  if (!existe) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: 'Usuarios' } } }] }
    });
    await escribirSolapa('Usuarios', 'A1:G1',
      [['UF', 'CUIT', 'Propietario', 'Email', 'Password', 'Rol', 'Activo']]);
    console.log('[SHEETS] Solapa "Usuarios" creada.');
  }
  usuariosTabChecked = true;
}

async function leerDatosInicio() {
  const rows = await leerSolapa('Datos inicio');
  const d = {};
  rows.forEach(function (r) { if (r[0]) d[String(r[0]).trim()] = r[1] || ''; });
  return d;
}

async function leerUFs() {
  const rows = await leerSolapa('UF');
  if (rows.length < 4) return [];
  return rows.slice(3).filter(function (r) { return r[0]; }).map(function (r) {
    return { uf: String(r[0] || '').trim(), depto: r[1] || '', tipo: r[2] || '', propietario: r[3] || '', cuit: r[4] || '', coeficiente: r[6] || '', email: r[9] || '' };
  });
}

async function leerGastos(mesFilter) {
  const rows = await leerSolapa('Gastos');
  if (rows.length < 3) return [];
  return rows.slice(2).filter(function (r) {
    if (!r[0]) return false;
    if (mesFilter && String(r[0]).trim() !== mesFilter) return false;
    return true;
  }).map(function (r) {
    return { mes: r[0] || '', fecha: r[1] || '', proveedor: r[2] || '', cuit: r[3] || '', nroComprobante: r[4] || '', categoria: r[5] || '', importe: r[6] || '', formaPago: r[7] || '', fechaPago: r[8] || '', montoDebitado: r[9] || '', diferencia: r[10] || '', estado: r[11] || '' };
  });
}

async function leerLiquidacionFinal() {
  const rows = await leerSolapa('Liquidacion final');
  if (rows.length < 3) return [];
  return rows.slice(2).filter(function (r) { return r[0]; }).map(function (r) {
    return { uf: String(r[0] || '').trim(), depto: r[1] || '', tipo: r[2] || '', propietario: r[3] || '', expensasAdeudadas: r[4] || '', pagos: r[5] || '', expMes: r[6] || '', extraord: r[7] || '', adeudado: r[8] || '', total1: r[11] || '', total2: r[12] || '', fecha1: r[13] || '', fecha2: r[14] || '', estado: r[15] || '', fechaPago: r[16] || '', montoCobrado: r[17] || '', montoPendiente: r[19] || '' };
  });
}

async function leerLiquidacionMensual(mes, anio) {
  var meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  var nombre = 'Liquidacion ' + meses[mes - 1] + ' ' + anio;
  try {
    var rows = await leerSolapa(nombre);
    if (rows.length < 3) return { nombre: nombre, datos: [] };
    return {
      nombre: nombre, datos: rows.slice(2).filter(function (r) { return r[0]; }).map(function (r) {
        return { uf: String(r[0] || '').trim(), depto: r[1] || '', propietario: r[2] || '', coef: r[3] || '', expAdeudadas: r[4] || '', pagos: r[5] || '', deuda: r[6] || '', expMes: r[7] || '', extraordinaria: r[8] || '', sum: r[9] || '', destapacion: r[10] || '', bicis: r[11] || '', venc1: r[12] || '', venc2: r[13] || '' };
      })
    };
  } catch (e) { return { nombre: nombre, datos: [], error: 'Solapa no encontrada' }; }
}

async function leerCashFlow() {
  var rows = await leerSolapa('Cash Flow');
  if (rows.length < 3) return [];
  return rows.slice(2).filter(function (r) { return r[0]; }).map(function (r) {
    return { mes: r[0] || '', saldoInicial: r[1] || '', creditosCobrados: r[2] || '', debitosProveedores: r[3] || '', impComBanco: r[4] || '', saldoCalculado: r[5] || '', saldoFinal: r[6] || '', diferencia: r[7] || '', deudaProveedores: r[8] || '', facturas: r[9] || '' };
  });
}

// ==================== HISTORIAL DE PAGOS ====================

// Lista los tabs "Liquidacion <Mes> <Año>", del mas nuevo al mas viejo.
async function listarLiquidacionesMensuales() {
  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const out = [];
  (meta.data.sheets || []).forEach(function (s) {
    var t = (s.properties && s.properties.title) || '';
    var m = t.match(/^Liquidacion\s+([A-Za-zÁÉÍÓÚáéíóúÑñ]+)\s+(\d{4})$/);
    if (!m) return;
    var mi = meses.indexOf(m[1].toLowerCase());
    if (mi === -1) return;
    var etiqueta = m[1].charAt(0).toUpperCase() + m[1].slice(1) + ' ' + m[2];
    out.push({ title: t, mesNum: mi + 1, anio: parseInt(m[2]), mesLabel: etiqueta, sortKey: parseInt(m[2]) * 100 + (mi + 1) });
  });
  out.sort(function (a, b) { return b.sortKey - a.sortKey; });
  return out;
}

function normalizarEstado(txt) {
  var t = String(txt || '').toLowerCase();
  if (t.indexOf('parcial') !== -1) return { clave: 'parcial', label: 'Parcial' };
  if (t.indexOf('pagad') !== -1 || t.indexOf('total') !== -1 || t.indexOf('cancel') !== -1 || t.indexOf('cobrad') !== -1 || t === 'si' || t === 'ok') return { clave: 'total', label: 'Pagado' };
  if (t.indexOf('parc') !== -1) return { clave: 'parcial', label: 'Parcial' };
  if (t.indexOf('pendiente') !== -1 || t.indexOf('impago') !== -1 || t.indexOf('adeuda') !== -1 || t.indexOf('debe') !== -1 || t === 'no') return { clave: 'pendiente', label: 'Pendiente' };
  if (t) return { clave: '', label: String(txt) };
  return { clave: 'pendiente', label: '—' };
}

// Historial mes a mes para una UF, leido de las liquidaciones mensuales.
async function leerHistorialPagos(uf, maxMeses) {
  maxMeses = maxMeses || 12;
  var tabs = await listarLiquidacionesMensuales();
  tabs = tabs.slice(0, maxMeses);
  var salida = [];
  for (var i = 0; i < tabs.length; i++) {
    var tab = tabs[i];
    try {
      var rows = await leerSolapa(tab.title);
      if (rows.length < 3) continue;
      var h0 = rows[0] || [], h1 = rows[1] || [];
      var maxCols = Math.max(h0.length, h1.length);
      // Detecta la columna de estado por el encabezado ("Estado", o "Pago" si esta a la derecha de los datos base).
      var idxEstado = -1, idxFechaPago = -1;
      for (var c = 0; c < maxCols; c++) {
        var hdr = (String(h0[c] || '') + ' ' + String(h1[c] || '')).toLowerCase();
        if (idxEstado === -1 && hdr.indexOf('estado') !== -1) idxEstado = c;
        if (idxFechaPago === -1 && hdr.indexOf('fecha') !== -1 && hdr.indexOf('pago') !== -1) idxFechaPago = c;
      }
      if (idxEstado === -1) {
        for (var c2 = 14; c2 < maxCols; c2++) {
          var hdr2 = (String(h0[c2] || '') + ' ' + String(h1[c2] || '')).toLowerCase();
          if (hdr2.indexOf('pago') !== -1 || hdr2.indexOf('cobr') !== -1) { idxEstado = c2; break; }
        }
      }
      var fila = rows.slice(2).find(function (r) { return String(r[0] || '').trim() === String(uf).trim(); });
      if (!fila) continue;
      var estadoTxt = idxEstado >= 0 ? (fila[idxEstado] || '') : '';
      salida.push({
        mesLabel: tab.mesLabel,
        expMes: fila[7] || '',
        venc1: fila[12] || '',
        venc2: fila[13] || '',
        fechaPago: idxFechaPago >= 0 ? (fila[idxFechaPago] || '') : '',
        estadoTexto: estadoTxt,
        estado: normalizarEstado(estadoTxt),
        columnaDetectada: idxEstado >= 0
      });
    } catch (e) { /* tab con formato raro o sin permiso: saltar */ }
  }
  return salida;
}

// ==================== USUARIOS ====================

async function leerUsuarios() {
  try {
    await asegurarSolapaUsuarios();
    var rows = await leerSolapa('Usuarios');
    if (rows.length < 2) return [];
    return rows.slice(1).filter(function (r) { return r[0]; }).map(function (r, i) {
      return { fila: i + 2, uf: String(r[0] || '').trim(), cuit: r[1] || '', propietario: r[2] || '', email: r[3] || '', password: r[4] || '', rol: r[5] || 'consorcista', activo: r[6] === 'SI' };
    });
  } catch (e) {
    console.log('[SHEETS] Error leyendo Usuarios:', e.message);
    return [];
  }
}

async function guardarUsuario(fila, datos) {
  await escribirSolapa('Usuarios', 'A' + fila + ':G' + fila,
    [[datos.uf, datos.cuit, datos.propietario, datos.email, datos.password, datos.rol, datos.activo ? 'SI' : 'NO']]);
}

async function agregarUsuario(datos) {
  await asegurarSolapaUsuarios();
  await agregarFilas('Usuarios',
    [[datos.uf, datos.cuit, datos.propietario, datos.email, datos.password || '', datos.rol || 'consorcista', datos.activo ? 'SI' : 'NO']]);
}

// Elimina la fila indicada de la solapa "Usuarios" (fila es 1-based, como en la planilla).
async function eliminarFilaUsuario(fila) {
  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const s = (meta.data.sheets || []).find(function (x) {
    return x.properties && x.properties.title === 'Usuarios';
  });
  if (!s) throw new Error('Solapa Usuarios no encontrada');
  const sheetId = s.properties.sheetId;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: sheetId,
            dimension: 'ROWS',
            startIndex: fila - 1, // API es 0-based
            endIndex: fila
          }
        }
      }]
    }
  });
}

module.exports = {
  leerSolapa: leerSolapa, escribirSolapa: escribirSolapa, agregarFilas: agregarFilas,
  asegurarSolapaUsuarios: asegurarSolapaUsuarios,
  leerDatosInicio: leerDatosInicio, leerUFs: leerUFs, leerGastos: leerGastos,
  leerLiquidacionFinal: leerLiquidacionFinal, leerLiquidacionMensual: leerLiquidacionMensual,
  leerCashFlow: leerCashFlow, leerUsuarios: leerUsuarios, guardarUsuario: guardarUsuario,
  agregarUsuario: agregarUsuario, eliminarFilaUsuario: eliminarFilaUsuario,
  SPREADSHEET_ID: SPREADSHEET_ID
};
