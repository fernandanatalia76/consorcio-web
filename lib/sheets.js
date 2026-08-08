const { google } = require('googleapis');
let sheetsClient = null;
// FIX (multi-consorcio): antes esto era un solo booleano ("ya revisado o
// no"), válido cuando solo existía UNA planilla. Ahora hay que recordar
// esto POR planilla (spreadsheetId), si no, al revisar el consorcio A se
// marcaba como "ya revisado" globalmente y nunca se revisaba de nuevo
// para el consorcio B.
var usuariosTabChecked = {}; // { [spreadsheetId]: true }
var cacheTabChecked = {};    // { [spreadsheetId]: true }

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

// FIX (multi-consorcio): TODAS las funciones ahora reciben "ssid" (el ID
// de la planilla del consorcio elegido) como PRIMER parámetro, en vez de
// depender de una única constante SPREADSHEET_ID fija. Así el mismo
// código sirve para cualquier cantidad de consorcios — cada sesión de
// usuario trabaja con la planilla que le corresponde según el consorcio
// que eligió al loguearse.

async function listarSolapas(ssid) {
  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: ssid });
  return (meta.data.sheets || []).map(function (s) { return (s.properties && s.properties.title) || ''; }).filter(Boolean);
}

let driveClient = null;
async function getDrive() {
  if (!driveClient) {
    driveClient = google.drive({ version: 'v3', auth: getCredentials() });
  }
  return driveClient;
}
// Descarga el contenido de un archivo de Drive (factura) usando la
// cuenta de servicio — así el navegador nunca tiene que loguearse en
// Google ni pedir permiso, el servidor ya tiene acceso de lectura.
async function descargarArchivoDrive(fileId) {
  const drive = await getDrive();
  const meta = await drive.files.get({ fileId: fileId, fields: 'name, mimeType' });
  const res = await drive.files.get(
    { fileId: fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  return { nombre: meta.data.name, mimeType: meta.data.mimeType, buffer: Buffer.from(res.data) };
}

async function leerSolapa(ssid, nombre, rango) {
  const sheets = await getSheets();
  const range = rango ? "'" + nombre + "'!" + rango : "'" + nombre + "'";
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: ssid, range: range });
  return res.data.values || [];
}
async function escribirSolapa(ssid, nombre, rango, valores) {
  const sheets = await getSheets();
  const range = "'" + nombre + "'!" + rango;
  await sheets.spreadsheets.values.update({
    spreadsheetId: ssid, range: range,
    valueInputOption: 'RAW', requestBody: { values: valores }
  });
}
// FIX: algunas cuentas/planillas rechazan la operación de "insertar
// filas nuevas" (values.append con INSERT_ROWS) con error 403, aunque
// la cuenta de servicio SÍ pueda editar celdas existentes (values.update
// funciona bien). Por eso, en vez de "append", buscamos la próxima fila
// vacía y escribimos ahí con "update" — mismo resultado, sin depender de
// esa operación restringida.
async function agregarFilas(ssid, nombre, valores) {
  const sheets = await getSheets();
  try {
    var actuales = await leerSolapa(ssid, nombre);
    var proximaFila = actuales.length + 1;
    var ultimaCol = valores[0].length;
    var letraCol = ultimaCol <= 26 ? String.fromCharCode(64 + ultimaCol) : ('A' + String.fromCharCode(64 + (ultimaCol - 26)));
    var rango = "'" + nombre + "'!A" + proximaFila + ":" + letraCol + (proximaFila + valores.length - 1);
    await sheets.spreadsheets.values.update({
      spreadsheetId: ssid, range: rango,
      valueInputOption: 'RAW', requestBody: { values: valores }
    });
  } catch (e) {
    console.log('[SHEETS] Error en agregarFilas("' + nombre + '"):', e.message);
    if (e.errors) console.log('[SHEETS] Detalle:', JSON.stringify(e.errors));
    if (e.code) console.log('[SHEETS] Código:', e.code);
    throw e;
  }
}
// Se asegura de que exista la solapa "Usuarios" con su encabezado.
// Se ejecuta una sola vez por proceso Y por planilla (idempotente).
async function asegurarSolapaUsuarios(ssid) {
  if (usuariosTabChecked[ssid]) return;
  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: ssid });
  const existe = (meta.data.sheets || []).some(function (s) {
    return s.properties && s.properties.title === 'Usuarios';
  });
  if (!existe) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: ssid,
      requestBody: { requests: [{ addSheet: { properties: { title: 'Usuarios' } } }] }
    });
    await escribirSolapa(ssid, 'Usuarios', 'A1:H1',
      [['UF', 'CUIT', 'Propietario', 'Email', 'Password', 'Rol', 'Activo', 'Tipo']]);
    console.log('[SHEETS] Solapa "Usuarios" creada.');
  } else {
    try {
      var hdr = await leerSolapa(ssid, 'Usuarios', 'A1:H1');
      var actual = (hdr && hdr[0]) || [];
      if (!actual[7]) {
        await escribirSolapa(ssid, 'Usuarios', 'H1', [['Tipo']]);
        console.log('[SHEETS] Encabezado "Tipo" agregado a columna H de Usuarios.');
      }
    } catch (e) { /* no bloquear si falla */ }
  }
  usuariosTabChecked[ssid] = true;
}
// ==================== CACHE PERSISTENTE ====================
async function asegurarSolapaCache(ssid) {
  if (cacheTabChecked[ssid]) return;
  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: ssid });
  const existe = (meta.data.sheets || []).some(function (s) {
    return s.properties && s.properties.title === 'Cache';
  });
  if (!existe) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: ssid,
      requestBody: { requests: [{ addSheet: { properties: { title: 'Cache' } } }] }
    });
    await escribirSolapa(ssid, 'Cache', 'A1:C3', [
      ['Clave', 'Datos JSON', 'Fecha ISO'],
      ['gastos', '', ''],
      ['liquidacion', '', '']
    ]);
    console.log('[SHEETS] Solapa "Cache" creada.');
  }
  cacheTabChecked[ssid] = true;
}
async function leerCache(ssid, clave) {
  try {
    await asegurarSolapaCache(ssid);
    var rows = await leerSolapa(ssid, 'Cache', 'A1:C10');
    var fila = (rows || []).find(function (r) { return String(r[0] || '').trim() === clave; });
    if (!fila || !fila[1]) return null;
    var datos = JSON.parse(fila[1]);
    var fecha = fila[2] ? new Date(fila[2]) : null;
    return { datos: datos, fecha: fecha };
  } catch (e) {
    console.log('[SHEETS] Error leyendo cache "' + clave + '":', e.message);
    return null;
  }
}
async function guardarCache(ssid, clave, datos, fecha) {
  try {
    await asegurarSolapaCache(ssid);
    var rows = await leerSolapa(ssid, 'Cache', 'A1:C10');
    var idxFila = -1;
    for (var i = 0; i < (rows || []).length; i++) {
      if (String(rows[i][0] || '').trim() === clave) { idxFila = i + 1; break; }
    }
    var json = JSON.stringify(datos);
    var fechaIso = (fecha || new Date()).toISOString();
    if (idxFila === -1) {
      await agregarFilas(ssid, 'Cache', [[clave, json, fechaIso]]);
    } else {
      await escribirSolapa(ssid, 'Cache', 'A' + idxFila + ':C' + idxFila, [[clave, json, fechaIso]]);
    }
  } catch (e) {
    console.log('[SHEETS] Error guardando cache "' + clave + '":', e.message);
    throw e;
  }
}
async function leerDatosInicio(ssid) {
  const rows = await leerSolapa(ssid, 'Datos inicio');
  const d = {};
  rows.forEach(function (r) { if (r[0]) d[String(r[0]).trim()] = r[1] || ''; });
  return d;
}
async function leerUFs(ssid) {
  const rows = await leerSolapa(ssid, 'UF');
  if (rows.length < 4) return [];
  return rows.slice(3).filter(function (r) { return r[0]; }).map(function (r) {
    return { uf: String(r[0] || '').trim(), depto: r[1] || '', tipo: r[2] || '', propietario: r[3] || '', cuit: r[4] || '', coeficiente: r[6] || '', email: r[9] || '' };
  });
}
async function leerGastos(ssid, mesFilter) {
  const rows = await leerSolapa(ssid, 'Gastos');
  if (rows.length < 3) return [];
  return rows.slice(2).filter(function (r) {
    if (!r[0]) return false;
    if (mesFilter && String(r[0]).trim() !== mesFilter) return false;
    return true;
  }).map(function (r) {
    // FIX: O (índice 14) y P (índice 15) tienen el link de Drive de la
    // factura — original y ya movida a la carpeta de imputados,
    // respectivamente. Se usa la de imputados si existe (siempre debería
    // estar si la factura se cargó con archivo adjunto), si no la
    // original.
    var driveUrlRaw = String(r[15] || '').trim();
    var mFile = /\/file\/d\/([^/]+)/.exec(driveUrlRaw);
    var facturaFileId = mFile ? mFile[1] : '';
    return { mes: r[0] || '', fecha: r[1] || '', proveedor: r[2] || '', cuit: r[3] || '', nroComprobante: r[4] || '', categoria: r[5] || '', importe: r[6] || '', formaPago: r[7] || '', fechaPago: r[8] || '', montoDebitado: r[9] || '', diferencia: r[10] || '', estado: r[11] || '', facturaFileId: facturaFileId };
  });
}
// Solapa aparte "Gastos Extraordinarios" — el portal no la leía, solo
// miraba "Gastos". Misma estructura de columnas que leerGastos.
async function leerGastosExtraordinarios(ssid, mesFilter) {
  try {
    const rows = await leerSolapa(ssid, 'Gastos Extraordinarios');
    if (rows.length < 3) return [];
    return rows.slice(2).filter(function (r) {
      if (!r[0]) return false;
      if (mesFilter && String(r[0]).trim() !== mesFilter) return false;
      return true;
    }).map(function (r) {
      var driveUrlRaw = String(r[15] || '').trim();
      var mFile = /\/file\/d\/([^/]+)/.exec(driveUrlRaw);
      var facturaFileId = mFile ? mFile[1] : '';
      return { mes: r[0] || '', fecha: r[1] || '', proveedor: r[2] || '', cuit: r[3] || '', nroComprobante: r[4] || '', categoria: r[5] || 'Extraordinario', importe: r[6] || '', formaPago: r[7] || '', fechaPago: r[8] || '', montoDebitado: r[9] || '', diferencia: r[10] || '', estado: r[11] || '', facturaFileId: facturaFileId };
    });
  } catch (e) {
    console.log('[SHEETS] No se pudo leer "Gastos Extraordinarios":', e.message);
    return [];
  }
}
async function leerLiquidacionFinal(ssid) {
  const rows = await leerSolapa(ssid, 'Liquidacion final');
  if (rows.length < 3) return [];
  return rows.slice(2).filter(function (r) { return r[0]; }).map(function (r) {
    return { uf: String(r[0] || '').trim(), depto: r[1] || '', tipo: r[2] || '', propietario: r[3] || '', expensasAdeudadas: r[4] || '', pagos: r[5] || '', expMes: r[6] || '', extraord: r[7] || '', adeudado: r[8] || '', total1: r[11] || '', total2: r[12] || '', fecha1: r[13] || '', fecha2: r[14] || '', estado: r[15] || '', fechaPago: r[16] || '', montoCobrado: r[17] || '', montoPendiente: r[19] || '' };
  });
}
async function leerLiquidacionMensual(ssid, mes, anio) {
  var meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  var nombre = 'Liquidacion ' + meses[mes - 1] + ' ' + anio;
  try {
    var rows = await leerSolapa(ssid, nombre);
    if (rows.length < 3) return { nombre: nombre, datos: [] };
    return {
      nombre: nombre, datos: rows.slice(2).filter(function (r) { return r[0]; }).map(function (r) {
        return { uf: String(r[0] || '').trim(), depto: r[1] || '', propietario: r[2] || '', coef: r[3] || '', expAdeudadas: r[4] || '', pagos: r[5] || '', deuda: r[6] || '', expMes: r[7] || '', extraordinaria: r[8] || '', sum: r[9] || '', destapacion: r[10] || '', bicis: r[11] || '', venc1: r[12] || '', venc2: r[13] || '' };
      })
    };
  } catch (e) { return { nombre: nombre, datos: [], error: 'Solapa no encontrada' }; }
}
async function leerLiquidacionMasReciente(ssid, mesInicial, anioInicial) {
  var meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  var sheetsApi = await getSheets();
  var meta = await sheetsApi.spreadsheets.get({ spreadsheetId: ssid });
  var titulos = (meta.data.sheets || []).map(function (s) { return s.properties && s.properties.title; });
  var m = mesInicial, a = anioInicial;
  for (var i = 0; i < 12; i++) {
    var nombre = 'Liquidacion ' + meses[m - 1] + ' ' + a;
    if (titulos.indexOf(nombre) !== -1) {
      var liq = await leerLiquidacionMensual(ssid, m, a);
      return {
        mes: m, anio: a,
        mesLabel: meses[m - 1] + ' ' + a,
        nombre: liq.nombre,
        datos: liq.datos,
        error: null
      };
    }
    m = (m === 1) ? 12 : m - 1;
    if (m === 12) a = a - 1;
  }
  return { mes: mesInicial, anio: anioInicial, mesLabel: meses[mesInicial - 1] + ' ' + anioInicial, nombre: '', datos: [], error: 'No se encontró ninguna solapa de liquidación reciente' };
}
async function leerCashFlow(ssid) {
  var rows = await leerSolapa(ssid, 'Cash Flow');
  if (rows.length < 3) return [];
  return rows.slice(2).filter(function (r) { return r[0]; }).map(function (r) {
    return { mes: r[0] || '', saldoInicial: r[1] || '', creditosCobrados: r[2] || '', debitosProveedores: r[3] || '', impComBanco: r[4] || '', saldoCalculado: r[5] || '', saldoFinal: r[6] || '', diferencia: r[7] || '', deudaProveedores: r[8] || '', facturas: r[9] || '' };
  });
}
// Cash Flow de la cuenta de Inversiones/Fondos comunes (Extraordinarias).
async function leerCashFlowExtraordinarias(ssid) {
  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: ssid });
  const titulos = (meta.data.sheets || []).map(function (s) { return (s.properties && s.properties.title) || ''; });
  const objetivo = 'cash flow extraordinarias';
  const real = titulos.find(function (t) { return t.trim().toLowerCase() === objetivo; });
  if (!real) {
    console.log('[SHEETS] No se encontró la solapa "Cash Flow Extraordinarias". Solapas disponibles:', JSON.stringify(titulos));
    return [];
  }
  var rows = await leerSolapa(ssid, real);
  if (rows.length < 3) return [];
  return rows.slice(2).filter(function (r) { return r[0]; }).map(function (r) {
    return { mes: r[0] || '', saldoInicial: r[1] || '', depositado: r[2] || '', rescatado: r[3] || '', saldoFinal: r[4] || '' };
  });
}
async function leerDeudaProveedores(ssid) {
  try {
    var rows = await leerSolapa(ssid, 'PDF Gastos y Saldos', 'E6');
    var val = (rows && rows[0] && rows[0][0] != null) ? String(rows[0][0]) : '';
    return val;
  } catch (e) {
    console.log('[SHEETS] No se pudo leer deuda a proveedores (E6):', e.message);
    return '';
  }
}
async function leerTotalGastos(ssid) {
  try {
    var rows = await leerSolapa(ssid, 'Gastos', 'J2');
    if (rows && rows[0] && rows[0][0] != null) return String(rows[0][0]);
    return '';
  } catch (e) {
    console.log('[SHEETS] No se pudo leer total de gastos (Gastos!J2):', e.message);
    return '';
  }
}
// ==================== HISTORIAL DE PAGOS ====================
async function listarLiquidacionesMensuales(ssid) {
  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: ssid });
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
async function leerHistorialPagos(ssid, uf, maxMeses) {
  maxMeses = maxMeses || 12;
  var tabs = await listarLiquidacionesMensuales(ssid);
  tabs = tabs.slice(0, maxMeses);
  var salida = [];
  for (var i = 0; i < tabs.length; i++) {
    var tab = tabs[i];
    try {
      var rows = await leerSolapa(ssid, tab.title);
      if (rows.length < 3) continue;
      var h0 = rows[0] || [], h1 = rows[1] || [];
      var maxCols = Math.max(h0.length, h1.length);
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
async function leerUsuarios(ssid) {
  try {
    await asegurarSolapaUsuarios(ssid);
    var rows = await leerSolapa(ssid, 'Usuarios');
    if (rows.length < 2) return [];
    return rows.slice(1).filter(function (r) { return r[0]; }).map(function (r, i) {
      var tipo = String(r[7] || '').toLowerCase().trim();
      if (tipo !== 'inquilino') tipo = 'propietario';
      return { fila: i + 2, uf: String(r[0] || '').trim(), cuit: r[1] || '', propietario: r[2] || '', email: r[3] || '', password: r[4] || '', rol: r[5] || 'consorcista', activo: r[6] === 'SI', tipo: tipo };
    });
  } catch (e) {
    console.log('[SHEETS] Error leyendo Usuarios:', e.message);
    return [];
  }
}
async function guardarUsuario(ssid, fila, datos) {
  await escribirSolapa(ssid, 'Usuarios', 'A' + fila + ':H' + fila,
    [[datos.uf, datos.cuit, datos.propietario, datos.email, datos.password, datos.rol, datos.activo ? 'SI' : 'NO', datos.tipo || 'propietario']]);
}
async function agregarUsuario(ssid, datos) {
  await asegurarSolapaUsuarios(ssid);
  await agregarFilas(ssid, 'Usuarios',
    [[datos.uf, datos.cuit, datos.propietario, datos.email, datos.password || '', datos.rol || 'consorcista', datos.activo ? 'SI' : 'NO', datos.tipo || 'propietario']]);
}
async function eliminarFilaUsuario(ssid, fila) {
  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: ssid });
  const s = (meta.data.sheets || []).find(function (x) {
    return x.properties && x.properties.title === 'Usuarios';
  });
  if (!s) throw new Error('Solapa Usuarios no encontrada');
  const sheetId = s.properties.sheetId;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssid,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: sheetId,
            dimension: 'ROWS',
            startIndex: fila - 1,
            endIndex: fila
          }
        }
      }]
    }
  });
}
// ==================== COMUNICADOS ====================
// Avisos que el administrador publica para los consorcistas. Se
// muestran como un cartel de alerta en las páginas del consorcista
// (Mi Liquidación, Gastos) hasta que el admin los desactiva.
var comunicadosTabChecked = {};
async function asegurarSolapaComunicados(ssid) {
  if (comunicadosTabChecked[ssid]) return;
  const sheetsApi = await getSheets();
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId: ssid });
  const existe = (meta.data.sheets || []).some(function (s) {
    return s.properties && s.properties.title === 'Comunicados';
  });
  if (!existe) {
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId: ssid,
      requestBody: { requests: [{ addSheet: { properties: { title: 'Comunicados' } } }] }
    });
    await escribirSolapa(ssid, 'Comunicados', 'A1:C1', [['Fecha', 'Mensaje', 'Activo']]);
    console.log('[SHEETS] Solapa "Comunicados" creada.');
  }
  comunicadosTabChecked[ssid] = true;
}
async function leerComunicados(ssid) {
  try {
    await asegurarSolapaComunicados(ssid);
    var rows = await leerSolapa(ssid, 'Comunicados');
    if (rows.length < 2) return [];
    return rows.slice(1).filter(function (r) { return r[1]; }).map(function (r, i) {
      return { fila: i + 2, fecha: r[0] || '', mensaje: r[1] || '', activo: String(r[2] || '').trim().toUpperCase() !== 'NO' };
    });
  } catch (e) {
    console.log('[SHEETS] Error leyendo Comunicados:', e.message);
    return [];
  }
}
async function agregarComunicado(ssid, mensaje, fecha) {
  await asegurarSolapaComunicados(ssid);
  await agregarFilas(ssid, 'Comunicados', [[fecha, mensaje, 'SI']]);
}
async function desactivarComunicado(ssid, fila) {
  await escribirSolapa(ssid, 'Comunicados', 'C' + fila, [['NO']]);
}

// Lee la solapa "Deudores" (generada por Apps Script al calcular la
// liquidación): UF, Depto, Propietario, Deuda arrastrada, A abonar (1er
// vencimiento). Ordena de mayor a menor por deuda.
async function leerDeudores(ssid) {
  try {
    var solapas = await listarSolapas(ssid);
    var real = solapas.find(function (t) { return t.trim().toLowerCase() === 'deudores'; });
    if (!real) return [];
    var rows = await leerSolapa(ssid, real);
    if (rows.length < 3) return [];
    var datos = rows.slice(2).filter(function (r) { return r[0] && /^\d+$/.test(String(r[0]).trim()); }).map(function (r) {
      return {
        uf: String(r[0]).trim(), depto: r[1] || '', propietario: r[2] || '',
        deuda: Number(String(r[3] || '0').replace(/[^\d.,-]/g, '').replace(/\./g, '').replace(',', '.')) || 0,
        aAbonar: Number(String(r[4] || '0').replace(/[^\d.,-]/g, '').replace(/\./g, '').replace(',', '.')) || 0
      };
    });
    datos.sort(function (a, b) { return b.deuda - a.deuda; });
    return datos;
  } catch (e) {
    console.log('[SHEETS] Error leyendo Deudores:', e.message);
    return [];
  }
}

module.exports = {
  leerSolapa: leerSolapa, escribirSolapa: escribirSolapa, agregarFilas: agregarFilas,
  listarSolapas: listarSolapas,
  asegurarSolapaUsuarios: asegurarSolapaUsuarios,
  leerDatosInicio: leerDatosInicio, leerUFs: leerUFs, leerGastos: leerGastos,
  leerLiquidacionFinal: leerLiquidacionFinal, leerLiquidacionMensual: leerLiquidacionMensual,
  leerGastosExtraordinarios: leerGastosExtraordinarios,
  leerLiquidacionMasReciente: leerLiquidacionMasReciente,
  leerCashFlow: leerCashFlow, leerCashFlowExtraordinarias: leerCashFlowExtraordinarias,
  leerDeudaProveedores: leerDeudaProveedores,
  leerTotalGastos: leerTotalGastos,
  leerUsuarios: leerUsuarios, guardarUsuario: guardarUsuario,
  agregarUsuario: agregarUsuario, eliminarFilaUsuario: eliminarFilaUsuario,
  leerCache: leerCache, guardarCache: guardarCache,
  descargarArchivoDrive: descargarArchivoDrive,
  leerComunicados: leerComunicados, agregarComunicado: agregarComunicado,
  desactivarComunicado: desactivarComunicado, leerDeudores: leerDeudores
};
