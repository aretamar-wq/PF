'use strict';

// Débitos pendientes: foto del momento (cada archivo REEMPLAZA al anterior).
// Solo valen las filas sistcod 5 / movcod 25030 ("Debito por transferencia"): si
// vienen de otro tipo (por ejemplo 25003, venta de moneda extranjera) es un error
// de la consulta y se rechaza todo el archivo.

const { sha256, parseCsv, centavos, parseFechaHora } = require('../util');

const ENCABEZADO_PENDIENTES = [
  'fecreal', 'tercod', 'succod', 'sistcod', 'moncod', 'cuecod', 'movcod', 'descdet', 'fecproceso',
  'comnro', 'nromen', 'mentexto', 'importedeb', 'fecenlace', 'fecorigen',
];

function leerPendientes(archivo, config, avisos) {
  const hash = sha256(archivo.contenido);
  const info = { nombre: archivo.nombre, tipo: 'pendientes', hash, filas: 0, estado: 'usado' };
  const filas = parseCsv(archivo.contenido);
  const encabezado = (filas[0] || []).map((h) => h.trim());
  if (encabezado.join(',') !== ENCABEZADO_PENDIENTES.join(',')) {
    avisos.error(`${archivo.nombre}: encabezado de pendientes inesperado (${encabezado.join(',')}).`);
    return { pendientes: [], archivo: { ...info, estado: 'rechazado' } };
  }
  const regs = filas.slice(1).map((f) => Object.fromEntries(ENCABEZADO_PENDIENTES.map((h, i) => [h, (f[i] == null ? '' : f[i]).trim()])));

  const ajenos = regs.filter((r) => r.sistcod !== config.pendientes.sistcod || r.movcod !== config.pendientes.movcod);
  if (ajenos.length > 0) {
    const tipos = [...new Set(ajenos.map((r) => `sistcod ${r.sistcod} / movcod ${r.movcod}`))].join(', ');
    avisos.error(
      `${archivo.nombre}: ${ajenos.length} fila(s) que no son débitos por transferencia (sistcod ${config.pendientes.sistcod}, movcod ${config.pendientes.movcod}): ${tipos}. ` +
        'Es un error de la consulta; se rechaza el archivo.'
    );
    return { pendientes: [], archivo: { ...info, filas: regs.length, estado: 'rechazado' } };
  }

  const pendientes = [];
  let invalidas = 0;
  for (const r of regs) {
    const importedeb = centavos(r.importedeb);
    const origen = parseFechaHora(r.fecorigen);
    if (importedeb == null || !origen || !r.comnro) {
      invalidas++;
      continue;
    }
    const proceso = parseFechaHora(r.fecproceso);
    pendientes.push({
      moncod: r.moncod,
      comnro: r.comnro,
      cuecod: r.cuecod,
      importedeb,
      fechaOrigen: origen.fecha,
      fechaHoraOrigen: `${origen.fecha} ${origen.hora}`,
      fechaProceso: proceso ? proceso.fecha : '',
      motivo: r.mentexto || r.descdet,
    });
  }
  if (invalidas > 0) avisos.error(`${archivo.nombre}: ${invalidas} fila(s) de pendientes con valores inválidos.`);
  return { pendientes, archivo: { ...info, filas: pendientes.length } };
}

module.exports = { ENCABEZADO_PENDIENTES, leerPendientes };
