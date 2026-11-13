'use strict';
const test = require('node:test');
const assert = require('node:assert');
const config = require('../../lib/qnet/config');
const { conciliar } = require('../../lib/qnet/conciliacion');
const { par, pendiente, transfer } = require('./fixtures');

// Día conciliado: jueves 12/11/2026. El día ya cerró (hoy es posterior).
const D = '2026-11-12';
const HOY = '2026-11-20';
const corteT = transfer('9999', 'APPROVED', '2026-11-13 23:58:41', 1, 5001); // fija el corte de BankService después de D
const correr = (partidas, transfers, extra = {}) => conciliar({ partidas, pendientes: [], transfers: [corteT, ...transfers], config, fecha: D, hoy: HOY, ...extra });
const tiposDe = (r, comprobante) => r.excepciones.filter((e) => e.comprobante === comprobante).map((e) => e.tipo).sort();

test('APPROVED del día encontrada en Loop con monto y cuenta iguales: sin diferencias', () => {
  const r = correr(par('10', 5001, D, D, 250.5), [transfer('10', 'APPROVED', `${D} 10:00:00`, 250.5, 5001)]);
  assert.strictEqual(r.cruce.encontradas, 1);
  assert.strictEqual(r.cruce.sinDiferencias, 1);
  assert.deepStrictEqual(tiposDe(r, '10'), []);
});

test('Monto distinto y cuenta distinta: cada diferencia es una excepción', () => {
  const r = correr(par('10', 5001, D, D, 250.5), [transfer('10', 'APPROVED', `${D} 10:00:00`, 250, 5999)]);
  assert.deepStrictEqual(tiposDe(r, '10'), ['Cuenta distinta', 'Monto distinto']);
  assert.strictEqual(r.cruce.sinDiferencias, 0);
});

test('Alcance de un día: las operaciones de otros días no cuentan', () => {
  const r = correr(par('10', 5001, D, D, 5), [
    transfer('10', 'APPROVED', `${D} 10:00:00`, 5, 5001),
    transfer('20', 'APPROVED', '2026-11-05 10:00:00', 5, 5001), // otro día, sin registro en Loop(D): no se evalúa
  ]);
  assert.deepStrictEqual(tiposDe(r, '20'), []);
  assert.strictEqual(r.cruce.delDia, 1);
  assert.ok(r.cruce.otrosDias >= 1);
});

test('Fin de semana: lo ejecutado el sábado y el domingo se contabiliza el lunes', () => {
  const lunes = '2026-11-16';
  const r = conciliar({ partidas: par('10', 5001, lunes, lunes, 5), pendientes: [], transfers: [corteT, transfer('10', 'APPROVED', '2026-11-14 10:00:00', 5, 5001), transfer('11', 'APPROVED', '2026-11-15 22:00:00', 5, 5001), transfer('12', 'APPROVED', '2026-11-13 10:00:00', 5, 5001)], config, fecha: lunes, hoy: HOY });
  assert.strictEqual(r.cruce.delDia, 2); // el 10 (sábado) y el 11 (domingo); el 12 es del viernes
  assert.deepStrictEqual(tiposDe(r, '11'), ['APPROVED sin registro']);
  assert.deepStrictEqual(tiposDe(r, '12'), []);
});

test('Un feriado se salta con el calendario (diaContable)', () => {
  const feriado = '2026-11-12';
  const diaContable = (iso) => (iso === feriado ? '2026-11-13' : iso);
  const r = conciliar({ partidas: par('10', 5001, '2026-11-13', '2026-11-13', 5), pendientes: [], transfers: [transfer('10', 'APPROVED', `${feriado} 15:00:00`, 5, 5001), transfer('9999', 'APPROVED', '2026-11-16 12:00:00', 1, 5001)], config, fecha: '2026-11-13', hoy: HOY, diaContable });
  assert.strictEqual(r.cruce.delDia, 1);
  assert.deepStrictEqual(tiposDe(r, '10'), []);
});

test('FAILED contabilizado', () => {
  const r = correr(par('10', 5001, D, D, 5), [transfer('10', 'FAILED', '', 5, 5001, { creada: `${D} 10:00:00`, error: 'SIN FONDOS' })]);
  assert.deepStrictEqual(tiposDe(r, '10'), ['FAILED contabilizado']);
  const sinAsiento = correr(par('12', 5001, D, D, 1), [transfer('11', 'FAILED', '', 5, 5001, { creada: `${D} 10:00:00` })]);
  assert.deepStrictEqual(tiposDe(sinAsiento, '11'), []);
});

test('Transfer sin ejecutar: PENDING_EXECUTION creada hasta el día, con o sin asiento en Loop', () => {
  const r = correr(par('10', 5001, D, D, 5), [
    transfer('10', 'PENDING_EXECUTION', '', 5, 5001, { creada: `${D} 09:00:00` }),
    transfer('11', 'PENDING_EXECUTION', '', 5, 5001, { creada: '2026-11-03 09:00:00' }),
    transfer('12', 'PENDING_EXECUTION', '', 5, 5001, { creada: '2026-11-13 09:00:00' }), // creada después del día: no es de este día
  ]);
  assert.match(r.excepciones.find((e) => e.comprobante === '10' && e.tipo === 'Transfer sin ejecutar').detalle, /tiene 2 partida/);
  assert.match(r.excepciones.find((e) => e.comprobante === '11').detalle, /sin asiento/);
  assert.deepStrictEqual(tiposDe(r, '12'), []);
});

test('APPROVED sin registro: en un día cerrado es excepción (con o sin débito pendiente); en un día abierto es "pendiente de contabilizar"', () => {
  const partidas = par('1', 5001, D, D, 1);
  const transfers = [transfer('20', 'APPROVED', `${D} 10:00:00`, 10, 5001), transfer('21', 'APPROVED', `${D} 11:00:00`, 10, 5001)];
  const cerrado = conciliar({ partidas, pendientes: [pendiente('21', 5001, 10, D)], transfers: [corteT, transfer('1', 'APPROVED', `${D} 09:00:00`, 1, 5001), ...transfers], config, fecha: D, hoy: HOY });
  const sr = cerrado.excepciones.filter((e) => e.tipo === 'APPROVED sin registro');
  assert.deepStrictEqual(sr.map((e) => e.comprobante).sort(), ['20', '21']);
  assert.match(sr.find((e) => e.comprobante === '21').detalle, /falta el crédito/);
  assert.match(sr.find((e) => e.comprobante === '20').detalle, /ni en los débitos pendientes/);
  const abierto = conciliar({ partidas, pendientes: [], transfers: [corteT, transfer('1', 'APPROVED', `${D} 09:00:00`, 1, 5001), ...transfers], config, fecha: D, hoy: D });
  assert.strictEqual(abierto.diaAbierto, true);
  assert.deepStrictEqual(abierto.excepciones.filter((e) => e.tipo === 'APPROVED sin registro'), []);
  assert.strictEqual(abierto.cruce.pendientesDeContabilizar, 2);
});

test('Sin operación en transfers: 2 partidas, no está en BankService (en ningún día) y el día es anterior al corte', () => {
  const r = correr([...par('77', 5001, D, D, 5), ...par('78', 5001, D, D, 5)], [transfer('78', 'APPROVED', '2026-11-05 10:00:00', 5, 5001)]);
  assert.deepStrictEqual(tiposDe(r, '77'), ['Sin operación en transfers']);
  assert.deepStrictEqual(tiposDe(r, '78'), []); // está en BankService (de otro día): se compara, no falta
  // si el corte de BankService no llegó al día, no se puede afirmar
  const sinCorte = conciliar({ partidas: par('77', 5001, D, D, 5), pendientes: [], transfers: [transfer('9999', 'APPROVED', `${D} 08:00:00`, 1, 5001)], config, fecha: D, hoy: HOY });
  assert.deepStrictEqual(tiposDe(sinCorte, '77'), []);
});

test('Moneda distinta: BankService la tiene en USD y Loop en pesos', () => {
  const r = correr(par('10', 5001, D, D, 5), [transfer('10', 'APPROVED', `${D} 10:00:00`, 5, 5001, { moncod: '2', moneda: 'USD', clave: '2|10' })]);
  assert.ok(tiposDe(r, '10').includes('Moneda distinta'));
  assert.ok(!tiposDe(r, '10').includes('APPROVED sin registro'));
});

test('CBU que no corresponde a la moneda', () => {
  const r = correr(par('10', 5001, D, D, 5), [transfer('10', 'APPROVED', `${D} 10:00:00`, 5, 5001, { cbuMonedaOk: false })]);
  assert.ok(tiposDe(r, '10').includes('CBU no coincide con la moneda'));
});
