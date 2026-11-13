'use strict';

// Histórico de corridas (qnet/corridas/<id>/): lista por fecha y evolución día a día.

const fs = require('fs');
const path = require('path');

const ID = /^[0-9a-f]{12}$/;

function leerJson(archivo) {
  try {
    return JSON.parse(fs.readFileSync(archivo, 'utf8'));
  } catch (err) {
    return null;
  }
}

// Una fila por corrida, la más nueva primero. Las que terminaron con error (sin
// resultado.json) salen igual, con la fecha y el código del log.
function listarCorridas(salidaDir) {
  let ids = [];
  try {
    ids = fs.readdirSync(salidaDir).filter((n) => ID.test(n));
  } catch (err) {
    return [];
  }
  return ids
    .map((id) => {
      const dir = path.join(salidaDir, id);
      let linea = '';
      try {
        linea = fs.readFileSync(path.join(dir, 'corrida.log'), 'utf8').split('\n')[0];
      } catch (err) {
        // Sin log.
      }
      const f = /fecha (\d{4}-\d{2}-\d{2})/.exec(linea);
      const c = /código de salida (\d)/.exec(linea);
      return {
        id,
        fecha: f ? f[1] : '',
        exitCode: c ? Number(c[1]) : null,
        generada: fs.statSync(dir).mtime.getTime(),
        conDashboard: fs.existsSync(path.join(dir, 'dashboard.html')),
      };
    })
    .sort((a, b) => b.fecha.localeCompare(a.fecha) || b.generada - a.generada);
}

// Resumen de una corrida para compararla con las demás.
function resumirCorrida(datos) {
  const porTipo = {};
  for (const e of datos.excepciones || []) porTipo[e.tipo] = (porTipo[e.tipo] || 0) + 1;
  const monedas = {};
  for (const [m, t] of Object.entries(datos.totales || {})) monedas[m] = { neto: t.neto, pendientes: t.pendientes, sinCubrir: t.sinCubrir, comprobantes: t.comprobantes };
  // Saldo pendiente total por moneda (el del día y el de días anteriores).
  const saldo = {};
  for (const t of (datos.antiguedad && datos.antiguedad.tramos) || []) {
    saldo[t.moneda] = saldo[t.moneda] || { cantidad: 0, importe: 0 };
    saldo[t.moneda].cantidad += t.cantidad;
    saldo[t.moneda].importe += t.importe;
  }
  return {
    id: datos.id,
    fecha: datos.fecha,
    exitCode: datos.exitCode,
    diaAbierto: !!datos.diaAbierto,
    comprobantes: datos.comprobantesTotal,
    conMarca: datos.comprobantesConMarca,
    excepciones: (datos.excepciones || []).length,
    porTipo,
    monedas,
    saldoPendiente: saldo,
    approvedSinRegistro: datos.cruce ? datos.cruce.approvedSinRegistro : 0,
  };
}

// Una corrida por fecha (la más nueva), de la más vieja a la más nueva.
function evolucion(salidaDir, limite = 120) {
  const porFecha = new Map();
  for (const c of listarCorridas(salidaDir)) {
    if (!c.fecha || porFecha.has(c.fecha)) continue; // listarCorridas viene ordenada: la primera de cada fecha es la más nueva
    const datos = leerJson(path.join(salidaDir, c.id, 'resultado.json'));
    if (datos) porFecha.set(c.fecha, resumirCorrida(datos));
  }
  return [...porFecha.values()].sort((a, b) => a.fecha.localeCompare(b.fecha)).slice(-limite);
}

module.exports = { ID, listarCorridas, resumirCorrida, evolucion };
