'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ejecutarCorrida } = require('../../lib/qnet/corrida');
const { crearFuenteArchivos } = require('../../lib/qnet/fuentes/archivos');
const { listarCorridas, evolucion } = require('../../lib/qnet/historial');
const { LOOP_H, PEND_H, BS_H, filaLoop, filaBs } = require('./fixtures');

async function dosDias() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qnet-hist-'));
  const loop = path.join(dir, 'loop');
  fs.mkdirSync(loop);
  const w = (n, ...filas) => fs.writeFileSync(path.join(loop, n), [LOOP_H, ...filas].join('\r\n') + '\r\n');
  w('Movimientos_Loop_20261102.csv', filaLoop(5, 0, 5001, '2026-11-02', 1, 25030, -1, 100), filaLoop(3, 0, 11000492, '2026-11-02', 1, 25031, 1, 100), filaLoop(3, 0, 11000492, '2026-11-02', 2, 25031, 1, 50));
  w('Movimientos_Loop_20261103.csv', filaLoop(5, 0, 5003, '2026-11-03', 3, 25030, -1, 30), filaLoop(3, 0, 11000492, '2026-11-03', 3, 25031, 1, 30));
  const pend = path.join(dir, 'pend.csv');
  fs.writeFileSync(pend, [PEND_H, ['12/11/2026 0:00:00.000', 7, 1, 5, 0, 5002, 25030, 'Debito', '2/11/2026 10:00:00.000', 2, 1, 'sin saldo', '50.00', '2/11/2026 10:00:00.000', '2/11/2026 10:00:00.000'].join(',')].join('\r\n'));
  const bs = [{ nombre: 'Movimientos_BankService-112026.csv', contenido: [BS_H,
    filaBs(1, '2026-11-02 09:00:00', '2026-11-02 09:00:05', 'APPROVED', 5001, '100'),
    filaBs(2, '2026-11-02 09:10:00', '2026-11-02 09:10:05', 'APPROVED', 5002, '50'),
    filaBs(3, '2026-11-03 09:00:00', '2026-11-03 09:00:05', 'APPROVED', 5003, '30'),
    filaBs(9, '2026-11-04 09:00:00', '2026-11-04 09:00:05', 'APPROVED', 5009, '1')].join('\n') + '\n' }];
  const salida = path.join(dir, 'corridas');
  const correr = (fecha) => ejecutarCorrida({ fuente: crearFuenteArchivos({ loopDir: loop, pendientesFile: pend }), bankservice: bs, fecha, hoy: '2026-11-20', salidaDir: salida });
  return { salida, correr, loop };
}

test('Histórico: lista las corridas por fecha y arma la evolución día a día (una por fecha, la más nueva)', async () => {
  const { salida, correr, loop } = await dosDias();
  const r3 = await correr('2026-11-03');
  const r2 = await correr('2026-11-02');
  const domingo = await correr('2026-11-01'); // error: sin Loop ese día
  assert.strictEqual(domingo.exitCode, 1);

  const lista = listarCorridas(salida);
  assert.deepStrictEqual(lista.map((c) => [c.fecha, c.exitCode]), [['2026-11-03', 0], ['2026-11-02', 0], ['2026-11-01', 1]]);
  assert.strictEqual(lista[2].conDashboard, false);

  let ev = evolucion(salida);
  assert.deepStrictEqual(ev.map((x) => x.fecha), ['2026-11-02', '2026-11-03']); // la corrida con error no entra
  const dia2 = ev[0];
  assert.deepStrictEqual([dia2.comprobantes, dia2.conMarca, dia2.excepciones], [2, 1, 1]);
  assert.deepStrictEqual(dia2.porTipo, { 'Débito pendiente del último día': 1 });
  assert.deepStrictEqual(dia2.monedas.ARS, { neto: 5000, pendientes: 5000, sinCubrir: 0, comprobantes: 2 });
  assert.deepStrictEqual(dia2.saldoPendiente.ARS, { cantidad: 1, importe: 5000 });
  assert.strictEqual(r2.id, dia2.id);

  // volver a correr un día con otro Loop (reexport): queda una sola por fecha, la más nueva
  fs.writeFileSync(path.join(loop, 'Movimientos_Loop_20261103_r2.csv'), [LOOP_H, filaLoop(5, 0, 5003, '2026-11-03', 3, 25030, -1, 30)].join('\r\n') + '\r\n');
  const nueva = await correr('2026-11-03');
  await new Promise((r) => setTimeout(r, 20));
  ev = evolucion(salida);
  assert.strictEqual(ev.filter((x) => x.fecha === '2026-11-03').length, 1);
  assert.strictEqual(ev.find((x) => x.fecha === '2026-11-03').id, nueva.id);
  assert.notStrictEqual(nueva.id, r3.id);
});
