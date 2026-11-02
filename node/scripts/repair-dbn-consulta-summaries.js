#!/usr/bin/env node
'use strict';

// Repara, para corridas VIEJAS de "Transferencia DEBIN - File" (de antes del
// fix de postRunSummary/handleOutputFilesGet en server.js/app.js), el
// ArchivoOK que quedó guardado como "(ninguno)" en el resumen del log —
// aunque el archivo dbnconsulta-...csv (el detalle completo, con
// transferencias OK y rechazos de negocio) sí se haya guardado en files/,
// solo que con un runId PROPIO (ver saveOutputFiles/consultaOkFileName en
// wwwroot/app.js), sin relación directa con el runId de la corrida. Sin
// esto, el botón "Descargar OK" de esas corridas viejas queda deshabilitado
// para siempre: el fix solo corrige corridas NUEVAS.
//
// No reescribe ninguna línea existente del log: APPENDEA una línea
// ">>> RESUMEN" corregida (appendRunSummary/parseRunSummary ya toman la
// ÚLTIMA línea de ese tipo, así que esto corrige sin borrar historial).
//
// Emparejamiento: una corrida y su dbnconsulta-...csv se generan en el
// mismo flujo síncrono del navegador (ver runFlowFromCsv) — el dbnconsulta
// siempre se guarda un poco DESPUÉS de que arrancó la corrida (procesa
// todas las filas, espera DEBIN_CONSULTA_DELAY_SECONDS, consulta cada
// transferencia, recién ahí guarda). Ordenando ambas listas por timestamp y
// emparejando cada corrida con el primer dbnconsulta no usado todavía que
// sea POSTERIOR a su propio inicio alcanza, salvo que dos operadores hayan
// corrido transferencias en paralelo exactamente al mismo tiempo — por eso
// el modo por default es dry-run: solo muestra el emparejamiento propuesto,
// no toca nada hasta correrlo con --apply.
//
// Una corrida cuyo archivo .log no tiene NINGUNA línea ">>> REQUEST" nunca
// llegó a llamar a ningún endpoint del banco (todas sus filas fallaron
// validación del lado del cliente antes de eso, ver runFlowFromCsv) — esa
// corrida nunca generó un dbnconsulta-...csv, así que se excluye del
// emparejamiento en vez de adjudicarle el archivo de otra corrida por error.
//
// Uso (desde la carpeta node/):
//   node scripts/repair-dbn-consulta-summaries.js           (dry-run, solo muestra)
//   node scripts/repair-dbn-consulta-summaries.js --apply   (aplica de verdad)

const fs = require('fs');
const path = require('path');
const rootDir = path.join(__dirname, '..', '..');
const logsDir = path.join(rootDir, 'logs');
const filesDir = path.join(rootDir, 'files');
const httpLogsDir = path.join(logsDir, 'http');

const flowEngine = require('../lib/flowEngine');

const HTTP_LOG_FILE_NAME_PATTERN = new RegExp(`^${flowEngine.RUN_ID_PATTERN.source.slice(1, -1)}\\.log$`);
const CONSULTA_FILE_PATTERN = /^(\d{18})-consulta-debin-solo\.csv$/;
const TARGET_FLOW_NAME = 'Transferencia DEBIN - File';

function parseTimestamp18(runId) {
  const match = runId.match(/^(\d{18})-/);
  return match ? match[1] : null;
}

function logHadHttpTraffic(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content.includes('>>> REQUEST');
}

function main() {
  const apply = process.argv.includes('--apply');

  if (!fs.existsSync(httpLogsDir)) {
    console.log('No existe logs/http/, nada que reparar.');
    return;
  }

  const candidateRuns = fs
    .readdirSync(httpLogsDir)
    .filter((name) => HTTP_LOG_FILE_NAME_PATTERN.test(name))
    .map((name) => {
      const filePath = path.join(httpLogsDir, name);
      let summary = null;
      try {
        summary = flowEngine.parseRunSummary(fs.readFileSync(filePath, 'utf8'));
      } catch (err) {
        return null;
      }
      if (!summary || summary.flowName !== TARGET_FLOW_NAME) return null;
      if (summary.okFileName) return null; // ya tiene archivo OK, no hace falta tocarlo
      if (!logHadHttpTraffic(filePath)) return null; // nunca llamó al banco: nunca generó dbnconsulta
      const runId = name.replace(/\.log$/, '');
      const ts = parseTimestamp18(runId);
      if (!ts) return null;
      return { logFileName: name, runId, ts, summary };
    })
    .filter(Boolean)
    .sort((a, b) => a.ts.localeCompare(b.ts));

  const consultaFiles = (fs.existsSync(filesDir) ? fs.readdirSync(filesDir) : [])
    .map((name) => {
      const match = name.match(CONSULTA_FILE_PATTERN);
      return match ? { fileName: name, ts: match[1] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.ts.localeCompare(b.ts));

  if (candidateRuns.length === 0) {
    console.log(`No hay corridas de "${TARGET_FLOW_NAME}" con ArchivoOK pendiente de reparar. Nada que hacer.`);
    return;
  }

  console.log(
    `${candidateRuns.length} corrida(s) sin ArchivoOK (con tráfico HTTP real), ${consultaFiles.length} archivo(s) dbnconsulta encontrados en files/.\n`
  );

  let consultaIdx = 0;
  const matches = [];
  for (const run of candidateRuns) {
    while (consultaIdx < consultaFiles.length && consultaFiles[consultaIdx].ts < run.ts) {
      consultaIdx++;
    }
    const match = consultaIdx < consultaFiles.length ? consultaFiles[consultaIdx] : null;
    matches.push({ run, consultaFile: match ? match.fileName : null });
    if (match) consultaIdx++;
  }

  for (const { run, consultaFile } of matches) {
    console.log(consultaFile ? `${run.logFileName}  ->  ${consultaFile}` : `${run.logFileName}  ->  (sin match: no se encontró ningún dbnconsulta posterior disponible)`);
  }

  if (!apply) {
    console.log('\nDry-run: no se modificó nada. Revisá el emparejamiento de arriba y corré de nuevo con --apply para aplicarlo.');
    return;
  }

  let applied = 0;
  for (const { run, consultaFile } of matches) {
    if (!consultaFile) continue;
    flowEngine.appendRunSummary(logsDir, `http/${run.logFileName}`, {
      flowName: run.summary.flowName,
      username: run.summary.username,
      okFileName: consultaFile,
      errorFileName: run.summary.errorFileName,
      pasosOk: run.summary.pasosOk,
      pasosError: run.summary.pasosError,
    });
    applied++;
  }
  console.log(`\nListo: ${applied} corrida(s) corregida(s). Sin match: ${matches.length - applied}.`);
}

main();
