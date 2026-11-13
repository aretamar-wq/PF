'use strict';

// Registro en MariaDB del contenido de dbnout-...csv y dbnconsulta-...csv
// (ver "Archivos de salida (files/)" en el README) con quién ejecutó la
// carga y cuándo — además del .csv que ya se guarda en files/ (ver
// handleSaveOutput en server.js), no en reemplazo. Tablas "dbn_out" y
// "dbn_consulta" (ver deploy/mariadb-schema.sql). dbn_consulta además se lee
// para el antiduplicado de transferencias (findTransferenciasRealizadas), el
// límite diario y la conciliación.

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
  await upsertDbnConsultaRecords(rootDir, rowsToRecords(csvContent), username);
}

// Una fila por idMensaje: el cliente registra cada transferencia apenas se
// hace (POST /api/dbn-consulta-rows, con la consulta de estado todavía
// pendiente) y al terminar el archivo vuelve a mandar todas con el
// resultado de la consulta (dbnconsulta-...csv vía /api/save-output) — si
// ese idMensaje ya está se actualiza en vez de insertar otra fila.
// ejecutado_en/ejecutado_por quedan los del primer registro (cuándo se hizo
// la transferencia), que es lo que usan el límite diario y la conciliación.
async function upsertDbnConsultaRecords(rootDir, records, username) {
  if (!records || records.length === 0) return;

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
        // Solo para importar corridas viejas (scripts/import-dbn-consulta.js):
        // cuándo y quién hizo la transferencia, en vez de ahora y quien guarda.
        ejecutadoEn, ejecutadoPor,
        ...rest
      } = record;
      const text = (value) => (value == null ? '' : String(value));
      const values = [
        text(idComprobante),
        text(idOperacion),
        text(creditoCuit),
        text(creditoCbu),
        text(creditoTitular),
        text(debitoCuit),
        text(debitoCbu),
        text(debitoTitular),
        text(moneda),
        text(importe),
        text(codigoRespuestaTransferencia),
        text(descripcionRespuestaTransferencia),
        text(realizado),
        text(errorConsulta),
        JSON.stringify(rest),
      ];

      let existe = false;
      if (text(idMensaje)) {
        const [found] = await connection.query('SELECT id FROM dbn_consulta WHERE id_mensaje = ? LIMIT 1', [text(idMensaje)]);
        existe = found.length > 0;
      }
      if (existe) {
        await connection.query(
          `UPDATE dbn_consulta SET
             id_comprobante = ?, id_operacion = ?,
             credito_cuit = ?, credito_cbu = ?, credito_titular = ?,
             debito_cuit = ?, debito_cbu = ?, debito_titular = ?,
             moneda = ?, importe = ?,
             codigo_respuesta = ?, descripcion_respuesta = ?, realizado = ?,
             error_consulta = ?, respuesta_json = ?
           WHERE id_mensaje = ?`,
          [...values, text(idMensaje)]
        );
      } else {
        await connection.query(
          `INSERT INTO dbn_consulta (
             id_comprobante, id_operacion,
             credito_cuit, credito_cbu, credito_titular,
             debito_cuit, debito_cbu, debito_titular,
             moneda, importe,
             codigo_respuesta, descripcion_respuesta, realizado,
             error_consulta, respuesta_json,
             id_mensaje, ejecutado_por, ejecutado_en
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [...values, text(idMensaje), text(ejecutadoPor) || username, text(ejecutadoEn) || now]
        );
      }
    }
    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

// Actualiza el estado de acreditación (y el resto de lo que devuelve la
// consulta DEBIN) de las transferencias de dbn_consulta con ese id_operacion:
// lo usa la "Consulta DEBIN" manual para completar las que quedaron sin
// estado. "campos" es lo que devuelve extractDebinConsultaFields (wwwroot/app.js);
// se mezcla en respuesta_json, como cuando lo guarda "Transferencia DEBIN -
// File". Devuelve cuántas filas se actualizaron y el estado resultante.
async function updateConsultaEstadoPorOperacion(rootDir, idOperacion, campos) {
  const operacion = String(idOperacion == null ? '' : idOperacion).trim();
  if (!operacion) return { actualizadas: 0 };
  const rows = await db.query(rootDir, 'SELECT id, respuesta_json FROM dbn_consulta WHERE TRIM(id_operacion) = ?', [operacion]);
  for (const row of rows) {
    let actual = {};
    try {
      actual = row.respuesta_json ? JSON.parse(row.respuesta_json) : {};
    } catch (err) {
      actual = {};
    }
    await db.query(rootDir, 'UPDATE dbn_consulta SET respuesta_json = ?, error_consulta = ? WHERE id = ?', [
      JSON.stringify({ ...actual, ...campos }),
      '',
      row.id,
    ]);
  }
  return { actualizadas: rows.length };
}

// La columna "moneda" de dbn_consulta/el CSV de entrada no trae el texto
// "ARS"/"USD": trae el código numérico que espera Nova-Link (ISO 4217 —
// "032"/"32" = ARS, "840" = USD, ver defaultValue de "moneda" en
// Flows/transferencia-debin.json). Los límites de Parametría sí están
// pensados en ARS/USD (son los que entiende un humano al cargarlos), así
// que hay que traducir el código antes de comparar — si no, "32" nunca
// matchea la clave "ARS" y el límite queda sin aplicarse (fail-open, pero
// por el motivo equivocado).
function normalizeMonedaCodigo(raw) {
  const value = String(raw || '').trim();
  const numeric = value.replace(/^0+(?=\d)/, ''); // "032" -> "32", para no depender de los ceros a la izquierda
  if (numeric === '32') return 'ARS';
  if (numeric === '840') return 'USD';
  return value.toUpperCase(); // ya viene como texto (ARS/USD) o es un código no reconocido — ver getTransferidoHoyPorCuit
}

// Clave del Map que devuelve getTransferidoHoyPorCuit: un acumulado
// independiente por CUIT, moneda Y destinatario — lo transferido en ARS no
// afecta el límite de USD, ni lo transferido a terceros afecta el límite de
// mismo CUIT (ver Parametría, debin.limiteDiarioArs/UsdMismoCuit/Terceros).
// moneda pasa por normalizeMonedaCodigo (código numérico -> ARS/USD) antes
// de armar la clave, así "32"/"032"/"ars"/"ARS" pisan el mismo acumulado.
// destinatario es literalmente 'mismo' o 'terceros' (ver mismoTitular en
// Flows/transferencia-debin-files.json: "1" si CUIT destino = CUIT origen).
function transferidoHoyKey(cuit, moneda, destinatario) {
  return `${cuit}|${normalizeMonedaCodigo(moneda)}|${destinatario}`;
}

// Para el límite diario de transferencias por CUIT origen, moneda y
// destinatario (Parametría, debin.limiteDiarioArs/UsdMismoCuit/Terceros, ver
// handleTransferenciasLimiteGet en server.js): suma, para cada
// (debito_cuit, moneda, destinatario) pedido, el importe de las
// transferencias YA CONFIRMADAS (realizado = 's') de HOY (fecha local del
// servidor vía CURDATE(), no la fecha de proceso bancaria — a diferencia de
// "Pago de Plazo Fijos", acá no hay ningún requisito de que coincida con el
// cierre de Sybase) en dbn_consulta — mismo criterio de "verdad" que ya usa
// el resto de esta tabla, sin necesitar una tabla nueva solo para esto.
// destinatario sale de comparar credito_cuit = debito_cuit en la propia
// query (CASE), no de una columna propia — dbn_consulta no guarda
// "mismoTitular" como tal. Una combinación sin ninguna transferencia hoy
// queda en 0, no ausente del Map.
async function getTransferidoHoyPorCuit(rootDir, cuits) {
  const uniqueCuits = [...new Set((cuits || []).map((c) => String(c || '').trim()).filter(Boolean))];
  const result = new Map();
  for (const cuit of uniqueCuits) {
    for (const moneda of ['ARS', 'USD']) {
      for (const destinatario of ['mismo', 'terceros']) {
        result.set(transferidoHoyKey(cuit, moneda, destinatario), 0);
      }
    }
  }
  if (uniqueCuits.length === 0) return result;

  const placeholders = uniqueCuits.map(() => '?').join(',');
  const rows = await db.query(
    rootDir,
    `SELECT debito_cuit, moneda,
            CASE WHEN credito_cuit = debito_cuit THEN 'mismo' ELSE 'terceros' END AS destinatario,
            SUM(CAST(importe AS DECIMAL(18,2))) AS total
     FROM dbn_consulta
     WHERE realizado = 's' AND DATE(ejecutado_en) = CURDATE() AND debito_cuit IN (${placeholders})
     GROUP BY debito_cuit, moneda, destinatario`,
    uniqueCuits
  );
  for (const row of rows) {
    result.set(transferidoHoyKey(row.debito_cuit, row.moneda, row.destinatario), Number(row.total) || 0);
  }
  return result;
}

// Para el archivo de conciliación diaria de transferencias (ver
// handleConciliacionGet en server.js): todas las filas de dbn_consulta de un
// día (fecha local yyyy-MM-dd de ejecutado_en), realizadas o no.
// estadoCodigo/estadoDescripcion no tienen columna propia: quedaron dentro de
// respuesta_json (ver addDbnConsultaRows, "...rest").
async function getConsultaRowsDelDia(rootDir, fecha) {
  return db.query(
    rootDir,
    `SELECT ${CONCILIACION_COLUMNAS}
     FROM dbn_consulta
     WHERE DATE(ejecutado_en) = ?
     ORDER BY ejecutado_en, id`,
    [fecha]
  );
}

// Antiduplicado de "Transferencia DEBIN - File": de los pares (debitoCuit,
// idComprobante) pedidos, cuáles ya tienen una transferencia realizada
// (realizado = 's') en dbn_consulta. Las rechazadas no cuentan: se pueden
// reintentar.
async function findTransferenciasRealizadas(rootDir, transferencias) {
  const pares = (transferencias || []).filter((t) => t.debitoCuit && t.idComprobante);
  if (pares.length === 0) return [];

  // TRIM: dbn_consulta guarda CUIT/comprobante tal como vinieron en el
  // archivo, con espacios si los había; el cliente manda los valores recortados.
  const conditions = pares.map(() => '(TRIM(debito_cuit) = ? AND TRIM(id_comprobante) = ?)').join(' OR ');
  const params = [];
  for (const t of pares) params.push(String(t.debitoCuit), String(t.idComprobante));

  const rows = await db.query(
    rootDir,
    `SELECT TRIM(debito_cuit) AS debito_cuit, TRIM(id_comprobante) AS id_comprobante, MIN(ejecutado_en) AS ejecutado_en
     FROM dbn_consulta
     WHERE realizado = 's' AND (${conditions})
     GROUP BY TRIM(debito_cuit), TRIM(id_comprobante)`,
    params
  );
  return rows.map((row) => ({ debitoCuit: row.debito_cuit, idComprobante: row.id_comprobante, ejecutadoEn: row.ejecutado_en }));
}

// Columnas de dbn_consulta que usa la conciliación de transferencias con IBS
// (estadoCodigo/estadoDescripcion no son columnas: están en respuesta_json).
// Las filas de las primeras corridas (formato viejo de dbnconsulta-...csv, sin
// CUIT, CBU, importe ni "realizado" propios) tienen esos datos solo dentro de
// la consulta del DEBIN (respuesta_json): comprador = quien paga (débito),
// vendedor = quien recibe (crédito). Se usan de respaldo cuando la columna
// está vacía, y una fila sin "realizado" pero con idOperacion (el DEBIN se
// creó) cuenta como realizada.
const jsonCampo = (campo) => `JSON_UNQUOTE(JSON_EXTRACT(respuesta_json, '$.${campo}'))`;
const conRespaldo = (columna, campo) => `COALESCE(NULLIF(TRIM(${columna}), ''), ${jsonCampo(campo)}) AS ${columna}`;
const CONCILIACION_COLUMNAS = `ejecutado_en, ejecutado_por, id_mensaje, id_comprobante, id_operacion,
            ${conRespaldo('debito_cuit', 'compradorCuit')}, ${conRespaldo('debito_cbu', 'compradorCuentaCbu')},
            ${conRespaldo('debito_titular', 'compradorTitular')},
            ${conRespaldo('credito_cuit', 'vendedorCuit')}, ${conRespaldo('credito_cbu', 'vendedorCuentaCbu')},
            ${conRespaldo('credito_titular', 'vendedorTitular')},
            ${conRespaldo('moneda', 'detalleMoneda')}, ${conRespaldo('importe', 'detalleImporte')},
            CASE WHEN TRIM(realizado) = '' AND TRIM(id_operacion) <> '' THEN 's' ELSE realizado END AS realizado,
            codigo_respuesta, descripcion_respuesta, error_consulta,
            JSON_UNQUOTE(JSON_EXTRACT(respuesta_json, '$.estadoCodigo')) AS estado_codigo,
            JSON_UNQUOTE(JSON_EXTRACT(respuesta_json, '$.estadoDescripcion')) AS estado_descripcion`;

// Todas las filas de dbn_consulta de un rango de días de ejecución (yyyy-MM-dd,
// ambos inclusive). Rango sobre ejecutado_en sin DATE() para poder usar el índice.
async function getConsultaRowsEntre(rootDir, desde, hasta) {
  return db.query(
    rootDir,
    `SELECT ${CONCILIACION_COLUMNAS}
     FROM dbn_consulta
     WHERE ejecutado_en >= ? AND ejecutado_en < DATE_ADD(?, INTERVAL 1 DAY)
     ORDER BY ejecutado_en, id`,
    [desde, hasta]
  );
}

// Las filas de esos comprobantes sin importar la fecha — para explicar en la
// conciliación un débito de IBS de una transferencia hecha fuera del rango.
async function getConsultaRowsPorComprobante(rootDir, comprobantes) {
  const unicos = [...new Set((comprobantes || []).map((c) => String(c || '').trim()).filter(Boolean))];
  const rows = [];
  for (let i = 0; i < unicos.length; i += 500) {
    const lote = unicos.slice(i, i + 500);
    rows.push(
      ...(await db.query(
        rootDir,
        `SELECT ${CONCILIACION_COLUMNAS} FROM dbn_consulta WHERE id_comprobante IN (${lote.map(() => '?').join(',')}) ORDER BY ejecutado_en, id`,
        lote
      ))
    );
  }
  return rows;
}

module.exports = {
  addDbnOutRows,
  addDbnConsultaRows,
  upsertDbnConsultaRecords,
  rowsToRecords,
  updateConsultaEstadoPorOperacion,
  getTransferidoHoyPorCuit,
  transferidoHoyKey,
  getConsultaRowsDelDia,
  getConsultaRowsEntre,
  getConsultaRowsPorComprobante,
  findTransferenciasRealizadas,
};
