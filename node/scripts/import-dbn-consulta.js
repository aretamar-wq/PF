#!/usr/bin/env node
'use strict';

// Carga a dbn_consulta las transferencias de archivos
// files/<runId>-consulta-debin-solo.csv que nunca llegaron a la tabla (corridas
// anteriores al registro en base: quedaron solo como archivo). Sin esto, la
// conciliación con IBS ve el débito de esas transferencias como "Solo en IBS"
// y el antiduplicado no las conoce.
//
// - Solo inserta: un idMensaje que ya está en dbn_consulta se saltea (no pisa
//   lo que ya tiene, que puede ser más nuevo).
// - La fecha y hora de la transferencia (ejecutado_en) sale del idMensaje
//   (PFC + yyyyMMddHHmmss + ms); si no se puede leer, del nombre del archivo
//   (ddMMyyyyHHmmss). ejecutado_por queda "importacion".
// - Dry-run por default: muestra qué cargaría. --apply para cargar de verdad.
//
// Uso (desde la carpeta node/):
//   node scripts/import-dbn-consulta.js ../files/301020261111300531-consulta-debin-solo.csv
//   node scripts/import-dbn-consulta.js --apply ../files/301020261111300531-consulta-debin-solo.csv
//   node scripts/import-dbn-consulta.js --apply ../files/*-consulta-debin-solo.csv

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..', '..');

function fechaDeIdMensaje(idMensaje) {
  const m = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(idMensaje || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : '';
}

// 301020261111300531-consulta-debin-solo.csv -> 2026-10-30 11:11:30
function fechaDeNombreArchivo(nombre) {
  const m = /^(\d{2})(\d{2})(\d{4})(\d{2})(\d{2})(\d{2})/.exec(path.basename(nombre));
  return m ? `${m[3]}-${m[2]}-${m[1]} ${m[4]}:${m[5]}:${m[6]}` : '';
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const archivos = args.filter((a) => !a.startsWith('--'));
  if (archivos.length === 0) {
    console.log('Uso: node scripts/import-dbn-consulta.js [--apply] <archivo-consulta-debin-solo.csv> [...]');
    process.exitCode = 1;
    return;
  }

  const db = require('../lib/mariadbClient');
  const debinOutputStore = require('../lib/debinOutputStore');
  let totalNuevas = 0;
  let totalExistentes = 0;
  let totalSinId = 0;

  for (const archivo of archivos) {
    if (!/-consulta-debin-solo\.csv$/.test(archivo)) {
      console.log(`${archivo}: se saltea (no es un -consulta-debin-solo.csv)`);
      continue;
    }
    const records = debinOutputStore.rowsToRecords(fs.readFileSync(archivo, 'utf8'));
    const nuevas = [];
    let existentes = 0;
    let sinId = 0;
    for (const record of records) {
      const idMensaje = String(record.idMensaje || '').trim();
      if (!idMensaje) {
        sinId++;
        continue;
      }
      const found = await db.query(rootDir, 'SELECT id FROM dbn_consulta WHERE id_mensaje = ? LIMIT 1', [idMensaje]);
      if (found.length > 0) {
        existentes++;
        continue;
      }
      nuevas.push({
        ...record,
        ejecutadoEn: fechaDeIdMensaje(idMensaje) || fechaDeNombreArchivo(archivo),
        ejecutadoPor: 'importacion',
      });
    }
    const fechas = nuevas.map((r) => r.ejecutadoEn).filter(Boolean).sort();
    console.log(
      `${path.basename(archivo)}: ${records.length} fila(s), ${nuevas.length} nueva(s)` +
        (fechas.length ? ` (${fechas[0]} a ${fechas[fechas.length - 1]})` : '') +
        `, ${existentes} ya estaban` +
        (sinId ? `, ${sinId} sin idMensaje (no se cargan)` : '')
    );
    if (apply && nuevas.length > 0) await debinOutputStore.upsertDbnConsultaRecords(rootDir, nuevas, 'importacion');
    totalNuevas += nuevas.length;
    totalExistentes += existentes;
    totalSinId += sinId;
  }

  console.log(
    `${apply ? 'Cargadas' : 'Se cargarían'}: ${totalNuevas} fila(s); ya estaban: ${totalExistentes}; sin idMensaje: ${totalSinId}.` +
      (apply ? '' : ' (dry-run: correlo con --apply para cargar de verdad)')
  );
  await db.getPool(rootDir).end();
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
