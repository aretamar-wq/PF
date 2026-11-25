const test = require('node:test');
const assert = require('node:assert');
const ci = require('../lib/conciliacionIbs');

const api = [{
  id_comprobante: '16319', realizado: 's', ejecutado_en: '2026-11-04 10:00:00', estado_codigo: 'ACREDITADO', estado_descripcion: 'ACREDITADO',
  moneda: '032', importe: '1000.00', debito_cuit: '20111111112', credito_cuit: '20111111112', debito_cbu: '3120000100000000758481', id_operacion: 'A1',
}];
const ibsPeriodo = ci.ibsRowsToLines([], { conConcod: true });
const posteriores = () => ci.leerIbsTransferencias(ci.ibsRowsToLines([
  { sistcod: 5, moncod: 2, cuecod: '75848', Fecha_Mov: '10/11/2026', comnro: '16319', movcod: '28600', signo: -1, accimp: '1000.00', Importe: '-1000.00' },
]), '2026-11-04', '2026-11-17').grupos;

test('query de movimientos posteriores valida y arma el filtro', () => {
  const q = ci.buildIbsMovimientosPosterioresQuery('2026-11-04', '2026-11-17', ['16319']);
  assert.match(q, /a\.fecmov >= '20261104'/);
  assert.match(q, /a\.fecmov < '20261118'/);
  assert.match(q, /a\.comnro in \(16319\)/);
  assert.throws(() => ci.buildIbsMovimientosPosterioresQuery('2026-11-04', '2026-11-17', ['1; drop']));
});

test('comprobantes sin débito son candidatos', () => {
  assert.deepStrictEqual(ci.comprobantesSinDebitoIbs(api, ibsPeriodo, '2026-11-04', '2026-11-05'), ['16319']);
});

test('débito imputado días después es OK (no es diferencia)', () => {
  const r = ci.conciliarTransferencias(api, ibsPeriodo, { desde: '2026-11-04', hasta: '2026-11-04', hoy: '2026-11-17', movimientosPosteriores: posteriores() });
  assert.deepStrictEqual(r.diferencias, []);
  assert.strictEqual(r.resumen.transferenciasOk, 1);
  assert.strictEqual(r.resumen.debitosPosteriores, 1);
});

test('débito posterior con importe distinto sí es diferencia', () => {
  const distinto = [{ ...api[0], importe: '900.00' }];
  const r = ci.conciliarTransferencias(distinto, ibsPeriodo, { desde: '2026-11-04', hasta: '2026-11-04', hoy: '2026-11-17', movimientosPosteriores: posteriores() });
  assert.deepStrictEqual(r.diferencias.map((d) => d.tipo), ['Importe distinto']);
});

test('sin movimiento posterior sigue siendo "Sin débito en IBS"', () => {
  const r = ci.conciliarTransferencias(api, ibsPeriodo, { desde: '2026-11-04', hasta: '2026-11-04', hoy: '2026-11-17' });
  assert.deepStrictEqual(r.diferencias.map((d) => d.tipo), ['Sin débito en IBS']);
});

test('enviada dos veces con los 2 débitos en IBS no es diferencia', () => {
  const dos = [api[0], { ...api[0], id_operacion: 'A2' }];
  const mov = (fecha) => ({ sistcod: 5, moncod: 0, cuecod: '75848', Fecha_Mov: fecha, comnro: '16319', movcod: '28600', concod: '', signo: -1, accimp: '1000.00', Importe: '-1000.00' });
  const ibs = ci.ibsRowsToLines([mov('04/11/2026'), mov('04/11/2026')], { conConcod: true });
  const r = ci.conciliarTransferencias(dos, ibs, { desde: '2026-11-04', hasta: '2026-11-04', hoy: '2026-11-17' });
  assert.deepStrictEqual(r.diferencias, []);
  const ibs1 = ci.ibsRowsToLines([mov('04/11/2026')], { conConcod: true });
  const r1 = ci.conciliarTransferencias(dos, ibs1, { desde: '2026-11-04', hasta: '2026-11-04', hoy: '2026-11-17' });
  assert.ok(r1.diferencias.some((d) => d.tipo === 'Enviada más de una vez'));
});

const cuadran = (r) => r.totales.every((t) => t.apicore.cantidad === t.ibs.cantidad && t.apicore.importe === t.ibs.importe);
const movIbs = (extra) => ({ sistcod: 5, moncod: 0, cuecod: '75848', Fecha_Mov: '04/11/2026', comnro: '16319', movcod: '28600', concod: '', signo: -1, accimp: '1000.00', Importe: '-1000.00', ...extra });

test('debitada y revertida en IBS sin estado de acreditación: OK y los totales cuadran', () => {
  const sinEstado = [{ ...api[0], estado_codigo: '', estado_descripcion: '' }];
  const ibs = ci.ibsRowsToLines([movIbs({ concod: 'M' }), movIbs({ concod: 'C', signo: 1, Importe: '1000.00' })], { conConcod: true });
  const r = ci.conciliarTransferencias(sinEstado, ibs, { desde: '2026-11-04', hasta: '2026-11-04', hoy: '2026-11-17' });
  assert.deepStrictEqual(r.diferencias, []);
  assert.strictEqual(r.resumen.revertidasOk, 1);
  assert.ok(cuadran(r), JSON.stringify(r.totales));
});

test('con débito pendiente en IBS: no suma en los totales de ApiCore', () => {
  const pend = [{ comnro: '16319', cuecod: '75848', cents: 100000, motivo: 'Sin saldo', fechaOrigen: '04/11/2026' }];
  const r = ci.conciliarTransferencias(api, ibsPeriodo, { desde: '2026-11-04', hasta: '2026-11-04', hoy: '2026-11-17', debitosPendientes: pend });
  assert.deepStrictEqual(r.diferencias.map((d) => d.tipo), ['Débito pendiente en IBS']);
  assert.ok(cuadran(r), JSON.stringify(r.totales));
});

test('rechazo del archivo reprocesado otro día: queda "reintentada", no "figura"', () => {
  const rechazo = [{ id_comprobante: '16319', realizado: 'n', ejecutado_en: '2026-11-04 09:00:00', moneda: '032', importe: '1000.00', debito_cuit: '20111111112', estado_descripcion: 'Error de comunicación' }];
  const ibs = ci.ibsRowsToLines([movIbs({})], { conConcod: true });
  const otrasFechas = new Map([['16319', [{ ...api[0], ejecutado_en: '2026-11-03 18:00:00' }]]]);
  const r = ci.conciliarTransferencias([], ibs, { desde: '2026-11-04', hasta: '2026-11-04', hoy: '2026-11-17', otrasFechas, rechazadosArchivo: rechazo });
  assert.deepStrictEqual(r.diferencias, []);
  assert.strictEqual(r.resumen.rechazadosEnIbs, 0);
  assert.strictEqual(r.rechazados[0].estado, 'reintentada');
});
