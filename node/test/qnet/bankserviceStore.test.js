'use strict';
const test = require('node:test');
const assert = require('node:assert');
const config = require('../../lib/qnet/config');
const { crearAvisos } = require('../../lib/qnet/avisos');
const { leerBankService } = require('../../lib/qnet/lectura/bankservice');
const store = require('../../lib/qnet/bankserviceStore');

const H = 'Comprobante,Creada,Ejecutada,Estado,Titular,CUIT titular,CBU origen,CBU destino,Destinatario,CUIT destinatario,Monto,Moneda,Código QNET,Error';
const csv = (...filas) => [H, ...filas].join('\r\n') + '\r\n';
const ejemplo = '166761,2026-11-17 23:56:15,2026-11-17 23:56:15,APPROVED,"ORTIZ, DARIO ROLANDO",23258836979,3120001902000002313070,3120001901000110004922,COCOS CAPITAL S.A,30708424478,1000000,ARS,—,—';

test('filasDesdeCsv: lee el formato de BankService (con coma entre comillas y guiones vacíos)', () => {
  const { filas, descartadas } = store.filasDesdeCsv('Movimientos_BankService-112026.csv', csv(ejemplo, '1,2026-11-17 10:00:00,—,RARO,x,1,1,1,x,1,10,ARS,—,—'), config);
  assert.strictEqual(descartadas, 1);
  assert.strictEqual(filas.length, 1);
  const f = filas[0];
  assert.strictEqual(f.titular, 'ORTIZ, DARIO ROLANDO');
  assert.strictEqual(f.monto, '1000000.00');
  assert.strictEqual(f.creada, '2026-11-17 23:56:15');
  assert.strictEqual(f.codigoQnet, '');
  assert.strictEqual(f.error, '');
});

test('filasDesdeCsv: encabezado distinto es error 400', () => {
  assert.throws(() => store.filasDesdeCsv('x.csv', 'a,b\r\n1,2\r\n', config), (e) => e.statusCode === 400);
});

test('archivosDesdeFilas: lo de la base se lee igual que el archivo original', () => {
  const filaBase = {
    comprobante: '166761', moneda: 'ARS', creada: '2026-11-17 23:56:15', ejecutada: '2026-11-17 23:56:15', estado: 'APPROVED',
    titular: 'ORTIZ, DARIO ROLANDO', cuit_titular: '23258836979', cbu_origen: '3120001902000002313070', cbu_destino: '3120001901000110004922',
    destinatario: 'COCOS CAPITAL S.A', cuit_destinatario: '30708424478', monto: '1000000.00', codigo_qnet: '', error: '',
  };
  const archivos = store.archivosDesdeFilas([filaBase, { ...filaBase, comprobante: '1', creada: '2026-10-31 10:00:00', ejecutada: null, estado: 'PENDING_EXECUTION' }]);
  assert.deepStrictEqual(archivos.map((a) => a.nombre), ['Movimientos_BankService-102026.csv', 'Movimientos_BankService-112026.csv']);
  const desdeBase = leerBankService(archivos, config, crearAvisos()).transfers;
  const original = leerBankService([{ nombre: 'Movimientos_BankService-112026.csv', contenido: csv(ejemplo) }], config, crearAvisos()).transfers;
  const sinArchivo = ({ archivo, ...resto }) => resto;
  assert.deepStrictEqual(sinArchivo(desdeBase.find((t) => t.comprobante === '166761')), sinArchivo(original[0]));
  assert.strictEqual(desdeBase.find((t) => t.comprobante === '1').ejecutada, '');
});

test('inicioDeMes: ventana del mes anterior al siguiente', () => {
  assert.strictEqual(store.inicioDeMes('2026-01-15', -1), '2025-12-01');
  assert.strictEqual(store.inicioDeMes('2026-11-18', 2), '2027-01-01');
});
