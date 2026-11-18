'use strict';

// Movimientos de BankService (transferencias QNET) guardados en MariaDB (tabla
// qnet_bankservice, ver deploy/mariadb-schema.sql): se cargan los archivos una vez
// y la conciliación Loop los lee de la base, sin tener que subirlos en cada corrida.
// Clave: comprobante + moneda. Un archivo nuevo actualiza lo que ya estaba, salvo
// que traiga PENDING_EXECUTION para algo que ya está en un estado final.

// La conexión se pide recién al usarla: así las funciones puras se pueden probar sin mysql2.
const db = { query: (...args) => require('../mariadbClient').query(...args) };
const { parseCsv, centavos, parseFechaHora } = require('./util');
const { ENCABEZADO_BANKSERVICE } = require('./lectura/bankservice');

const ESTADOS = ['APPROVED', 'FAILED', 'PENDING_EXECUTION'];
const sinGuion = (v) => {
  const s = String(v == null ? '' : v).trim();
  return s === '—' || s === '-' ? '' : s;
};
const fechaHora = (v) => {
  const f = parseFechaHora(v);
  return f ? `${f.fecha} ${f.hora}` : null;
};

// Archivo de BankService -> filas para la tabla. config: monedas válidas.
function filasDesdeCsv(nombre, contenido, config) {
  const filas = parseCsv(contenido);
  const encabezado = (filas[0] || []).map((h) => h.trim());
  if (encabezado.join(',') !== ENCABEZADO_BANKSERVICE.join(',')) {
    const error = new Error(`${nombre}: no tiene el encabezado de BankService (${ENCABEZADO_BANKSERVICE.join(',')}).`);
    error.statusCode = 400;
    throw error;
  }
  const col = Object.fromEntries(ENCABEZADO_BANKSERVICE.map((h, i) => [h, i]));
  const validas = [];
  let descartadas = 0;
  for (const f of filas.slice(1)) {
    if (f.length === 1 && String(f[0]).trim() === '') continue;
    const g = (h) => (f[col[h]] == null ? '' : String(f[col[h]]).trim());
    const monto = centavos(g('Monto'));
    const fila = {
      comprobante: g('Comprobante'),
      moneda: g('Moneda'),
      creada: fechaHora(g('Creada')),
      ejecutada: fechaHora(sinGuion(g('Ejecutada'))),
      estado: g('Estado'),
      titular: g('Titular'),
      cuitTitular: g('CUIT titular'),
      cbuOrigen: g('CBU origen'),
      cbuDestino: g('CBU destino'),
      destinatario: g('Destinatario'),
      cuitDestinatario: g('CUIT destinatario'),
      monto: monto == null ? null : (monto / 100).toFixed(2),
      codigoQnet: sinGuion(g('Código QNET')),
      error: sinGuion(g('Error')),
      archivo: nombre,
    };
    if (!fila.comprobante || !ESTADOS.includes(fila.estado) || !(fila.moneda in config.monedas) || fila.monto == null || !fila.creada) {
      descartadas++;
      continue;
    }
    validas.push(fila);
  }
  return { filas: validas, descartadas };
}

const COLUMNAS = [
  'comprobante', 'moneda', 'creada', 'ejecutada', 'estado', 'titular', 'cuit_titular', 'cbu_origen', 'cbu_destino',
  'destinatario', 'cuit_destinatario', 'monto', 'codigo_qnet', 'error', 'archivo', 'cargado_por', 'cargado_en',
];
// Se actualiza todo salvo que llegue PENDING_EXECUTION para algo ya final; estado va
// último porque las asignaciones de ON DUPLICATE KEY UPDATE se aplican en orden.
const SE_ACTUALIZA = "(VALUES(estado) <> 'PENDING_EXECUTION' OR estado = 'PENDING_EXECUTION')";
const ACTUALIZAR = COLUMNAS.filter((c) => !['comprobante', 'moneda', 'estado'].includes(c))
  .map((c) => `\`${c}\` = IF(${SE_ACTUALIZA}, VALUES(\`${c}\`), \`${c}\`)`)
  .concat([`estado = IF(${SE_ACTUALIZA}, VALUES(estado), estado)`])
  .join(', ');

async function guardar(rootDir, filas, usuario, ahora) {
  let nuevas = 0;
  let actualizadas = 0;
  for (let i = 0; i < filas.length; i += 500) {
    const lote = filas.slice(i, i + 500);
    const [existentes] = await db.query(
      rootDir,
      `SELECT COUNT(*) AS n FROM qnet_bankservice WHERE (comprobante, moneda) IN (${lote.map(() => '(?, ?)').join(', ')})`,
      lote.flatMap((f) => [f.comprobante, f.moneda])
    );
    const valores = [];
    for (const f of lote) {
      valores.push(f.comprobante, f.moneda, f.creada, f.ejecutada, f.estado, f.titular, f.cuitTitular, f.cbuOrigen, f.cbuDestino,
        f.destinatario, f.cuitDestinatario, f.monto, f.codigoQnet, f.error, f.archivo, usuario, ahora);
    }
    const marcadores = lote.map(() => `(${COLUMNAS.map(() => '?').join(', ')})`).join(', ');
    const r = await db.query(rootDir, `INSERT INTO qnet_bankservice (${COLUMNAS.map((c) => `\`${c}\``).join(', ')}) VALUES ${marcadores} ON DUPLICATE KEY UPDATE ${ACTUALIZAR}`, valores);
    // affectedRows: 1 por fila nueva, 2 por fila existente que cambió, 0 si quedó igual.
    const nuevasLote = lote.length - Number(existentes.n || 0);
    nuevas += nuevasLote;
    actualizadas += Math.max(Math.round((r.affectedRows - nuevasLote) / 2), 0);
  }
  return { nuevas, actualizadas };
}

// Primer día del mes de fecha (aaaa-mm-dd) desplazado `meses`.
function inicioDeMes(fecha, meses) {
  const [y, m] = fecha.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + meses, 1));
  return d.toISOString().slice(0, 10);
}

// Ventana que necesita la conciliación de un día: el mes anterior, el del día y el
// siguiente (lo mismo que cubrían los archivos mensuales que se subían).
async function leerVentana(rootDir, fecha) {
  return db.query(
    rootDir,
    `SELECT comprobante, moneda, creada, ejecutada, estado, titular, cuit_titular, cbu_origen, cbu_destino,
            destinatario, cuit_destinatario, monto, codigo_qnet, \`error\`
     FROM qnet_bankservice
     WHERE creada >= ? AND creada < ?
     ORDER BY creada, comprobante`,
    [inicioDeMes(fecha, -1), inicioDeMes(fecha, 2)]
  );
}

const csvCampo = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Filas de la base -> archivos con el formato de BankService (uno por mes de
// "Creada"), para pasarle a la conciliación lo mismo que si se hubieran subido.
function archivosDesdeFilas(filas) {
  const porMes = new Map();
  for (const r of filas) {
    const creada = String(r.creada || '');
    const nombre = `Movimientos_BankService-${creada.slice(5, 7)}${creada.slice(0, 4)}.csv`;
    if (!porMes.has(nombre)) porMes.set(nombre, [ENCABEZADO_BANKSERVICE.join(',')]);
    porMes.get(nombre).push([
      r.comprobante, creada, r.ejecutada || '—', r.estado, r.titular, r.cuit_titular, r.cbu_origen, r.cbu_destino,
      r.destinatario, r.cuit_destinatario, r.monto, r.moneda, r.codigo_qnet || '—', r.error || '—',
    ].map(csvCampo).join(','));
  }
  return [...porMes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([nombre, lineas]) => ({ nombre, contenido: lineas.join('\r\n') + '\r\n' }));
}

async function resumen(rootDir) {
  const [r] = await db.query(rootDir, 'SELECT COUNT(*) AS total, MIN(creada) AS desde, MAX(creada) AS hasta, MAX(cargado_en) AS ultimaCarga FROM qnet_bankservice');
  return { total: Number(r.total) || 0, desde: r.desde || '', hasta: r.hasta || '', ultimaCarga: r.ultimaCarga || '' };
}

module.exports = { filasDesdeCsv, guardar, leerVentana, archivosDesdeFilas, resumen, inicioDeMes };
