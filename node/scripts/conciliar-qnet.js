#!/usr/bin/env node
'use strict';

// Conciliación diaria de transferencias QNET: Loop (contabilidad) + débitos
// pendientes (ambos directo de Sybase) + BankService (CSV por mes).
//
// Código de salida: 0 = bien, 1 = error (no se concilió), 2 = hubo advertencias.
//
// Uso (desde la carpeta node/):
//   node scripts/conciliar-qnet.js --bankservice ../qnet/entrada/Movimientos_BankService-102026.csv \
//                                  --bankservice ../qnet/entrada/Movimientos_BankService-112026.csv
//   opciones: --desde aaaa-mm-dd --hasta aaaa-mm-dd   (por defecto, el período de BankService)
//             --salida <carpeta>                       (por defecto ../qnet/corridas)
//             --config <archivo.json>                  (pisa reglas de config.js)
//   sin Sybase, con lo exportado antes:
//             --loop-dir <carpeta con Movimientos_Loop_aaaammdd.csv> --pendientes <archivo.csv>

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..', '..');

function leerArgs(argv) {
  const args = { bankservice: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bankservice') args.bankservice.push(argv[++i]);
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
  }
  return args;
}

async function main() {
  const args = leerArgs(process.argv.slice(2));
  if (args.bankservice.length === 0) {
    console.error('Falta --bankservice <Movimientos_BankService-mmaaaa.csv> (se puede repetir).');
    process.exitCode = 1;
    return;
  }
  const { ejecutarCorrida, cargarConfig } = require('../lib/qnet/corrida');
  const configExtra = args.config ? JSON.parse(fs.readFileSync(args.config, 'utf8')) : {};
  const config = cargarConfig(configExtra);

  let fuente;
  if (args['loop-dir']) {
    const { crearFuenteArchivos } = require('../lib/qnet/fuentes/archivos');
    fuente = crearFuenteArchivos({ loopDir: args['loop-dir'], pendientesFile: args.pendientes });
  } else {
    const { crearFuenteSybase } = require('../lib/qnet/fuentes/sybase');
    const parametriaStore = require('../lib/parametriaStore');
    const sybaseClient = require('../lib/sybaseClient');
    const parametria = await parametriaStore.getParametria(rootDir);
    fuente = crearFuenteSybase(parametria.sybase, sybaseClient.querySybase, config, { progreso: (m) => console.log(m) });
  }

  const bankservice = args.bankservice.map((f) => ({ nombre: path.basename(f), contenido: fs.readFileSync(f, 'utf8') }));
  const resultado = await ejecutarCorrida({
    fuente,
    bankservice,
    desde: args.desde,
    hasta: args.hasta,
    config: configExtra,
    salidaDir: args.salida || path.join(rootDir, 'qnet', 'corridas'),
    progreso: (m) => console.log(m),
  });

  for (const a of resultado.avisos) console.log(`[${a.nivel.toUpperCase()}] ${a.mensaje}`);
  console.log(`Corrida ${resultado.id}: ${resultado.dir}`);
  if (resultado.conciliacion) {
    const r = resultado.conciliacion;
    console.log(`Período de Loop ${r.periodo.primerDia} a ${r.periodo.ultimoDia}; corte de transfers ${r.corte.ejecutada}.`);
    console.log(`Excepciones: ${r.excepciones.length}. Sin cubrir:`, Object.fromEntries(Object.entries(r.totales).map(([m, t]) => [m, (t.sinCubrir / 100).toFixed(2)])));
  }
  process.exitCode = resultado.exitCode;
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
