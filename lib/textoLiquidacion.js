function toNum(s) {
  if (s === null || s === undefined) return 0;
  var t = String(s).replace(/[^\d.,-]/g, '').trim();
  if (!t) return 0;
  if (t.indexOf(',') !== -1) t = t.replace(/\./g, '').replace(',', '.');
  var n = parseFloat(t);
  return isNaN(n) ? 0 : n;
}

function esNumerica(linea) {
  return /^\$?\s*[\d.,]+\s*$/.test(linea.trim()) && /\d/.test(linea);
}

function esUF(linea) {
  return /^\d{1,4}$/.test(linea.trim());
}

var RE_COCHERA = /^(\d{1,4})\s+(\d{1,4}\s*(?:desc|cub))\s*$/i;

var HEADERS_IGNORAR = ['uf','depto','propietario','%','expensas','adeudadas','pagos',
  'exp de mes','extraordina','ria','sum','multa','bicis','primer venc.','2do ven',
  'total','totalizado'];

function esLineaHeaderOTitulo(linea) {
  var l = linea.trim().toLowerCase();
  if (!l) return true;
  if (HEADERS_IGNORAR.indexOf(l) !== -1) return true;
  if (l.indexOf('consorcio') !== -1 || l.indexOf('liquidacion mes') !== -1 ||
      l.indexOf('cbu') !== -1) return true;
  return false;
}

function extraerMesLabel(texto) {
  var m = /LIQUIDACION\s+MES\s+([A-Za-zÁÉÍÓÚáéíóúñÑ]+)\s+VENCIMIENTO\s+[A-Za-z]+\s+(\d{4})/i.exec(texto);
  if (!m) return null;
  var mes = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return mes + ' ' + m[2];
}

function looksLikeRowStart(lineas, idx) {
  if (idx >= lineas.length) return false;
  if (RE_COCHERA.test(lineas[idx])) return true;
  if (!esUF(lineas[idx])) return false;
  if (idx + 1 >= lineas.length) return false;
  var l1 = lineas[idx + 1];

  if (RE_COCHERA.test(l1)) return false;

  if (/^\d{1,4}\s*(?:desc|cub)\s*$/i.test(l1)) {
    return idx + 2 < lineas.length && /^[A-Za-zÁÉÍÓÚáéíóúñÑ]/.test(lineas[idx + 2]);
  }

  if (/^\d+\s*(?:desc|cub)?\d*\s*[A-Za-zÁÉÍÓÚáéíóúñÑ]/i.test(l1)) return true;

  if (esUF(l1) && idx + 2 < lineas.length && /^[A-Za-zÁÉÍÓÚáéíóúñÑ]/.test(lineas[idx + 2])) {
    return true;
  }
  return false;
}

function parsearTextoLiquidacion(texto) {
  var mesLabel = extraerMesLabel(texto);
  var lineas = texto.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);

  var filas = [];
  var i = 0;

  while (i < lineas.length && !looksLikeRowStart(lineas, i)) i++;

  while (i < lineas.length) {
    var linea = lineas[i];

    if (esLineaHeaderOTitulo(linea)) { i++; continue; }
    if (/^total$/i.test(linea)) break;

    var uf, depto, propietario;

    var mCoch = RE_COCHERA.exec(linea);
    if (mCoch) {
      uf = mCoch[1];
      depto = mCoch[2].trim();
      i++;
      propietario = lineas[i] || '';
      i++;
    } else if (looksLikeRowStart(lineas, i)) {
      uf = linea;
      i++;
      var sigLinea = lineas[i];
      if (/^\d{1,4}\s*(?:desc|cub)\s*$/i.test(sigLinea)) {
        depto = sigLinea;
        i++;
        propietario = lineas[i] || '';
        i++;
      } else {
        var mMerge = /^(\d+\s*(?:desc|cub)?\d*)\s*([A-Za-zÁÉÍÓÚáéíóúñÑ].+)$/i.exec(sigLinea);
        if (mMerge) {
          depto = mMerge[1].trim();
          propietario = mMerge[2].trim();
          i++;
        } else {
          depto = sigLinea;
          i++;
          propietario = lineas[i] || '';
          i++;
        }
      }
    } else {
      i++;
      continue;
    }

    var coef = 0;
    if (i < lineas.length && /^\d{1,2}(?:[.,]\d{1,4})?$/.test(lineas[i])) {
      coef = toNum(lineas[i]);
      i++;
    }

    var numeros = [];
    while (i < lineas.length) {
      var l2 = lineas[i];
      if (/^total$/i.test(l2)) break;
      if (looksLikeRowStart(lineas, i)) break;
      if (esNumerica(l2)) { numeros.push(toNum(l2)); i++; }
      else { i++; }
    }

    if (numeros.length >= 3) {
      var venc2 = numeros[numeros.length - 1];
      var venc1 = numeros[numeros.length - 2];
      var mid = numeros.slice(0, numeros.length - 2);
      var adeu = 0, pagos = 0, expMes = 0, extra = 0, sum = 0;
      if (mid.length >= 1) adeu = mid[0];
      if (mid.length === 4) { pagos = mid[1]; expMes = mid[2]; extra = mid[3]; }
      else if (mid.length === 3) { expMes = mid[1]; extra = mid[2]; }
      else if (mid.length === 5) { pagos = mid[1]; expMes = mid[2]; extra = mid[3]; sum = mid[4]; }
      else if (mid.length >= 6) { pagos = mid[1]; expMes = mid[2]; extra = mid[3]; sum = mid.slice(4).reduce(function(a,b){return a+b;},0); }
      var deuda = Math.round((adeu - pagos) * 100) / 100;

      filas.push({
        uf: uf, depto: depto, propietario: propietario, coef: coef,
        expAdeudadas: adeu, pagos: pagos, deuda: deuda,
        expMes: expMes, extraordinaria: extra, sum: sum,
        destapacion: 0, bicis: 0, venc1: venc1, venc2: venc2
      });
    }
  }

  if (!filas.length) {
    return { ok: false, error: 'No se pudo interpretar ninguna fila.', textoCrudo: texto };
  }
  return { ok: true, filas: filas, mesLabel: mesLabel };
}

module.exports = { parsearTextoLiquidacion: parsearTextoLiquidacion };
