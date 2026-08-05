// ============================================================
// DIRECTORIO DE CONSORCIOS
// Lee la planilla maestra "Directorio Consorcios" (separada, un
// spreadsheet propio, ID en la variable de entorno
// GOOGLE_DIRECTORIO_SHEET_ID) para saber qué consorcios existen y a
// qué planilla (spreadsheetId) corresponde cada uno.
//
// Estructura esperada (PRIMERA solapa de esa planilla, fila 1 =
// encabezado): A: Nombre | B: SpreadsheetID | C: Activo
// ============================================================

const sheets = require('./sheets');

const DIRECTORIO_ID = process.env.GOOGLE_DIRECTORIO_SHEET_ID;

async function listarConsorcios() {
  if (!DIRECTORIO_ID) {
    console.log('[DIRECTORIO] Falta la variable de entorno GOOGLE_DIRECTORIO_SHEET_ID.');
    return [];
  }
  try {
    var solapas = await sheets.listarSolapas(DIRECTORIO_ID);
    if (!solapas.length) {
      console.log('[DIRECTORIO] La planilla del directorio no tiene ninguna solapa.');
      return [];
    }
    var nombreSolapa = solapas[0]; // usamos la primera solapa que exista
    var rows = await sheets.leerSolapa(DIRECTORIO_ID, nombreSolapa, 'A1:C1000');
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

async function buscarPorSpreadsheetId(ssid) {
  var lista = await listarConsorcios();
  return lista.find(function (c) { return c.spreadsheetId === ssid; }) || null;
}

module.exports = { listarConsorcios: listarConsorcios, buscarPorSpreadsheetId: buscarPorSpreadsheetId };
