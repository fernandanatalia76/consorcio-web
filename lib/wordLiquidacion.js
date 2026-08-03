// ============================================================
// PARSER DE LIQUIDACIÓN DESDE WORD (.docx)
// A diferencia de un PDF (que pierde toda la estructura de columnas al
// extraer el texto), un .docx conserva la tabla real — cada celda queda
// separada sin ambigüedad. Usamos "mammoth" para convertir el .docx a
// HTML (conservando las tablas) y "cheerio" para leer esa tabla celda
// por celda.
//
// Columnas esperadas (en este orden, por posición — no por nombre de
// encabezado, para no depender de que el título de cada columna sea
// idéntico letra por letra):
//   0=UF, 1=Depto, 2=Propietario, 3=%Coef, 4=Expensas Adeudadas,
//   5=Pagos, 6=Exp de Mes, 7=Extraordinaria, 8=Sum, 9=Multa, 10=Bicis,
//   11=1er Venc, 12=2do Venc
// ============================================================

const mammoth = require('mammoth');
const cheerio = require('cheerio');

function toNum(s) {
  if (s === null || s === undefined) return 0;
  var t = String(s).replace(/[^\d.,-]/g, '').trim();
  if (!t) return 0;
  if (t.indexOf(',') !== -1) t = t.replace(/\./g, '').replace(',', '.');
  var n = parseFloat(t);
  return isNaN(n) ? 0 : n;
}

function extraerMesLabel(textoPlano) {
  var m = /LIQUIDACION\s+MES\s+([A-Za-zÁÉÍÓÚáéíóúñÑ]+)\s+VENCIMIENTO\s+[A-Za-z]+\s+(\d{4})/i.exec(textoPlano || '');
  if (!m) return null;
  var mes = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return mes + ' ' + m[2];
}

async function parsearWordLiquidacion(buffer) {
  var resultHtml = await mammoth.convertToHtml({ buffer: buffer });
  var resultTexto = await mammoth.extractRawText({ buffer: buffer });
  var mesLabel = extraerMesLabel(resultTexto.value);

  var $ = cheerio.load(resultHtml.value);
  var tablas = $('table');
  if (!tablas.length) {
    return { ok: false, error: 'No se encontró ninguna tabla en el documento Word.', textoCrudo: resultTexto.value };
  }

  // Usamos la tabla más grande (más filas) — la de la liquidación.
  var mejorTabla = null, mejorFilas = 0;
  tablas.each(function (i, tabla) {
    var nFilas = $(tabla).find('tr').length;
    if (nFilas > mejorFilas) { mejorFilas = nFilas; mejorTabla = tabla; }
  });

  var filasRaw = [];
  $(mejorTabla).find('tr').each(function (i, tr) {
    var celdas = [];
    $(tr).find('td, th').each(function (j, td) {
      celdas.push($(td).text().trim());
    });
    if (celdas.length) filasRaw.push(celdas);
  });

  var filas = [];
  filasRaw.forEach(function (c) {
    if (!c[0] || !/^\d+$/.test(String(c[0]).trim())) return; // no es una fila de UF (encabezado, TOTAL, etc.)
    var adeu = toNum(c[4]);
    var pagos = toNum(c[5]);
    filas.push({
      uf: String(c[0]).trim(),
      depto: String(c[1] || '').trim(),
      propietario: String(c[2] || '').trim(),
      coef: toNum(c[3]),
      expAdeudadas: adeu,
      pagos: pagos,
      deuda: Math.round((adeu - pagos) * 100) / 100,
      expMes: toNum(c[6]),
      extraordinaria: toNum(c[7]),
      sum: toNum(c[8]),
      destapacion: toNum(c[9]),
      bicis: toNum(c[10]),
      venc1: toNum(c[11]),
      venc2: toNum(c[12])
    });
  });

  if (!filas.length) {
    return { ok: false, error: 'No se encontró ninguna fila de UF válida en la tabla del Word.', textoCrudo: resultTexto.value };
  }

  return { ok: true, filas: filas, mesLabel: mesLabel };
}

module.exports = { parsearWordLiquidacion: parsearWordLiquidacion };
