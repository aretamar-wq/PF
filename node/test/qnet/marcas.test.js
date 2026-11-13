'use strict';
const test = require('node:test');
const assert = require('node:assert');
const config = require('../../lib/qnet/config');
const { conciliar, MARCAS } = require('../../lib/qnet/conciliacion');
const { par, soloCredito, partida, pendiente } = require('./fixtures');

const D1 = '2026-11-10';
const D2 = '2026-11-12'; // último día de Loop
const HOY = '2026-12-01'; // el día D2 ya cerró
const marcaDe = (partidas, pendientes = [], com = '100') => {
  const r = conciliar({ partidas, pendientes, transfers: [], config, fecha: D2, hoy: HOY });
  return r.comprobantes.find((c) => c.comnro === com);
};

test('Correcto: 2 partidas y neto 0, aunque las fechas difieran', () => {
  assert.strictEqual(marcaDe(par('100', 5001, D1, D2, 500)).marca, MARCAS.CORRECTO);
});

test('Más de 2 partidas', () => {
  const p = [...par('100', 5001, D1, D1, 500), partida(5, 0, 5001, D1, '100', 25030, -1, 5)];
  assert.strictEqual(marcaDe(p).marca, MARCAS.MAS_DE_DOS);
});

test('Débito de centavo sin crédito (0,01 en la cuenta puente, sistcod 3)', () => {
  const c = marcaDe([partida(3, 0, 11000492, D1, '100', 25030, -1, 0.01)]);
  assert.strictEqual(c.marca, MARCAS.CENTAVO);
});

test('Una partida: solo el débito, o el crédito de 0,01 en la cuenta del cliente', () => {
  assert.strictEqual(marcaDe([partida(5, 0, 5001, D1, '100', 25030, -1, 11040.59)]).marca, MARCAS.UNA_PARTIDA);
  assert.strictEqual(marcaDe([partida(5, 0, 5001, D1, '100', 25031, 1, 0.01)]).marca, MARCAS.UNA_PARTIDA);
});

test('Importes distintos: 2 partidas con neto distinto de 0', () => {
  const c = marcaDe(par('100', 5001, D1, D1, 500, 400));
  assert.strictEqual(c.marca, MARCAS.IMPORTES_DISTINTOS);
  assert.strictEqual(c.neto, -10000); // débito 500 - crédito 400
});

test('Débito pendiente del último día: 1 partida (crédito) y pendiente por el mismo importe', () => {
  const c = marcaDe(soloCredito('100', D2, 500), [pendiente('100', 5001, 500, D2)]);
  assert.strictEqual(c.marca, MARCAS.PEND_ULTIMO);
  assert.strictEqual(c.cuenta, '5001'); // sin débito en Loop, la cuenta sale del pendiente
});

test('Débito pendiente anterior: la fecha del crédito es anterior al último día', () => {
  const c = marcaDe(soloCredito('100', D1, 500), [pendiente('100', 5001, 500, D1)]);
  assert.strictEqual(c.marca, MARCAS.PEND_ANTERIOR);
});

test('Pendiente con importe distinto, y señala un posible débito cruzado en la misma cuenta', () => {
  const partidas = [...soloCredito('100', D1, 500), ...par('200', 5001, D1, D1, 480)];
  const r = conciliar({ partidas, pendientes: [pendiente('100', 5001, 480, D1)], transfers: [], config, fecha: D2, hoy: HOY });
  const c = r.comprobantes.find((x) => x.comnro === '100');
  assert.strictEqual(c.marca, MARCAS.PEND_DISTINTO);
  assert.match(c.detalle, /200/);
  assert.match(c.detalle, /cruzado o duplicado/);
});

test('Una partida con pendiente, pero la partida es un débito: no es débito pendiente', () => {
  const c = marcaDe([partida(5, 0, 5001, D1, '100', 25030, -1, 500)], [pendiente('100', 5001, 500, D1)]);
  assert.strictEqual(c.marca, MARCAS.UNA_PARTIDA);
});

test('La clave es moneda + comnro: el mismo número en USD es otro comprobante', () => {
  const r = conciliar({ partidas: [...par('100', 5001, D1, D1, 500), ...par('100', 6001, D1, D1, 20, 20, 2)], pendientes: [], transfers: [], config, fecha: D2, hoy: HOY });
  assert.strictEqual(r.comprobantes.filter((c) => c.comnro === '100').length, 2);
});

test('Totales: neto - pendientes = sin cubrir; la antigüedad separa el último día', () => {
  const partidas = [...soloCredito('100', D2, 500), ...soloCredito('101', D1, 300), ...soloCredito('102', D1, 200, 2), ...par('103', 5003, D1, D1, 50)];
  const pend = [pendiente('100', 5001, 500, D2), pendiente('101', 5002, 300, D1), pendiente('102', 6001, 190, D1, 2)];
  const r = conciliar({ partidas, pendientes: pend, transfers: [], config, fecha: D2, hoy: HOY });
  assert.strictEqual(r.totales.ARS.neto, 80000); // 500 + 300 + 0 (par neto 0)
  assert.strictEqual(r.totales.ARS.pendientes, 80000);
  assert.strictEqual(r.totales.ARS.sinCubrir, 0);
  assert.strictEqual(r.totales.USD.sinCubrir, 1000); // 200 - 190
  const ult = r.antiguedad.tramos.find((t) => t.tramo === 'Último día' && t.moneda === 'ARS');
  assert.deepStrictEqual([ult.cantidad, ult.importe], [1, 50000]);
  const ant = r.antiguedad.tramos.find((t) => t.tramo === 'Días anteriores' && t.moneda === 'ARS');
  assert.deepStrictEqual([ant.cantidad, ant.importe], [1, 30000]);
  // acumulado por moneda, del más viejo al más nuevo
  assert.deepStrictEqual(r.antiguedad.filas.filter((f) => f.moneda === 'ARS').map((f) => f.acumulado), [30000, 80000]);
});

test('Pendientes sin comprobante en Loop del día: posteriores se informan aparte, del día son excepción, anteriores solo entran en la antigüedad', () => {
  const partidas = par('9000', 7777, D2, D2, 1);
  const pend = [pendiente('300', 5001, 550000, '2026-11-13'), pendiente('301', 5002, 10, D1), pendiente('302', 5003, 20, D2)];
  const r = conciliar({ partidas, pendientes: pend, transfers: [], config, fecha: D2, hoy: HOY });
  assert.deepStrictEqual(r.pendientesPosteriores.map((p) => p.comprobante), ['300']);
  assert.deepStrictEqual(r.pendientesAnteriores.map((p) => p.comprobante), ['301']);
  assert.deepStrictEqual(r.excepciones.filter((e) => e.tipo === 'Débito pendiente sin asiento en Loop').map((e) => e.comprobante), ['302']);
  // la antigüedad suma los del día (302) y los anteriores (301), no los posteriores (300)
  assert.deepStrictEqual(r.antiguedad.tramos.map((x) => [x.tramo, x.cantidad, x.importe]).sort(), [['Días anteriores', 1, 1000], ['Último día', 1, 2000]].sort());
});
