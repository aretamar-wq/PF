'use strict';

// Capa de datos de la Conciliación FX: consultas de IBS (movimientos 25001-25012 y
// débitos pendientes), órdenes de BankService FX de la base (nunca del archivo),
// búsqueda de movimientos imputados después, historia por día y carga de los CSV.

const config = require('./config');
const ibs = require('../transfCaCc/ibs');
const bankservice = require('./bankservice');
const { conciliar } = require('./conciliar');
const calculo = require('../../../wwwroot/fx-calculo');
const { aDiaHabil, agregarSaldos } = require('../transfCaCc/servicio');

const db = () => require('../mariadbClient');

function sumarDias(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const aaaammdd = (iso) => iso.replace(/-/g, '');

// Movimientos posteriores de comprobantes puntuales (las dos monedas), desde una fecha hasta mañana.
function consultaPosteriores(desde, hasta, comprobantes) {
  if (comprobantes.some((c) => !/^\d{1,15}$/.test(String(c)))) throw new Error('Comprobantes inválidos.');
  return `select a.usrident, a.sistcod, a.moncod, a.cuecod,
       convert(varchar, a.fecmov, 103) 'Fecha_Mov', a.comnro, a.movcod,
       b.signo, b.accimp, b.signo * b.accimp 'Importe'
from tgl_movimientos a, tgl_movimientos_aper b
where a.fecmov >= '${aaaammdd(desde)}' and a.fecmov < '${aaaammdd(hasta)}'
  and a.comnro in (${comprobantes.join(',')})
  and a.concod = ' '
  and a.fecreal = b.fecreal and a.tercod = b.tercod and b.funcod = 1
  and a.movcod in (${config.movimientos.join(', ')})
order by a.comnro`;
}

async function ultimaCarga(rootDir) {
  const [c] = await db().query(rootDir, 'SELECT id, nombre, cargado_en, cargado_por FROM fx_cargas ORDER BY id DESC LIMIT 1');
  const [m] = await db().query(rootDir, 'SELECT MAX(fecha_operacion) AS corte FROM fx_ordenes');
  return c ? { ...c, corte: (m && m.corte) || '' } : null;
}

async function historialCargas(rootDir, limite = 50) {
  return db().query(
    rootDir,
    `SELECT id, nombre, hash, filas_leidas, insertadas, actualizadas, sin_cambios, rechazadas, conflictos, fecha_min, fecha_max, cargado_por, cargado_en
     FROM fx_cargas ORDER BY id DESC LIMIT ?`,
    [limite]
  );
}

async function detalleCarga(rootDir, id) {
  const [c] = await db().query(rootDir, 'SELECT rechazos_json FROM fx_cargas WHERE id = ?', [id]);
  if (!c) return null;
  try {
    return JSON.parse(c.rechazos_json || '{}');
  } catch (err) {
    return {};
  }
}

async function cargar(rootDir, archivos, usuario, ahora) {
  const resultados = [];
  for (const a of archivos) {
    const conn = await db().getPool(rootDir).getConnection();
    try {
      resultados.push(await bankservice.cargarArchivo(conn, a, usuario, ahora, config));
    } catch (err) {
      resultados.push({ nombre: a.nombre, error: err.message });
    } finally {
      conn.release();
    }
  }
  return resultados;
}

const COLS = 'id, comprobante, status, side, ars, usd, creada, fecha_operacion, customer_cuit, fail_reason';

// Concilia un día (desde, hasta exclusiva).
async function obtenerDatos({ rootDir, querySybase, desde, hasta, ahora, feriados }) {
  const avisos = [];
  const mov = ibs.normalizarMovimientos(await querySybase(ibs.consultaMovimientos(desde, hasta, config)), config);
  const pend = ibs.normalizarPendientes(await querySybase(ibs.consultaPendientes(config)), config);
  avisos.push(...mov.avisos, ...pend.avisos);
  await agregarSaldos(querySybase, pend.pendientes, avisos);

  // Órdenes del día (con margen: las de un sábado, domingo o feriado van al próximo día
  // hábil) y, de cualquier fecha, las de los comprobantes que aparecen en IBS o en pendientes.
  const filas = await db().query(rootDir, `SELECT ${COLS} FROM fx_ordenes WHERE fecha_operacion >= ? AND fecha_operacion < ?`, [sumarDias(desde, -10), hasta]);
  const vistos = new Set(filas.map((f) => String(f.comprobante || '').replace(/^0+(?=\d)/, '')));
  const conMovimiento = new Set([...mov.movimientos.map((m) => m.comprobante), ...pend.pendientes.map((p) => p.comprobante)]);
  const faltan = [...conMovimiento].filter((c) => c && !vistos.has(c));
  for (let i = 0; i < faltan.length; i += 500) {
    const lote = faltan.slice(i, i + 500);
    filas.push(...(await db().query(rootDir, `SELECT ${COLS} FROM fx_ordenes WHERE comprobante IN (${lote.map(() => '?').join(', ')})`, lote)));
  }
  const ordenes = aDiaHabil(bankservice.ordenesDesdeFilas(filas), feriados).filter((o) => (o.fecha >= desde && o.fecha < hasta) || conMovimiento.has(o.comprobante));
  // Movimientos de IBS sin orden: se verifica de nuevo en MariaDB, de cualquier fecha y sin
  // ceros a la izquierda. Si la orden está, se concilia con ella (se desestima como
  // "sin operación"); si no está, queda como diferencia.
  const conOrden = new Set(ordenes.map((o) => o.comprobante));
  const sinOrden = [...new Set(mov.movimientos.map((m) => m.comprobante))].filter((c) => c && !conOrden.has(c));
  if (sinOrden.length > 0) {
    const encontradas = [];
    for (let i = 0; i < sinOrden.length; i += 500) {
      const lote = sinOrden.slice(i, i + 500);
      encontradas.push(...(await db().query(rootDir, `SELECT ${COLS} FROM fx_ordenes WHERE TRIM(LEADING '0' FROM comprobante) IN (${lote.map(() => '?').join(', ')})`, lote)));
    }
    const nuevas = aDiaHabil(bankservice.ordenesDesdeFilas(encontradas), feriados).filter((o) => !conOrden.has(o.comprobante));
    ordenes.push(...nuevas);
    const halladas = new Set(nuevas.map((o) => o.comprobante));
    const noFiguran = sinOrden.filter((c) => !halladas.has(c));
    avisos.push(`IBS: ${sinOrden.length} comprobante(s) con movimientos sin orden se verificaron en la base de BankService FX: ` +
      `${halladas.size} figuran (se concilian con su orden) y ${noFiguran.length} no figuran (quedan como diferencia${noFiguran.length ? `: ${noFiguran.slice(0, 20).join(', ')}${noFiguran.length > 20 ? '…' : ''}` : ''}).`);
  }
  if (ordenes.length === 0) avisos.push('No hay órdenes de BankService FX en la base para ese día: cargá el archivo.');

  // Movimientos imputados después: órdenes COMPLETED del día a las que les falta algún
  // movimiento y no lo tienen en pendientes.
  const manana = sumarDias(ahora.slice(0, 10), 1);
  if (hasta < manana) {
    const hay = new Set(mov.movimientos.map((m) => `${m.comprobante}|${m.movcod}`));
    const enPend = new Set(pend.pendientes.map((p) => `${p.comprobante}|${p.movcod}`));
    const ladoDe = new Map(config.lados.map((l) => [l.lado, l]));
    const buscar = ordenes.filter((o) => o.status === 'COMPLETED' && o.fecha >= desde && o.fecha < hasta && /^\d+$/.test(o.comprobante) &&
      ladoDe.get(o.side).movs.some((m) => !hay.has(`${o.comprobante}|${m.cod}`) && !enPend.has(`${o.comprobante}|${m.cod}`)));
    const ya = new Set(mov.movimientos.map((m) => `${m.comprobante}|${m.movcod}|${m.fecha}|${m.importe}|${m.cuecod}`));
    let encontrados = 0;
    try {
      for (let i = 0; i < buscar.length; i += 200) {
        const lote = buscar.slice(i, i + 200);
        const filasIbs = await querySybase(consultaPosteriores(lote.reduce((min, o) => (o.fecha < min ? o.fecha : min), desde), manana, lote.map((o) => o.comprobante)));
        for (const m of ibs.normalizarMovimientos(filasIbs, config).movimientos) {
          const clave = `${m.comprobante}|${m.movcod}|${m.fecha}|${m.importe}|${m.cuecod}`;
          if (ya.has(clave)) continue;
          ya.add(clave);
          mov.movimientos.push({ ...m, posterior: true });
          encontrados++;
        }
      }
      if (buscar.length) avisos.push(`IBS: se buscaron movimientos posteriores para ${buscar.length} orden(es) incompleta(s); se encontraron ${encontrados}.`);
    } catch (err) {
      avisos.push(`No se pudieron buscar los movimientos imputados en fechas posteriores: ${err.message}`);
    }
  }

  const r = conciliar({ movimientos: mov.movimientos, pendientes: pend.pendientes, ordenes, config });
  return { rango: { desde, hasta }, generado: ahora, lados: config.lados, ultimaCarga: await ultimaCarga(rootDir), avisos, ...r };
}

// Historia: un registro por día y lado (lo último conciliado).
function resumenPorDia(datos) {
  const dias = [...new Set(datos.ordenes.map((o) => o.fecha))].filter((f) => f >= datos.rango.desde && f < datos.rango.hasta);
  const out = [];
  for (const fecha of dias) {
    for (const l of config.lados) {
      const ind = calculo.indicadores(datos, fecha, l);
      const sem = calculo.semaforo(ind, l);
      out.push({
        fecha, lado: l.lado,
        completadas: ind.bs.completadas, completas: ind.bs.completas, pendientes: ind.bs.pendientes,
        diferencias: ind.bs.incompletas + ind.bs.sinRegistro + ind.bs.porContabilizar,
        importeArs: ind.bs.ars, importeUsd: ind.bs.usd, pendArs: ind.bs.pendArs, pendUsd: ind.bs.pendUsd,
        excepciones: ind.excepciones.length, semaforo: sem.color,
      });
    }
  }
  return out;
}

async function guardarDias(rootDir, datos, usuario) {
  const dias = resumenPorDia(datos);
  await db().query(rootDir, 'DELETE FROM fx_dias WHERE fecha >= ? AND fecha < ?', [datos.rango.desde, datos.rango.hasta]);
  for (const d of dias) {
    await db().query(
      rootDir,
      `INSERT INTO fx_dias (fecha, lado, completadas, completas, pendientes, diferencias, importe_ars, importe_usd, pend_ars, pend_usd, excepciones, semaforo, generado_en, generado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [d.fecha, d.lado, d.completadas, d.completas, d.pendientes, d.diferencias, (d.importeArs / 100).toFixed(2), (d.importeUsd / 100).toFixed(2), (d.pendArs / 100).toFixed(2), (d.pendUsd / 100).toFixed(2), d.excepciones, d.semaforo, datos.generado, usuario]
    );
  }
  return new Set(dias.map((d) => d.fecha)).size;
}

async function historia(rootDir, desde, hasta) {
  const filas = await db().query(rootDir, 'SELECT * FROM fx_dias WHERE fecha >= ? AND fecha <= ? ORDER BY fecha, lado', [desde, hasta]);
  return filas.map((f) => ({
    fecha: String(f.fecha).slice(0, 10), lado: f.lado, completadas: f.completadas, completas: f.completas, pendientes: f.pendientes, diferencias: f.diferencias,
    importeArs: Math.round(Number(f.importe_ars) * 100), importeUsd: Math.round(Number(f.importe_usd) * 100),
    pendArs: Math.round(Number(f.pend_ars) * 100), pendUsd: Math.round(Number(f.pend_usd) * 100), excepciones: f.excepciones, semaforo: f.semaforo, generadoEn: f.generado_en,
  }));
}

module.exports = { obtenerDatos, cargar, ultimaCarga, historialCargas, detalleCarga, resumenPorDia, guardarDias, historia, sumarDias, consultaPosteriores, config };
