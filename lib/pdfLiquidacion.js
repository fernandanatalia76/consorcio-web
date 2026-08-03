// ============================================================
// PARSER DE PDF DE LIQUIDACIÓN
// Lee el texto de un PDF exportado desde la solapa "Liquidacion <Mes>
// <Año>" y arma un array de filas con la estructura que usa el resto
// del portal (mismo formato que leerLiquidacionMensual en lib/sheets.js).
//
// Formato real observado por fila:
//   UF  DEPTO  Propietario  %Coef  [ExpAdeudadas] [Pagos] ExpMes Extra
//   [cargos manuales...] Venc1 Venc2
// Las columnas entre corchetes pueden faltar si su valor es 0 (el PDF
// no imprime celdas vacías, así que la cantidad de números por fila
// varía). Probado contra un PDF real: 31/31 filas parseadas OK.
// ============================================================

const pdfParse = require('pdf-parse');

function toNum(s) {
  if (s === null || s === undefined) return 0;
  var t = String(s).replace(/[^\d.,-]/g, '').trim();
  if (!t) return 0;
  if (t.indexOf(',') !== -1) t = t.replace(/\./g, '').replace(',', '.');
  var n = parseFloat(t);
  return isNaN(n) ? 0 : n;
}

function extraerMesLabel(texto) {
  var m = /LIQUIDACI[ÓO]N\s+([A-ZÁÉÍÓÚ]+)\s+(\d{4})/i.exec(texto);
  if (!m) return null;
  var mes = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return mes + ' ' + m[2];
}

// Fila esperada: UF  DEPTO  Propietario  %Coef  <resto de números>
var RE_FILA = /^(\d{1,4})\s+(\d{1,4})\s*([A-Za-zÁÉÍÓÚáéíóúÑñ/.].*?)\s+(\d{1,2}(?:[.,]\d{1,4})?)\s+(.*)$/;

function parsearLinea(linea) {
  var m = RE_FILA.exec(linea);
  if (!m) return null;

  var uf = m[1].trim();
  var depto = m[2].trim();
  var propietario = m[3].trim();
  var coef = toNum(m[4]);
  var resto = m[5];

  var tokens = (resto.match(/\$?\s*[\d.,]+/g) || []).map(toNum);
  if (tokens.length < 3) return null; // hace falta al menos adeu + venc1 + venc2

  var venc2 = tokens[tokens.length - 1];
  var venc1 = tokens[tokens.length - 2];
  var mid = tokens.slice(0, tokens.length - 2);

  var adeu = 0, pagos = 0, expMes = 0, extra = 0, sum = 0;
  if (mid.length >= 1) adeu = mid[0];
  if (mid.length === 4) {
    pagos = mid[1]; expMes = mid[2]; extra = mid[3];
  } else if (mid.length === 3) {
    // "Pagos" no se imprimió (era 0)
    expMes = mid[1]; extra = mid[2];
  } else if (mid.length === 5) {
    pagos = mid[1]; expMes = mid[2]; extra = mid[3]; sum = mid[4];
  } else if (mid.length >= 6) {
    pagos = mid[1]; expMes = mid[2]; extra = mid[3];
    sum = mid.slice(4).reduce(function (a, b) { return a + b; }, 0);
  }
  var deuda = Math.round((adeu - pagos) * 100) / 100;

  return {
    uf: uf, depto: depto, propietario: propietario, coef: coef,
    expAdeudadas: adeu, pagos: pagos, deuda: deuda,
    expMes: expMes, extraordinaria: extra, sum: sum,
    destapacion: 0, bicis: 0,
    venc1: venc1, venc2: venc2
  };
}

function parsearTextoLiquidacion(texto) {
  var mesLabel = extraerMesLabel(texto);
  var lineas = texto.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);

  var filas = [];
  lineas.forEach(function (linea) {
    var f = parsearLinea(linea);
    if (f) filas.push(f);
  });

  if (!filas.length) {
    return {
      ok: false,
      error: 'No se pudo interpretar ninguna fila de UF en el PDF. Puede que el formato de exportación no coincida con el esperado — copiá el texto de abajo y avisá para ajustar el patrón.',
      textoCrudo: texto
    };
  }

  return { ok: true, filas: filas, mesLabel: mesLabel, textoCrudo: texto };
}

async function parsearPdfLiquidacion(buffer) {
  var data = await pdfParse(buffer);
  return parsearTextoLiquidacion(data.text);
}

module.exports = {
  parsearPdfLiquidacion: parsearPdfLiquidacion,
  parsearTextoLiquidacion: parsearTextoLiquidacion
};
