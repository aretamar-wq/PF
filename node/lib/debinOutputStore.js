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
      const {
        idMensaje, idComprobante, idOperacion, errorConsulta,
        creditoCuit, creditoCbu, creditoTitular,
        debitoCuit, debitoCbu, debitoTitular,
        moneda, importe,
        // Resultado de la transferencia ORIGINAL (no el de la consulta de
        // estado, que sigue viniendo en DEBIN_CONSULTA_COLUMNS y cae en
        // "rest" más abajo) — nombres distintos (sufijo "Transferencia")
        // a propósito, para no colisionar con los codigoRespuesta/
        // descripcionRespuesta de la consulta (ver DEBIN_CONSULTA_COLUMNS
        // en wwwroot/app.js).
        codigoRespuestaTransferencia, descripcionRespuestaTransferencia, realizado,
        ...rest
      } = record;
      await connection.query(
        `INSERT INTO dbn_consulta (
           id_mensaje, id_comprobante, id_operacion,
           credito_cuit, credito_cbu, credito_titular,
           debito_cuit, debito_cbu, debito_titular,
           moneda, importe,
           codigo_respuesta, descripcion_respuesta, realizado,
           error_consulta, respuesta_json,
           ejecutado_por, ejecutado_en
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          idMensaje || '',
          idComprobante || '',
          idOperacion || '',
          creditoCuit || '',
          creditoCbu || '',
          creditoTitular || '',
          debitoCuit || '',
          debitoCbu || '',
          debitoTitular || '',
          moneda || '',
          importe || '',
          codigoRespuestaTransferencia || '',
          descripcionRespuestaTransferencia || '',
          realizado || '',
          errorConsulta || '',
          JSON.stringify(rest),
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

// Clave del Map que devuelve getTransferidoHoyPorCuit: un acumulado
// independiente por CUIT Y por moneda (lo transferido en ARS no afecta el
// límite de USD, ni viceversa — ver Parametría, debin.limiteDiarioArs/Usd).
// Mayúsculas a propósito: la columna "moneda" de dbn_consulta es texto
// libre tal como vino en el CSV, así que "ars"/"ARS"/"Ars" tienen que
// pisar el mismo acumulado.
function transferidoHoyKey(cuit, moneda) {
  return `${cuit}|${String(moneda || '').trim().toUpperCase()}`;
}

// Para el límite diario de transferencias por CUIT origen y moneda
// (Parametría, debin.limiteDiarioArs/Usd, ver
// handleTransferenciasLimiteGet en server.js): suma, para cada
// (debito_cuit, moneda) pedido, el importe de las transferencias YA
// CONFIRMADAS (realizado = 's') de HOY (fecha local del servidor vía
// CURDATE(), no la fecha de proceso bancaria — a diferencia de "Pago de
// Plazo Fijos", acá no hay ningún requisito de que coincida con el cierre
// de Sybase) en dbn_consulta — mismo criterio de "verdad" que ya usa el
// resto de esta tabla, sin necesitar una tabla nueva solo para esto. Una
// combinación sin ninguna transferencia hoy queda en 0, no ausente del Map.
async function getTransferidoHoyPorCuit(rootDir, cuits) {
  const uniqueCuits = [...new Set((cuits || []).map((c) => String(c || '').trim()).filter(Boolean))];
  const result = new Map();
  for (const cuit of uniqueCuits) {
    result.set(transferidoHoyKey(cuit, 'ARS'), 0);
    result.set(transferidoHoyKey(cuit, 'USD'), 0);
  }
  if (uniqueCuits.length === 0) return result;

  const placeholders = uniqueCuits.map(() => '?').join(',');
  const rows = await db.query(
    rootDir,
    `SELECT debito_cuit, moneda, SUM(CAST(importe AS DECIMAL(18,2))) AS total
     FROM dbn_consulta
     WHERE realizado = 's' AND DATE(ejecutado_en) = CURDATE() AND debito_cuit IN (${placeholders})
     GROUP BY debito_cuit, moneda`,
    uniqueCuits
  );
  for (const row of rows) {
    result.set(transferidoHoyKey(row.debito_cuit, row.moneda), Number(row.total) || 0);
  }
  return result;
}

module.exports = { addDbnOutRows, addDbnConsultaRows, getTransferidoHoyPorCuit, transferidoHoyKey };
