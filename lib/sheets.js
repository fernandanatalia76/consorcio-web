const { google } = require('googleapis');

let sheetsClient = null;

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

async function leerDatosInicio() {
  const rows = await leerSolapa('Datos inicio');
  const d = {};
  rows.forEach(function(r) { if (r[0]) d[String(r[0]).trim()] = r[1] || ''; });
  return d;
}

async function leerUFs() {
  const rows = await leerSolapa('UF');
  if (rows.length < 4) return [];
  return rows.slice(3).filter(function(r) { return r[0]; }).map(function(r) {
    return { uf: String(r[0]||'').trim(), depto: r[1]||'', tipo: r[2]||'', propietario: r[3]||'', cuit: r[4]||'', coeficiente: r[6]||'', email: r[9]||'' };
  });
}

async function leerGastos(mesFilter) {
  const rows = await leerSolapa('Gastos');
  if (rows.length < 3) return [];
  return rows.slice(2).filter(function(r) {
    if (!r[0]) return false;
    if (mesFilter && String(r[0]).trim() !== mesFilter) return false;
    return true;
  }).map(function(r) {
    return { mes:r[0]||'', fecha:r[1]||'', proveedor:r[2]||'', cuit:r[3]||'', nroComprobante:r[4]||'', categoria:r[5]||'', importe:r[6]||'', formaPago:r[7]||'', fechaPago:r[8]||'', montoDebitado:r[9]||'', diferencia:r[10]||'', estado:r[11]||'' };
  });
}

async function leerLiquidacionFinal() {
  const rows = await leerSolapa('Liquidacion final');
  if (rows.length < 3) return [];
  return rows.slice(2).filter(function(r){return r[0];}).map(function(r) {
    return { uf:String(r[0]||'').trim(), depto:r[1]||'', tipo:r[2]||'', propietario:r[3]||'', expensasAdeudadas:r[4]||'', pagos:r[5]||'', expMes:r[6]||'', extraord:r[7]||'', adeudado:r[8]||'', total1:r[11]||'', total2:r[12]||'', fecha1:r[13]||'', fecha2:r[14]||'', estado:r[15]||'', fechaPago:r[16]||'', montoCobrado:r[17]||'', montoPendiente:r[19]||'' };
  });
}

async function leerLiquidacionMensual(mes, anio) {
  var meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  var nombre = 'Liquidacion ' + meses[mes-1] + ' ' + anio;
  try {
    var rows = await leerSolapa(nombre);
    if (rows.length < 3) return { nombre:nombre, datos:[] };
    return { nombre:nombre, datos: rows.slice(2).filter(function(r){return r[0];}).map(function(r) {
      return { uf:String(r[0]||'').trim(), depto:r[1]||'', propietario:r[2]||'', coef:r[3]||'', expAdeudadas:r[4]||'', pagos:r[5]||'', deuda:r[6]||'', expMes:r[7]||'', extraordinaria:r[8]||'', sum:r[9]||'', destapacion:r[10]||'', bicis:r[11]||'', venc1:r[12]||'', venc2:r[13]||'' };
    })};
  } catch(e) { return { nombre:nombre, datos:[], error:'Solapa no encontrada' }; }
}

async function leerCashFlow() {
  var rows = await leerSolapa('Cash Flow');
  if (rows.length < 3) return [];
  return rows.slice(2).filter(function(r){return r[0];}).map(function(r) {
    return { mes:r[0]||'', saldoInicial:r[1]||'', creditosCobrados:r[2]||'', debitosProveedores:r[3]||'', impComBanco:r[4]||'', saldoCalculado:r[5]||'', saldoFinal:r[6]||'', diferencia:r[7]||'', deudaProveedores:r[8]||'', facturas:r[9]||'' };
  });
}

// Usuarios en solapa "Usuarios" de la misma planilla
async function leerUsuarios() {
  try {
    var rows = await leerSolapa('Usuarios');
    if (rows.length < 2) return [];
    return rows.slice(1).filter(function(r){return r[0];}).map(function(r,i) {
      return { fila:i+2, uf:String(r[0]||'').trim(), cuit:r[1]||'', propietario:r[2]||'', email:r[3]||'', password:r[4]||'', rol:r[5]||'consorcista', activo:r[6]==='SI' };
    });
  } catch(e) { return []; }
}

async function guardarUsuario(fila, datos) {
  await escribirSolapa('Usuarios', 'A'+fila+':G'+fila, [[datos.uf, datos.cuit, datos.propietario, datos.email, datos.password, datos.rol, datos.activo?'SI':'NO']]);
}

async function agregarUsuario(datos) {
  await agregarFilas('Usuarios', [[datos.uf, datos.cuit, datos.propietario, datos.email, datos.password||'', datos.rol||'consorcista', datos.activo?'SI':'NO']]);
}

module.exports = { leerSolapa:leerSolapa, escribirSolapa:escribirSolapa, agregarFilas:agregarFilas, leerDatosInicio:leerDatosInicio, leerUFs:leerUFs, leerGastos:leerGastos, leerLiquidacionFinal:leerLiquidacionFinal, leerLiquidacionMensual:leerLiquidacionMensual, leerCashFlow:leerCashFlow, leerUsuarios:leerUsuarios, guardarUsuario:guardarUsuario, agregarUsuario:agregarUsuario, SPREADSHEET_ID:SPREADSHEET_ID };
