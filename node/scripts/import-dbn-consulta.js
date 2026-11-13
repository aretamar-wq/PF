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
// - Avisa (no frena) las transferencias realizadas que ya figuran realizadas
//   en dbn_consulta o más de una vez en lo que se va a cargar (mismo CUIT de
//   débito y comprobante): son envíos distintos, se cargan igual y la
//   conciliación las va a marcar como "Enviada más de una vez".
// - También lee el formato VIEJO: files/dbnconsulta-<yyyyMMddHHmmss>.csv, que
//   no tenía CUIT, CBU, importe ni "realizado" propios. Si está su
//   files/dbnout-<mismo sello>.csv (los datos de la transferencia) se usan esos
//   datos; si no, se toman de la consulta del DEBIN (comprador = quien paga,
//   vendedor = quien recibe) y la fila cuenta como realizada si tiene
//   idOperacion. Las transferencias que están en el dbnout y no en el
//   dbnconsulta también se cargan (sin estado de acreditación).
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

const text = (v) => (v == null ? '' : String(v).trim());

// dbnconsulta-<ts>.csv (formato viejo) + dbnout-<ts>.csv -> registros con la
// forma del formato nuevo (ver debinOutputStore.upsertDbnConsultaRecords).
function leerFormatoViejo(archivo, rowsToRecords) {
  const dir = path.dirname(archivo);
  const sello = /^dbnconsulta-(\d{14})\.csv$/.exec(path.basename(archivo))[1];
  const consulta = rowsToRecords(fs.readFileSync(archivo, 'utf8'));
  const outPath = path.join(dir, `dbnout-${sello}.csv`);
  const salidas = fs.existsSync(outPath) ? rowsToRecords(fs.readFileSync(outPath, 'utf8')) : [];
  const salidaPorMensaje = new Map(salidas.map((o) => [text(o.idMensaje), o]));

  // Los dbnout viejos marcaban realizado = 's' aunque el banco hubiera
  // contestado con un error (ej. 103 "No existe saldo"): solo el código 00 es
  // una transferencia hecha.
  const realizadaSegunCodigo = (realizado, codigo) => (text(realizado) === 's' && ['', '00'].includes(text(codigo)) ? 's' : text(realizado) === 's' ? 'n' : text(realizado));

  const records = consulta.map((c) => {
    const o = salidaPorMensaje.get(text(c.idMensaje));
    // Si ya trae las columnas nuevas (archivo de la etapa intermedia) se respetan.
    const idOperacion = text(c.idOperacion) || text(o && o.idRespuesta);
    return {
      ...c,
      idOperacion,
      creditoCuit: text(c.creditoCuit) || text(o && o.creditoCuit) || text(c.vendedorCuit),
      creditoCbu: text(c.creditoCbu) || text(o && o.creditoCbu) || text(c.vendedorCuentaCbu),
      creditoTitular: text(c.creditoTitular) || text(o && o.creditoTitular) || text(c.vendedorTitular),
      debitoCuit: text(c.debitoCuit) || text(o && o.debitoCuit) || text(c.compradorCuit),
      debitoCbu: text(c.debitoCbu) || text(o && o.debitoCbu) || text(c.compradorCuentaCbu),
      debitoTitular: text(c.debitoTitular) || text(o && o.debitoTitular) || text(c.compradorTitular),
      moneda: text(c.moneda) || text(o && o.moneda) || text(c.detalleMoneda),
      importe: text(c.importe) || text(o && o.importe) || text(c.detalleImporte),
      codigoRespuestaTransferencia: text(c.codigoRespuestaTransferencia) || text(o && o.codigoRespuesta),
      descripcionRespuestaTransferencia: text(c.descripcionRespuestaTransferencia) || text(o && o.descripcionRespuesta),
      realizado: realizadaSegunCodigo(text(c.realizado) || text(o && o.realizado) || (idOperacion ? 's' : 'n'), text(c.codigoRespuestaTransferencia) || text(o && o.codigoRespuesta)),
    };
  });

  // Transferencias del dbnout que no tienen fila en el dbnconsulta.
  const enConsulta = new Set(consulta.map((c) => text(c.idMensaje)));
  for (const o of salidas) {
    if (!text(o.idMensaje) || enConsulta.has(text(o.idMensaje))) continue;
    records.push({
      idMensaje: o.idMensaje,
      idComprobante: o.idComprobante,
      idOperacion: o.idRespuesta,
      creditoCuit: o.creditoCuit,
      creditoCbu: o.creditoCbu,
      creditoTitular: o.creditoTitular,
      debitoCuit: o.debitoCuit,
      debitoCbu: o.debitoCbu,
      debitoTitular: o.debitoTitular,
      moneda: o.moneda,
      importe: o.importe,
      codigoRespuestaTransferencia: o.codigoRespuesta,
      descripcionRespuestaTransferencia: o.descripcionRespuesta,
      realizado: realizadaSegunCodigo(o.realizado, o.codigoRespuesta),
    });
  }
  return records;
}

// dbnconsulta-20261001103108.csv -> 2026-10-01 10:31:08
function fechaDeSelloViejo(nombre) {
  const m = /^dbnconsulta-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.csv$/.exec(path.basename(nombre));
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : '';
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
  const vistas = new Map(); // "cuit|comprobante" -> archivos/idMensaje de las realizadas a cargar
  const repetidas = [];

  for (const archivo of archivos) {
    const viejo = /^dbnconsulta-\d{14}\.csv$/.test(path.basename(archivo));
    if (!viejo && !/-consulta-debin-solo\.csv$/.test(archivo)) {
      console.log(`${archivo}: se saltea (no es un -consulta-debin-solo.csv ni un dbnconsulta-<fecha>.csv; los dbnout se leen junto a su dbnconsulta)`);
      continue;
    }
    const records = viejo
      ? leerFormatoViejo(archivo, debinOutputStore.rowsToRecords)
      : debinOutputStore.rowsToRecords(fs.readFileSync(archivo, 'utf8'));
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
        ejecutadoEn: fechaDeIdMensaje(idMensaje) || (viejo ? fechaDeSelloViejo(archivo) : fechaDeNombreArchivo(archivo)),
        ejecutadoPor: 'importacion',
      });
    }
    for (const r of nuevas) {
      if (String(r.realizado).trim() !== 's') continue;
      const clave = `${String(r.debitoCuit || '').trim()}|${String(r.idComprobante || '').trim()}`;
      if (vistas.has(clave)) repetidas.push({ clave, motivo: `repetida en lo que se carga (${vistas.get(clave)} y ${r.idMensaje})` });
      else vistas.set(clave, r.idMensaje);
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

  const pares = [...vistas.keys()].map((k) => {
    const [debitoCuit, idComprobante] = k.split('|');
    return { debitoCuit, idComprobante };
  });
  for (const e of await debinOutputStore.findTransferenciasRealizadas(rootDir, pares)) {
    repetidas.push({ clave: `${e.debitoCuit}|${e.idComprobante}`, motivo: `ya figura realizada en dbn_consulta (${e.ejecutadoEn})` });
  }
  if (repetidas.length > 0) {
    console.log(`ATENCIÓN: ${repetidas.length} transferencia(s) realizada(s) repetidas (CUIT de débito | comprobante) — se cargan igual:`);
    for (const r of repetidas) console.log(`  ${r.clave}: ${r.motivo}`);
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
