// ============================================================
// PARSER DE PDF DE LIQUIDACIÓN
// Lee el texto de un PDF exportado desde la solapa "Liquidacion <Mes>
// <Año>" (columnas: UF, Depto, Propietario, % Coef, Expensas Adeudadas,
// Pagos, Deuda, Exp de Mes, Extraordinaria, Sum, Destapación, Bicis,
// 1er Venc, 2do Venc) y arma un array de filas con la misma estructura
// que usa el resto del portal (leerLiquidacionMensual en lib/sheets.js).
//
// NOTA: la extracción de texto de un PDF no siempre preserva las
// columnas perfectamente alineadas. Este parser hace lo mejor posible
// con expresiones regulares; si algo no matchea bien con tu PDF real,
// avisá para ajustar el patrón exacto.
// ============================================================

const pdfParse = require('pdf-parse');

// Convierte "1.234,56" / "1234.56" / "" a número.
function toNum(s) {
  if (s === null || s === undefined) return 0;
  var t = String(s).replace(/[^\d.,-]/g, '').trim();
  if (!t) return 0;
  if (t.indexOf(',') !== -1) t = t.replace(/\./g, '').replace(',', '.');
  var n = parseFloat(t);
  return isNaN(n) ? 0 : n;
}

// Intenta extraer el mes/año del título ("LIQUIDACIÓN JULIO 2026 — ...").
function extraerMesLabel(texto) {
  var m = /LIQUIDACI[ÓO]N\s+([A-ZÁÉÍÓÚ]+)\s+(\d{4})/i.exec(texto);
  if (!m) return null;
  var mes = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return mes + ' ' + m[2];
}

// Parsea el texto completo del PDF y devuelve { ok, filas, mesLabel, error, textoCrudo }
function parsearTextoLiquidacion(texto) {
  var mesLabel = extraerMesLabel(texto);
  var lineas = texto.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);

  var filas = [];
  // Patrón esperado por línea (best-effort): un número de UF al principio,
  // seguido de texto (depto + propietario) y luego una serie de montos
  // separados por espacios, terminando en los 2 vencimientos.
  // Ej: "12   3°B   Fernanda Huguet   8,33%   45.000,00   45.000,00   0,00   ..."
  var reFila = /^(\d{1,3})\s+(.+?)\s+(\d{1,3}[.,]\d{2,4}\s?%)\s+(.+)$/;

  lineas.forEach(function (linea) {
    var m = reFila.exec(linea);
    if (!m) return;
    var uf = m[1].trim();
    var depto = m[2].trim();
    var coef = m[3].trim();
    var resto = m[4].trim();
    // El resto son montos separados por espacios (2+ espacios o tabs);
    // como el propietario puede tener espacios, buscamos los últimos
    // 9 tokens numéricos (adeu, pagos, deuda, expMes, extra, sum,
    // destap, bicis, venc1, venc2 = 10, pero el propietario puede
    // "comerse" el primero si no hay separador claro).
    var tokens = resto.split(/\s{2,}|\t/).map(function (t) { return t.trim(); }).filter(Boolean);
    // Si no separó bien por espacios dobles, probamos por espacio simple
    // tomando solo los que parecen montos (contienen coma o punto).
    if (tokens.length < 9) {
      tokens = resto.split(/\s+/).filter(function (t) { return /\d/.test(t); });
    }
    if (tokens.length < 9) return; // no se pudo parsear esta línea, se descarta

    var nums = tokens.slice(-9).map(toNum);
    var propietario = resto.replace(tokens.join(' '), '').trim() || depto;

    filas.push({
      uf: uf,
      depto: depto,
      propietario: propietario,
      coef: coef,
      expAdeudadas: nums[0],
      pagos: nums[1],
      deuda: nums[2],
      expMes: nums[3],
      extraordinaria: nums[4],
      sum: nums[5],
      destapacion: nums[6],
      bicis: nums[7],
      venc1: nums[8],
      venc2: nums[8] // si el PDF solo trae 9 montos legibles, el 2do venc puede faltar
    });
  });

  if (!filas.length) {
    return {
      ok: false,
      error: 'No se pudo interpretar ninguna fila de UF en el PDF. Puede que el formato de exportación no coincida con el esperado.',
      textoCrudo: texto
    };
  }

  return { ok: true, filas: filas, mesLabel: mesLabel, textoCrudo: texto };
}

async function parsearPdfLiquidacion(buffer) {
  var data = await pdfParse(buffer);
  return parsearTextoLiquidacion(data.text);
}

module.exports = { parsearPdfLiquidacion: parsearPdfLiquidacion, parsearTextoLiquidacion: parsearTextoLiquidacion };
