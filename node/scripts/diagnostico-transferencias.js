#!/usr/bin/env node
'use strict';

// Diagnóstico de la "Conciliación con IBS" de transferencias DEBIN para un día o
// un rango: corre la misma conciliación que la pantalla (mismas consultas a
// MariaDB y a Sybase) y muestra, además de lo que muestra la pantalla:
//   - las consultas de Sybase que ejecutó (para correrlas a mano),
//   - los totales ApiCore vs IBS con la diferencia,
//   - un cuadro por día de la transferencia (ApiCore vs IBS),
//   - cada comprobante cuyo importe en ApiCore no cuadra con el de IBS (lo que
//     explica una diferencia de totales aunque no haya filas en Diferencias),
//   - y, opcionalmente, el detalle de todos los comprobantes en un CSV.
//
// Uso (en el servidor, desde la carpeta node/):
//   node scripts/diagnostico-transferencias.js --desde 2026-11-12 [--hasta 2026-11-12]
//        [--comprobante 30680 --comprobante 30681] [--csv diagnostico.csv]
//
// No modifica nada: solo lee. No incluye los rechazos que solo están en el
// archivo de error de "Transferencia DEBIN - File" (la pantalla sí los suma).

const fs = require('fs');
const path = require('path');
const ci = require('../lib/conciliacionIbs');
const saldosCuentas = require('../lib/saldosCuentas');
const parametriaStore = require('../lib/parametriaStore');
const sybaseClient = require('../lib/sybaseClient');
const debinOutputStore = require('../lib/debinOutputStore');
const { formatDateOnly } = require('../lib/dateUtil');

const rootDir = path.join(__dirname, '..', '..');

function args() {
  const a = { comprobantes: [] };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '--desde') a.desde = v[++i];
    else if (v[i] === '--hasta') a.hasta = v[++i];
    else if (v[i] === '--comprobante') a.comprobantes.push(String(v[++i]).trim());
    else if (v[i] === '--csv') a.csv = v[++i];
  }
  a.hasta = a.hasta || a.desde;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.desde || '') || !/^\d{4}-\d{2}-\d{2}$/.test(a.hasta) || a.hasta < a.desde) {
    console.error('Uso: node scripts/diagnostico-transferencias.js --desde aaaa-mm-dd [--hasta aaaa-mm-dd] [--comprobante N ...] [--csv salida.csv]');
    process.exit(1);
  }
  return a;
}

const cents = (v) => Math.round(Number(String(v == null ? '' : v).replace(',', '.')) * 100) || 0;
const fmt = (c) => (c / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONEDA = { 32: 'ARS', '032': 'ARS', 840: 'USD', 0: 'ARS', 2: 'USD' };
const monedaApi = (r) => MONEDA[String(r.moneda).trim()] || String(r.moneda || '');
const csvCelda = (v) => {
  const s = v == null ? '' : String(v);
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const linea = (t = '') => console.log(t);
const titulo = (t) => {
  linea();
  linea(`=== ${t} ${'='.repeat(Math.max(0, 70 - t.length))}`);
};

async function main() {
  const { desde, hasta, comprobantes, csv } = args();
  const parametria = await parametriaStore.getParametria(rootDir);
  const { fechas: feriados, invalidos } = ci.parseFeriados((parametria.calendario || {}).feriados);
  const hastaEsperado = ci.proximoDiaHabil(hasta, feriados);
  const hoy = formatDateOnly(new Date());
  const sql = (q) => sybaseClient.querySybase(parametria.sybase, q);

  // Mismas consultas que la pantalla (ver handleConciliacionTransferencias en server.js).
  const qMov = ci.buildIbsTransferenciasQuery(desde, hastaEsperado);
  const qPend = ci.buildIbsDebitosPendientesQuery();
  const ibsLines = ci.ibsRowsToLines(await sql(qMov), { conConcod: true });
  const debitosPendientes = ci.leerDebitosPendientes(await sql(qPend));
  const saldos = debitosPendientes.length ? await saldosCuentas.consultarSaldos(sql, debitosPendientes) : null;
  const apiRows = await debinOutputStore.getConsultaRowsEntre(rootDir, desde, hasta);

  let qPost = '';
  let movimientosPosteriores = new Map();
  if (hastaEsperado < hoy) {
    const candidatos = ci.comprobantesSinDebitoIbs(apiRows, ibsLines, desde, hastaEsperado);
    if (candidatos.length > 0) {
      qPost = ci.buildIbsMovimientosPosterioresQuery(desde, hoy, candidatos);
      movimientosPosteriores = ci.leerIbsTransferencias(ci.ibsRowsToLines(await sql(qPost)), desde, hoy).grupos;
    }
  }
  const enRango = new Set(apiRows.map((r) => String(r.id_comprobante || '').trim()));
  const faltantes = ci.comprobantesIbsTransferencias(ibsLines, desde, hastaEsperado).filter((c) => !enRango.has(c));
  const otrasFechas = new Map();
  for (const r of await debinOutputStore.getConsultaRowsPorComprobante(rootDir, faltantes)) {
    const c = String(r.id_comprobante || '').trim();
    if (!otrasFechas.has(c)) otrasFechas.set(c, []);
    otrasFechas.get(c).push(r);
  }
  const res = ci.conciliarTransferencias(apiRows, ibsLines, {
    desde, hasta, hoy, feriados, feriadosInvalidos: invalidos, otrasFechas, debitosPendientes, saldos, movimientosPosteriores,
  });

  titulo(`Conciliación de transferencias ${desde} a ${hasta} (IBS hasta ${hastaEsperado}, hoy ${hoy})`);
  linea(`Feriados cargados: ${feriados.size}${invalidos.length ? ` (no reconocidos: ${invalidos.join(', ')})` : ''}`);
  linea(`Filas de ApiCore (dbn_consulta) en el rango: ${apiRows.length} · movimientos IBS 28600/28601: ${res.resumen.movimientosIbs} · débitos pendientes leídos: ${debitosPendientes.length}`);
  for (const [k, v] of Object.entries(res.resumen)) linea(`  ${k}: ${v}`);
  for (const a of res.avisos) linea(`Aviso: ${a}`);

  titulo('Consultas a Sybase ejecutadas');
  linea('-- Movimientos del período:');
  linea(qMov);
  linea('-- Débitos pendientes:');
  linea(qPend);
  if (qPost) {
    linea('-- Débitos imputados en fechas posteriores:');
    linea(qPost);
  }

  titulo('Totales ApiCore vs IBS');
  for (const t of res.totales) {
    const dc = t.ibs.cantidad - t.apicore.cantidad;
    const di = Math.round((t.ibs.importe - t.apicore.importe) * 100);
    linea(`${t.concepto.padEnd(36)} ApiCore ${String(t.apicore.cantidad).padStart(5)} · ${fmt(Math.round(t.apicore.importe * 100)).padStart(18)}   IBS ${String(t.ibs.cantidad).padStart(5)} · ${fmt(Math.round(t.ibs.importe * 100)).padStart(18)}   ${dc || di ? `DIFERENCIA ${dc > 0 ? '+' : ''}${dc} · ${fmt(di)}` : 'OK'}`);
  }

  // Clasificación de cada comprobante según el resultado de la conciliación.
  const clase = new Map();
  const agregar = (c, t) => {
    if (!clase.has(c)) clase.set(c, []);
    clase.get(c).push(t);
  };
  for (const d of res.diferencias) agregar(String(d.numeroComprobante), `DIFERENCIA: ${d.tipo} — ${d.detalle}`);
  for (const p of res.pendientes) agregar(String(p.numeroComprobante), `Pendiente de su día hábil — ${p.detalle}`);
  for (const e of res.explicadas) agregar(String(e.numeroComprobante), `Débito de una transferencia de otra fecha (${String(e.fecha).slice(0, 10)})`);
  for (const x of res.sinDebitoCoherentes || []) agregar(String(x.numeroComprobante), `Sin débito y está bien: ${x.motivo} — ${x.detalle}`);
  for (const r of res.rechazados) agregar(String(r.numeroComprobante), `Rechazada (${r.estado})${r.detalle ? ` — ${r.detalle}` : ''}`);

  const { grupos } = ci.leerIbsTransferencias(ibsLines, desde, hastaEsperado);
  const porComp = new Map();
  for (const r of apiRows) {
    const c = String(r.id_comprobante || '').trim() || `(sin comprobante ${r.id_mensaje || ''})`;
    if (!porComp.has(c)) porComp.set(c, []);
    porComp.get(c).push(r);
  }
  const todos = [...new Set([...porComp.keys(), ...grupos.keys()])].sort((a, b) => (Number(a) || 0) - (Number(b) || 0));

  const filas = todos.map((c) => {
    const api = porComp.get(c) || [];
    const realizadas = api.filter((r) => r.realizado === 's');
    const g = grupos.get(c);
    const post = movimientosPosteriores.get(c);
    const vigentes = [...(g ? g.vigentes : []), ...(post ? post.vigentes.filter((m) => m.fecha > hastaEsperado) : [])];
    const pend = debitosPendientes.filter((p) => p.comnro === c);
    // Como en la conciliación: cuentan las realizadas ACREDITADO o sin estado; una
    // pendiente de su día hábil o debitada y revertida en IBS no se espera en IBS.
    const extra = clase.get(c) || [];
    const apiCents = realizadas.filter((r) => ['', 'ACREDITADO'].includes(String(r.estado_codigo || '').trim())).reduce((s, r) => s + cents(r.importe), 0);
    const revertida = !!(g && g.hayReversa) && vigentes.length === 0;
    const esperadoCents = revertida || extra.some((t) => t.startsWith('Pendiente de su día hábil')) ? 0 : apiCents;
    const ibsCents = vigentes.reduce((s, m) => s + m.cents, 0);
    return {
      comprobante: c,
      fechaApi: api.length ? String(api[0].ejecutado_en).slice(0, 10) : '',
      fechaIbs: vigentes.map((m) => m.fecha).join(' '),
      moneda: api.length ? monedaApi(api[0]) : vigentes.length ? MONEDA[vigentes[0].moncod] || vigentes[0].moncod : '',
      envios: realizadas.length,
      rechazos: api.length - realizadas.length,
      estado: [...new Set(api.map((r) => String(r.estado_codigo || 'sin estado')))].join('/'),
      apiImporte: apiCents,
      esperadoImporte: esperadoCents,
      ibsImporte: ibsCents,
      ibsDebitos: vigentes.length,
      reversas: g && g.hayReversa ? 'sí' : '',
      movimientos: g ? g.movs.map((m) => `${m.fecha} ${m.movcod} ${m.signo < 0 ? 'D' : 'C'}${m.concod ? `(${m.concod})` : ''} cta ${m.cuecod} ${fmt(m.cents)}`).join(' | ') : '',
      pendienteIbs: pend.map((p) => {
        const sd = saldosCuentas.evaluarPendiente(saldos, p);
        return `${fmt(p.cents)} cta ${p.cuecod} ${p.motivo}${sd ? ` · ${sd.conSaldo ? 'CON' : 'SIN'} saldo${sd.sdodiaope != null ? ` (disponible ${fmt(sd.sdodiaope)})` : ''}` : ''}`;
      }).join(' | '),
      clasificacion: extra.length ? extra.join(' || ') : realizadas.length ? 'OK' : api.length ? 'Rechazada' : '',
    };
  });

  // Por día de la transferencia (ApiCore): lo que ApiCore realizó y lo que IBS debitó de esas transferencias.
  titulo('Por día de la transferencia (lo que ApiCore espera debitado vs débitos vigentes en IBS de esos comprobantes)');
  const dias = new Map();
  for (const f of filas) {
    const d = f.fechaApi || `IBS ${f.fechaIbs.split(' ')[0] || ''}`;
    const k = `${d} ${f.moneda}`;
    if (!dias.has(k)) dias.set(k, { api: 0, apiN: 0, ibs: 0, ibsN: 0, dif: 0 });
    const x = dias.get(k);
    x.api += f.esperadoImporte;
    x.apiN += f.esperadoImporte ? f.envios : 0;
    x.ibs += f.ibsImporte;
    x.ibsN += f.ibsDebitos;
    if (/DIFERENCIA/.test(f.clasificacion)) x.dif++;
  }
  for (const [k, x] of [...dias].sort()) {
    linea(`${k.padEnd(18)} ApiCore ${String(x.apiN).padStart(5)} · ${fmt(x.api).padStart(18)}   IBS ${String(x.ibsN).padStart(5)} · ${fmt(x.ibs).padStart(18)}   ${x.api === x.ibs ? 'cuadra' : `dif ${fmt(x.ibs - x.api)}`}${x.dif ? ` · ${x.dif} con diferencias` : ''}`);
  }

  titulo('Comprobantes donde ApiCore e IBS no cuadran (incluye los que no figuran en Diferencias)');
  const descuadre = filas.filter((f) => f.esperadoImporte !== f.ibsImporte);
  if (descuadre.length === 0) linea('Ninguno.');
  for (const f of descuadre) {
    linea(`${f.comprobante} · ApiCore ${f.fechaApi || '—'} ${f.moneda} ${fmt(f.apiImporte)} (${f.envios} envío(s), estado ${f.estado || '—'}; se espera en IBS ${fmt(f.esperadoImporte)}) · IBS ${fmt(f.ibsImporte)} (${f.ibsDebitos} débito(s) ${f.fechaIbs})`);
    if (f.movimientos) linea(`    IBS: ${f.movimientos}`);
    if (f.pendienteIbs) linea(`    Débito pendiente: ${f.pendienteIbs}`);
    linea(`    → ${f.clasificacion}`);
  }

  if (comprobantes.length) {
    titulo('Comprobantes pedidos');
    for (const c of comprobantes) {
      const f = filas.find((x) => x.comprobante === c);
      const api = await debinOutputStore.getConsultaRowsPorComprobante(rootDir, [c]);
      linea(`Comprobante ${c}:`);
      for (const r of api) linea(`  ApiCore ${r.ejecutado_en} realizado=${r.realizado} estado=${r.estado_codigo || '—'} (${r.estado_descripcion || ''}) ${monedaApi(r)} ${r.importe} DEBIN ${r.id_operacion || '—'} CUIT ${r.debito_cuit} -> ${r.credito_cuit}`);
      if (!api.length) linea('  ApiCore: no figura en dbn_consulta.');
      linea(f ? `  IBS: ${f.movimientos || 'sin movimientos en el período'}${f.pendienteIbs ? ` · pendiente: ${f.pendienteIbs}` : ''}\n  → ${f.clasificacion || '—'}` : '  No está en el período conciliado.');
    }
  }

  if (csv) {
    const cols = ['comprobante', 'fechaApi', 'fechaIbs', 'moneda', 'envios', 'rechazos', 'estado', 'apiImporte', 'esperadoImporte', 'ibsImporte', 'ibsDebitos', 'reversas', 'movimientos', 'pendienteIbs', 'clasificacion'];
    const out = [cols.join(';'), ...filas.map((f) => cols.map((k) => csvCelda(/Importe$/.test(k) ? (f[k] / 100).toFixed(2).replace('.', ',') : f[k])).join(';'))];
    fs.writeFileSync(csv, `﻿${out.join('\r\n')}\r\n`);
    titulo(`Detalle de ${filas.length} comprobante(s) en ${path.resolve(csv)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
