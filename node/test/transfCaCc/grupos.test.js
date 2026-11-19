'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Base falsa: bankservice_movimientos con dos operaciones (una por cada par de movimientos).
const bsRows = [
  { comprobante: '500', moncod: '0', cuecod: '5001', monto: '100.00', estado: 'APPROVED', creada: '2026-11-16 10:00:00', ejecutada: '2026-11-16 10:00:00', fecha_operacion: '2026-11-16', error: '' },
  { comprobante: '600', moncod: '0', cuecod: '5002', monto: '200.00', estado: 'APPROVED', creada: '2026-11-16 10:00:00', ejecutada: '2026-11-16 10:00:00', fecha_operacion: '2026-11-16', error: '' },
  { comprobante: '700', moncod: '0', cuecod: '5003', monto: '50.00', estado: 'APPROVED', creada: '2026-11-16 10:00:00', ejecutada: '2026-11-16 10:00:00', fecha_operacion: '2026-11-16', error: '' },
];
require.cache[require.resolve('../../lib/mariadbClient')] = {
  id: 'fake', filename: 'fake', loaded: true,
  exports: { query: async (root, sql) => (/WHERE fecha_operacion/.test(sql) ? bsRows.slice() : /MAX\(ejecutada\)/.test(sql) ? [{ corte: '' }] : []) },
};
const servicio = require('../../lib/transfCaCc/servicio');
const calculo = require(path.join(__dirname, '../../../wwwroot/transf-ca-cc-calculo'));

const fila = (comnro, movcod, imp, sistcod = 5) => ({ usrident: '123123123', sistcod, moncod: 0, cuecod: sistcod === 5 ? 5001 + (comnro === 600 ? 1 : 0) : 11000492, Fecha_Mov: '16/11/2026', comnro, movcod, signo: movcod % 2 === 0 ? -1 : 1, accimp: imp, Importe: imp });

test('25032 / 25033: cada operación se concilia con su par de movimientos, en su sección', async () => {
  const sqls = [];
  const datos = await servicio.obtenerDatos({
    rootDir: '/', ahora: '2026-11-16 18:00:00', desde: '2026-11-16', hasta: '2026-11-17',
    querySybase: async (sql) => {
      sqls.push(sql);
      if (/tgl_deb_pendientes/.test(sql)) return [{ moncod: 0, cuecod: 5003, movcod: 25032, comnro: 700, importedeb: '50.00', fecorigen: '16/11/2026 0:00:00.000', mentexto: 'SIN SALDO' }];
      return [fila(500, 25030, '100.00'), fila(500, 25031, '100.00', 3), fila(600, 25032, '200.00'), fila(600, 25033, '200.00', 3)];
    },
  });
  assert.match(sqls[0], /a\.movcod in \(25030, 25031, 25032, 25033\)/);
  assert.deepStrictEqual(datos.operaciones.map((o) => o.comprobante), ['500']);
  const g2 = datos.grupos.g2;
  assert.deepStrictEqual(g2.operaciones.map((o) => [o.comprobante, o.clase]).sort(), [['600', 'ejecutada'], ['700', 'pendiente']]);
  assert.deepStrictEqual(datos.excepciones, []);
  const ind2 = calculo.indicadores({ ...g2, rango: datos.rango }, '2026-11-16');
  assert.deepStrictEqual([ind2.ibs.debitos[0], ind2.ibs.creditos[0], ind2.ibs.pendientes[0], ind2.bs.aprobadas[0]], [1, 1, 1, 2]);
  assert.deepStrictEqual(calculo.coloresTransferencias(ind2).debitos, 'warn');
  const ind1 = calculo.indicadores(datos, '2026-11-16');
  assert.deepStrictEqual(calculo.coloresTransferencias(ind1).debitos, 'ok');
});
