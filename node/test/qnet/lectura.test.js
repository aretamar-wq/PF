'use strict';
const test = require('node:test');
const assert = require('node:assert');
const config = require('../../lib/qnet/config');
const { crearAvisos } = require('../../lib/qnet/avisos');
const { leerLoop } = require('../../lib/qnet/lectura/loop');
const { leerPendientes } = require('../../lib/qnet/lectura/pendientes');
const { leerBankService } = require('../../lib/qnet/lectura/bankservice');
const { LOOP_H, PEND_H, BS_H, filaLoop, filaBs } = require('./fixtures');

const loopCsv = (...filas) => [LOOP_H, ...filas].join('\r\n') + '\r\n';
const dia = (fecha, ...filas) => loopCsv(...filas.map((f) => f.replace('{F}', fecha)));
const par = (fecha, com, cuenta, imp) => [
  filaLoop(5, 0, cuenta, fecha, com, 25030, -1, imp),
  filaLoop(3, 0, 11000492, fecha, com, 25031, 1, imp),
];

test('Loop: junta los días y valida que cada archivo tenga solo filas de su fecha', () => {
  const avisos = crearAvisos();
  const r = leerLoop([
    { nombre: 'Movimientos_Loop_20261102.csv', contenido: loopCsv(...par('2026-11-02', 1, 5001, 10)) },
    { nombre: 'Movimientos_Loop_20261103.csv', contenido: loopCsv(...par('2026-11-03', 2, 5002, 20)) },
  ], avisos);
  assert.strictEqual(r.partidas.length, 4);
  assert.strictEqual(avisos.codigoSalida(), 0);
  assert.strictEqual(r.partidas[0].importe, -1000);
});

test('Loop: una fila de otra fecha es un error', () => {
  const avisos = crearAvisos();
  leerLoop([{ nombre: 'Movimientos_Loop_20261102.csv', contenido: loopCsv(...par('2026-11-03', 1, 5001, 10)) }], avisos);
  assert.strictEqual(avisos.codigoSalida(), 1);
  assert.match(avisos.errores()[0].mensaje, /fecha distinta/);
});

test('Loop: un reexport REEMPLAZA completo al archivo del día (no se suma)', () => {
  const avisos = crearAvisos();
  const r = leerLoop([
    { nombre: 'Movimientos_Loop_20261104.csv', contenido: loopCsv(...par('2026-11-04', 1, 5001, 10), ...par('2026-11-04', 2, 5002, 20)) },
    { nombre: 'Movimientos_Loop_20261104_xxxx.csv', contenido: loopCsv(...par('2026-11-04', 1, 5001, 10)) },
  ], avisos);
  assert.strictEqual(r.partidas.length, 2);
  assert.strictEqual(r.archivos.find((a) => a.nombre === 'Movimientos_Loop_20261104.csv').estado, 'reemplazado');
  assert.strictEqual(avisos.codigoSalida(), 0);
});

test('Loop: un archivo idéntico (mismo hash) se informa y no se procesa de nuevo', () => {
  const avisos = crearAvisos();
  const contenido = loopCsv(...par('2026-11-05', 1, 5001, 10));
  const r = leerLoop([
    { nombre: 'Movimientos_Loop_20261105.csv', contenido },
    { nombre: 'Movimientos_Loop_20261105_copia.csv', contenido },
  ], avisos);
  assert.strictEqual(r.partidas.length, 2);
  assert.strictEqual(avisos.codigoSalida(), 2);
  assert.match(avisos.advertencias()[0].mensaje, /idéntico/);
});

test('Loop: encabezado inesperado y nombre inválido son errores', () => {
  const a1 = crearAvisos();
  leerLoop([{ nombre: 'Movimientos_Loop_20261102.csv', contenido: 'a,b,c\r\n1,2,3\r\n' }], a1);
  assert.strictEqual(a1.codigoSalida(), 1);
  const a2 = crearAvisos();
  leerLoop([{ nombre: 'loop.csv', contenido: loopCsv() }], a2);
  assert.strictEqual(a2.codigoSalida(), 1);
});

test('Loop (consulta directa): el día llega con su fecha y no hace falta que esté en el nombre', () => {
  const avisos = crearAvisos();
  const r = leerLoop([{ nombre: 'x.csv', fecha: '2026-11-02', contenido: loopCsv(...par('2026-11-02', 1, 5001, 10)) }], avisos);
  assert.strictEqual(r.partidas.length, 2);
});

const pendFila = (sist, mov, com, imp, origen = '12/11/2026 10:30:00.000') =>
  ['12/11/2026 0:00:00.000', 7, 1, sist, 0, 5001, mov, 'Debito por transferencia', origen, com, 1, '"sin saldo, reintentar"', imp, origen, origen].join(',');

test('Pendientes: lee solo débitos por transferencia y normaliza las fechas d/M/aaaa', () => {
  const avisos = crearAvisos();
  const r = leerPendientes({ nombre: 'p.csv', contenido: [PEND_H, pendFila(5, 25030, 100, '500.00', '2/11/2026 9:03:07.123')].join('\r\n') }, config, avisos);
  assert.strictEqual(avisos.codigoSalida(), 0);
  assert.deepStrictEqual([r.pendientes[0].comnro, r.pendientes[0].importedeb, r.pendientes[0].fechaOrigen], ['100', 50000, '2026-11-02']);
  assert.strictEqual(r.pendientes[0].motivo, 'sin saldo, reintentar');
});

test('Pendientes: si vienen filas de otro tipo (25003) se rechaza el archivo: error de la consulta', () => {
  const avisos = crearAvisos();
  const r = leerPendientes({ nombre: 'p.csv', contenido: [PEND_H, pendFila(5, 25030, 100, '500'), pendFila(5, 25003, 101, '900')].join('\r\n') }, config, avisos);
  assert.strictEqual(avisos.codigoSalida(), 1);
  assert.match(avisos.errores()[0].mensaje, /error de la consulta/);
  assert.strictEqual(r.pendientes.length, 0);
  assert.strictEqual(r.archivo.estado, 'rechazado');
});

const bsCsv = (...filas) => [BS_H, ...filas].join('\n') + '\n';

test('BankService: combina meses por comprobante y gana el archivo más nuevo (PENDING -> APPROVED)', () => {
  const avisos = crearAvisos();
  const oct = bsCsv(filaBs(1, '2026-10-30 10:00:00', '', 'PENDING_EXECUTION', 5001, '100.50'), filaBs(2, '2026-10-30 11:00:00', '2026-10-30 11:00:05', 'APPROVED', 5002, '20'));
  const nov = bsCsv(filaBs(1, '2026-10-30 10:00:00', '2026-11-01 09:00:00', 'APPROVED', 5001, '100.50'), filaBs(3, '2026-11-02 08:00:00', '2026-11-02 08:00:03', 'FAILED', 5003, '7'));
  // el de noviembre se pasa primero a propósito: el orden lo da el nombre, no la posición
  const r = leerBankService([{ nombre: 'Movimientos_BankService-112026.csv', contenido: nov }, { nombre: 'Movimientos_BankService-102026.csv', contenido: oct }], config, avisos);
  assert.strictEqual(r.transfers.length, 3);
  assert.strictEqual(r.transfers.find((t) => t.comprobante === '1').estado, 'APPROVED');
  assert.strictEqual(avisos.errores().length, 0);
});

test('BankService: moneda, cuenta del CBU (caracteres 11 a 21), "—" vacío y sin datos personales', () => {
  const avisos = crearAvisos();
  const r = leerBankService([{ nombre: 'Movimientos_BankService-112026.csv', contenido: bsCsv(
    filaBs(1, '2026-11-02 08:00:00', '2026-11-02 08:00:03', 'APPROVED', 131945, '1500.25', 'ARS'),
    filaBs(2, '2026-11-02 08:00:00', '2026-11-02 08:00:03', 'APPROVED', 64150, '10', 'USD'),
    filaBs(3, '2026-11-02 08:00:00', '2026-11-02 08:00:03', 'APPROVED', 5001, '10', 'USD', { cbu: '3120001902' + '00000005001' + '0' }),
  ) }], config, avisos);
  const [a, b, c] = r.transfers;
  assert.deepStrictEqual([a.moncod, a.cuenta, a.monto, a.codigoQnet, a.error, a.cbuMonedaOk], ['0', '131945', 150025, '', '', true]);
  assert.deepStrictEqual([b.moncod, b.cuenta, b.cbuMonedaOk], ['2', '64150', true]);
  assert.strictEqual(c.cbuMonedaOk, false); // USD con dígitos "02"
  const texto = JSON.stringify(r);
  assert.ok(!/APELLIDO|20111222333|30999888777|0070000000000000000000/.test(texto), 'no debe conservar nombres, CUIT ni CBU');
});

test('BankService: archivo idéntico y nombre inválido', () => {
  const avisos = crearAvisos();
  const c = bsCsv(filaBs(1, '2026-11-02 08:00:00', '2026-11-02 08:00:03', 'APPROVED', 5001, '10'));
  leerBankService([{ nombre: 'Movimientos_BankService-112026.csv', contenido: c }, { nombre: 'copia-Movimientos_BankService-112026.csv', contenido: c }, { nombre: 'otro.csv', contenido: c }], config, avisos);
  assert.ok(avisos.advertencias().some((a) => /idéntico/.test(a.mensaje)));
  assert.strictEqual(avisos.codigoSalida(), 1);
});
