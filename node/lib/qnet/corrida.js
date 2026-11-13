'use strict';

// Orquestador de una corrida: lee las fuentes, valida, concilia, guarda el
// histórico (entradas tal como llegaron + salidas) y devuelve el código de salida:
// 0 = bien, 1 = error (no se concilia), 2 = hubo advertencias.
//
// Idempotente: el id de la corrida es el hash de las entradas y de la
// configuración, así que correrla dos veces con lo mismo escribe lo mismo en la
// misma carpeta (solo cambia el log, que lleva la hora).

const fs = require('fs');
const path = require('path');
const baseConfig = require('./config');
const { crearAvisos } = require('./avisos');
const { sha256, sumarDias } = require('./util');
const { leerLoop } = require('./lectura/loop');
const { leerPendientes } = require('./lectura/pendientes');
const { leerBankService } = require('./lectura/bankservice');
const { conciliar } = require('./conciliacion');
const { escribirReportes } = require('./reportes/csv');

function cargarConfig(sobrescritura) {
  return { ...baseConfig, ...(sobrescritura || {}) };
}

function escribir(dir, nombre, contenido) {
  fs.mkdirSync(path.dirname(path.join(dir, nombre)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, nombre), contenido, { mode: 0o600 });
}

// bankservice: [{ nombre, contenido }]. fuente: ver fuentes/. salidaDir: raíz del histórico.
async function ejecutarCorrida({ fuente, bankservice, desde, hasta, config: cfg, salidaDir, ahora = new Date(), progreso = () => {} }) {
  const config = cargarConfig(cfg);
  const avisos = crearAvisos();
  const resultado = { exitCode: 0, id: '', dir: '', conciliacion: null, avisos: avisos.lista };

  const bs = leerBankService(bankservice, config, avisos);
  if (bs.transfers.length === 0 && avisos.errores().length === 0) avisos.error('BankService no trae ninguna operación.');

  // Período de consulta: el de BankService salvo que se indique otro.
  const fechasBs = bs.transfers.flatMap((t) => [t.creada.slice(0, 10), t.ejecutada.slice(0, 10)]).filter(Boolean).sort();
  const periodoDesde = desde || fechasBs[0];
  const periodoHasta = hasta || fechasBs[fechasBs.length - 1];
  if (!periodoDesde || !periodoHasta) avisos.error('No se pudo determinar el período (indicá desde y hasta).');

  let loopCrudo = [];
  let pendCrudo = null;
  if (avisos.errores().length === 0) {
    progreso(`Período de Loop: ${periodoDesde} a ${periodoHasta} (fuente ${fuente.nombre})`);
    loopCrudo = await fuente.loopDias(periodoDesde, periodoHasta);
    pendCrudo = await fuente.pendientes();
  }

  const loop = leerLoop(loopCrudo, avisos);
  const pend = pendCrudo ? leerPendientes(pendCrudo, config, avisos) : { pendientes: [], archivo: null };
  if (avisos.errores().length === 0 && loop.partidas.length === 0) avisos.error('Loop no trae ninguna partida en el período.');

  const archivos = [...loop.archivos, ...(pend.archivo ? [pend.archivo] : []), ...bs.archivos];
  const entradas = [
    ...loopCrudo.map((a) => ({ ruta: `entradas/loop/${a.nombre}`, contenido: a.contenido })),
    ...(pendCrudo ? [{ ruta: `entradas/pendientes/${pendCrudo.nombre}`, contenido: pendCrudo.contenido }] : []),
    ...bankservice.map((a) => ({ ruta: `entradas/bankservice/${a.nombre.replace(/^.*[\\/]/, '')}`, contenido: a.contenido })),
  ];
  resultado.id = sha256(JSON.stringify([entradas.map((e) => [e.ruta, sha256(e.contenido)]).sort(), config])).slice(0, 12);
  resultado.dir = path.join(salidaDir, resultado.id);

  if (avisos.errores().length === 0) {
    resultado.conciliacion = conciliar({ partidas: loop.partidas, pendientes: pend.pendientes, transfers: bs.transfers, config });
    for (const a of resultado.conciliacion.avisos) avisos.advertencia(a);
  }

  resultado.exitCode = avisos.codigoSalida();

  // Histórico: entradas tal como llegaron (carpeta 0700, archivos 0600), salidas y log.
  fs.mkdirSync(resultado.dir, { recursive: true, mode: 0o700 });
  for (const e of entradas) escribir(resultado.dir, e.ruta, e.contenido);
  if (resultado.conciliacion) {
    escribirReportes(resultado.dir, resultado.conciliacion, archivos, config, { fuente: fuente.nombre, desde: periodoDesde, hasta: periodoHasta });
    const { comprobantes, ...liviano } = resultado.conciliacion;
    escribir(resultado.dir, 'resultado.json', JSON.stringify({ id: resultado.id, exitCode: resultado.exitCode, archivos, ...liviano }, null, 1));
  }
  const lineas = [`Corrida ${resultado.id} — ${ahora.toISOString()} — código de salida ${resultado.exitCode}`];
  for (const a of avisos.lista) lineas.push(`[${a.nivel.toUpperCase()}] ${a.mensaje}`);
  if (avisos.lista.length === 0) lineas.push('Sin avisos.');
  escribir(resultado.dir, 'corrida.log', lineas.join('\n') + '\n');
  // Puntero a la última corrida, para el dashboard.
  fs.mkdirSync(salidaDir, { recursive: true });
  fs.writeFileSync(path.join(salidaDir, 'ultima.txt'), resultado.id);
  return resultado;
}

module.exports = { ejecutarCorrida, cargarConfig, sumarDias };
