'use strict';
const test = require('node:test');
const assert = require('node:assert');
const config = require('../../lib/transfCaCc/config');
const bs = require('../../lib/transfCaCc/bankservice');

const H = bs.ENCABEZADO.join(',');
const fila = (comp, estado, { creada = '2026-11-16 10:00:00', ejecutada = '2026-11-16 10:00:05', monto = '1000', moneda = 'ARS', cbu = '3120001902000000050011' } = {}) =>
  [comp, creada, estado === 'APPROVED' ? ejecutada : '—', estado, '"PEREZ, JUAN"', '20111111112', cbu, '3120001901000110004922', 'COCOS', '30708424478', monto, moneda, '—', '—'].join(',');
const csv = (...filas) => '﻿' + [H, ...filas].join('\n') + '\n';

// Conexión falsa en memoria: interpreta solo las consultas de cargarArchivo.
function conexionFalsa() {
  const db = { cargas: [], movs: new Map(), auditoria: [] };
  let snapshot = null;
  const conn = {
    db,
    async beginTransaction() { snapshot = JSON.stringify({ cargas: db.cargas, movs: [...db.movs], auditoria: db.auditoria }); },
    async commit() { snapshot = null; },
    async rollback() { const s = JSON.parse(snapshot); db.cargas = s.cargas; db.movs = new Map(s.movs); db.auditoria = s.auditoria; },
    async query(sql, p) {
      if (/^SELECT id, nombre, cargado_en FROM bankservice_cargas/.test(sql)) return [db.cargas.filter((c) => c.hash === p[0])];
      if (/^INSERT INTO bankservice_cargas/.test(sql)) { db.cargas.push({ id: db.cargas.length + 1, nombre: p[0], hash: p[1], cargado_en: p[8] }); return [{ insertId: db.cargas.length }]; }
      if (/^\s*SELECT comprobante, moncod/.test(sql)) return [p.filter((c) => db.movs.has(c)).map((c) => db.movs.get(c))];
      if (/^\s*INSERT INTO bankservice_movimientos/.test(sql)) {
        if (conn.fallarEn === p[0]) throw new Error('falla simulada');
        db.movs.set(p[0], { comprobante: p[0], moncod: p[1], cuecod: p[2], monto: p[3], estado: p[4], creada: p[5], ejecutada: p[6], fecha_operacion: p[7], error: p[8] });
        return [{}];
      }
      if (/^\s*UPDATE bankservice_movimientos/.test(sql)) { db.movs.set(p[10], { comprobante: p[10], moncod: p[0], cuecod: p[1], monto: p[2], estado: p[3], creada: p[4], ejecutada: p[5], fecha_operacion: p[6], error: p[7] }); return [{}]; }
      if (/^INSERT INTO bankservice_auditoria/.test(sql)) { db.auditoria.push(/NULL/.test(sql) ? [p[0], null, p[1]] : p.slice(0, 3)); return [{}]; }
      if (/^UPDATE bankservice_cargas/.test(sql)) return [{}];
      throw new Error('consulta no prevista: ' + sql);
    },
  };
  return conn;
}
const cargar = (conn, nombre, contenido) => bs.cargarArchivo(conn, { nombre, contenido }, 'u', '2026-11-18 10:00:00', config);

test('leerArchivo: comillas con comas, "—" vacío, BOM, LF, cuenta y fecha de la operación', () => {
  const r = bs.leerArchivo('a.csv', csv(fila(1, 'APPROVED'), fila(2, 'FAILED', { creada: '2026-11-15 09:00:00' })), config);
  assert.strictEqual(r.rechazadas.length, 0);
  assert.deepStrictEqual(r.filas.map((f) => [f.comprobante, f.cuecod, f.monto, f.fechaOperacion, f.ejecutada]), [['1', '5001', 100000, '2026-11-16', '2026-11-16 10:00:05'], ['2', '5001', 100000, '2026-11-15', null]]);
  assert.ok(!('titular' in r.filas[0]) && !('cbu' in r.filas[0])); // minimización
});

test('leerArchivo: rechaza fila por fila con motivo y valida el CBU según la moneda', () => {
  const r = bs.leerArchivo('a.csv', csv(fila(1, 'APPROVED'), fila(2, 'RARO'), fila(3, 'APPROVED', { moneda: 'USD' }), fila(4, 'APPROVED', { monto: 'x' }), '5,2026-11-16'), config);
  assert.strictEqual(r.filas.length, 1);
  assert.deepStrictEqual(r.rechazadas.map((x) => x.fila), [3, 4, 5, 6]);
  assert.match(r.rechazadas[1].motivo, /dígitos 9 y 10/);
});

test('leerArchivo: encabezado incompleto rechaza el archivo', () => {
  assert.throws(() => bs.leerArchivo('a.csv', 'Comprobante,Monto\n1,2\n', config), (e) => e.statusCode === 400 && /faltan columnas/.test(e.message));
});

test('carga: upsert, sin cambios, archivo ya cargado y auditoría de estados', async () => {
  const conn = conexionFalsa();
  const a = await cargar(conn, 'oct.csv', csv(fila(1, 'PENDING_EXECUTION'), fila(2, 'APPROVED')));
  assert.deepStrictEqual([a.insertadas, a.actualizadas, a.sinCambios], [2, 0, 0]);
  const b = await cargar(conn, 'nov.csv', csv(fila(1, 'APPROVED'), fila(2, 'APPROVED'), fila(3, 'FAILED')));
  assert.deepStrictEqual([b.insertadas, b.actualizadas, b.sinCambios], [1, 1, 1]);
  assert.strictEqual(conn.db.movs.get('1').estado, 'APPROVED');
  assert.deepStrictEqual(conn.db.auditoria.find((x) => x[0] === '1' && x[1] === 'PENDING_EXECUTION'), ['1', 'PENDING_EXECUTION', 'APPROVED']);
  const c = await cargar(conn, 'otra-vez.csv', csv(fila(1, 'PENDING_EXECUTION'), fila(2, 'APPROVED')));
  assert.ok(c.yaCargado); // mismo contenido que oct.csv
});

test('carga: un estado final no vuelve atrás (conflicto informado)', async () => {
  const conn = conexionFalsa();
  await cargar(conn, 'nov.csv', csv(fila(1, 'APPROVED')));
  const r = await cargar(conn, 'viejo.csv', csv(fila(1, 'PENDING_EXECUTION', { creada: '2026-11-16 10:00:00' }) + '\n'));
  assert.strictEqual(r.conflictos.length, 1);
  assert.strictEqual(conn.db.movs.get('1').estado, 'APPROVED');
});

test('carga: el orden de los archivos no cambia el resultado', async () => {
  const viejo = csv(fila(1, 'PENDING_EXECUTION'), fila(2, 'PENDING_EXECUTION'));
  const nuevo = csv(fila(1, 'APPROVED'), fila(2, 'FAILED'), fila(3, 'APPROVED'));
  const x = conexionFalsa();
  await cargar(x, 'v', viejo);
  await cargar(x, 'n', nuevo);
  const y = conexionFalsa();
  await cargar(y, 'n', nuevo);
  await cargar(y, 'v', viejo);
  assert.deepStrictEqual([...x.db.movs.values()].map((m) => [m.comprobante, m.estado]).sort(), [...y.db.movs.values()].map((m) => [m.comprobante, m.estado]).sort());
});

test('carga: si algo falla, el archivo no entra (transacción)', async () => {
  const conn = conexionFalsa();
  conn.fallarEn = '2';
  await assert.rejects(cargar(conn, 'a.csv', csv(fila(1, 'APPROVED'), fila(2, 'APPROVED'))));
  assert.strictEqual(conn.db.movs.size, 0);
  assert.strictEqual(conn.db.cargas.length, 0);
});
