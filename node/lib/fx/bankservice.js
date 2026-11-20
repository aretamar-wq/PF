'use strict';

// BankService FX: lectura del CSV de órdenes (fx-orders-settlement-*.csv) y carga en
// MariaDB (fx_ordenes, fx_cargas, fx_auditoria; ver deploy/mariadb-schema.sql).
// Mismas reglas que la carga de BankService de la Conciliación Loop: encabezado
// obligatorio, rechazo fila por fila, SHA-256 (archivo ya cargado), una transacción por
// archivo, UPSERT por id de orden solo si cambió, un estado final (COMPLETED / FAILED)
// nunca cambia y cada cambio de estado queda en la auditoría. Se guarda el CUIT del
// cliente; no se guardan nombres.

const { sha256, parseCsv, centavos, parseFechaHora } = require('../transfCaCc/util');

const COLUMNAS = ['id', 'status', 'side', 'currency', 'amount', 'counterCurrency', 'counterAmount', 'price', 'receiptNumber', 'createdAt', 'settlementDate', 'customerCUIT'];
const OPCIONALES = ['ticketNumber', 'failReason', 'failureCategory', 'confirmedAt'];

const txt = (v) => String(v == null ? '' : v).trim();
// "2026-10-30T13:21:39.701Z" (UTC) -> "2026-10-30 10:21:39" (hora de Argentina, UTC-3).
function fechaHoraAr(v) {
  const s = txt(v);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function leerArchivo(nombre, contenido) {
  const hash = sha256(contenido);
  const tabla = parseCsv(contenido);
  const encabezado = (tabla[0] || []).map((h) => txt(h));
  const faltan = COLUMNAS.filter((h) => !encabezado.includes(h));
  if (faltan.length > 0) {
    const err = new Error(`${nombre}: faltan columnas del archivo de FX de BankService: ${faltan.join(', ')}.`);
    err.statusCode = 400;
    throw err;
  }
  const col = Object.fromEntries([...COLUMNAS, ...OPCIONALES].map((h) => [h, encabezado.indexOf(h)]));
  const filas = [];
  const rechazadas = [];
  for (let i = 1; i < tabla.length; i++) {
    const f = tabla[i];
    if (f.length === 1 && txt(f[0]) === '') continue;
    const g = (h) => (col[h] >= 0 ? txt(f[col[h]]) : '');
    const id = g('id');
    const rechazar = (motivo) => rechazadas.push({ fila: i + 1, comprobante: g('receiptNumber') || id, motivo });
    if (f.length < encabezado.length) { rechazar(`tiene ${f.length} columnas y el encabezado ${encabezado.length}`); continue; }
    if (!id) { rechazar('id vacío'); continue; }
    const status = g('status');
    if (!status) { rechazar('status vacío'); continue; }
    const side = g('side');
    if (side !== 'BUY' && side !== 'SELL') { rechazar(`side desconocido '${side}'`); continue; }
    const amount = centavos(g('amount'));
    const counter = centavos(g('counterAmount'));
    if (amount == null || counter == null) { rechazar('amount o counterAmount inválido'); continue; }
    const recibo = g('receiptNumber');
    if (recibo && !/^\d+$/.test(recibo)) { rechazar(`receiptNumber no numérico '${recibo}'`); continue; }
    if (status === 'COMPLETED' && !recibo) { rechazar('orden COMPLETED sin receiptNumber'); continue; }
    const creada = fechaHoraAr(g('createdAt'));
    if (!creada) { rechazar(`createdAt inválido '${g('createdAt')}'`); continue; }
    const liquidacion = parseFechaHora(g('settlementDate'));
    // Fecha de la operación: la de liquidación (settlementDate); si no viene, la de creación.
    const fechaOperacion = liquidacion ? liquidacion.fecha : creada.slice(0, 10);
    // Importes por moneda: BUY = el cliente paga pesos (amount) y recibe dólares (counterAmount).
    const ars = side === 'BUY' ? amount : counter;
    const usd = side === 'BUY' ? counter : amount;
    filas.push({
      id,
      comprobante: recibo,
      ticket: g('ticketNumber'),
      status,
      side,
      ars,
      usd,
      precio: g('price'),
      creada,
      confirmada: fechaHoraAr(g('confirmedAt')),
      fechaOperacion,
      cuit: g('customerCUIT').replace(/\D/g, '').slice(0, 20),
      failReason: g('failReason').slice(0, 500),
      failureCategory: g('failureCategory').slice(0, 50),
      fila: i + 1,
    });
  }
  const porId = new Map();
  for (const r of filas) porId.set(r.id, r);
  return { hash, filas: [...porId.values()], rechazadas, leidas: tabla.length - 1 };
}

const dec = (c) => (c / 100).toFixed(2);
const igual = (a, b) =>
  a.comprobante === String(b.comprobante || '') && a.status === b.status && a.side === b.side && dec(a.ars) === Number(b.ars).toFixed(2) &&
  dec(a.usd) === Number(b.usd).toFixed(2) && a.fechaOperacion === String(b.fecha_operacion).slice(0, 10) && a.cuit === String(b.customer_cuit || '') &&
  a.failReason === String(b.fail_reason || '');

function decidir(nueva, existente, finales = ['COMPLETED', 'FAILED']) {
  if (!existente) return 'insertar';
  if (igual(nueva, existente)) return 'sin-cambios';
  if (finales.includes(existente.status) && nueva.status !== existente.status) return 'conflicto';
  return 'actualizar';
}

async function cargarArchivo(conn, archivo, usuario, ahora, config) {
  const leido = leerArchivo(archivo.nombre, archivo.contenido);
  const [previas] = await conn.query('SELECT id, nombre, cargado_en FROM fx_cargas WHERE hash = ? LIMIT 1', [leido.hash]);
  if (previas.length > 0) {
    return { nombre: archivo.nombre, yaCargado: true, cargaPrevia: previas[0], mensaje: `archivo ya cargado (${previas[0].nombre}, ${previas[0].cargado_en})` };
  }
  const r = { nombre: archivo.nombre, hash: leido.hash, leidas: leido.leidas, insertadas: 0, actualizadas: 0, sinCambios: 0, rechazadas: leido.rechazadas.length, conflictos: [], rechazos: leido.rechazadas };
  const fechas = leido.filas.map((f) => f.fechaOperacion).sort();
  await conn.beginTransaction();
  try {
    const [ins] = await conn.query(
      `INSERT INTO fx_cargas (nombre, hash, filas_leidas, insertadas, actualizadas, sin_cambios, rechazadas, conflictos, fecha_min, fecha_max, cargado_por, cargado_en)
       VALUES (?, ?, ?, 0, 0, 0, ?, 0, ?, ?, ?, ?)`,
      [archivo.nombre.slice(0, 255), leido.hash, leido.leidas, r.rechazadas, fechas[0] || null, fechas[fechas.length - 1] || null, usuario, ahora]
    );
    const cargaId = ins.insertId;
    r.cargaId = cargaId;
    for (let i = 0; i < leido.filas.length; i += 500) {
      const lote = leido.filas.slice(i, i + 500);
      const [existentes] = await conn.query(
        `SELECT id, comprobante, status, side, ars, usd, fecha_operacion, customer_cuit, fail_reason FROM fx_ordenes WHERE id IN (${lote.map(() => '?').join(', ')}) FOR UPDATE`,
        lote.map((f) => f.id)
      );
      const porId = new Map(existentes.map((e) => [String(e.id), e]));
      for (const f of lote) {
        const e = porId.get(f.id);
        const accion = decidir(f, e, config.estadosFinales);
        const valores = [f.comprobante, f.ticket, f.status, f.side, dec(f.ars), dec(f.usd), f.precio || null, f.creada, f.confirmada, f.fechaOperacion, f.cuit, f.failReason, f.failureCategory, cargaId, ahora];
        if (accion === 'insertar') {
          await conn.query(
            `INSERT INTO fx_ordenes (id, comprobante, ticket, status, side, ars, usd, precio, creada, confirmada, fecha_operacion, customer_cuit, fail_reason, failure_category, carga_id, cargado_en)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [f.id, ...valores]
          );
          await conn.query('INSERT INTO fx_auditoria (orden_id, estado_anterior, estado_nuevo, carga_id, fecha) VALUES (?, NULL, ?, ?, ?)', [f.id, f.status, cargaId, ahora]);
          r.insertadas++;
        } else if (accion === 'actualizar') {
          await conn.query(
            `UPDATE fx_ordenes SET comprobante = ?, ticket = ?, status = ?, side = ?, ars = ?, usd = ?, precio = ?, creada = ?, confirmada = ?, fecha_operacion = ?,
               customer_cuit = ?, fail_reason = ?, failure_category = ?, carga_id = ?, cargado_en = ? WHERE id = ?`,
            [...valores, f.id]
          );
          if (e.status !== f.status) {
            await conn.query('INSERT INTO fx_auditoria (orden_id, estado_anterior, estado_nuevo, carga_id, fecha) VALUES (?, ?, ?, ?, ?)', [f.id, e.status, f.status, cargaId, ahora]);
          }
          r.actualizadas++;
        } else if (accion === 'sin-cambios') {
          r.sinCambios++;
        } else {
          r.conflictos.push({ fila: f.fila, comprobante: f.comprobante || f.id, motivo: `ya está ${e.status} y el archivo trae ${f.status}: no se pisa` });
        }
      }
    }
    await conn.query(
      'UPDATE fx_cargas SET insertadas = ?, actualizadas = ?, sin_cambios = ?, conflictos = ?, rechazos_json = ? WHERE id = ?',
      [r.insertadas, r.actualizadas, r.sinCambios, r.conflictos.length, JSON.stringify({ rechazos: r.rechazos.slice(0, 1000), conflictos: r.conflictos.slice(0, 1000) }), cargaId]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  }
  return r;
}

// Filas de fx_ordenes -> órdenes para la conciliación (importes en centavos).
function ordenesDesdeFilas(filas) {
  return filas.map((f) => ({
    id: String(f.id),
    comprobante: String(f.comprobante || ''),
    status: f.status,
    side: f.side,
    ars: Math.round(Number(f.ars) * 100),
    usd: Math.round(Number(f.usd) * 100),
    creada: String(f.creada || ''),
    fecha: String(f.fecha_operacion || '').slice(0, 10),
    cuit: String(f.customer_cuit || ''),
    failReason: f.fail_reason || '',
  }));
}

module.exports = { COLUMNAS, leerArchivo, decidir, cargarArchivo, ordenesDesdeFilas };
