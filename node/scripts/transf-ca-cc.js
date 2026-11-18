#!/usr/bin/env node
'use strict';

// Ejemplo de cómo se alimenta el dashboard "Conciliación Transferencias CA -> CC"
// sin servidor: toma las salidas de las dos consultas de IBS (CSV con exactamente
// las columnas de cada consulta) y uno o más CSV de BankService, aplica la misma
// carga en memoria (mismas reglas que la base) y la misma conciliación, imprime el
// resumen y deja el JSON que consume el dashboard (lo mismo que devuelve
// GET /api/transf-ca-cc/datos).
//
//   node scripts/transf-ca-cc.js --ibs movimientos.csv --pendientes pendientes.csv \
//     --bankservice Movimientos_BankService-102026.csv --bankservice Movimientos_BankService-112026.csv \
//     [--dia 2026-11-16] [--salida datos.json]

const fs = require('fs');
const config = require('../lib/transfCaCc/config');
const ibs = require('../lib/transfCaCc/ibs');
const bankservice = require('../lib/transfCaCc/bankservice');
const { conciliar } = require('../lib/transfCaCc/conciliar');
const { parseCsv } = require('../lib/qnet/util');
const calculo = require('../../wwwroot/transf-ca-cc-calculo');

function args(argv) {
  const r = { bankservice: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[++i];
    if (k === 'bankservice') r.bankservice.push(v);
    else r[k] = v;
  }
  return r;
}

const objetos = (texto) => {
  const [h, ...filas] = parseCsv(texto);
  const cab = h.map((c) => c.trim());
  return filas.filter((f) => !(f.length === 1 && !f[0].trim())).map((f) => Object.fromEntries(cab.map((c, i) => [c, f[i]])));
};

const a = args(process.argv.slice(2));
if (!a.ibs || !a.pendientes || a.bankservice.length === 0) {
  console.error('Uso: node scripts/transf-ca-cc.js --ibs movimientos.csv --pendientes pendientes.csv --bankservice archivo.csv [--bankservice ...] [--dia aaaa-mm-dd] [--salida datos.json]');
  process.exit(1);
}

// BankService en memoria con las mismas reglas que la base (UPSERT por comprobante,
// un estado final no vuelve atrás).
const base = new Map();
for (const ruta of a.bankservice) {
  const leido = bankservice.leerArchivo(ruta, fs.readFileSync(ruta, 'utf8'), config);
  for (const r of leido.rechazadas) console.error(`${ruta}: fila ${r.fila} rechazada (${r.motivo})`);
  for (const f of leido.filas) {
    const e = base.get(f.comprobante);
    const existente = e && { ...e, monto: (e.monto / 100).toFixed(2), fecha_operacion: e.fechaOperacion };
    const accion = bankservice.decidir(f, existente);
    if (accion === 'insertar' || accion === 'actualizar') base.set(f.comprobante, f);
    if (accion === 'conflicto') console.error(`${ruta}: comprobante ${f.comprobante} ya está ${e.estado} y trae ${f.estado}: no se pisa`);
  }
}
const operaciones = [...base.values()].map((f) => ({ comprobante: f.comprobante, moncod: f.moncod, cuecod: f.cuecod, monto: f.monto, estado: f.estado, creada: f.creada, ejecutada: f.ejecutada || '', fecha: f.fechaOperacion, error: f.error }));

const mov = ibs.normalizarMovimientos(objetos(fs.readFileSync(a.ibs, 'utf8')), config);
const pend = ibs.normalizarPendientes(objetos(fs.readFileSync(a.pendientes, 'utf8')), config);
const r = conciliar({ movimientos: mov.movimientos, pendientes: pend.pendientes, operaciones, config });
const datos = { generado: new Date().toISOString(), config: { movDebito: config.movDebito, movCredito: config.movCredito }, avisos: [...mov.avisos, ...pend.avisos], ...r };

const ind = calculo.indicadores(datos, a.dia || '');
const t = ind.total;
const M = (o) => `${t(o)} (${o[0]} / ${o[2]})`;
const $ = (c) => (c / 100).toLocaleString('es-AR', { minimumFractionDigits: 2 });
const deb = mov.movimientos.filter((m) => m.movcod === config.movDebito);
const cre = mov.movimientos.filter((m) => m.movcod === config.movCredito);
console.log(`IBS: ${mov.movimientos.length} movimientos = ${deb.length} débitos 25030 + ${cre.length} créditos 25031; ${new Set(mov.movimientos.map((m) => `${m.moncod}|${m.comprobante}`)).size} comprobantes.`);
console.log(`  1 centavo: ${deb.filter((m) => m.importe <= config.maxCentavo).length} débitos, ${cre.filter((m) => m.importe <= config.maxCentavo).length} créditos. Último día ${r.corte.ultimoDiaIbs}, mayor comprobante ${r.corte.mayorComprobante}.`);
console.log(`APPROVED: ${M(ind.bs.aprobadas)} = ejecutadas ${M(ind.bs.ejecutadas)} + con débito pendiente ${M(ind.bs.pendientes)} + sin registro ${M(ind.bs.sinRegistro)} + por contabilizar ${M(ind.bs.porContabilizar)} -> ${ind.bs.control.diferencia === 0 ? 'cierra' : `NO cierra (dif. ${ind.bs.control.diferencia})`}`);
console.log(`Pendientes: ${pend.pendientes.length} en la consulta; de APPROVED: $ ${$(ind.bs.importePendiente[0])} y US$ ${$(ind.bs.importePendiente[2])}.`);
console.log(`FAILED en IBS: ${ind.bs.failedEnIbs} de ${ind.bs.failed}.`);
const porTipo = {};
for (const e of ind.excepciones) porTipo[e.tipo] = (porTipo[e.tipo] || 0) + 1;
console.log('Excepciones:', porTipo);
console.log('Saldo de débitos pendientes por día:');
for (const s of calculo.porDia(datos, '', '').saldo) console.log(`  ${s.fecha}: ${s.nPend[0]} / $ ${$(s.importePend[0])}${s.nPend[2] ? ` · ${s.nPend[2]} / US$ ${$(s.importePend[2])}` : ''}`);
for (const av of datos.avisos) console.log('AVISO:', av);
if (a.salida) {
  fs.writeFileSync(a.salida, JSON.stringify(datos));
  console.log(`JSON para el dashboard: ${a.salida}`);
}
