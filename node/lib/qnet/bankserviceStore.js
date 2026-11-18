'use strict';

// La Conciliación Loop lee BankService de la misma tabla que la "Conciliación
// Transferencias CA -> CC" (bankservice_movimientos, ver node/lib/transfCaCc y
// deploy/mariadb-schema.sql). La tabla no guarda nombres, CUIT ni CBU: para pasarle
// a la lectura de Loop el mismo CSV de siempre se arma un CBU técnico con la moneda
// (dígitos 9 y 10) y la cuenta (11 a 21), que es todo lo que esa lectura usa del CBU.

const { ENCABEZADO_BANKSERVICE } = require('./lectura/bankservice');
const transfConfig = require('../transfCaCc/config');

const db = { query: (...args) => require('../mariadbClient').query(...args) };

// Primer día del mes de fecha (aaaa-mm-dd) desplazado `meses`.
function inicioDeMes(fecha, meses) {
  const [y, m] = fecha.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + meses, 1)).toISOString().slice(0, 10);
}

// La conciliación de un día necesita el mes anterior, el del día y el siguiente.
async function leerVentana(rootDir, fecha) {
  return db.query(
    rootDir,
    `SELECT comprobante, moncod, cuecod, monto, estado, creada, ejecutada, error
     FROM bankservice_movimientos WHERE creada >= ? AND creada < ? ORDER BY creada, comprobante`,
    [inicioDeMes(fecha, -1), inicioDeMes(fecha, 2)]
  );
}

const csvCampo = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const monedaDe = (moncod) => Object.keys(transfConfig.monedas).find((k) => transfConfig.monedas[k] === String(moncod)) || '';
const cbuTecnico = (moneda, cuecod) => `3120001${'9'}${transfConfig.digitosCbuMoneda[moneda] || '00'}${String(cuecod).padStart(11, '0')}0`;

// Filas de la base -> archivos con el formato de BankService (uno por mes de "Creada").
function archivosDesdeFilas(filas) {
  const porMes = new Map();
  for (const r of filas) {
    const creada = String(r.creada || '');
    const nombre = `Movimientos_BankService-${creada.slice(5, 7)}${creada.slice(0, 4)}.csv`;
    if (!porMes.has(nombre)) porMes.set(nombre, [ENCABEZADO_BANKSERVICE.join(',')]);
    const moneda = monedaDe(r.moncod);
    porMes.get(nombre).push([
      r.comprobante, creada, r.ejecutada || '—', r.estado, '', '', cbuTecnico(moneda, r.cuecod), '', '', '', r.monto, moneda, '—', r.error || '—',
    ].map(csvCampo).join(','));
  }
  return [...porMes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([nombre, lineas]) => ({ nombre, contenido: lineas.join('\r\n') + '\r\n' }));
}

async function resumen(rootDir) {
  const [r] = await db.query(rootDir, 'SELECT COUNT(*) AS total, MIN(creada) AS desde, MAX(creada) AS hasta, MAX(cargado_en) AS ultimaCarga FROM bankservice_movimientos');
  return { total: Number(r.total) || 0, desde: r.desde || '', hasta: r.hasta || '', ultimaCarga: r.ultimaCarga || '' };
}

module.exports = { leerVentana, archivosDesdeFilas, resumen, inicioDeMes };
