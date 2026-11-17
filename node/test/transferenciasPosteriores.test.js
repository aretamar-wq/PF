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

test('débito imputado días después se informa y no es "Sin débito en IBS"', () => {
  const r = ci.conciliarTransferencias(api, ibsPeriodo, { desde: '2026-11-04', hasta: '2026-11-04', hoy: '2026-11-17', movimientosPosteriores: posteriores() });
  const tipos = r.diferencias.map((d) => d.tipo);
  assert.deepStrictEqual(tipos, ['Débito imputado en fecha posterior']);
  assert.match(r.diferencias[0].detalle, /2026-11-10/);
});

test('sin movimiento posterior sigue siendo "Sin débito en IBS"', () => {
  const r = ci.conciliarTransferencias(api, ibsPeriodo, { desde: '2026-11-04', hasta: '2026-11-04', hoy: '2026-11-17' });
  assert.deepStrictEqual(r.diferencias.map((d) => d.tipo), ['Sin débito en IBS']);
});
