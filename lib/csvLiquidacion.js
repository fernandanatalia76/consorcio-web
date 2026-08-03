// ============================================================
// PARSER DE CSV DE LIQUIDACIÓN
// Lee el CSV descargado directo de Google Sheets (Archivo > Descargar >
// Valores separados por comas) de la solapa "Liquidacion <Mes> <Año>".
// A diferencia de un PDF, el CSV conserva las columnas separadas de
// verdad — no hay que adivinar nada.
//
// Estructura esperada (fila 1 = título, fila 2 = encabezados, fila 3+ =
// datos):
//   UF, Depto, Propietario, % Coef, Expensas Adeudadas, Pagos, Deuda,
//   Exp de Mes, Extraordinaria, Sum, Destapación, Bicis, 1er Venc, 2do Venc
// ============================================================

// Parsea una línea de CSV respetando comillas (por si algún campo trae
// una coma adentro, como "1.234,56" con separador decimal argentino
// entrecomillado por Sheets).
function parsearLineaCSV(linea) {
  var campos = [];
  var actual = '';
  var dentroComillas = false;
  for (var i = 0; i < linea.length; i++) {
    var c = linea[i];
    if (c === '"') {
      if (dentroComillas && linea[i + 1] === '"') { actual += '"'; i++; }
      else dentroComillas = !dentroComillas;
    } else if (c === ',' && !dentroComillas) {
      campos.push(actual);
      actual = '';
    } else {
      actual += c;
    }
  }
  campos.push(actual);
  return campos;
}

function toNum(s) {
  if (s === null || s === undefined) return 0;
  var t = String(s).replace(/[^\d.,-]/g, '').trim();
  if (!t) return 0;
  if (t.indexOf(',') !== -1) t = t.replace(/\./g, '').replace(',', '.');
  var n = parseFloat(t);
  return isNaN(n) ? 0 : n;
}

function extraerMesLabel(primeraLinea) {
  var m = /LIQUIDACI[ÓO]N\s+([A-ZÁÉÍÓÚ]+)\s+(\d{4})/i.exec(primeraLinea || '');
  if (!m) return null;
  var mes = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return mes + ' ' + m[2];
}

function parsearCSVLiquidacion(textoCSV) {
  // Normalizar saltos de línea (Windows vs Unix) y sacar líneas vacías del final
  var lineas = textoCSV.replace(/\r\n/g, '\n').split('\n');
  while (lineas.length && !lineas[lineas.length - 1].trim()) lineas.pop();

  if (lineas.length < 3) {
    return { ok: false, error: 'El archivo tiene muy pocas filas — ¿es el CSV correcto?', textoCrudo: textoCSV };
  }

  var mesLabel = extraerMesLabel(lineas[0]);

  var filas = [];
  for (var i = 2; i < lineas.length; i++) { // fila 1=título, fila 2=encabezado, fila 3+ = datos
    var campos = parsearLineaCSV(lineas[i]);
    if (!campos[0] || !String(campos[0]).trim()) continue; // fila vacía, saltear
    var uf = String(campos[0]).trim();
    if (!/^\d+$/.test(uf)) continue; // no es una fila de UF válida (ej. fila de TOTAL)

    filas.push({
      uf: uf,
      depto: String(campos[1] || '').trim(),
      propietario: String(campos[2] || '').trim(),
      coef: toNum(campos[3]),
      expAdeudadas: toNum(campos[4]),
      pagos: toNum(campos[5]),
      deuda: toNum(campos[6]),
      expMes: toNum(campos[7]),
      extraordinaria: toNum(campos[8]),
      sum: toNum(campos[9]),
      destapacion: toNum(campos[10]),
      bicis: toNum(campos[11]),
      venc1: toNum(campos[12]),
      venc2: toNum(campos[13])
    });
  }

  if (!filas.length) {
    return {
      ok: false,
      error: 'No se encontró ninguna fila de UF válida en el CSV. Revisá que sea el archivo correcto (exportado de la solapa "Liquidacion <Mes> <Año>").',
      textoCrudo: textoCSV
    };
  }

  return { ok: true, filas: filas, mesLabel: mesLabel };
}

module.exports = { parsearCSVLiquidacion: parsearCSVLiquidacion };
