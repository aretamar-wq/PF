'use strict';

const { MARCAS_PENDIENTE } = require('./marcas');

// Por moneda: neto en Loop, débitos pendientes (importedeb de los comprobantes
// con alguna marca de débito pendiente) y "Sin cubrir" = neto - pendientes. Tiene
// que tender a 0; negativo = pendientes de más.
function calcularTotales(lista, config) {
  const res = {};
  for (const c of lista) {
    const m = config.etiquetasMoneda[c.moncod] || c.moncod;
    res[m] = res[m] || { neto: 0, pendientes: 0, sinCubrir: 0, comprobantes: 0 };
    res[m].neto += c.neto;
    res[m].comprobantes++;
    if (MARCAS_PENDIENTE.includes(c.marca)) res[m].pendientes += c.pendiente.importedeb;
  }
  for (const t of Object.values(res)) t.sinCubrir = t.neto - t.pendientes;
  return res;
}

// Saldo de débitos pendientes por fecha del crédito, por moneda, con cantidad,
// importe y acumulado (del más viejo al más nuevo); separa el último día de los anteriores.
function calcularAntiguedad(lista, ultimoDia, config) {
  const grupos = new Map();
  for (const c of lista) {
    if (!MARCAS_PENDIENTE.includes(c.marca)) continue;
    const m = config.etiquetasMoneda[c.moncod] || c.moncod;
    const k = `${m}|${c.fechaCredito}`;
    const g = grupos.get(k) || { moneda: m, fecha: c.fechaCredito, cantidad: 0, importe: 0 };
    g.cantidad++;
    g.importe += c.pendiente.importedeb;
    grupos.set(k, g);
  }
  const filas = [...grupos.values()].sort((a, b) => a.moneda.localeCompare(b.moneda) || a.fecha.localeCompare(b.fecha));
  const acumulado = {};
  for (const f of filas) {
    acumulado[f.moneda] = (acumulado[f.moneda] || 0) + f.importe;
    f.acumulado = acumulado[f.moneda];
    f.tramo = f.fecha === ultimoDia ? 'Último día' : 'Días anteriores';
  }
  const tramos = {};
  for (const f of filas) {
    const k = `${f.tramo}|${f.moneda}`;
    tramos[k] = tramos[k] || { tramo: f.tramo, moneda: f.moneda, cantidad: 0, importe: 0 };
    tramos[k].cantidad += f.cantidad;
    tramos[k].importe += f.importe;
  }
  return { filas, tramos: Object.values(tramos) };
}

module.exports = { calcularTotales, calcularAntiguedad };
