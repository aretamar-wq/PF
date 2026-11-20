'use strict';

// BankService: lectura del CSV y carga en MariaDB (bankservice_movimientos,
// bankservice_cargas, bankservice_auditoria; ver deploy/mariadb-schema.sql).
//
// - Encabezado obligatorio; UTF-8 (con o sin BOM), CRLF o LF, comillas con comas
//   adentro y "—" como vacío. Cada fila mal formada se rechaza con su motivo.
// - Solo se guarda lo que usa la conciliación: comprobante, moneda, cuenta, monto,
//   estado, fechas y error. Nunca nombres, CUIT ni CBU.
// - Un archivo ya cargado (mismo SHA-256) no se procesa de nuevo.
// - Cada archivo entra en una transacción: completo o nada.
// - UPSERT por comprobante: lo existente se actualiza solo si cambió. Un estado
//   final (APPROVED/FAILED) nunca vuelve a PENDING_EXECUTION ni cambia por otro
//   final: es un conflicto y se informa. Cada cambio de estado queda en la auditoría.

const { sha256, parseCsv, centavos, parseFechaHora } = require('./util');

const ENCABEZADO = [
  'Comprobante', 'Creada', 'Ejecutada', 'Estado', 'Titular', 'CUIT titular', 'CBU origen', 'CBU destino',
  'Destinatario', 'CUIT destinatario', 'Monto', 'Moneda', 'Código QNET', 'Error',
];
const FINALES = ['APPROVED', 'FAILED'];

const limpio = (v) => {
  const s = String(v == null ? '' : v).trim();
  return s === '—' || s === '-' ? '' : s;
};

// "aaaa-mm-dd HH:mm:ss" (hora local) -> el mismo texto normalizado, o null.
function fechaHora(v) {
  const f = parseFechaHora(limpio(v));
  return f ? `${f.fecha} ${f.hora}` : null;
}

// CSV -> { hash, filas: [registro], rechazadas: [{ fila, comprobante, motivo }] }.
// Lanza un error (statusCode 400) si el encabezado no es el de BankService.
function leerArchivo(nombre, contenido, config) {
  const hash = sha256(contenido);
  const tabla = parseCsv(contenido);
  const encabezado = (tabla[0] || []).map((h) => String(h).trim());
  const faltan = ENCABEZADO.filter((h) => !encabezado.includes(h));
  if (faltan.length > 0) {
    const err = new Error(`${nombre}: faltan columnas de BankService: ${faltan.join(', ')}.`);
    err.statusCode = 400;
    throw err;
  }
  const col = Object.fromEntries(ENCABEZADO.map((h) => [h, encabezado.indexOf(h)]));
  const filas = [];
  const rechazadas = [];
  for (let i = 1; i < tabla.length; i++) {
    const f = tabla[i];
    if (f.length === 1 && String(f[0]).trim() === '') continue; // línea vacía
    const g = (h) => limpio(f[col[h]]);
    const comprobante = g('Comprobante');
    const rechazar = (motivo) => rechazadas.push({ fila: i + 1, comprobante, motivo });
    if (f.length < encabezado.length) { rechazar(`tiene ${f.length} columnas y el encabezado ${encabezado.length}`); continue; }
    if (!/^\d+$/.test(comprobante)) { rechazar('comprobante vacío o no numérico'); continue; }
    const estado = g('Estado');
    if (!config.estados.includes(estado)) { rechazar(`estado desconocido '${estado}'`); continue; }
    const moneda = g('Moneda');
    if (!(moneda in config.monedas)) { rechazar(`moneda desconocida '${moneda}'`); continue; }
    const monto = centavos(g('Monto'));
    if (monto == null || monto <= 0) { rechazar(`monto inválido '${g('Monto')}'`); continue; }
    const creada = fechaHora(g('Creada'));
    if (!creada) { rechazar(`fecha Creada inválida '${g('Creada')}'`); continue; }
    const ejecutada = g('Ejecutada') ? fechaHora(g('Ejecutada')) : null;
    if (g('Ejecutada') && !ejecutada) { rechazar(`fecha Ejecutada inválida '${g('Ejecutada')}'`); continue; }
    const cbu = g('CBU origen');
    if (!/^\d{22}$/.test(cbu)) { rechazar('CBU origen inválido (no son 22 dígitos)'); continue; }
    if (cbu.slice(8, 10) !== config.digitosCbuMoneda[moneda]) {
      rechazar(`los dígitos 9 y 10 del CBU origen (${cbu.slice(8, 10)}) no corresponden a ${moneda} (${config.digitosCbuMoneda[moneda]})`);
      continue;
    }
    // Fecha de la operación: la de Ejecutada; para FAILED / PENDING_EXECUTION, la de Creada.
    const fechaOperacion = (estado === 'APPROVED' && ejecutada ? ejecutada : creada).slice(0, 10);
    filas.push({
      comprobante,
      moncod: config.monedas[moneda],
      cuecod: String(parseInt(cbu.slice(10, 21), 10)),
      monto,
      estado,
      creada,
      ejecutada,
      fechaOperacion,
      error: g('Error').slice(0, 500),
      fila: i + 1,
    });
  }
  // Repetido dentro del archivo: vale la última fila.
  const porComprobante = new Map();
  for (const r of filas) porComprobante.set(r.comprobante, r);
  return { hash, filas: [...porComprobante.values()], rechazadas, leidas: tabla.length - 1 };
}

const montoDecimal = (c) => (c / 100).toFixed(2);
const mismoValor = (a, b) =>
  a.moncod === String(b.moncod) && a.cuecod === String(b.cuecod) && montoDecimal(a.monto) === Number(b.monto).toFixed(2) &&
  a.estado === b.estado && a.creada === String(b.creada) && (a.ejecutada || null) === (b.ejecutada || null) &&
  a.fechaOperacion === String(b.fecha_operacion).slice(0, 10) && a.error === String(b.error || '');

// Decide qué hacer con una fila del archivo frente a lo que ya está en la base.
// -> 'insertar' | 'actualizar' | 'sin-cambios' | 'conflicto'
function decidir(nueva, existente) {
  if (!existente) return 'insertar';
  if (mismoValor(nueva, existente)) return 'sin-cambios';
  const antes = existente.estado;
  if (FINALES.includes(antes) && nueva.estado !== antes) return 'conflicto';
  return 'actualizar';
}

// conn: conexión mysql2/promise (con beginTransaction/commit/rollback/query).
// archivo: { nombre, contenido }. Devuelve el resultado de la carga.
async function cargarArchivo(conn, archivo, usuario, ahora, config) {
  const leido = leerArchivo(archivo.nombre, archivo.contenido, config);
  const [previas] = await conn.query('SELECT id, nombre, cargado_en FROM bankservice_cargas WHERE hash = ? LIMIT 1', [leido.hash]);
  if (previas.length > 0) {
    return { nombre: archivo.nombre, yaCargado: true, cargaPrevia: previas[0], mensaje: `archivo ya cargado (${previas[0].nombre}, ${previas[0].cargado_en})` };
  }
  const r = { nombre: archivo.nombre, hash: leido.hash, leidas: leido.leidas, insertadas: 0, actualizadas: 0, sinCambios: 0, rechazadas: leido.rechazadas.length, conflictos: [], rechazos: leido.rechazadas };
  const fechas = leido.filas.map((f) => f.fechaOperacion).sort();
  await conn.beginTransaction();
  try {
    const [ins] = await conn.query(
      `INSERT INTO bankservice_cargas (nombre, hash, filas_leidas, insertadas, actualizadas, sin_cambios, rechazadas, conflictos, fecha_min, fecha_max, cargado_por, cargado_en)
       VALUES (?, ?, ?, 0, 0, 0, ?, 0, ?, ?, ?, ?)`,
      [archivo.nombre.slice(0, 255), leido.hash, leido.leidas, r.rechazadas, fechas[0] || null, fechas[fechas.length - 1] || null, usuario, ahora]
    );
    const cargaId = ins.insertId;
    r.cargaId = cargaId;
    for (let i = 0; i < leido.filas.length; i += 500) {
      const lote = leido.filas.slice(i, i + 500);
      const [existentes] = await conn.query(
        `SELECT comprobante, moncod, cuecod, monto, estado, creada, ejecutada, fecha_operacion, error FROM bankservice_movimientos
         WHERE comprobante IN (${lote.map(() => '?').join(', ')}) FOR UPDATE`,
        lote.map((f) => f.comprobante)
      );
      const porComp = new Map(existentes.map((e) => [String(e.comprobante), e]));
      for (const f of lote) {
        const e = porComp.get(f.comprobante);
        const accion = decidir(f, e);
        const valores = [f.moncod, f.cuecod, montoDecimal(f.monto), f.estado, f.creada, f.ejecutada, f.fechaOperacion, f.error, cargaId, ahora];
        if (accion === 'insertar') {
          await conn.query(
            `INSERT INTO bankservice_movimientos (comprobante, moncod, cuecod, monto, estado, creada, ejecutada, fecha_operacion, error, carga_id, cargado_en)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [f.comprobante, ...valores]
          );
          await conn.query('INSERT INTO bankservice_auditoria (comprobante, estado_anterior, estado_nuevo, carga_id, fecha) VALUES (?, NULL, ?, ?, ?)', [f.comprobante, f.estado, cargaId, ahora]);
          r.insertadas++;
        } else if (accion === 'actualizar') {
          await conn.query(
            `UPDATE bankservice_movimientos SET moncod = ?, cuecod = ?, monto = ?, estado = ?, creada = ?, ejecutada = ?, fecha_operacion = ?, error = ?, carga_id = ?, cargado_en = ?
             WHERE comprobante = ?`,
            [...valores, f.comprobante]
          );
          if (e.estado !== f.estado) {
            await conn.query('INSERT INTO bankservice_auditoria (comprobante, estado_anterior, estado_nuevo, carga_id, fecha) VALUES (?, ?, ?, ?, ?)', [f.comprobante, e.estado, f.estado, cargaId, ahora]);
          }
          r.actualizadas++;
        } else if (accion === 'sin-cambios') {
          r.sinCambios++;
        } else {
          r.conflictos.push({ fila: f.fila, comprobante: f.comprobante, motivo: `ya está ${e.estado} y el archivo trae ${f.estado}: no se pisa` });
        }
      }
    }
    await conn.query(
      'UPDATE bankservice_cargas SET insertadas = ?, actualizadas = ?, sin_cambios = ?, conflictos = ?, rechazos_json = ? WHERE id = ?',
      [r.insertadas, r.actualizadas, r.sinCambios, r.conflictos.length, JSON.stringify({ rechazos: r.rechazos.slice(0, 1000), conflictos: r.conflictos.slice(0, 1000) }), cargaId]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  }
  return r;
}

// Movimientos guardados -> operaciones para la conciliación (monto en centavos).
function operacionesDesdeFilas(filas) {
  return filas.map((f) => ({
    comprobante: String(f.comprobante),
    moncod: String(f.moncod),
    cuecod: String(f.cuecod),
    monto: Math.round(Number(f.monto) * 100),
    estado: f.estado,
    creada: String(f.creada || ''),
    ejecutada: f.ejecutada ? String(f.ejecutada) : '',
    fecha: String(f.fecha_operacion || '').slice(0, 10),
    error: f.error || '',
  }));
}

module.exports = { ENCABEZADO, leerArchivo, decidir, cargarArchivo, operacionesDesdeFilas };
