'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sc = require('../lib/saldosCuentas');
const ci = require('../lib/conciliacionIbs');
const { conciliar: conciliarLoop, TIPOS: TL } = require('../lib/transfCaCc/conciliar');
const { conciliar: conciliarFx, TIPOS: TF } = require('../lib/fx/conciliar');
const fxConfig = require('../lib/fx/config');

const filas = [
  { cuecod: '160588', sistcod: '5', moncod: '0', sdodiaope: '1500.00', sdodiacon: '1500.00' },
  { cuecod: '75848', sistcod: 5, moncod: 2, sdodiaope: null, sdodiacon: null },
];

test('consulta de saldos: arma el filtro por cuenta y valida', () => {
  const q = sc.buildSaldosCuentasQuery(['160588', '0075848']);
  assert.match(q, /c\.cuecod in \(160588, 75848\)/);
  assert.match(q, /sdh\.sdodiaope/);
  assert.throws(() => sc.buildSaldosCuentasQuery(['1; drop']));
});

test('evaluar: con saldo si sdodiaope alcanza; sin saldo si no alcanza o no hay saldo del día', () => {
  const saldos = sc.leerSaldosCuentas(filas);
  assert.strictEqual(sc.evaluarPendiente(saldos, { sistcod: '5', moncod: '0', cuecod: '160588', cents: 150000 }).conSaldo, true);
  assert.strictEqual(sc.evaluarPendiente(saldos, { sistcod: '5', moncod: '0', cuecod: '160588', cents: 150001 }).conSaldo, false);
  assert.strictEqual(sc.evaluarPendiente(saldos, { sistcod: '5', moncod: '2', cuecod: '75848', cents: 1 }).conSaldo, false);
  assert.strictEqual(sc.evaluarPendiente(null, { cuecod: '1', cents: 1 }), null);
});

test('transferencias con IBS: "Débito pendiente con saldo" / "sin saldo"', () => {
  const api = [{ id_comprobante: '16319', realizado: 's', ejecutado_en: '2026-11-04 10:00:00', estado_codigo: 'ACREDITADO', estado_descripcion: 'ACREDITADO', moneda: '032', importe: '1000.00', debito_cuit: '1', credito_cuit: '1', debito_cbu: '3120000100000001605881', id_operacion: 'A1' }];
  const ibs = ci.ibsRowsToLines([], { conConcod: true });
  const pend = () => [{ comnro: '16319', sistcod: '5', moncod: '0', cuecod: '160588', cents: 100000, motivo: 'Sin saldo', fechaOrigen: '04/11/2026' }];
  const conSaldo = ci.conciliarTransferencias(api, ibs, { desde: '2026-11-04', hasta: '2026-11-04', hoy: '2026-11-17', debitosPendientes: pend(), saldos: sc.leerSaldosCuentas(filas) });
  assert.deepStrictEqual(conSaldo.diferencias.map((d) => d.tipo), ['Débito pendiente con saldo']);
  assert.match(conSaldo.diferencias[0].detalle, /Saldo disponible \(sdodiaope\) 1\.500,00: alcanza/);
  assert.strictEqual(conSaldo.resumen.debitosPendientesConSaldo, 1);
  const sinSaldo = ci.conciliarTransferencias(api, ibs, { desde: '2026-11-04', hasta: '2026-11-04', hoy: '2026-11-17', debitosPendientes: pend(), saldos: sc.leerSaldosCuentas([{ ...filas[0], sdodiaope: '10' }]) });
  assert.deepStrictEqual(sinSaldo.diferencias.map((d) => d.tipo), ['Débito pendiente sin saldo']);
  assert.strictEqual(sinSaldo.resumen.debitosPendientesSinSaldo, 1);
  const sinConsulta = ci.conciliarTransferencias(api, ibs, { desde: '2026-11-04', hasta: '2026-11-04', hoy: '2026-11-17', debitosPendientes: pend() });
  assert.deepStrictEqual(sinConsulta.diferencias.map((d) => d.tipo), ['Débito pendiente en IBS']);
});

test('Loop y FX: el tipo del pendiente según el saldo', () => {
  const saldo = (conSaldo) => ({ conSaldo, sdodiaope: 1, texto: conSaldo ? 'alcanza' : 'no alcanza' });
  const loopConfig = require('../lib/transfCaCc/config');
  const ibsLoop = require('../lib/transfCaCc/ibs');
  const pendLoop = ibsLoop.normalizarPendientes([{ sistcod: 5, moncod: 0, cuecod: 5001, movcod: 25030, comnro: 61, importedeb: 1000, fecorigen: '16/11/2026 0:00:00.000', mentexto: 'SIN SALDO' }], loopConfig).pendientes;
  pendLoop[0].saldo = saldo(false);
  const loop = conciliarLoop({
    movimientos: [],
    pendientes: pendLoop,
    operaciones: [{ comprobante: '61', moncod: '0', cuecod: '5001', monto: 100000, estado: 'APPROVED', creada: '2026-11-16 10:00:00', ejecutada: '2026-11-16 10:00:00', fecha: '2026-11-16', error: '' }],
    config: loopConfig,
  });
  assert.ok(loop.excepciones.some((e) => e.tipo === TL.DEBITO_PENDIENTE_SIN_SALDO), JSON.stringify(loop.excepciones.map((e) => e.tipo)));
  const movs = fxConfig.lados[0].movs.filter((m) => m.cod !== '25003').map((m) => ({ usuario: '123123123', moncod: m.moneda === 'USD' ? '2' : '0', cuecod: '5000', fecha: '2026-11-04', comprobante: '11', movcod: m.cod, signo: 1, importe: m.moneda === 'USD' ? 1000 : 1600000 }));
  const fx = conciliarFx({
    movimientos: movs,
    pendientes: [{ moncod: '0', cuecod: '5000', comprobante: '11', movcod: '25003', importe: 1600000, fechaOrigen: '2026-11-04', motivo: 'x', saldo: saldo(true) }],
    ordenes: [{ id: 'fxo_11', comprobante: '11', status: 'COMPLETED', side: 'BUY', ars: 1600000, usd: 1000, fecha: '2026-11-04', cuit: '1' }],
    config: fxConfig,
  });
  assert.ok(fx.excepciones.some((e) => e.tipo === TF.PENDIENTE_CON_SALDO), JSON.stringify(fx.excepciones.map((e) => e.tipo)));
});

test('consultarSaldos: una sola consulta para todas las cuentas', async () => {
  const consultas = [];
  const pendientes = Array.from({ length: 450 }, (_, i) => ({ cuecod: String(1000 + (i % 400)) }));
  await sc.consultarSaldos(async (q) => { consultas.push(q); return []; }, pendientes);
  assert.strictEqual(consultas.length, 1);
  assert.strictEqual((consultas[0].match(/c\.cuecod in \(([^)]*)\)/)[1].split(',')).length, 400);
  assert.strictEqual((await sc.consultarSaldos(async () => { throw new Error('no'); }, [])).size, 0);
});
