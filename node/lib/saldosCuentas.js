'use strict';

// Saldo de las cuentas con débitos pendientes de IBS (consulta del área): para
// saber si un débito pendiente se puede realizar. sdodiaope es el saldo disponible
// operativo del día de proceso; alcanza si es mayor o igual al importe pendiente.
// Lo usan las conciliaciones con débitos pendientes: transferencias con IBS, Loop y FX.

function buildSaldosCuentasQuery(cuentas) {
  const crudas = (cuentas || []).map((c) => String(c).trim());
  if (crudas.length === 0 || crudas.some((c) => !/^\d{1,15}$/.test(c))) throw new Error('Cuentas inválidas para consultar saldos.');
  const lista = [...new Set(crudas.map((c) => String(parseInt(c, 10))))];
  return `SELECT c.cuecod, c.sistcod, c.moncod, c.succod, c.estctacod, c.tipbloqcod, c.ctacondgi, sdh.sdodiaope, sdh.sdodiacon
FROM tgl_cuentas c, tgl_saldodia_oper sdh
WHERE c.paiscod = 54
  AND c.bcocod = 312
  AND c.succod = 1
  AND c.sistcod in (3,5,27)
  AND c.codsubsist = 0
  AND sdh.fecsdodia = ( select fecproceso from tgl_fechaproceso where sistcod = 3 and succod = 1 )
  AND c.paiscod *= sdh.paiscod
  AND c.bcocod *= sdh.bcocod
  AND c.succod *= sdh.succod
  AND c.sistcod *= sdh.sistcod
  AND c.cuecod *= sdh.cuecod
  AND c.estctacod IN (1,2,4,5,7)
  AND c.cuecod in (${lista.join(', ')})
order by sdh.sdodiaope`;
}

const claveSaldo = (sistcod, moncod, cuecod) => `${Number(sistcod)}|${Number(moncod)}|${String(parseInt(String(cuecod == null ? '' : cuecod).trim(), 10))}`;

// "1234.50" / "1234,50" -> centavos; vacío o NULL (sin fila de saldo del día) -> null.
function centavosONull(v) {
  const t = String(v == null ? '' : v).trim().replace(',', '.');
  if (t === '' || t.toUpperCase() === 'NULL' || !Number.isFinite(Number(t))) return null;
  return Math.round(Number(t) * 100);
}

// Filas de la consulta -> Map (sistcod|moncod|cuenta) -> { sdodiaope, sdodiacon } en centavos.
function leerSaldosCuentas(rows) {
  const saldos = new Map();
  for (const r of rows || []) {
    saldos.set(claveSaldo(r.sistcod, r.moncod, r.cuecod), {
      sdodiaope: centavosONull(r.sdodiaope),
      sdodiacon: centavosONull(r.sdodiacon),
      estctacod: String(r.estctacod == null ? '' : r.estctacod).trim(),
      tipbloqcod: String(r.tipbloqcod == null ? '' : r.tipbloqcod).trim(),
    });
  }
  return saldos;
}

// Consulta los saldos de las cuentas de los pendientes ({ cuecod }), en lotes.
async function consultarSaldos(querySybase, pendientes) {
  const cuentas = [...new Set((pendientes || []).map((p) => String(p.cuecod || '').trim()).filter((c) => /^\d+$/.test(c)))];
  const saldos = new Map();
  for (let i = 0; i < cuentas.length; i += 300) {
    for (const [k, v] of leerSaldosCuentas(await querySybase(buildSaldosCuentasQuery(cuentas.slice(i, i + 300))))) saldos.set(k, v);
  }
  return saldos;
}

// ¿Alcanza el saldo para el débito pendiente? { sistcod, moncod, cuecod, cents }.
// Sin saldos (no se consultaron) -> null.
function evaluarPendiente(saldos, p) {
  if (!saldos) return null;
  const sd = saldos.get(claveSaldo(p.sistcod || 5, p.moncod, p.cuecod));
  if (!sd || sd.sdodiaope == null) return { conSaldo: false, sdodiaope: null, texto: 'Sin saldo del día de la cuenta (sdodiaope): no se puede debitar.' };
  const conSaldo = sd.sdodiaope >= p.cents;
  const fmt = (c) => (c / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return { conSaldo, sdodiaope: sd.sdodiaope, texto: `Saldo disponible (sdodiaope) ${fmt(sd.sdodiaope)}: ${conSaldo ? 'alcanza' : 'no alcanza'} para el débito.` };
}

module.exports = { buildSaldosCuentasQuery, leerSaldosCuentas, consultarSaldos, evaluarPendiente, claveSaldo };
