const { google } = require('googleapis');

let sheetsClient = null;
let driveClient = null;

function getCredentials() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/drive.readonly'
    ]
  });
}

async function getSheets() {
  if (!sheetsClient) {
    const auth = getCredentials();
    sheetsClient = google.sheets({ version: 'v4', auth });
  }
  return sheetsClient;
}

async function getDrive() {
  if (!driveClient) {
    const auth = getCredentials();
    driveClient = google.drive({ version: 'v3', auth });
  }
  return driveClient;
}

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID;

// Lee una solapa completa y devuelve un array de objetos {col1: val, col2: val, ...}
async function leerSolapa(nombre, rango) {
  const sheets = await getSheets();
  const range = rango ? `'${nombre}'!${rango}` : `'${nombre}'`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: range
  });
  return res.data.values || [];
}

// Lee Datos inicio como un mapa clave->valor
async function leerDatosInicio() {
  const rows = await leerSolapa('Datos inicio');
  const d = {};
  rows.forEach(r => { if (r[0]) d[String(r[0]).trim()] = r[1] || ''; });
  return d;
}

// Lee la solapa UF y devuelve un array de objetos
async function leerUFs() {
  const rows = await leerSolapa('UF');
  if (rows.length < 4) return []; // fila 3 = headers, datos desde fila 4
  const data = rows.slice(3); // saltear las 3 primeras filas
  return data.filter(r => r[0]).map(r => ({
    uf: String(r[0] || '').trim(),
    depto: r[1] || '',
    tipo: r[2] || '',
    propietario: r[3] || '',
    cuit: r[4] || '',
    coeficiente: r[6] || '',
    email: r[9] || '',    // columna J
    envioMail: r[10] || '' // columna K
  }));
}

// Lee la solapa Gastos y devuelve un array de objetos
async function leerGastos(mesFilter) {
  const rows = await leerSolapa('Gastos');
  if (rows.length < 3) return [];
  const data = rows.slice(2); // datos desde fila 3
  return data.filter(r => {
    if (!r[0]) return false;
    if (mesFilter && String(r[0]).trim() !== mesFilter) return false;
    return true;
  }).map(r => ({
    mes: r[0] || '',
    fecha: r[1] || '',
    proveedor: r[2] || '',
    cuit: r[3] || '',
    nroComprobante: r[4] || '',
    categoria: r[5] || '',
    importe: r[6] || '',
    formaPago: r[7] || '',
    fechaPago: r[8] || '',
    montoDebitado: r[9] || '',
    diferencia: r[10] || '',
    estado: r[11] || '',
    archivoFactura: r[14] || '',
    archivoImputado: r[15] || ''
  }));
}

// Lee Liquidacion final
async function leerLiquidacionFinal() {
  const rows = await leerSolapa('Liquidacion final');
  if (rows.length < 3) return [];
  const data = rows.slice(2);
  return data.filter(r => r[0]).map(r => ({
    uf: String(r[0] || '').trim(),
    depto: r[1] || '',
    tipo: r[2] || '',
    propietario: r[3] || '',
    cuit: r[4] || '',
    expensasAdeudadas: r[4] || '', // columna E
    pagos: r[5] || '',             // columna F
    coeficiente: r[5] || '',
    expMes: r[6] || '',
    extraord: r[7] || '',
    adeudado: r[8] || '',
    sum: r[9] || '',
    bicis: r[10] || '',
    total1: r[11] || '',
    total2: r[12] || '',
    fecha1: r[13] || '',
    fecha2: r[14] || '',
    estado: r[15] || '',
    fechaPago: r[16] || '',
    montoCobrado: r[17] || '',
    tipoPago: r[18] || '',
    montoPendiente: r[19] || ''
  }));
}

// Lee la solapa de liquidación mensual (Liquidacion [Mes] [Año])
async function leerLiquidacionMensual(mes, anio) {
  const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                 'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const nombre = 'Liquidacion ' + meses[mes-1] + ' ' + anio;
  try {
    const rows = await leerSolapa(nombre);
    if (rows.length < 3) return { nombre, datos: [] };
    const data = rows.slice(2);
    return {
      nombre,
      datos: data.filter(r => r[0]).map(r => ({
        uf: String(r[0] || '').trim(),
        depto: r[1] || '',
        propietario: r[2] || '',
        coef: r[3] || '',
        expAdeudadas: r[4] || '',
        pagos: r[5] || '',
        deuda: r[6] || '',
        expMes: r[7] || '',
        extraordinaria: r[8] || '',
        sum: r[9] || '',
        destapacion: r[10] || '',
        bicis: r[11] || '',
        venc1: r[12] || '',
        venc2: r[13] || ''
      }))
    };
  } catch(e) {
    return { nombre, datos: [], error: 'Solapa no encontrada' };
  }
}

// Lee Cash Flow
async function leerCashFlow() {
  const rows = await leerSolapa('Cash Flow');
  if (rows.length < 3) return [];
  const data = rows.slice(2);
  return data.filter(r => r[0]).map(r => ({
    mes: r[0] || '',
    saldoInicial: r[1] || '',
    creditosCobrados: r[2] || '',
    debitosProveedores: r[3] || '',
    impComBanco: r[4] || '',
    saldoCalculado: r[5] || '',
    saldoFinal: r[6] || '',
    diferencia: r[7] || '',
    deudaProveedores: r[8] || '',
    facturas: r[9] || ''
  }));
}

module.exports = {
  leerSolapa, leerDatosInicio, leerUFs, leerGastos,
  leerLiquidacionFinal, leerLiquidacionMensual, leerCashFlow, getDrive,
  SPREADSHEET_ID
};
