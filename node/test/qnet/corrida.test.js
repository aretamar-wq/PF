'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ejecutarCorrida } = require('../../lib/qnet/corrida');
const { crearFuenteArchivos } = require('../../lib/qnet/fuentes/archivos');
const { crearFuenteSybase, consultaLoop } = require('../../lib/qnet/fuentes/sybase');
const config = require('../../lib/qnet/config');
const { LOOP_H, PEND_H, BS_H, filaLoop, filaBs } = require('./fixtures');

function escenario() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qnet-'));
  const loop = path.join(dir, 'loop');
  fs.mkdirSync(loop);
  const w = (n, c) => fs.writeFileSync(path.join(loop, n), c);
  const dia = (fecha, ...filas) => [LOOP_H, ...filas].join('\r\n') + '\r\n';
  // 02/11 (lunes): comprobante 1 correcto, 2 con el débito pendiente (solo crédito)
  w('Movimientos_Loop_20261102.csv', dia('2026-11-02',
    filaLoop(5, 0, 5001, '2026-11-02', 1, 25030, -1, 100), filaLoop(3, 0, 11000492, '2026-11-02', 1, 25031, 1, 100),
    filaLoop(3, 0, 11000492, '2026-11-02', 2, 25031, 1, 50)));
  // 03/11: comprobante 3 y un débito de centavo en la cuenta puente
  w('Movimientos_Loop_20261103.csv', dia('2026-11-03',
    filaLoop(5, 0, 5003, '2026-11-03', 3, 25030, -1, 30), filaLoop(3, 0, 11000492, '2026-11-03', 3, 25031, 1, 30),
    filaLoop(3, 0, 11000492, '2026-11-03', 4, 25030, -1, 0.01)));
  const pend = path.join(dir, 'pendientes.csv');
  fs.writeFileSync(pend, [PEND_H, ['12/11/2026 0:00:00.000', 7, 1, 5, 0, 5002, 25030, 'Debito por transferencia', '2/11/2026 10:00:00.000', 2, 1, 'sin saldo', '50.00', '2/11/2026 10:00:00.000', '2/11/2026 10:00:00.000'].join(',')].join('\r\n'));
  const bs = [{ nombre: 'Movimientos_BankService-112026.csv', contenido: [BS_H,
    filaBs(1, '2026-11-02 09:00:00', '2026-11-02 09:00:05', 'APPROVED', 5001, '100'),
    filaBs(2, '2026-11-02 09:10:00', '2026-11-02 09:10:05', 'APPROVED', 5002, '50'),
    filaBs(3, '2026-11-03 09:00:00', '2026-11-03 09:00:05', 'APPROVED', 5003, '30'),
    filaBs(5, '2026-11-03 10:00:00', '2026-11-03 10:00:02', 'FAILED', 5005, '9')].join('\n') + '\n' }];
  return { dir, loop, pend, bs, salida: path.join(dir, 'corridas') };
}

const leer = (dir) => Object.fromEntries(fs.readdirSync(dir).filter((n) => n !== 'corrida.log' && fs.statSync(path.join(dir, n)).isFile()).map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]));

test('Corrida completa desde archivos: resultado, histórico y salidas CSV sin datos personales', async () => {
  const e = escenario();
  const r = await ejecutarCorrida({ fuente: crearFuenteArchivos({ loopDir: e.loop, pendientesFile: e.pend }), bankservice: e.bs, salidaDir: e.salida });
  assert.strictEqual(r.exitCode, 0);
  const c = r.conciliacion;
  assert.deepStrictEqual(c.periodo, { primerDia: '2026-11-02', ultimoDia: '2026-11-03' });
  const marcas = Object.fromEntries(c.comprobantes.map((x) => [x.comnro, x.marca]));
  assert.deepStrictEqual(marcas, { 1: 'Correcto', 2: 'Débito pendiente anterior', 3: 'Correcto', 4: 'Débito de centavo sin crédito' });
  assert.deepStrictEqual([c.totales.ARS.neto, c.totales.ARS.pendientes, c.totales.ARS.sinCubrir], [5000 + 0 - 1, 5000, -1]);
  // histórico: entradas tal como llegaron y salidas
  for (const f of ['entradas/loop/Movimientos_Loop_20261102.csv', 'entradas/pendientes/pendientes.csv', 'entradas/bankservice/Movimientos_BankService-112026.csv', 'excepciones.csv', 'resumen.csv', 'pendientes-por-dia.csv', 'fuentes.csv', 'conciliacion-comprobantes.csv', 'resultado.json', 'corrida.log']) {
    assert.ok(fs.existsSync(path.join(r.dir, f)), f);
  }
  assert.strictEqual(fs.readFileSync(path.join(e.salida, 'ultima.txt'), 'utf8'), r.id);
  const salidas = Object.values(leer(r.dir)).join('\n');
  assert.ok(!/APELLIDO|20111222333|30999888777|0070000000000/.test(salidas), 'las salidas no deben llevar nombres, CUIT ni CBU');
  const exc = fs.readFileSync(path.join(r.dir, 'excepciones.csv'), 'utf8');
  assert.match(exc, /\r\n/);
  assert.match(exc, /Débito pendiente anterior,2,5002,ARS,02\/11\/2026,50\.00/);
});

test('Idempotente: dos corridas con los mismos archivos dan el mismo id y las mismas salidas', async () => {
  const e = escenario();
  const correr = () => ejecutarCorrida({ fuente: crearFuenteArchivos({ loopDir: e.loop, pendientesFile: e.pend }), bankservice: e.bs, salidaDir: e.salida });
  const r1 = await correr();
  const salidas1 = leer(r1.dir);
  const r2 = await correr();
  assert.strictEqual(r1.id, r2.id);
  assert.deepStrictEqual(leer(r2.dir), salidas1);
  assert.strictEqual(fs.readdirSync(e.salida).filter((n) => n !== 'ultima.txt').length, 1);
  // otro Loop (un día reexportado con otro contenido) = otra corrida
  fs.writeFileSync(path.join(e.loop, 'Movimientos_Loop_20261103_r2.csv'), [LOOP_H, filaLoop(5, 0, 5003, '2026-11-03', 3, 25030, -1, 30), filaLoop(3, 0, 11000492, '2026-11-03', 3, 25031, 1, 30)].join('\r\n') + '\r\n');
  const r3 = await correr();
  assert.notStrictEqual(r3.id, r1.id);
  assert.ok(!r3.conciliacion.comprobantes.some((x) => x.comnro === '4'), 'el reexport reemplazó al día: el comprobante 4 ya no está');
});

test('Código de salida 1: pendientes con filas de otro tipo, y no se concilia', async () => {
  const e = escenario();
  fs.writeFileSync(e.pend, [PEND_H, ['12/11/2026 0:00:00.000', 7, 1, 5, 0, 5002, 25003, 'Venta ME', '2/11/2026 10:00:00.000', 9, 1, '', '50.00', '2/11/2026 10:00:00.000', '2/11/2026 10:00:00.000'].join(',')].join('\r\n'));
  const r = await ejecutarCorrida({ fuente: crearFuenteArchivos({ loopDir: e.loop, pendientesFile: e.pend }), bankservice: e.bs, salidaDir: e.salida });
  assert.strictEqual(r.exitCode, 1);
  assert.strictEqual(r.conciliacion, null);
  assert.match(fs.readFileSync(path.join(r.dir, 'corrida.log'), 'utf8'), /\[ERROR\].*error de la consulta/);
});

test('Código de salida 2: un archivo de Loop repetido es una advertencia y la corrida sigue', async () => {
  const e = escenario();
  fs.copyFileSync(path.join(e.loop, 'Movimientos_Loop_20261102.csv'), path.join(e.loop, 'Movimientos_Loop_20261102_copia.csv'));
  const r = await ejecutarCorrida({ fuente: crearFuenteArchivos({ loopDir: e.loop, pendientesFile: e.pend }), bankservice: e.bs, salidaDir: e.salida });
  assert.strictEqual(r.exitCode, 2);
  assert.ok(r.conciliacion);
});

test('Fuente Sybase: una consulta por día hábil (aaaammdd) y los pendientes con fechas de isql', async () => {
  const consultas = [];
  const filasLoop = {
    '20261102': [
      { sistcod: '5', moncod: '0', cuecod: '5001', Fecha_Mov: '02/11/2026', comnro: '1', movcod: '25030', signo: '-1', accimp: '100.000', Importe: '-100.000' },
      { sistcod: '3', moncod: '0', cuecod: '11000492', Fecha_Mov: '02/11/2026', comnro: '1', movcod: '25031', signo: '1', accimp: '100.000', Importe: '100.000' },
    ],
  };
  const querySybase = async (_p, sql) => {
    consultas.push(sql);
    if (/tgl_deb_pendientes/.test(sql)) {
      return [{ fecreal: 'Nov 12 2026 12:00AM', tercod: '7', succod: '1', sistcod: '5', moncod: '0', cuecod: '5002', movcod: '25030', descdet: 'Debito por transferencia', fecproceso: 'Nov  2 2026 10:00AM', comnro: '2', nromen: '1', mentexto: 'sin saldo', importedeb: '50.00', fecenlace: 'Nov  2 2026 10:00AM', fecorigen: 'Nov  2 2026 10:00AM' }];
    }
    const m = /a\.fecmov >= '(\d{8})'/.exec(sql);
    return filasLoop[m[1]] || [];
  };
  const e = escenario();
  const bs = [{ nombre: 'Movimientos_BankService-112026.csv', contenido: [BS_H, filaBs(1, '2026-11-02 09:00:00', '2026-11-02 09:00:05', 'APPROVED', 5001, '100'), filaBs(9, '2026-11-08 09:00:00', '2026-11-08 09:00:05', 'APPROVED', 5009, '1')].join('\n') + '\n' }];
  const r = await ejecutarCorrida({ fuente: crearFuenteSybase({}, querySybase, config), bankservice: bs, salidaDir: e.salida });
  const consultasLoop = consultas.filter((c) => /tgl_movimientos/.test(c));
  // período 02/11 (lunes) a 08/11 (domingo): lunes a viernes = 5 consultas, sin sábado ni domingo
  assert.strictEqual(consultasLoop.length, 5);
  assert.ok(/a\.fecmov >= '20261102'\s+and a\.fecmov < '20261103'/.test(consultasLoop[0]));
  assert.ok(/a\.movcod in \(25030, 25031\)/.test(consultasLoop[0]) && /a\.concod = ' '/.test(consultasLoop[0]));
  assert.ok(fs.existsSync(path.join(r.dir, 'entradas/loop/Movimientos_Loop_20261102.csv')));
  assert.ok(!fs.existsSync(path.join(r.dir, 'entradas/loop/Movimientos_Loop_20261103.csv')), 'un día sin movimientos no genera archivo');
  // el pendiente del comprobante 2 (fecha de isql "Nov  2 2026 10:00AM") no tiene partidas en Loop: excepción con su fecha
  const sinAsiento = r.conciliacion.excepciones.find((x) => x.tipo === 'Débito pendiente sin asiento en Loop');
  assert.deepStrictEqual([sinAsiento.comprobante, sinAsiento.fecha, sinAsiento.importe], ['2', '2026-11-02', 5000]);
  assert.strictEqual(consultaLoop('2026-11-12', config).includes("'20261113'"), true);
});
