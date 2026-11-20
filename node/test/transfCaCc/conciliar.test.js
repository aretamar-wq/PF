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
  assert.deepStrictEqual(tiposDe(r, 104), [TIPOS.DEBITO_PENDIENTE, TIPOS.PEND_IMPORTE, TIPOS.CREDITO_FALTANTE_PENDIENTE].sort());
  assert.match(r.excepciones.find((e) => e.comprobante === '104' && e.tipo === TIPOS.DEBITO_PENDIENTE).detalle, /Falta el débito en IBS: está en débitos pendientes/);
  assert.ok(tiposDe(r, 101).includes(TIPOS.CREDITO_FALTANTE)); // tiene débito y no tiene crédito
  assert.deepStrictEqual(tiposDe(r, 105), [TIPOS.CUENTA, TIPOS.CREDITO_FALTANTE, TIPOS.IMPORTE].sort());
  assert.deepStrictEqual(tiposDe(r, 101), [TIPOS.CREDITO_FALTANTE, TIPOS.PEND_DEBITADO].sort());
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
  assert.strictEqual(ind.activar.debitos[0], 0); // el de 103 tiene operación: va con las transferencias
  assert.strictEqual(ind.activar.sinOperacion, 1);
  assert.strictEqual(ind.ibs.creditos[0], 1); // solo el de la operación 100 de BankService (99998 y 98 no están)
  assert.strictEqual(ind.ibs.manuales[0], 0); // el manual del 99999 no es de una operación de BankService
  assert.strictEqual(ind.ibs.debitos[0], 5); // APPROVED 100, 101, 103, 105 y la FAILED 200 (99999 y 1 no tienen operación)
  assert.strictEqual(ind.bs.importePendiente[0], 70000 + 80000);
  assert.strictEqual(ind.bs.importeAprobadas[2], 5000); // la 102 en USD
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

test('movimientos imputados en fecha posterior: cruzan, suman en IBS en el día de la operación y no mueven el corte', () => {
  const m = ibs.normalizarMovimientos([mov(10, '16/11/2026', 25030, 100), mov(10, '16/11/2026', 25031, 100, { sistcod: 3 })], config).movimientos;
  const post = ibs.normalizarMovimientos([mov(9, '18/11/2026', 25030, 50), mov(9, '18/11/2026', 25031, 50, { sistcod: 3 })], config).movimientos.map((x) => ({ ...x, posterior: true }));
  const r = conciliar({ movimientos: [...m, ...post], pendientes: [], operaciones: [op(10, '2026-11-16', 100), op(9, '2026-11-13', 50)], config });
  assert.strictEqual(r.corte.ultimoDiaIbs, '2026-11-16');
  const o9 = r.operaciones.find((o) => o.comprobante === '9');
  assert.strictEqual(o9.clase, 'ejecutada');
  assert.strictEqual(o9.posterior, true);
  assert.deepStrictEqual(r.excepciones, []);
  const ind = calculo.indicadores({ ...r, config: { movDebito: '25030', movCredito: '25031' } }, '');
  assert.strictEqual(ind.total(ind.ibs.debitos), 2);
  assert.strictEqual(ind.total(ind.ibs.creditos), 2);
  assert.strictEqual(ind.ibs.saldoDebitos[0], 15000);
  assert.strictEqual(ind.total(ind.ibs.posteriores), 2);
  const del13 = calculo.indicadores({ ...r, config: { movDebito: '25030', movCredito: '25031' } }, '2026-11-13');
  assert.strictEqual(del13.total(del13.ibs.debitos), 1); // el posterior cuenta en el día de su operación
  assert.strictEqual(del13.total(del13.ibs.creditos), 1);
  assert.strictEqual(ind.bs.control.diferencia, 0);
});

test('consulta de posteriores: misma consulta, por moneda y comprobantes', () => {
  const q = ibs.consultaPosteriores('2026-10-06', '2026-11-19', '0', ['572', '573'], config);
  assert.match(q, /a\.fecmov >= '20261006' and a\.fecmov < '20261119'/);
  assert.match(q, /a\.moncod = 0/);
  assert.match(q, /a\.comnro in \(572,573\)/);
  assert.throws(() => ibs.consultaPosteriores('2026-10-06', '2026-11-19', '0', ['1; drop'], config));
});

test('semáforos: rojo con diferencias, amarillo con pendientes, verde si está todo bien', () => {
  const { datos } = armar();
  const s = calculo.semaforos(calculo.indicadores(datos, ''));
  assert.strictEqual(s.ibs.color, 'rojo');
  assert.strictEqual(s.bs.color, 'rojo');
  assert.ok(s.bs.motivos.some((m) => /APPROVED sin registro/.test(m)));
  assert.strictEqual(s.activar.color, 'amarillo');
  const soloPend = conciliar({ movimientos: [], pendientes: ibs.normalizarPendientes([pend(5, 10)], config).pendientes, operaciones: [op(5, '2026-11-16', 10)], config });
  const s2 = calculo.semaforos(calculo.indicadores({ ...soloPend, config: { movDebito: '25030', movCredito: '25031' } }, ''));
  assert.deepStrictEqual([s2.ibs.color, s2.bs.color, s2.activar.color], ['amarillo', 'amarillo', 'verde']);
  const ok = conciliar({ movimientos: ibs.normalizarMovimientos([mov(5, '16/11/2026', 25030, 10), mov(5, '16/11/2026', 25031, 10, { sistcod: 3 })], config).movimientos, pendientes: [], operaciones: [op(5, '2026-11-16', 10)], config });
  const s3 = calculo.semaforos(calculo.indicadores({ ...ok, config: { movDebito: '25030', movCredito: '25031' } }, ''));
  assert.deepStrictEqual([s3.ibs.color, s3.bs.color, s3.activar.color], ['verde', 'verde', 'verde']);
});

test('historia: resumen por día del período (lo que se guarda en transf_ca_cc_dias)', () => {
  const { resumenPorDia } = require('../../lib/transfCaCc/servicio');
  const { datos } = armar();
  const dias = resumenPorDia({ ...datos, rango: { desde: '2026-11-01', hasta: '2026-11-17' } });
  assert.deepStrictEqual(dias.map((d) => d.fecha), ['2026-11-14', '2026-11-15', '2026-11-16']);
  const d16 = dias.find((d) => d.fecha === '2026-11-16');
  assert.strictEqual(d16.aprobadas, d16.ejecutadas + d16.pendientes + d16.sinRegistro + d16.porContabilizar);
  assert.strictEqual(d16.importePendArs, 70000);
  assert.strictEqual(d16.semaforoBs, 'rojo');
  assert.ok(d16.porTipo['Transfer sin ejecutar'] >= 1);
});

test('operaciones de sábado, domingo o feriado se asignan al próximo día hábil', () => {
  const { aDiaHabil } = require('../../lib/transfCaCc/servicio');
  const ops = aDiaHabil([op(1, '2026-11-14', 10), op(2, '2026-11-15', 10), op(3, '2026-11-20', 10), op(4, '2026-11-18', 10)], new Set(['2026-11-20']));
  assert.deepStrictEqual(ops.map((o) => [o.fecha, o.fechaOriginal]), [['2026-11-16', '2026-11-14'], ['2026-11-16', '2026-11-15'], ['2026-11-23', '2026-11-20'], ['2026-11-18', undefined]]);
  const r = conciliar({ movimientos: ibs.normalizarMovimientos([mov(9, '16/11/2026', 25030, 1)], config).movimientos, pendientes: [], operaciones: ops.slice(0, 1), config });
  const e = r.excepciones.find((x) => x.comprobante === '1');
  assert.strictEqual(e.fecha, '2026-11-16');
  assert.match(e.detalle, /Operación del 14\/11\/2026 \(no hábil\)/);
});

test('1 centavo: con operación en BankService va con las transferencias; sin operación, a Activar Cuentas', () => {
  const m = ibs.normalizarMovimientos([mov(10, '16/11/2026', 25030, 100), mov(11, '16/11/2026', 25030, 0.01), mov(12, '16/11/2026', 25031, 0.01)], config).movimientos;
  const r = conciliar({ movimientos: m, pendientes: [], operaciones: [op(10, '2026-11-16', 100)], config });
  const ind = calculo.indicadores({ ...r, config: { movDebito: '25030', movCredito: '25031' } }, '');
  assert.strictEqual(ind.ibs.debitos[0], 1);
  assert.strictEqual(ind.ibs.saldoDebitos[0], 10000);
  assert.strictEqual(ind.ibs.creditos[0], 0); // los créditos siguen sin los de 1 centavo
  assert.strictEqual(ind.activar.debitos[0], 1);
});

test('Comprobantes: las operaciones de BankService del día sin las de 1 centavo, con detalle por estado', () => {
  const r = conciliar({ movimientos: [], pendientes: [], operaciones: [op(1, '2026-11-16', 10), op(2, '2026-11-16', 0.01), op(3, '2026-11-16', 5, { estado: 'FAILED' }), op(4, '2026-11-16', 7, { moncod: '2' }), op(5, '2026-11-13', 7)], config });
  const ind = calculo.indicadores({ ...r, config: { movDebito: '25030', movCredito: '25031' } }, '2026-11-16');
  assert.deepStrictEqual([ind.ibs.comprobantes[0], ind.ibs.comprobantes[2]], [2, 1]);
  assert.deepStrictEqual(ind.ibs.comprobantesEstado, { APPROVED: 2, FAILED: 1, PENDING_EXECUTION: 0 });
});

test('1 centavo con operación en BankService suma en Débitos / Créditos de Transferencias Loop', () => {
  const m = ibs.normalizarMovimientos([mov(20, '16/11/2026', 25030, 0.01), mov(20, '16/11/2026', 25031, 0.01, { sistcod: 3 }), mov(21, '16/11/2026', 25031, 0.01)], config).movimientos;
  const r = conciliar({ movimientos: m, pendientes: [], operaciones: [op(20, '2026-11-16', 0.01)], config });
  const ind = calculo.indicadores({ ...r, config: { movDebito: '25030', movCredito: '25031' } }, '');
  assert.deepStrictEqual([ind.ibs.debitos[0], ind.ibs.creditos[0], ind.ibs.saldoDebitos[0]], [1, 1, 1]);
  assert.deepStrictEqual([ind.activar.debitos[0], ind.activar.creditos[0], ind.activar.comprobantes[0]], [0, 1, 1]);
  assert.strictEqual(r.operaciones[0].clase, 'ejecutada');
});

test('BankService manda: un débito del día de una operación anterior (ex pendiente) no suma en el día ni es excepción', () => {
  const m = ibs.normalizarMovimientos([
    mov(30, '16/11/2026', 25030, 100), mov(30, '16/11/2026', 25031, 100, { sistcod: 3 }), // operación del día
    mov(25, '16/11/2026', 25030, 70, { usr: '36077255' }), mov(25, '16/11/2026', 25031, 70, { sistcod: 3 }), // operación del 13/11 que estaba pendiente
    mov(77, '16/11/2026', 25030, 5), // sin operación en BankService
  ], config).movimientos;
  const r = conciliar({ movimientos: m, pendientes: [], operaciones: [op(30, '2026-11-16', 100), op(25, '2026-11-13', 70)], config });
  const ind = calculo.indicadores({ ...r, config: { movDebito: '25030', movCredito: '25031' } }, '2026-11-16');
  assert.deepStrictEqual([ind.ibs.debitos[0], ind.ibs.creditos[0]], [1, 1]); // solo la operación del día
  assert.ok(r.excepciones.some((e) => e.comprobante === '77' && e.tipo === 'Débito sin operación en BankService'));
  assert.ok(!r.excepciones.some((e) => e.comprobante === '25' && e.tipo !== 'Débito manual'));
});

test('colores de Débitos y Créditos contra BankService: verde, amarillo por pendientes, rojo por diferencias', () => {
  const colores = (movFilas, pendFilas, ops) => {
    const r = conciliar({ movimientos: ibs.normalizarMovimientos(movFilas, config).movimientos, pendientes: ibs.normalizarPendientes(pendFilas, config).pendientes, operaciones: ops, config });
    return calculo.coloresTransferencias(calculo.indicadores({ ...r, config: { movDebito: '25030', movCredito: '25031' } }, '2026-11-16'));
  };
  const par = (c, imp) => [mov(c, '16/11/2026', 25030, imp), mov(c, '16/11/2026', 25031, imp, { sistcod: 3 })];
  // Todo coincide
  let c = colores([...par(1, 10), ...par(2, 20)], [], [op(1, '2026-11-16', 10), op(2, '2026-11-16', 20)]);
  assert.deepStrictEqual([c.debitos, c.creditos, c.saldoDebitos[0], c.saldoCreditos[0], c.pendientes], ['ok', 'ok', 'ok', 'ok', 'ok']);
  // La 2 tiene débito pendiente: amarillo
  c = colores(par(1, 10), [pend(2, 20)], [op(1, '2026-11-16', 10), op(2, '2026-11-16', 20)]);
  assert.deepStrictEqual([c.debitos, c.creditos, c.saldoDebitos[0], c.saldoCreditos[0], c.pendientes, c.saldoPendientes[0]], ['warn', 'warn', 'warn', 'warn', 'warn', 'warn']);
  // La 2 no tiene débito ni pendiente (sin registro): rojo
  c = colores(par(5, 10), [], [op(5, '2026-11-16', 10), op(2, '2026-11-16', 20)]); // 2 < 5: sin registro
  assert.deepStrictEqual([c.debitos, c.saldoDebitos[0]], ['err', 'err']);
  // Importe distinto: la cantidad coincide, el importe no
  c = colores(par(1, 15), [], [op(1, '2026-11-16', 10)]);
  assert.deepStrictEqual([c.debitos, c.saldoDebitos[0]], ['ok', 'err']);
});

test('semáforo de Transferencias Loop: el más crítico entre excepciones e indicadores', () => {
  const sem = (movFilas, pendFilas, ops) => {
    const r = conciliar({ movimientos: ibs.normalizarMovimientos(movFilas, config).movimientos, pendientes: ibs.normalizarPendientes(pendFilas, config).pendientes, operaciones: ops, config });
    return calculo.semaforos(calculo.indicadores({ ...r, config: { movDebito: '25030', movCredito: '25031' } }, '2026-11-16')).transferencias;
  };
  const par = (c, imp) => [mov(c, '16/11/2026', 25030, imp), mov(c, '16/11/2026', 25031, imp, { sistcod: 3 })];
  assert.strictEqual(sem(par(1, 10), [], [op(1, '2026-11-16', 10)]).color, 'verde');
  assert.strictEqual(sem(par(1, 10), [pend(2, 20)], [op(1, '2026-11-16', 10), op(2, '2026-11-16', 20)]).color, 'amarillo');
  // Solo falta el crédito (sin excepción): el indicador de créditos queda en rojo y el semáforo también.
  const s = sem([mov(1, '16/11/2026', 25030, 10)], [], [op(1, '2026-11-16', 10)]);
  assert.strictEqual(s.color, 'rojo');
  assert.ok(s.motivos.some((m) => /Créditos 25031/.test(m)));
});

test('créditos: más de uno, importe distinto y crédito sin débito figuran en Excepciones, en el día de la operación', () => {
  const m = ibs.normalizarMovimientos([
    mov(40, '16/11/2026', 25030, 100), mov(40, '16/11/2026', 25031, 100, { sistcod: 3 }), mov(40, '17/11/2026', 25031, 100, { sistcod: 3 }),
    mov(41, '16/11/2026', 25030, 50), mov(41, '16/11/2026', 25031, 45, { sistcod: 3 }),
    mov(42, '16/11/2026', 25031, 70, { sistcod: 3 }),
    mov(43, '18/11/2026', 25030, 80), mov(43, '18/11/2026', 25031, 81, { sistcod: 3 }),
  ], config).movimientos.map((x) => (x.comprobante === '43' ? { ...x, posterior: true } : x));
  const r = conciliar({ movimientos: m, pendientes: [], operaciones: [op(40, '2026-11-16', 100), op(41, '2026-11-16', 50), op(42, '2026-11-16', 70), op(43, '2026-11-16', 80)], config });
  assert.deepStrictEqual(tiposDe(r, 40), [TIPOS.MAS_DE_UN_CREDITO]);
  assert.deepStrictEqual(tiposDe(r, 41), [TIPOS.CREDITO_IMPORTE]);
  assert.ok(tiposDe(r, 42).includes(TIPOS.CREDITO_SIN_DEBITO));
  // El débito y el crédito del 18/11 son de una operación del 16/11: la excepción va al 16/11.
  const e43 = r.excepciones.find((e) => e.comprobante === '43');
  assert.strictEqual(e43.tipo, TIPOS.CREDITO_IMPORTE);
  assert.strictEqual(e43.fecha, '2026-11-16');
  assert.match(e43.detalle, /18\/11\/2026/);
});

test('Excepciones a revisar: llevan el CUIT del titular de la operación de BankService', () => {
  const r = conciliar({ movimientos: ibs.normalizarMovimientos([mov(50, '16/11/2026', 25030, 99)], config).movimientos, pendientes: [], operaciones: [{ ...op(50, '2026-11-16', 100), cuit: '20321655271' }], config });
  assert.ok(r.excepciones.length > 0);
  assert.ok(r.excepciones.every((e) => e.cuit === '20321655271'));
  const sinOp = conciliar({ movimientos: ibs.normalizarMovimientos([mov(51, '16/11/2026', 25030, 99)], config).movimientos, pendientes: [], operaciones: [], config });
  assert.strictEqual(sinOp.excepciones[0].cuit, '');
});

test('crédito sin débito con el débito en pendientes: no es excepción y el crédito cuenta en verde', () => {
  const m = ibs.normalizarMovimientos([mov(60, '16/11/2026', 25030, 10), mov(60, '16/11/2026', 25031, 10, { sistcod: 3 }), mov(61, '16/11/2026', 25031, 20, { sistcod: 3 })], config).movimientos;
  const p = ibs.normalizarPendientes([pend(61, 20)], config).pendientes;
  const r = conciliar({ movimientos: m, pendientes: p, operaciones: [op(60, '2026-11-16', 10), op(61, '2026-11-16', 20)], config });
  assert.ok(!r.excepciones.some((e) => e.tipo === TIPOS.CREDITO_SIN_DEBITO));
  assert.deepStrictEqual(tiposDe(r, 61), [TIPOS.DEBITO_PENDIENTE]);
  const c = calculo.coloresTransferencias(calculo.indicadores({ ...r, config: { movDebito: '25030', movCredito: '25031' } }, '2026-11-16'));
  assert.deepStrictEqual([c.debitos, c.creditos, c.saldoDebitos[0], c.saldoCreditos[0]], ['warn', 'ok', 'warn', 'ok']);
});

test('indicador: operaciones PENDING_EXECUTION de BankService que figuran en IBS', () => {
  const m = ibs.normalizarMovimientos([mov(70, '16/11/2026', 25030, 30)], config).movimientos;
  const r = conciliar({ movimientos: m, pendientes: [], operaciones: [op(70, '2026-11-16', 30, { estado: 'PENDING_EXECUTION' }), op(71, '2026-11-16', 30, { estado: 'PENDING_EXECUTION' })], config });
  const ind = calculo.indicadores({ ...r, config: { movDebito: '25030', movCredito: '25031' } }, '2026-11-16');
  assert.deepStrictEqual([ind.bs.sinEjecutar, ind.bs.sinEjecutarEnIbs], [2, 1]);
  assert.strictEqual(calculo.semaforos(ind).transferencias.color, 'rojo');
});

test('operación PENDING_EXECUTION con débito y crédito en IBS: una sola excepción con todo el detalle', () => {
  const m = ibs.normalizarMovimientos([mov(80, '16/11/2026', 25030, 30), mov(80, '16/11/2026', 25031, 30, { sistcod: 3 })], config).movimientos;
  const r = conciliar({ movimientos: m, pendientes: [], operaciones: [op(80, '2026-11-16', 30, { estado: 'PENDING_EXECUTION' })], config });
  assert.deepStrictEqual(tiposDe(r, 80), [TIPOS.DEBITO_FAILED]);
  assert.match(r.excepciones[0].detalle, /PENDING_EXECUTION .*1 débito\(s\) 25030 .* y 1 crédito\(s\) 25031/);
  assert.match(r.excepciones[0].detalle, /CSV de BankService más nuevo/);
});

test('créditos que faltan: con el débito hecho (rojo) y con el débito pendiente (amarillo)', () => {
  const m = ibs.normalizarMovimientos([mov(90, '16/11/2026', 25030, 10)], config).movimientos;
  const p = ibs.normalizarPendientes([pend(91, 20)], config).pendientes;
  const r = conciliar({ movimientos: m, pendientes: p, operaciones: [op(90, '2026-11-16', 10), op(91, '2026-11-16', 20)], config });
  assert.deepStrictEqual(tiposDe(r, 90), [TIPOS.CREDITO_FALTANTE]);
  assert.deepStrictEqual(tiposDe(r, 91), [TIPOS.DEBITO_PENDIENTE, TIPOS.CREDITO_FALTANTE_PENDIENTE].sort());
  const solo91 = conciliar({ movimientos: [], pendientes: p, operaciones: [op(91, '2026-11-16', 20)], config });
  const sem = calculo.semaforos(calculo.indicadores({ ...solo91, config: { movDebito: '25030', movCredito: '25031' } }, '2026-11-16')).transferencias;
  assert.strictEqual(sem.color, 'amarillo');
});

test('movimientos de una operación PENDING_EXECUTION suman en Débitos y Créditos (y quedan en rojo contra las APPROVED)', () => {
  const m = ibs.normalizarMovimientos([mov(100, '16/11/2026', 25030, 50), mov(100, '16/11/2026', 25031, 50, { sistcod: 3 }), mov(101, '16/11/2026', 25030, 30), mov(101, '16/11/2026', 25031, 30, { sistcod: 3 })], config).movimientos;
  const r = conciliar({ movimientos: m, pendientes: [], operaciones: [op(100, '2026-11-16', 50), op(101, '2026-11-16', 30, { estado: 'PENDING_EXECUTION' })], config });
  const ind = calculo.indicadores({ ...r, config: { movDebito: '25030', movCredito: '25031' } }, '2026-11-16');
  assert.deepStrictEqual([ind.ibs.debitos[0], ind.ibs.creditos[0], ind.ibs.saldoDebitos[0]], [2, 2, 8000]);
  assert.strictEqual(ind.bs.importeNoAprobadasEnIbs[0], 3000);
  const c = calculo.coloresTransferencias(ind);
  assert.deepStrictEqual([c.debitos, c.creditos], ['err', 'err']);
});
