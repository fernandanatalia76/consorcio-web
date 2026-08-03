// ============================================================
// PARSER DE LIQUIDACIÓN DESDE WORD (.docx)
// FIX: en vez de depender de que mammoth reconozca TODO el documento
// como una sola tabla HTML (algunas partes del Word pueden no
// convertirse como tabla real si tienen un formato distinto, aunque se
// vean igual — eso hacía que solo se leyeran algunas filas), se usa el
// TEXTO PLANO completo (que sí trae todo el contenido, línea por línea,
// igual que cuando se copia y pega manualmente desde Word) y se procesa
// con el mismo parser de texto ya validado contra datos reales
// (lib/textoLiquidacion.js — 68/68 filas correctas, departamentos y
// cocheras).
// ============================================================

const mammoth = require('mammoth');
const textoLiquidacion = require('./textoLiquidacion');

async function parsearWordLiquidacion(buffer) {
  var resultTexto = await mammoth.extractRawText({ buffer: buffer });
  return textoLiquidacion.parsearTextoLiquidacion(resultTexto.value);
}

module.exports = { parsearWordLiquidacion: parsearWordLiquidacion };
