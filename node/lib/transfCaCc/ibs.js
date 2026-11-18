'use strict';

// Capa de datos de IBS: las dos consultas (tal cual las del área) y la
// normalización de sus filas. El dashboard nunca se conecta a IBS: recibe lo que
// devuelve esta capa.

const { centavos, parseFechaHora } = require('../qnet/util');

const COLUMNAS_MOVIMIENTOS = ['usrident', 'sistcod', 'moncod', 'cuecod', 'Fecha_Mov', 'comnro', 'movcod', 'signo', 'accimp', 'Importe'];
const COLUMNAS_PENDIENTES = ['fecreal', 'tercod', 'succod', 'sistcod', 'moncod', 'cuecod', 'movcod', 'descdet', 'fecproceso', 'comnro', 'nromen', 'mentexto', 'importedeb', 'fecenlace', 'fecorigen'];

const aaaammdd = (iso) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) throw new Error(`Fecha inválida: '${iso}'.`);
  return iso.replace(/-/g, '');
};

// @desde inclusive, @hasta exclusiva (aaaa-mm-dd -> 'aaaammdd').
function consultaMovimientos(desde, hasta, config) {
  return `select a.usrident, a.sistcod, a.moncod, a.cuecod,
       convert(varchar, a.fecmov, 103) 'Fecha_Mov', a.comnro, a.movcod,
       b.signo, b.accimp, b.signo * b.accimp 'Importe'
from tgl_movimientos a, tgl_movimientos_aper b
where a.fecmov >= '${aaaammdd(desde)}' and a.fecmov < '${aaaammdd(hasta)}' and a.concod = ' '
  and a.fecreal = b.fecreal and a.tercod = b.tercod and b.funcod = 1
  and a.movcod in (${config.movDebito}, ${config.movCredito})`;
}

function consultaPendientes(config) {
  return `select b.fecreal, b.tercod, b.succod, b.sistcod, b.moncod, b.cuecod, movcod, descdet,
       b.fecproceso, b.comnro, b.nromen, m.mentexto, b.importedeb, fecenlace, fecorigen
from Banksys..tgl_deb_pendientes b
inner join Banksys..tgt_transaccion a on b.paiscod = a.paiscod and b.bcocod = a.bcocod
     and b.sistcod = a.sistcod and b.trancod = a.trancod
left outer join Banksys..tdoc_mensages m on b.nromen = m.nromen
where b.paiscod = 54 and b.bcocod = 312 and b.succod = 1 and a.tipofunc in (0,1)
  and a.movcod in (${config.movDebito}, ${config.movCredito})
order by b.fecorigen, b.fecreal, b.fecenlace, b.cuecod`;
}

const txt = (v) => String(v == null ? '' : v).trim();
const entero = (v) => {
  const s = txt(v).replace(/\.0+$/, '');
  return /^-?\d+$/.test(s) ? String(parseInt(s, 10)) : s;
};
const fecha = (v) => {
  const f = parseFechaHora(txt(v));
  return f ? f.fecha : '';
};

// Filas de la consulta de movimientos -> { movimientos, avisos }. La consulta no
// filtra por sistcod: los créditos 25031 se toman de cualquier sistema y los débitos
// 25030 solo de la cuenta del cliente (sistcod 5); el resto se ignora y se avisa.
function normalizarMovimientos(filas, config) {
  const movimientos = [];
  const avisos = [];
  let otroSistema = 0;
  let invalidas = 0;
  for (const f of filas || []) {
    const sistcod = entero(f.sistcod);
    const movcod = entero(f.movcod);
    const accimp = centavos(txt(f.accimp));
    const signo = Number(txt(f.signo)) < 0 ? -1 : 1;
    const fechaMov = fecha(f.Fecha_Mov);
    if ((movcod !== config.movDebito && movcod !== config.movCredito) || accimp == null || !fechaMov || !entero(f.comnro)) { invalidas++; continue; }
    if (movcod === config.movDebito && sistcod !== config.sistCliente) { otroSistema++; continue; }
    movimientos.push({
      usuario: entero(f.usrident),
      sistcod,
      moncod: entero(f.moncod),
      cuecod: entero(f.cuecod),
      fecha: fechaMov,
      comprobante: entero(f.comnro),
      movcod,
      signo,
      importe: Math.abs(accimp),
    });
  }
  if (otroSistema) avisos.push(`IBS: se ignoraron ${otroSistema} débito(s) 25030 con sistcod distinto de ${config.sistCliente}.`);
  if (invalidas) avisos.push(`IBS: se ignoraron ${invalidas} movimiento(s) con datos inválidos.`);
  return { movimientos, avisos };
}

// Filas de la consulta de pendientes -> { pendientes, avisos }. Un movcod
// distinto de 25030/25031 se avisa y no se aplica.
function normalizarPendientes(filas, config) {
  const pendientes = [];
  const avisos = [];
  const otros = new Map();
  for (const f of filas || []) {
    const movcod = entero(f.movcod);
    if (movcod !== config.movDebito && movcod !== config.movCredito) {
      otros.set(movcod, (otros.get(movcod) || 0) + 1);
      continue;
    }
    const importe = centavos(txt(f.importedeb).replace(',', '.'));
    if (importe == null || !entero(f.comnro)) continue;
    pendientes.push({
      moncod: entero(f.moncod),
      cuecod: entero(f.cuecod),
      comprobante: entero(f.comnro),
      movcod,
      importe: Math.abs(importe),
      fechaOrigen: fecha(f.fecorigen),
      fechaProceso: fecha(f.fecproceso),
      motivo: txt(f.mentexto || f.descdet).replace(/\s+/g, ' '),
    });
  }
  for (const [movcod, n] of otros) avisos.push(`Pendientes: ${n} fila(s) con movcod ${movcod || '(vacío)'}: no se aplican.`);
  return { pendientes, avisos };
}

module.exports = { COLUMNAS_MOVIMIENTOS, COLUMNAS_PENDIENTES, consultaMovimientos, consultaPendientes, normalizarMovimientos, normalizarPendientes };
