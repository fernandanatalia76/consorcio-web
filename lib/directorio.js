// ============================================================
// DIRECTORIO DE CONSORCIOS
// Lee la planilla maestra "Directorio Consorcios" (separada, un
// spreadsheet propio, ID en la variable de entorno
// GOOGLE_DIRECTORIO_SHEET_ID) para saber qué consorcios existen y a
// qué planilla (spreadsheetId) corresponde cada uno.
//
// Estructura esperada (solapa principal, fila 1 = encabezado):
//   A: Nombre | B: SpreadsheetID | C: Activo
// ============================================================

const sheets = require('./sheets');

const DIRECTORIO_ID = process.env.GOOGLE_DIRECTORIO_SHEET_ID;

async function listarConsorcios() {
  if (!DIRECTORIO_ID) {
    console.log('[DIRECTORIO] Falta la variable de entorno GOOGLE_DIRECTORIO_SHEET_ID.');
    return [];
  }
  try {
    var rows = await sheets.leerSolapa(DIRECTORIO_ID, 'A1:C1000');
    if (rows.length < 2) return [];
    return rows.slice(1)
      .filter(function (r) { return r[0] && r[1]; })
      .filter(function (r) { return String(r[2] || '').trim().toUpperCase() !== 'NO'; })
      .map(function (r) {
        return { nombre: String(r[0]).trim(), spreadsheetId: String(r[1]).trim() };
      });
  } catch (e) {
    console.log('[DIRECTORIO] Error leyendo el directorio de consorcios:', e.message);
    return [];
  }
}

// Busca un consorcio por su spreadsheetId (para validar que el ID que
// llega en un formulario/sesión realmente esté en el directorio, y no
// sea algo inventado).
async function buscarPorSpreadsheetId(ssid) {
  var lista = await listarConsorcios();
  return lista.find(function (c) { return c.spreadsheetId === ssid; }) || null;
}

module.exports = { listarConsorcios: listarConsorcios, buscarPorSpreadsheetId: buscarPorSpreadsheetId };
