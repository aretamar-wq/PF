'use strict';
const test = require('node:test');
const assert = require('node:assert');
const config = require('../../lib/fx/config');
const bs = require('../../lib/fx/bankservice');
const { conciliar, TIPOS } = require('../../lib/fx/conciliar');
const calculo = require('../../../wwwroot/fx-calculo');
const { generarReporte } = require('../../lib/fx/reporte');

const COLS = ['id', 'status', 'side', 'pair', 'currency', 'amount', 'counterCurrency', 'counterAmount', 'price', 'receiptNumber', 'ticketNumber', 'failReason', 'failureCategory', 'createdAt', 'confirmedAt', 'settlementDate', 'customerCUIT', 'customerFullName'];
const filaCsv = (o) => COLS.map((c) => (o[c] == null ? '' : String(o[c]).includes(',') ? `"${o[c]}"` : o[c])).join(',');
const orden = (id, extra = {}) => ({ id, status: 'COMPLETED', side: 'BUY', pair: 'USD/ARS', currency: 'ARS', amount: '16000', counterCurrency: 'USD', counterAmount: '10', price: '1600', receiptNumber: id.replace(/\D/g, ''), createdAt: '2026-11-04T13:00:00.000Z', confirmedAt: '2026-11-04T13:00:01.000Z', settlementDate: '2026-11-04', customerCUIT: '20111111112', customerFullName: 'PEREZ, JUAN', ...extra });

test('leerArchivo: importes por moneda, hora de Argentina y rechazos', () => {
  const csv = [COLS.join(','), filaCsv(orden('fxo_100')), filaCsv(orden('fxo_101', { side: 'SELL', currency: 'USD', amount: '10', counterCurrency: 'ARS', counterAmount: '15000' })),
    filaCsv(orden('fxo_102', { receiptNumber: '' })), filaCsv(orden('fxo_x', { status: 'FAILED', receiptNumber: '', failReason: 'Saldo insuficiente' })), filaCsv(orden('fxo_103', { side: 'XX' }))].join('\n');
  const r = bs.leerArchivo('fx.csv', csv);
  assert.strictEqual(r.filas.length, 3);
  const [compra, venta, fallida] = r.filas;
  assert.deepStrictEqual([compra.ars, compra.usd, compra.creada, compra.fechaOperacion], [1600000, 1000, '2026-11-04 10:00:00', '2026-11-04']);
  assert.deepStrictEqual([venta.ars, venta.usd], [1500000, 1000]);
  assert.strictEqual(fallida.status, 'FAILED');
  assert.deepStrictEqual(r.rechazadas.map((x) => x.motivo), ['orden COMPLETED sin receiptNumber', "side desconocido 'XX'"]);
  assert.throws(() => bs.leerArchivo('x.csv', 'id,status\n1,COMPLETED'), /faltan columnas/);
});

test('decidir: un estado final no cambia', () => {
  const f = { comprobante: '1', status: 'FAILED', side: 'BUY', ars: 100, usd: 1, fechaOperacion: '2026-11-04', cuit: '', failReason: '' };
  assert.strictEqual(bs.decidir(f, null), 'insertar');
  const e = { comprobante: '1', status: 'COMPLETED', side: 'BUY', ars: '1.00', usd: '0.01', fecha_operacion: '2026-11-04', customer_cuit: '', fail_reason: '' };
  assert.strictEqual(bs.decidir(f, e), 'conflicto');
  assert.strictEqual(bs.decidir({ ...f, status: 'COMPLETED' }, e), 'sin-cambios');
  assert.strictEqual(bs.decidir({ ...f, status: 'COMPLETED' }, { ...e, status: 'PENDING_SETTLEMENT' }), 'actualizar');
});

// Movimientos de IBS de una orden (los 6 de su lado), con importes en centavos.
const movsDe = (comp, lado, ars, usd, { menos = [], fecha = '2026-11-04', usuario = '123123123' } = {}) =>
  config.lados.find((l) => l.lado === lado).movs.filter((m) => !menos.includes(m.cod))
    .map((m) => ({ usuario, sistcod: '5', moncod: m.moneda === 'USD' ? '2' : '0', cuecod: m.nombre.includes('Puente') ? '11000525' : '5000', fecha, comprobante: comp, movcod: m.cod, signo: 1, importe: m.moneda === 'USD' ? usd : ars }));
const o = (comprobante, extra = {}) => ({ id: `fxo_${comprobante}`, comprobante, status: 'COMPLETED', side: 'BUY', ars: 1600000, usd: 1000, creada: '2026-11-04 10:00:00', fecha: '2026-11-04', cuit: '20111111112', failReason: '', ...extra });

function escenario() {
  const ordenes = [o('10'), o('11'), o('12'), o('13'), o('14', { side: 'SELL' }), o('', { id: 'fxo_f', status: 'FAILED' }), o('16', { status: 'PENDING_SETTLEMENT' }), o('99')];
  const movimientos = [
    ...movsDe('10', 'BUY', 1600000, 1000),
    ...movsDe('11', 'BUY', 1600000, 1000, { menos: ['25003'] }), // 25003 en pendientes
    ...movsDe('12', 'BUY', 1600000, 1000, { menos: ['25003'] }), // falta 25003
    ...movsDe('13', 'BUY', 1600000, 1000), ...movsDe('13', 'BUY', 1600000, 1000).filter((m) => m.movcod === '25002'), // duplicado
    ...movsDe('14', 'SELL', 1600000, 999), // importe USD distinto
    ...movsDe('16', 'BUY', 1600000, 1000), // orden no COMPLETED con movimientos
    ...movsDe('20', 'BUY', 100, 1, { usuario: '29318967' }), // sin orden y manual
  ];
  const pendientes = [
    { moncod: '0', cuecod: '5000', comprobante: '11', movcod: '25003', importe: 1600000, fechaOrigen: '2026-11-04', motivo: 'Venta de moneda extranjera' },
    { moncod: '0', cuecod: '6000', comprobante: '77', movcod: '25003', importe: 500, fechaOrigen: '2026-11-03', motivo: 'x' },
  ];
  return conciliar({ movimientos, pendientes, ordenes, config });
}

test('conciliar: clases de órdenes y excepciones', () => {
  const r = escenario();
  const clase = Object.fromEntries(r.ordenes.map((x) => [x.id, x.clase]));
  assert.deepStrictEqual(clase, { fxo_10: 'completa', fxo_11: 'pendiente', fxo_12: 'incompleta', fxo_13: 'completa', fxo_14: 'completa', fxo_f: '', fxo_16: 'noCompletadaEnIbs', fxo_99: 'porContabilizar' });
  const tipos = r.excepciones.map((e) => `${e.tipo}|${e.comprobante}`).sort();
  assert.deepStrictEqual(tipos, [
    `${TIPOS.PENDIENTE}|11`, `${TIPOS.FALTAN}|12`, `${TIPOS.DUPLICADO}|13`, `${TIPOS.IMPORTE}|14`, `${TIPOS.IMPORTE}|14`, `${TIPOS.IMPORTE}|14`,
    `${TIPOS.REVISION_CON_MOV}|16`, `${TIPOS.SIN_OPERACION}|20`, `${TIPOS.MANUAL}|20`, `${TIPOS.PEND_SIN_OPERACION}|77`, `${TIPOS.POR_CONTABILIZAR}|99`,
  ].sort());
  const pend = r.excepciones.find((e) => e.tipo === TIPOS.PENDIENTE);
  assert.deepStrictEqual([pend.cuenta, pend.cuit, pend.lado, pend.moneda], ['5000', '20111111112', 'BUY', 'ARS']);
  assert.strictEqual(r.excepciones.find((e) => e.tipo === TIPOS.FALTAN).cuenta, '5000');
});

test('indicadores y semáforo por lado', () => {
  const r = escenario();
  const datos = { ...r, lados: config.lados };
  const [compra, venta] = config.lados;
  const ic = calculo.indicadores(datos, '2026-11-04', compra);
  assert.strictEqual(ic.bs.completadas, 5);
  assert.deepStrictEqual([ic.bs.completas, ic.bs.pendientes, ic.bs.incompletas, ic.bs.porContabilizar, ic.bs.noCompletadasEnIbs, ic.bs.failed, ic.bs.revision], [2, 1, 1, 1, 1, 1, 1]);
  // Solo movimientos de órdenes COMPLETED (la 16 no cuenta). 25003: 10 y 13 -> rojo.
  assert.strictEqual(ic.ibs['25003'].n, 2);
  assert.strictEqual(ic.colores['25003'].n, 'err');
  // 25001: 10, 11, 12, 13 en IBS + la 99 por contabilizar = 5 esperadas -> amarillo.
  assert.deepStrictEqual([ic.ibs['25001'].n, ic.colores['25001'].n], [4, 'warn']);
  assert.strictEqual(calculo.semaforo(ic, compra).color, 'rojo');
  const iv = calculo.indicadores(datos, '2026-11-04', venta);
  assert.strictEqual(iv.colores['25008'].importe, 'err');
  assert.strictEqual(iv.colores['25010'].importe, 'ok');
  // Un día sin nada: verde.
  const vacio = calculo.indicadores({ ordenes: [], movimientos: [], pendientes: [], excepciones: [] }, '2026-11-05', compra);
  assert.strictEqual(calculo.semaforo(vacio, compra).color, 'verde');
});

test('reporte PDF del día', () => {
  const r = escenario();
  const datos = { ...r, lados: config.lados, rango: { desde: '2026-11-04', hasta: '2026-11-05' }, generado: '2026-11-05 09:00:00', avisos: [], ultimaCarga: null };
  const pdf = generarReporte({ datos, dia: '2026-11-04', usuario: 'auditor', ahora: new Date('2026-11-05T12:00:00Z') });
  assert.ok(pdf.buffer.slice(0, 5).toString() === '%PDF-');
  assert.match(pdf.nombre, /^conciliacion-fx-2026-11-04-/);
  assert.match(pdf.sha256, /^[0-9a-f]{64}$/);
});

test('semáforo: toma el color del peor indicador, no el de las excepciones', () => {
  // Orden con débito pendiente (amarillo) + un pendiente sin orden del día anterior (excepción roja, sin indicador).
  const r = conciliar({
    movimientos: movsDe('11', 'BUY', 1600000, 1000, { menos: ['25003'] }),
    pendientes: [{ moncod: '0', cuecod: '5000', comprobante: '11', movcod: '25003', importe: 1600000, fechaOrigen: '2026-11-04', motivo: 'x' },
      { moncod: '0', cuecod: '6000', comprobante: '77', movcod: '25003', importe: 500, fechaOrigen: '2026-11-04', motivo: 'x' }],
    ordenes: [o('11')],
    config,
  });
  const compra = config.lados[0];
  const ind = calculo.indicadores({ ...r, lados: config.lados }, '2026-11-04', compra);
  assert.ok(ind.excepciones.some((e) => e.tipo === TIPOS.PEND_SIN_OPERACION));
  assert.strictEqual(calculo.estados(ind, compra).movs['25003'], 'warn');
  const sem = calculo.semaforo(ind, compra);
  assert.strictEqual(sem.color, 'amarillo');
  assert.ok(sem.motivos.some((m) => /débito pendiente/.test(m)));
});

test('movimientos de IBS sin orden en BankService: diferencia (rojo)', () => {
  const r = conciliar({ movimientos: [...movsDe('10', 'BUY', 1600000, 1000), ...movsDe('20', 'BUY', 100, 1)], pendientes: [], ordenes: [o('10')], config });
  const compra = config.lados[0];
  const ind = calculo.indicadores({ ...r, lados: config.lados }, '2026-11-04', compra);
  assert.deepStrictEqual([ind.sinOrden.comprobantes, ind.sinOrden.n, ind.sinOrden.ARS, ind.sinOrden.USD], [1, 6, 300, 3]);
  assert.strictEqual(calculo.estados(ind, compra).sinOrden, 'err');
  const sem = calculo.semaforo(ind, compra);
  assert.strictEqual(sem.color, 'rojo');
  assert.ok(sem.motivos.some((m) => /no figuran en BankService FX/.test(m)));
  // Con la orden en la base (el servidor la encuentra en MariaDB), deja de ser diferencia.
  const r2 = conciliar({ movimientos: [...movsDe('10', 'BUY', 1600000, 1000), ...movsDe('20', 'BUY', 100, 1)], pendientes: [], ordenes: [o('10'), o('20', { ars: 100, usd: 1, fecha: '2026-10-30' })], config });
  const ind2 = calculo.indicadores({ ...r2, lados: config.lados }, '2026-11-04', compra);
  assert.strictEqual(ind2.sinOrden.comprobantes, 0);
  assert.ok(!r2.excepciones.some((e) => e.tipo === TIPOS.SIN_OPERACION));
});

test('ordenesDesdeFilas: el comprobante va sin ceros a la izquierda', () => {
  assert.strictEqual(bs.ordenesDesdeFilas([{ id: 'x', comprobante: '005204', status: 'COMPLETED', side: 'BUY', ars: '1.00', usd: '0.01', fecha_operacion: '2026-11-04' }])[0].comprobante, '5204');
});

test('movimiento manual: solo si el comprobante no está en BankService', () => {
  const r = conciliar({
    movimientos: [...movsDe('10', 'BUY', 1600000, 1000, { usuario: '29318967' }), ...movsDe('20', 'BUY', 100, 1, { usuario: '29318967' })],
    pendientes: [], ordenes: [o('10')], config,
  });
  assert.deepStrictEqual(r.excepciones.filter((e) => e.tipo === TIPOS.MANUAL).map((e) => e.comprobante), ['20']);
  const ind = calculo.indicadores({ ...r, lados: config.lados }, '2026-11-04', config.lados[0]);
  assert.strictEqual(ind.manuales, 6);
});

test('órdenes con débito pendiente: cantidad por moneda', () => {
  const pend = (comp, cod, importe) => ({ moncod: cod === '25005' ? '2' : '0', cuecod: '5000', comprobante: comp, movcod: cod, importe, fechaOrigen: '2026-11-04', motivo: 'x' });
  const r = conciliar({
    movimientos: [...movsDe('11', 'BUY', 1600000, 1000, { menos: ['25003'] }), ...movsDe('12', 'BUY', 1600000, 1000, { menos: ['25005'] }), ...movsDe('13', 'BUY', 1600000, 1000, { menos: ['25003'] })],
    pendientes: [pend('11', '25003', 1600000), pend('12', '25005', 1000), pend('13', '25003', 1600000)],
    ordenes: [o('11'), o('12'), o('13')],
    config,
  });
  const ind = calculo.indicadores({ ...r, lados: config.lados }, '2026-11-04', config.lados[0]);
  assert.deepStrictEqual([ind.bs.pendientes, ind.bs.pendArsN, ind.bs.pendUsdN, ind.bs.pendArs, ind.bs.pendUsd], [3, 2, 1, 3200000, 1000]);
});
