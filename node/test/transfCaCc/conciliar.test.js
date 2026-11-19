'use strict';
const test = require('node:test');
const assert = require('node:assert');
const config = require('../../lib/transfCaCc/config');
const ibs = require('../../lib/transfCaCc/ibs');
const { conciliar, TIPOS } = require('../../lib/transfCaCc/conciliar');
const calculo = require('../../../wwwroot/transf-ca-cc-calculo');

// Filas como las devuelve la consulta de IBS.
const mov = (comnro, fecha, movcod, importe, { moncod = 0, cuecod = 5001, usr = '123123123', sistcod = 5 } = {}) => ({
  usrident: usr, sistcod, moncod, cuecod, Fecha_Mov: fecha, comnro, movcod, signo: movcod === 25030 ? -1 : 1, accimp: importe, Importe: (movcod === 25030 ? -1 : 1) * importe,
});
const pend = (comnro, importe, { moncod = 0, cuecod = 5001, fecorigen = '16/11/2026 0:00:00.000', movcod = 25030 } = {}) => ({
  fecreal: '', tercod: '', succod: 1, sistcod: 5, moncod, cuecod, movcod, descdet: 'Sin saldo', fecproceso: fecorigen, comnro, nromen: 1, mentexto: 'SIN SALDO', importedeb: importe, fecenlace: '', fecorigen,
});
const op = (comprobante, fecha, monto, { moncod = '0', cuecod = '5001', estado = 'APPROVED' } = {}) => ({
  comprobante: String(comprobante), moncod, cuecod, monto: Math.round(monto * 100), estado, creada: `${fecha} 10:00:00`, ejecutada: estado === 'APPROVED' ? `${fecha} 10:00:00` : '', fecha, error: '',
});

function armar() {
  const movFilas = [
    mov(100, '15/11/2026', 25030, 1000),
    mov(101, '16/11/2026', 25030, 2000),
    mov(102, '16/11/2026', 25030, 50, { moncod: 2, cuecod: 7001 }),
    mov(103, '16/11/2026', 25030, 0.01), // 1 centavo de una operación de BankService
    mov(99999, '16/11/2026', 25030, 15),
    mov(99999, '16/11/2026', 25030, 100000, { usr: 'operador1' }),
    mov(99998, '16/11/2026', 25031, 15),
    mov(99997, '16/11/2026', 25031, 0.01), // Activar Cuentas
    mov(200, '16/11/2026', 25030, 300), // débito de una FAILED
    mov(105, '16/11/2026', 25030, 999, { cuecod: 9999 }), // cuenta distinta e importe distinto
    mov(1, '16/11/2026', 25030, 5, { sistcod: 3 }), // débito de otro sistema: también entra
    mov(100, '15/11/2026', 25031, 1000, { sistcod: 3, cuecod: 11000492 }), // contrapartida en la CC: no es excepción
    mov(98, '16/11/2026', 25031, 40, { sistcod: 3, cuecod: 11000492 }), // crédito en la CC sin operación
  ];
  const pendFilas = [
    pend(104, 700, { fecorigen: '16/11/2026 0:00:00.000' }),
    pend(106, 800, { fecorigen: '9/10/2026 0:00:00.000' }),
    pend(158871, 10, { fecorigen: '17/11/2026 0:00:00.000' }),
    pend(101, 2000),
    pend(5, 1, { movcod: 999 }),
  ];
  const operaciones = [
    op(100, '2026-11-15', 1000), op(101, '2026-11-16', 2000), op(102, '2026-11-16', 50, { moncod: '2', cuecod: '7001' }),
    op(103, '2026-11-16', 0.01), op(104, '2026-11-16', 750), op(106, '2026-10-09', 800),
    op(105, '2026-11-16', 1000), op(90, '2026-11-14', 10), op(500, '2026-11-16', 10),
    op(200, '2026-11-16', 300, { estado: 'FAILED' }), op(201, '2026-11-16', 30, { estado: 'FAILED' }),
    op(300, '2026-11-16', 30, { estado: 'PENDING_EXECUTION' }),
  ];
  const m = ibs.normalizarMovimientos(movFilas, config);
  const p = ibs.normalizarPendientes(pendFilas, config);
  const r = conciliar({ movimientos: m.movimientos, pendientes: p.pendientes, operaciones, config });
  return { m, p, r, datos: { ...r, config: { movDebito: config.movDebito, movCredito: config.movCredito } } };
}

const tiposDe = (r, comprobante) => r.excepciones.filter((e) => e.comprobante === String(comprobante)).map((e) => e.tipo).sort();
const clase = (r, c) => r.operaciones.find((o) => o.comprobante === String(c)).clase;

test('normalización: toma todos los sistcod y avisa movcod de pendientes no aplicables', () => {
  const { m, p } = armar();
  assert.ok(m.movimientos.some((x) => x.comprobante === '1' && x.sistcod === '3'));
  assert.ok(p.avisos.some((a) => /movcod 999/.test(a)));
  assert.strictEqual(p.pendientes.find((x) => x.comprobante === '106').fechaOrigen, '2026-10-09');
});

test('corte: último día de IBS y mayor comprobante de los débitos', () => {
  const { r } = armar();
  assert.strictEqual(r.corte.ultimoDiaIbs, '2026-11-16');
  assert.strictEqual(r.corte.mayorComprobante, 99999);
});

test('clasificación de las APPROVED', () => {
  const { r } = armar();
  assert.strictEqual(clase(r, 100), 'ejecutada');
  assert.strictEqual(clase(r, 103), 'ejecutada'); // 1 centavo con operación: es una transferencia
  assert.strictEqual(clase(r, 104), 'pendiente');
  assert.strictEqual(r.operaciones.find((o) => o.comprobante === '104').subclase, 'ultimoDia');
  assert.strictEqual(r.operaciones.find((o) => o.comprobante === '106').subclase, 'anterior');
  assert.strictEqual(clase(r, 90), 'sinRegistro'); // comprobante menor al mayor de IBS
  assert.strictEqual(clase(r, 500), 'sinRegistro'); // 500 < 99999
});

test('sin registro vs pendiente de contabilizar se decide por la secuencia de comprobantes', () => {
  const { m, p } = armar();
  const r = conciliar({ movimientos: m.movimientos, pendientes: p.pendientes, operaciones: [op(100000, '2026-11-16', 5), op(100001, '2026-11-15', 5)], config });
  assert.strictEqual(clase(r, 100000), 'porContabilizar');
  assert.strictEqual(clase(r, 100001), 'sinRegistro'); // fecha anterior al último día de IBS
});

test('excepciones', () => {
  const { r } = armar();
  assert.deepStrictEqual(tiposDe(r, 99999), [TIPOS.DEBITO_MANUAL, TIPOS.DEBITO_SIN_OPERACION, TIPOS.DEBITO_SIN_OPERACION, TIPOS.MAS_DE_UN_DEBITO].sort());
  assert.deepStrictEqual(tiposDe(r, 99998), [TIPOS.CREDITO_RELEVANTE]);
  assert.match(r.excepciones.find((e) => e.comprobante === '99998').detalle, /sin operación en BankService/);
  assert.deepStrictEqual(tiposDe(r, 99997), []); // Activar Cuentas
  assert.deepStrictEqual(tiposDe(r, 100), []); // crédito contrapartida de sistcod 3
  assert.deepStrictEqual(tiposDe(r, 98), [TIPOS.CREDITO_RELEVANTE]);
  assert.match(r.excepciones.find((e) => e.comprobante === '98').detalle, /sistcod 3/);
  assert.deepStrictEqual(tiposDe(r, 104), [TIPOS.PEND_IMPORTE]);
  assert.deepStrictEqual(tiposDe(r, 105), [TIPOS.CUENTA, TIPOS.IMPORTE].sort());
  assert.deepStrictEqual(tiposDe(r, 101), [TIPOS.PEND_DEBITADO]);
  assert.deepStrictEqual(tiposDe(r, 158871), [TIPOS.PEND_SIN_OPERACION]);
  assert.deepStrictEqual(tiposDe(r, 200), [TIPOS.DEBITO_FAILED]);
  assert.deepStrictEqual(tiposDe(r, 300), [TIPOS.SIN_EJECUTAR]);
  assert.deepStrictEqual(tiposDe(r, 90), [TIPOS.SIN_REGISTRO]);
});

test('indicadores: control, Activar Cuentas y FAILED en IBS', () => {
  const { datos } = armar();
  const ind = calculo.indicadores(datos, '');
  const t = ind.total;
  assert.strictEqual(t(ind.bs.aprobadas), 9);
  assert.strictEqual(ind.bs.control.diferencia, 0);
  assert.strictEqual(t(ind.bs.ejecutadas), 5); // 100, 101, 102, 103, 105
  assert.strictEqual(t(ind.bs.pendientes), 2); // 104, 106
  assert.strictEqual(t(ind.bs.sinRegistro), 2); // 90, 500
  assert.strictEqual(ind.bs.failed, 2);
  assert.strictEqual(ind.bs.failedEnIbs, 1);
  assert.strictEqual(ind.activar.creditos[0], 1);
  assert.strictEqual(ind.activar.debitos[0], 1); // el de 103 (con operación)
  assert.strictEqual(ind.activar.sinOperacion, 1);
  assert.strictEqual(ind.ibs.creditos[0], 3); // 99998 y los dos de sistcod 3 (el de 1 centavo no cuenta)
  assert.strictEqual(ind.ibs.manuales[0], 1);
  assert.strictEqual(ind.ibs.importeManuales[0], 10000000);
  assert.strictEqual(ind.bs.importePendiente[0], 70000 + 80000);
});

test('filtro por día y saldo de pendientes con acumulado dentro del período', () => {
  const { datos } = armar();
  const ind = calculo.indicadores(datos, '2026-11-15');
  assert.strictEqual(ind.total(ind.bs.aprobadas), 1);
  assert.strictEqual(ind.total(ind.ibs.debitos), 1);
  const { saldo, grafico } = calculo.porDia(datos, '2026-10-01', '2026-11-30');
  assert.deepStrictEqual(saldo.map((s) => [s.fecha, s.nPend[0], s.importePend[0], s.acumulado[0]]), [['2026-10-09', 1, 80000, 80000], ['2026-11-16', 1, 70000, 150000]]);
  const solo16 = calculo.porDia(datos, '2026-11-16', '2026-11-16').saldo;
  assert.strictEqual(solo16[0].acumulado[0], 70000);
  assert.ok(grafico.find((g) => g.fecha === '2026-11-16').ejecutadas >= 3);
});

test('débito imputado en fecha posterior: cruza como ejecutada, no mueve el corte ni los indicadores de IBS', () => {
  const m = ibs.normalizarMovimientos([mov(10, '16/11/2026', 25030, 100)], config).movimientos;
  const post = ibs.normalizarMovimientos([mov(9, '18/11/2026', 25030, 50)], config).movimientos.map((x) => ({ ...x, posterior: true }));
  const r = conciliar({ movimientos: [...m, ...post], pendientes: [], operaciones: [op(10, '2026-11-16', 100), op(9, '2026-11-13', 50)], config });
  assert.strictEqual(r.corte.ultimoDiaIbs, '2026-11-16');
  const o9 = r.operaciones.find((o) => o.comprobante === '9');
  assert.strictEqual(o9.clase, 'ejecutada');
  assert.strictEqual(o9.posterior, true);
  assert.deepStrictEqual(r.excepciones, []);
  const ind = calculo.indicadores({ ...r, config: { movDebito: '25030', movCredito: '25031' } }, '');
  assert.strictEqual(ind.total(ind.ibs.debitos), 1);
  assert.strictEqual(ind.total(ind.bs.posteriores), 1);
  assert.strictEqual(ind.bs.control.diferencia, 0);
});

test('consulta de posteriores: misma consulta, por moneda y comprobantes', () => {
  const q = ibs.consultaPosteriores('2026-10-06', '2026-11-19', '0', ['572', '573'], config);
  assert.match(q, /a\.fecmov >= '20261006' and a\.fecmov < '20261119'/);
  assert.match(q, /a\.moncod = 0/);
  assert.match(q, /a\.comnro in \(572,573\)/);
  assert.throws(() => ibs.consultaPosteriores('2026-10-06', '2026-11-19', '0', ['1; drop'], config));
});
