'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ip = require('../lib/informePendientes');

const movs = [{ movcod: '25030', descripcion: 'Transferencias CA -> CC (débito)' }, { movcod: '25032', descripcion: 'Pago de Servicios (débito)' }];
const fila = (x) => ({ sistcod: '5', moncod: '0', cuecod: '160588', movcod: '25030', descdet: 'Debito  CA', comnro: '178900', importedeb: '1000.000', fecorigen: '19/11/2026 00:00:00.000', nrodoc: '20111111112', ...x });

test('query: movcod de Parametría y validación', () => {
  assert.match(ip.buildQuery(['25030', '25032']), /a\.movcod in \(25030, 25032\)/);
  assert.match(ip.buildQuery(['25030']), /tcl_VinculoCli_Cue/);
  assert.throws(() => ip.buildQuery([]), /No hay códigos/);
  assert.throws(() => ip.buildQuery(['1;drop']), /inválidos/);
});

test('leerFilas: una fila por pendiente, con los documentos de los cotitulares juntos', () => {
  const filas = ip.leerFilas([fila(), fila({ nrodoc: '27222222223' }), fila({ comnro: '178901', moncod: 2, cuecod: '700', importedeb: '50' })], movs);
  assert.strictEqual(filas.length, 2);
  assert.deepStrictEqual(filas[0].documentos, ['20111111112', '27222222223']);
  assert.deepStrictEqual([filas[0].importe, filas[0].fechaOrigen, filas[0].moneda, filas[0].descripcion, filas[0].descdet], [100000, '2026-11-19', 'ARS', 'Transferencias CA -> CC (débito)', 'Debito CA']);
  assert.strictEqual(filas[1].moneda, 'USD');
});

test('validarMovimientos: solo números, sin repetidos, ignora filas vacías', () => {
  assert.deepStrictEqual(ip.validarMovimientos([{ movcod: ' 25030 ', descripcion: 'x' }, { movcod: '', descripcion: '' }]), [{ movcod: '25030', descripcion: 'x' }]);
  assert.throws(() => ip.validarMovimientos([{ movcod: 'abc' }]), /inválido/);
  assert.throws(() => ip.validarMovimientos([{ movcod: '1' }, { movcod: '1' }]), /repetido/);
});

test('generar: con saldo / sin saldo y una sola consulta de saldos', async () => {
  const consultas = [];
  const querySybase = async (sql) => {
    consultas.push(sql);
    if (/tgl_saldodia_oper/.test(sql)) return [{ cuecod: 160588, sistcod: 5, moncod: 0, sdodiaope: '1500.00' }, { cuecod: 700, sistcod: 5, moncod: 2, sdodiaope: '10.00' }];
    return [fila(), fila({ comnro: '178901', moncod: 2, cuecod: '700', importedeb: '50' }), fila({ comnro: '178902', cuecod: '999', movcod: '25032' })];
  };
  const r = await ip.generar({ querySybase, ahora: '2026-11-25 10:00:00', movimientos: movs });
  assert.strictEqual(consultas.filter((q) => /tgl_saldodia_oper/.test(q)).length, 1);
  assert.deepStrictEqual(r.filas.map((f) => f.saldo.conSaldo), [true, false, false]);
  assert.deepStrictEqual([r.resumen.total.n, r.resumen.conSaldo.n, r.resumen.sinSaldo.n, r.resumen.conSaldo.ARS, r.resumen.sinSaldo.USD, r.resumen.sinSaldo.nARS], [3, 1, 2, 100000, 5000, 1]);
});

test('saldo a reclamar: importe - saldo disponible (0 si alcanza; todo el importe sin saldo del día)', () => {
  assert.strictEqual(ip.saldoAReclamar({ importe: 100000, saldo: { conSaldo: true, sdodiaope: 150000 } }), 0);
  assert.strictEqual(ip.saldoAReclamar({ importe: 100000, saldo: { conSaldo: false, sdodiaope: 30000 } }), 70000);
  assert.strictEqual(ip.saldoAReclamar({ importe: 100000, saldo: { conSaldo: false, sdodiaope: null } }), 100000);
  assert.strictEqual(ip.saldoAReclamar({ importe: 100000, saldo: null }), null);
  const r = ip.resumir([{ moneda: 'ARS', importe: 100000, saldo: { conSaldo: false }, aReclamar: 70000 }, { moneda: 'USD', importe: 5000, saldo: { conSaldo: true }, aReclamar: 0 }]);
  assert.deepStrictEqual([r.aReclamar.n, r.aReclamar.ARS, r.aReclamar.USD], [1, 70000, 0]);
});
