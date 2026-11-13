'use strict';
const test = require('node:test');
const assert = require('node:assert');
const config = require('../../lib/qnet/config');
const { conciliar } = require('../../lib/qnet/conciliacion');
const { par, soloCredito, partida, pendiente, transfer } = require('./fixtures');

const PRIMER = '2026-10-01';
const ULTIMO = '2026-11-12';
const base = () => [...par('1', 5001, PRIMER, PRIMER, 1), ...par('2', 5001, ULTIMO, ULTIMO, 1)]; // fijan el período de Loop
const corteT = transfer('9999', 'APPROVED', '2026-11-12 23:58:41', 1, 5001);
const tipos = (r) => r.excepciones.map((e) => e.tipo);

test('Período de Loop y corte de transfers', () => {
  const r = conciliar({ partidas: base(), pendientes: [], transfers: [corteT], config });
  assert.deepStrictEqual(r.periodo, { primerDia: PRIMER, ultimoDia: ULTIMO });
  assert.strictEqual(r.corte.ejecutada, '2026-11-12 23:58:41');
});

test('APPROVED encontrada en Loop con monto, moneda y cuenta iguales: sin diferencias', () => {
  const r = conciliar({ partidas: [...base(), ...par('10', 5001, '2026-11-02', '2026-11-02', 250.5)], pendientes: [], transfers: [corteT, transfer('10', 'APPROVED', '2026-11-02 10:00:00', 250.5, 5001)], config });
  assert.strictEqual(r.cruce.encontradas, 1);
  assert.strictEqual(r.cruce.sinDiferencias, 1);
  assert.deepStrictEqual(r.excepciones.filter((e) => e.comprobante === '10'), []);
});

test('Monto distinto y cuenta distinta (cada diferencia es una excepción)', () => {
  const r = conciliar({ partidas: [...base(), ...par('10', 5001, '2026-11-02', '2026-11-02', 250.5)], pendientes: [], transfers: [corteT, transfer('10', 'APPROVED', '2026-11-02 10:00:00', 250, 5999)], config });
  assert.deepStrictEqual(r.excepciones.filter((e) => e.comprobante === '10').map((e) => e.tipo).sort(), ['Cuenta distinta', 'Monto distinto']);
  assert.strictEqual(r.cruce.sinDiferencias, 0);
});

test('FAILED contabilizado', () => {
  const r = conciliar({ partidas: [...base(), ...par('10', 5001, '2026-11-02', '2026-11-02', 5)], pendientes: [], transfers: [corteT, transfer('10', 'FAILED', '2026-11-02 10:00:00', 5, 5001, { error: 'SIN FONDOS' })], config });
  assert.ok(tipos(r).includes('FAILED contabilizado'));
  const sinAsiento = conciliar({ partidas: base(), pendientes: [], transfers: [corteT, transfer('11', 'FAILED', '2026-11-02 10:00:00', 5, 5001)], config });
  assert.ok(!tipos(sinAsiento).includes('FAILED contabilizado'));
});

test('Transfer sin ejecutar: PENDING_EXECUTION, con o sin asiento en Loop', () => {
  const r = conciliar({ partidas: [...base(), ...par('10', 5001, '2026-11-02', '2026-11-02', 5)], pendientes: [], transfers: [corteT, transfer('10', 'PENDING_EXECUTION', '', 5, 5001, { creada: '2026-11-02 09:00:00' }), transfer('11', 'PENDING_EXECUTION', '', 5, 5001, { creada: '2026-11-02 09:00:00' })], config });
  const ex = r.excepciones.filter((e) => e.tipo === 'Transfer sin ejecutar');
  assert.strictEqual(ex.length, 2);
  assert.match(ex.find((e) => e.comprobante === '10').detalle, /tiene 2 partida/);
  assert.match(ex.find((e) => e.comprobante === '11').detalle, /sin asiento/);
});

test('APPROVED sin registro: dentro del período es excepción (indica si tiene débito pendiente); último día y posteriores son pendientes de contabilizar; anteriores, fuera del período', () => {
  const transfers = [
    corteT,
    transfer('20', 'APPROVED', '2026-11-05 10:00:00', 10, 5001), // sin registro, sin pendiente
    transfer('21', 'APPROVED', '2026-11-06 10:00:00', 10, 5001), // sin registro, con débito pendiente
    transfer('22', 'APPROVED', '2026-11-12 10:00:00', 10, 5001), // último día: pendiente de contabilizar
    transfer('23', 'APPROVED', '2026-09-30 10:00:00', 10, 5001), // antes del período
  ];
  const r = conciliar({ partidas: base(), pendientes: [pendiente('21', 5001, 10, '2026-11-06')], transfers, config });
  const sr = r.excepciones.filter((e) => e.tipo === 'APPROVED sin registro');
  assert.deepStrictEqual(sr.map((e) => e.comprobante).sort(), ['20', '21']);
  assert.match(sr.find((e) => e.comprobante === '21').detalle, /falta el crédito/);
  assert.match(sr.find((e) => e.comprobante === '20').detalle, /ni en los débitos pendientes/);
  assert.strictEqual(r.cruce.approvedSinRegistro, 2);
  assert.strictEqual(r.cruce.pendientesDeContabilizar, 2); // el 22 y el de corte (12/11)
  assert.strictEqual(r.cruce.fueraDelPeriodo, 1);
});

test('Sin operación en transfers: 2 partidas, no está en BankService y es anterior al corte', () => {
  const r = conciliar({ partidas: [...base(), ...par('77', 5001, '2026-11-03', '2026-11-03', 5), ...par('78', 5001, '2026-11-12', '2026-11-12', 5)], pendientes: [], transfers: [corteT], config });
  // el 1 (fija el primer día) y el 77 no están en BankService; el 2 y el 78 son del día del corte
  assert.deepStrictEqual(r.excepciones.filter((e) => e.tipo === 'Sin operación en transfers').map((e) => e.comprobante).sort(), ['1', '77']);
});

test('Moneda distinta: BankService la tiene en USD y Loop en pesos', () => {
  const r = conciliar({ partidas: [...base(), ...par('10', 5001, '2026-11-02', '2026-11-02', 5)], pendientes: [], transfers: [corteT, transfer('10', 'APPROVED', '2026-11-02 10:00:00', 5, 5001, { moncod: '2', moneda: 'USD', clave: '2|10' })], config });
  assert.ok(tipos(r).includes('Moneda distinta'));
  assert.ok(!tipos(r).includes('APPROVED sin registro'));
});

test('CBU que no corresponde a la moneda', () => {
  const r = conciliar({ partidas: [...base(), ...par('10', 5001, '2026-11-02', '2026-11-02', 5)], pendientes: [], transfers: [corteT, transfer('10', 'APPROVED', '2026-11-02 10:00:00', 5, 5001, { cbuMonedaOk: false })], config });
  assert.ok(tipos(r).includes('CBU no coincide con la moneda'));
});
