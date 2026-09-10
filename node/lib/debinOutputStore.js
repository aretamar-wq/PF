'use strict';

// Registro en MariaDB del contenido de dbnout-...csv y dbnconsulta-...csv
// (ver "Archivos de salida (files/)" en el README) con quién ejecutó la
// carga y cuándo — además del .csv que ya se guarda en files/ (ver
// handleSaveOutput en server.js), no en reemplazo. Tablas "dbn_out" y
// "dbn_consulta" (ver deploy/mariadb-schema.sql), puramente de
// registro/auditoría: no se leen para deduplicar (eso lo sigue haciendo
// processedOperationsStore).

const { formatLocal } = require('./dateUtil');
const db = require('./mariadbClient');

// Mismo parser que parseCsvLine/parseCsvText en wwwroot/app.js — el
// contenido que llega acá ya viene armado por saveOutputFiles con
// csvEscape, así que hay que interpretarlo con las mismas reglas (comillas
// dobles para escapar una comilla, campos entre comillas para valores con
// coma/salto de línea).
function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

function parseCsvText(text) {
  return text
    .split(/\r\n|\r|\n/)
    .filter((line) => line.length > 0)
    .map(parseCsvLine);
}

function rowsToRecords(csvContent) {
  const lines = parseCsvText(csvContent);
  if (lines.length <= 1) return [];
  const header = lines[0];
  return lines.slice(1).map((row) => {
    const record = {};
    header.forEach((col, idx) => {
      record[col] = row[idx] !== undefined ? row[idx] : '';
    });
    return record;
  });
}

async function addDbnOutRows(rootDir, csvContent, username) {
  const records = rowsToRecords(csvContent);
  if (records.length === 0) return;

  const now = formatLocal();
  const pool = db.getPool(rootDir);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const record of records) {
      await connection.query(
        `INSERT INTO dbn_out (
           credito_cuit, credito_cbu, credito_titular,
           debito_cuit, debito_cbu, debito_titular,
           id_comprobante, moneda, importe,
           codigo_respuesta, descripcion_respuesta, id_respuesta, id_mensaje, realizado,
           ejecutado_por, ejecutado_en
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.creditoCuit || '',
          record.creditoCbu || '',
          record.creditoTitular || '',
          record.debitoCuit || '',
          record.debitoCbu || '',
          record.debitoTitular || '',
          record.idComprobante || '',
          record.moneda || '',
          record.importe || '',
          record.codigoRespuesta || '',
          record.descripcionRespuesta || '',
          record.idRespuesta || '',
          record.idMensaje || '',
          record.realizado || '',
          username,
          now,
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

async function addDbnConsultaRows(rootDir, csvContent, username) {
  const records = rowsToRecords(csvContent);
  if (records.length === 0) return;

  const now = formatLocal();
  const pool = db.getPool(rootDir);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const record of records) {
      const { idMensaje, idComprobante, idOperacion, errorConsulta, ...rest } = record;
      await connection.query(
        `INSERT INTO dbn_consulta (
           id_mensaje, id_comprobante, id_operacion, error_consulta, respuesta_json,
           ejecutado_por, ejecutado_en
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [idMensaje || '', idComprobante || '', idOperacion || '', errorConsulta || '', JSON.stringify(rest), username, now]
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

module.exports = { addDbnOutRows, addDbnConsultaRows };
