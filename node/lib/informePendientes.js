'use strict';

// "Informe de movimientos pendientes": los débitos pendientes de IBS
// (tgl_deb_pendientes) de los códigos de movimiento que se configuran en
// Parametría (tabla informe_pendientes_movimientos: código + descripción), con el
// documento del cliente (tcl_VinculoCli_Cue) y si la cuenta tiene saldo para
// hacer el débito (sdodiaope, ver saldosCuentas.js: una sola consulta para todas
// las cuentas). Importes en centavos.

const saldosCuentas = require('./saldosCuentas');
const { centavos, parseFechaHora } = require('./transfCaCc/util');

const db = () => require('./mariadbClient');

const MONEDA = { 0: 'ARS', 2: 'USD' };
const SISTEMA = { 3: 'Cuenta Corriente', 5: 'Caja de Ahorro', 27: 'Sistema 27' };

function buildQuery(movcods) {
  const lista = [...new Set((movcods || []).map((c) => String(c).trim()))];
  if (lista.length === 0) throw new Error('No hay códigos de movimiento configurados en Parametría para el informe.');
  if (lista.some((c) => !/^\d{1,9}$/.test(c))) throw new Error('Hay códigos de movimiento inválidos en Parametría (solo números).');
  return `select b.sistcod, b.moncod, b.cuecod, movcod, descdet, b.comnro, b.importedeb, fecorigen, c.nrodoc
From Banksys..tgl_deb_pendientes b
inner join Banksys..tgt_transaccion a on b.paiscod = a.paiscod and
b.bcocod = a.bcocod and
b.sistcod = a.sistcod and
b.trancod = a.trancod
left outer join Banksys..tdoc_mensages m on b.nromen = m.nromen
inner join Banksys..tcl_VinculoCli_Cue c on c.paiscod = b.paiscod
and c.bcocod = b.bcocod
and c.sistcod = b.sistcod
and c.moncod = b.moncod
and c.cuecod = b.cuecod
Where
b.paiscod = 54 and
b.bcocod = 312 and
b.succod = 1 and
a.tipofunc in (0,1)
and a.movcod in (${lista.join(', ')})
order by b.moncod, b.cuecod, b.fecorigen, b.fecreal, b.fecenlace`;
}

const txt = (v) => String(v == null ? '' : v).trim();
const entero = (v) => {
  const s = txt(v).replace(/\.0+$/, '');
  return /^-?\d+$/.test(s) ? String(parseInt(s, 10)) : s;
};

// Filas de la consulta -> un registro por débito pendiente. Una cuenta con más de
// un titular trae una fila por titular (join con tcl_VinculoCli_Cue): se agrupan y
// los documentos quedan juntos.
function leerFilas(rows, movimientos) {
  const descripcion = new Map((movimientos || []).map((m) => [String(m.movcod), m.descripcion]));
  const porClave = new Map();
  for (const r of rows || []) {
    const f = {
      sistcod: entero(r.sistcod),
      moncod: entero(r.moncod),
      cuecod: entero(r.cuecod),
      movcod: entero(r.movcod),
      descdet: txt(r.descdet).replace(/\s+/g, ' '),
      comprobante: entero(r.comnro),
      importe: Math.abs(centavos(txt(r.importedeb).replace(',', '.')) || 0),
      fechaOrigen: (parseFechaHora(txt(r.fecorigen)) || {}).fecha || '',
    };
    const clave = [f.sistcod, f.moncod, f.cuecod, f.movcod, f.comprobante, f.importe, f.fechaOrigen].join('|');
    if (!porClave.has(clave)) {
      porClave.set(clave, {
        ...f,
        moneda: MONEDA[f.moncod] || f.moncod,
        sistema: SISTEMA[f.sistcod] || `Sistema ${f.sistcod}`,
        descripcion: descripcion.get(f.movcod) || '',
        documentos: [],
      });
    }
    const x = porClave.get(clave);
    const doc = entero(r.nrodoc);
    if (doc && !x.documentos.includes(doc)) x.documentos.push(doc);
  }
  return [...porClave.values()];
}

// Saldo a reclamar: Importe - Saldo disponible (sdodiaope). Si el saldo alcanza es 0;
// sin saldo del día de la cuenta se toma 0 de saldo (se reclama todo el importe).
// Sin consulta de saldos, null.
function saldoAReclamar(f) {
  if (!f.saldo) return null;
  return Math.max(0, f.importe - (f.saldo.sdodiaope == null ? 0 : f.saldo.sdodiaope));
}

function resumir(filas) {
  const vacio = () => ({ n: 0, ARS: 0, USD: 0, nARS: 0, nUSD: 0 });
  const r = { total: vacio(), conSaldo: vacio(), sinSaldo: vacio(), sinConsulta: vacio(), aReclamar: vacio() };
  for (const f of filas) {
    const grupo = !f.saldo ? 'sinConsulta' : f.saldo.conSaldo ? 'conSaldo' : 'sinSaldo';
    for (const g of ['total', grupo]) {
      r[g].n++;
      if (f.moneda === 'USD' || f.moneda === 'ARS') {
        r[g][f.moneda] += f.importe;
        r[g][`n${f.moneda}`]++;
      }
    }
    if (f.aReclamar && (f.moneda === 'USD' || f.moneda === 'ARS')) {
      r.aReclamar.n++;
      r.aReclamar[f.moneda] += f.aReclamar;
      r.aReclamar[`n${f.moneda}`]++;
    }
  }
  return r;
}

// --- Parametría: códigos de movimiento del informe --------------------------------

async function getMovimientos(rootDir) {
  const filas = await db().query(rootDir, 'SELECT movcod, descripcion FROM informe_pendientes_movimientos ORDER BY movcod');
  return filas.map((f) => ({ movcod: String(f.movcod), descripcion: f.descripcion || '' }));
}

function validarMovimientos(lista) {
  if (!Array.isArray(lista)) throw new Error('Formato inválido.');
  const out = [];
  const vistos = new Set();
  for (const m of lista) {
    const movcod = txt(m && m.movcod);
    const descripcion = txt(m && m.descripcion).slice(0, 255);
    if (!movcod && !descripcion) continue;
    if (!/^\d{1,9}$/.test(movcod)) throw new Error(`Código de movimiento inválido: '${movcod}' (solo números).`);
    if (vistos.has(movcod)) throw new Error(`El código ${movcod} está repetido.`);
    vistos.add(movcod);
    out.push({ movcod, descripcion });
  }
  return out;
}

// Reemplaza la lista completa (en una transacción).
async function saveMovimientos(rootDir, lista, usuario, ahora) {
  const movimientos = validarMovimientos(lista);
  const conn = await db().getPool(rootDir).getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM informe_pendientes_movimientos');
    for (const m of movimientos) {
      await conn.query(
        'INSERT INTO informe_pendientes_movimientos (movcod, descripcion, actualizado_por, actualizado_en) VALUES (?, ?, ?, ?)',
        [m.movcod, m.descripcion, usuario, ahora]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return movimientos;
}

// --- Informe -----------------------------------------------------------------------

async function generar({ rootDir, querySybase, ahora, movimientos }) {
  const movs = movimientos || (await getMovimientos(rootDir));
  const avisos = [];
  const filas = leerFilas(await querySybase(buildQuery(movs.map((m) => m.movcod))), movs);
  if (filas.length > 0) {
    try {
      const saldos = await saldosCuentas.consultarSaldos(querySybase, filas);
      for (const f of filas) {
        f.saldo = saldosCuentas.evaluarPendiente(saldos, { ...f, cents: f.importe });
        f.aReclamar = saldoAReclamar(f);
      }
    } catch (err) {
      avisos.push(`No se pudo consultar el saldo de las cuentas: ${err.message}`);
    }
  }
  return { generado: ahora, movimientos: movs, filas, resumen: resumir(filas), avisos };
}

module.exports = { buildQuery, leerFilas, saldoAReclamar, resumir, validarMovimientos, getMovimientos, saveMovimientos, generar };
