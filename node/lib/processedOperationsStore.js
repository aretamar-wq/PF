'use strict';

// Registro de operaciones (cuit + numeroComprobante) que ya se ejecutaron con
// éxito, para poder bloquear una fila que intente repetir la misma operación
// antes de llamar a ningún endpoint del banco. En MariaDB (tabla
// "operaciones_procesadas") — reemplaza logs/processed-operations.json (ver
// deploy/mariadb-schema.sql y "Base de datos (MariaDB)" en el README).
//
// A diferencia del archivo JSON (que se leía entero para buscar duplicados),
// findDuplicateOperations arma una sola consulta con el índice único
// (cuit, numero_comprobante) en vez de traer toda la tabla — más elemento
// pensado a futuro también para cuando la tabla crezca mucho.

const { formatLocal, formatDateOnlyDMY } = require('./dateUtil');
const db = require('./mariadbClient');

function mapOperationRow(row) {
  return {
    cuit: row.cuit,
    numeroComprobante: row.numero_comprobante,
    idMensaje: row.id_mensaje,
    cajaAhorro: row.caja_ahorro,
    importeNeto: row.importe_neto,
    fechaVencimiento: row.fecha_vencimiento,
    tipoCircuito: row.tipo_circuito,
    pfPagado: !!row.pf_pagado,
    apellidoNombre: row.apellido_nombre,
    processedAt: row.processed_at,
    processedBy: row.processed_by,
  };
}

async function findDuplicateOperations(rootDir, operations) {
  if (!operations || operations.length === 0) return [];

  // Un solo WHERE con pares (cuit, numero_comprobante) — igual que antes se
  // armaba un Map en memoria con todo el archivo, pero delegando la
  // búsqueda a la base en vez de traer todas las filas.
  const conditions = operations.map(() => '(cuit = ? AND numero_comprobante = ?)').join(' OR ');
  const params = [];
  for (const op of operations) {
    params.push(String(op.cuit), String(op.numeroComprobante));
  }

  const rows = await db.query(
    rootDir,
    `SELECT cuit, numero_comprobante, id_mensaje, processed_at, processed_by
     FROM operaciones_procesadas
     WHERE ${conditions}`,
    params
  );

  return rows.map((row) => ({
    cuit: row.cuit,
    numeroComprobante: row.numero_comprobante,
    processedAt: row.processed_at,
    processedBy: row.processed_by,
  }));
}

async function addProcessedOperations(rootDir, operations, username) {
  if (!operations || operations.length === 0) return;

  const now = formatLocal();
  const pool = db.getPool(rootDir);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const op of operations) {
      // ON DUPLICATE KEY UPDATE como no-op (id = id): la UNIQUE KEY
      // (cuit, numero_comprobante) evita una fila duplicada si esta misma
      // operación ya se había registrado antes (ej. una carrera entre dos
      // corridas), sin tirar un error de constraint — mismo espíritu que
      // antes, donde simplemente se agregaba al array sin chequear si ya
      // estaba (la deduplicación real la hacía findDuplicateOperations
      // ANTES de llegar acá, bloqueando la fila).
      await connection.query(
        `INSERT INTO operaciones_procesadas (
           cuit, numero_comprobante, id_mensaje,
           caja_ahorro, importe_neto, fecha_vencimiento, tipo_circuito, pf_pagado,
           apellido_nombre, processed_at, processed_by
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id`,
        [
          String(op.cuit),
          String(op.numeroComprobante),
          String(op.idMensaje),
          String(op.cajaAhorro || ''),
          String(op.importeNeto || ''),
          String(op.fechaVencimiento || ''),
          String(op.tipoCircuito || ''),
          op.pfPagado ? 1 : 0,
          String(op.apellidoNombre || ''),
          now,
          username,
        ]
      );
    }
    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

async function getProcessedOperations(rootDir) {
  const rows = await db.query(rootDir, 'SELECT * FROM operaciones_procesadas ORDER BY id');
  return rows.map(mapOperationRow);
}

// Plazos fijos a pagar hoy (flow "Pago de Plazo Fijos"): vencimiento = hoy,
// tipo_circuito = '0' (flujo completo — un circuito = '1', solo alta, no
// tiene sentido pagarlo por acá) y todavía no pagados. fecha_vencimiento es
// texto libre tal como lo devuelve el banco (dd/MM/yyyy, ver
// formatDateOnlyDMY en dateUtil.js) — se compara por igualdad exacta de
// string, no como fecha.
async function findOperationsToPay(rootDir, today = formatDateOnlyDMY()) {
  const rows = await db.query(
    rootDir,
    `SELECT * FROM operaciones_procesadas
     WHERE fecha_vencimiento = ? AND tipo_circuito = '0' AND pf_pagado = 0
     ORDER BY id`,
    [today]
  );
  return rows.map(mapOperationRow);
}

// Marca pf_pagado = 1 para cada (cuit, numero_comprobante) de la lista —
// llamado por el flow "Pago de Plazo Fijos" solo para las operaciones cuyo
// débito en Caja de Ahorro Y crédito en Cuenta Corriente salieron bien
// (ver runPagoPlazoFijos en wwwroot/app.js). Mismo patrón transaccional que
// addProcessedOperations: si una fila falla, se revierten todas — no tiene
// sentido dejar la lista de pagos a medio marcar.
async function markOperationsPaid(rootDir, operations) {
  if (!operations || operations.length === 0) return;

  const pool = db.getPool(rootDir);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const op of operations) {
      await connection.query(
        `UPDATE operaciones_procesadas SET pf_pagado = 1 WHERE cuit = ? AND numero_comprobante = ?`,
        [String(op.cuit), String(op.numeroComprobante)]
      );
    }
    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = {
  getProcessedOperations,
  findDuplicateOperations,
  addProcessedOperations,
  findOperationsToPay,
  markOperationsPaid,
};
