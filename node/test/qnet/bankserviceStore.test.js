'use strict';
const test = require('node:test');
const assert = require('node:assert');
const config = require('../../lib/qnet/config');
const { crearAvisos } = require('../../lib/qnet/avisos');
const { leerBankService } = require('../../lib/qnet/lectura/bankservice');
const store = require('../../lib/qnet/bankserviceStore');

test('archivosDesdeFilas: lo de la base (sin CBU) se lee igual en la Conciliación Loop', () => {
  const fila = { comprobante: '166761', moncod: '0', cuecod: '231307', monto: '1000000.00', estado: 'APPROVED', creada: '2026-11-17 23:56:15', ejecutada: '2026-11-17 23:56:15', error: '' };
  const archivos = store.archivosDesdeFilas([fila, { ...fila, comprobante: '1', moncod: '2', creada: '2026-10-31 10:00:00', ejecutada: null, estado: 'PENDING_EXECUTION' }]);
  assert.deepStrictEqual(archivos.map((a) => a.nombre), ['Movimientos_BankService-102026.csv', 'Movimientos_BankService-112026.csv']);
  const avisos = crearAvisos();
  const t = leerBankService(archivos, config, avisos).transfers;
  assert.strictEqual(avisos.codigoSalida(), 0);
  const a = t.find((x) => x.comprobante === '166761');
  assert.strictEqual(a.cuenta, '231307');
  assert.strictEqual(a.cbuMonedaOk, true);
  assert.strictEqual(a.monto, 100000000);
  const b = t.find((x) => x.comprobante === '1');
  assert.strictEqual(b.moneda, 'USD');
  assert.strictEqual(b.cbuMonedaOk, true);
  assert.strictEqual(b.ejecutada, '');
});

test('inicioDeMes: ventana del mes anterior al siguiente', () => {
  assert.strictEqual(store.inicioDeMes('2026-01-15', -1), '2025-12-01');
  assert.strictEqual(store.inicioDeMes('2026-11-18', 2), '2027-01-01');
});
