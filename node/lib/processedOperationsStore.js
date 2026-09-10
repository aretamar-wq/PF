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

const { formatLocal } = require('./dateUtil');
const db = require('./mariadbClient');

function mapOperationRow(row) {
  return {
    cuit: row.cuit,
    numeroComprobante: row.numero_comprobante,
    idMensaje: row.id_mensaje,
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
        `INSERT INTO operaciones_procesadas (cuit, numero_comprobante, id_mensaje, processed_at, processed_by)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id`,
        [String(op.cuit), String(op.numeroComprobante), String(op.idMensaje), now, username]
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

module.exports = { getProcessedOperations, findDuplicateOperations, addProcessedOperations };
