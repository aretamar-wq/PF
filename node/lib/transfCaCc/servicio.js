'use strict';

// Capa de datos del dashboard "Conciliación Transferencias CA -> CC": ejecuta las
// dos consultas de IBS, lee BankService de la base (nunca del archivo), guarda la
// foto diaria de los pendientes y arma lo que consume el dashboard.

const config = require('./config');
const ibs = require('./ibs');
const bankservice = require('./bankservice');
const { conciliar } = require('./conciliar');
const calculo = require('../../../wwwroot/transf-ca-cc-calculo');

const db = () => require('../mariadbClient');

function sumarDias(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function ultimaCarga(rootDir) {
  const [c] = await db().query(rootDir, 'SELECT id, nombre, cargado_en, cargado_por FROM bankservice_cargas ORDER BY id DESC LIMIT 1');
  const [m] = await db().query(rootDir, 'SELECT MAX(ejecutada) AS corte FROM bankservice_movimientos');
  return c ? { ...c, corte: (m && m.corte) || '' } : null;
}

async function historialCargas(rootDir, limite = 50) {
  return db().query(
    rootDir,
    `SELECT id, nombre, hash, filas_leidas, insertadas, actualizadas, sin_cambios, rechazadas, conflictos, fecha_min, fecha_max, cargado_por, cargado_en
     FROM bankservice_cargas ORDER BY id DESC LIMIT ?`,
    [limite]
  );
}

async function detalleCarga(rootDir, id) {
  const [c] = await db().query(rootDir, 'SELECT rechazos_json FROM bankservice_cargas WHERE id = ?', [id]);
  if (!c) return null;
  try {
    return JSON.parse(c.rechazos_json || '{}');
  } catch (err) {
    return {};
  }
}

// Carga de archivos de BankService: uno por transacción.
async function cargarBankService(rootDir, archivos, usuario, ahora) {
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

// Foto diaria de los pendientes (la consulta devuelve solo el estado del momento):
// una por día, la última del día pisa a la anterior.
async function guardarFotoPendientes(rootDir, pendientes, ahora) {
  await db().query(
    rootDir,
    'REPLACE INTO ibs_pendientes_fotos (fecha, tomada_en, filas, contenido) VALUES (?, ?, ?, ?)',
    [ahora.slice(0, 10), ahora, pendientes.length, JSON.stringify(pendientes)]
  );
}

// desde/hasta: rango de IBS (aaaa-mm-dd, hasta exclusiva). querySybase(sql) -> filas.
async function obtenerDatos({ rootDir, querySybase, desde, hasta, ahora }) {
  const avisos = [];
  const movFilas = await querySybase(ibs.consultaMovimientos(desde, hasta, config));
  const pendFilas = await querySybase(ibs.consultaPendientes(config));
  const mov = ibs.normalizarMovimientos(movFilas, config);
  const pend = ibs.normalizarPendientes(pendFilas, config);
  avisos.push(...mov.avisos, ...pend.avisos);
  try {
    await guardarFotoPendientes(rootDir, pend.pendientes, ahora);
  } catch (err) {
    avisos.push(`No se pudo guardar la foto diaria de pendientes: ${err.message}`);
  }
  // BankService: las operaciones del rango de IBS, con margen (las que se ejecutan
  // un día y se debitan después, o se crearon antes).
  const bsFilas = await db().query(
    rootDir,
    `SELECT comprobante, moncod, cuecod, monto, estado, creada, ejecutada, fecha_operacion, error
     FROM bankservice_movimientos WHERE fecha_operacion >= ? AND fecha_operacion < ?`,
    [sumarDias(desde, -10), sumarDias(hasta, 10)]
  );
  // Además, las operaciones de cualquier fecha cuyo comprobante tiene un débito o un
  // pendiente en lo traído de IBS (un pendiente puede ser de semanas atrás).
  const vistos = new Set(bsFilas.map((f) => String(f.comprobante)));
  const conMovimiento = new Set([...mov.movimientos.map((m) => m.comprobante), ...pend.pendientes.map((p) => p.comprobante)]);
  const faltan = [...conMovimiento].filter((c) => !vistos.has(c));
  for (let i = 0; i < faltan.length; i += 500) {
    const lote = faltan.slice(i, i + 500);
    bsFilas.push(...(await db().query(
      rootDir,
      `SELECT comprobante, moncod, cuecod, monto, estado, creada, ejecutada, fecha_operacion, error
       FROM bankservice_movimientos WHERE comprobante IN (${lote.map(() => '?').join(', ')})`,
      lote
    )));
  }
  const operaciones = bankservice.operacionesDesdeFilas(bsFilas).filter((o) => (o.fecha >= desde && o.fecha < hasta) || conMovimiento.has(o.comprobante));
  if (operaciones.length === 0) avisos.push('No hay operaciones de BankService en la base para ese período: cargá el archivo.');

  // Débitos imputados en fechas posteriores al período: para las operaciones sin
  // débito ni pendiente en lo traído, se buscan sus movimientos desde la fecha de la
  // operación hasta mañana (por moneda, en lotes de comprobantes).
  const manana = sumarDias(ahora.slice(0, 10), 1);
  if (hasta < manana) {
    const conDebito = new Set(mov.movimientos.filter((m) => m.movcod === config.movDebito).map((m) => `${m.moncod}|${m.comprobante}`));
    const conPendiente = new Set(pend.pendientes.map((p) => `${p.moncod}|${p.comprobante}`));
    const sinDebito = operaciones.filter((o) => !conDebito.has(`${o.moncod}|${o.comprobante}`) && !conPendiente.has(`${o.moncod}|${o.comprobante}`) && /^\d+$/.test(o.comprobante));
    const yaTraidos = new Set(mov.movimientos.map((m) => `${m.moncod}|${m.comprobante}|${m.movcod}|${m.fecha}|${m.importe}|${m.cuecod}`));
    let encontrados = 0;
    try {
      for (const moncod of [...new Set(sinDebito.map((o) => o.moncod))]) {
        const ops = sinDebito.filter((o) => o.moncod === moncod);
        const desdeOp = ops.reduce((min, o) => (o.fecha && o.fecha < min ? o.fecha : min), hasta);
        for (let i = 0; i < ops.length; i += 200) {
          const lote = ops.slice(i, i + 200).map((o) => o.comprobante);
          const filas = await querySybase(ibs.consultaPosteriores(desdeOp, manana, moncod, lote, config));
          for (const m of ibs.normalizarMovimientos(filas, config).movimientos) {
            const clave = `${m.moncod}|${m.comprobante}|${m.movcod}|${m.fecha}|${m.importe}|${m.cuecod}`;
            if (yaTraidos.has(clave)) continue;
            yaTraidos.add(clave);
            mov.movimientos.push({ ...m, posterior: true });
            encontrados++;
          }
        }
      }
      if (sinDebito.length > 0) avisos.push(`IBS: se buscaron movimientos posteriores al período para ${sinDebito.length} operación(es) sin débito ni pendiente; se encontraron ${encontrados}.`);
    } catch (err) {
      avisos.push(`No se pudieron buscar los débitos imputados en fechas posteriores: ${err.message}`);
    }
  }
  const r = conciliar({ movimientos: mov.movimientos, pendientes: pend.pendientes, operaciones, config });
  return {
    rango: { desde, hasta },
    generado: ahora,
    config: { movDebito: config.movDebito, movCredito: config.movCredito, usuariosProceso: config.usuariosProceso },
    ultimaCarga: await ultimaCarga(rootDir),
    avisos,
    ...r,
  };
}

// Resumen de cada día del período (fecha de la operación en BankService) para la
// historia: lo mismo que muestran el gráfico, el saldo de pendientes y los semáforos.
function resumenPorDia(datos) {
  const dias = [...new Set(datos.operaciones.map((o) => o.fecha))]
    .filter((f) => f && f >= datos.rango.desde && f < datos.rango.hasta)
    .sort();
  return dias.map((fecha) => {
    const ind = calculo.indicadores(datos, fecha);
    const sem = calculo.semaforos(ind);
    const t = ind.total;
    const porTipo = {};
    for (const e of ind.excepciones) porTipo[e.tipo] = (porTipo[e.tipo] || 0) + 1;
    return {
      fecha,
      aprobadas: t(ind.bs.aprobadas),
      ejecutadas: t(ind.bs.ejecutadas),
      pendientes: t(ind.bs.pendientes),
      sinRegistro: t(ind.bs.sinRegistro),
      porContabilizar: t(ind.bs.porContabilizar),
      pendArs: ind.bs.pendientes[0],
      pendUsd: ind.bs.pendientes[2],
      importePendArs: ind.bs.importePendiente[0],
      importePendUsd: ind.bs.importePendiente[2],
      excepciones: ind.excepciones.length,
      semaforoIbs: sem.ibs.color,
      semaforoBs: sem.bs.color,
      porTipo,
    };
  });
}

// Guarda el resultado de los días del período: si el día ya estaba conciliado se
// actualiza con lo nuevo, y un día del período que ya no tiene operaciones se borra.
async function guardarDias(rootDir, datos, usuario) {
  const dias = resumenPorDia(datos);
  const fechas = dias.map((d) => d.fecha);
  await db().query(
    rootDir,
    `DELETE FROM transf_ca_cc_dias WHERE fecha >= ? AND fecha < ?${fechas.length ? ` AND fecha NOT IN (${fechas.map(() => '?').join(', ')})` : ''}`,
    [datos.rango.desde, datos.rango.hasta, ...fechas]
  );
  for (const d of dias) {
    await db().query(
      rootDir,
      `REPLACE INTO transf_ca_cc_dias (fecha, aprobadas, ejecutadas, pendientes, sin_registro, por_contabilizar, pend_ars, pend_usd,
         importe_pend_ars, importe_pend_usd, excepciones, semaforo_ibs, semaforo_bs, excepciones_json, generado_en, generado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [d.fecha, d.aprobadas, d.ejecutadas, d.pendientes, d.sinRegistro, d.porContabilizar, d.pendArs, d.pendUsd,
        (d.importePendArs / 100).toFixed(2), (d.importePendUsd / 100).toFixed(2), d.excepciones, d.semaforoIbs, d.semaforoBs,
        JSON.stringify(d.porTipo), datos.generado, usuario]
    );
  }
  return dias.length;
}

async function historia(rootDir, desde, hasta) {
  const filas = await db().query(
    rootDir,
    `SELECT fecha, aprobadas, ejecutadas, pendientes, sin_registro, por_contabilizar, pend_ars, pend_usd, importe_pend_ars, importe_pend_usd,
            excepciones, semaforo_ibs, semaforo_bs, excepciones_json, generado_en, generado_por
     FROM transf_ca_cc_dias WHERE fecha >= ? AND fecha <= ? ORDER BY fecha`,
    [desde, hasta]
  );
  return filas.map((f) => ({
    fecha: String(f.fecha).slice(0, 10),
    aprobadas: f.aprobadas, ejecutadas: f.ejecutadas, pendientes: f.pendientes, sinRegistro: f.sin_registro, porContabilizar: f.por_contabilizar,
    pendArs: f.pend_ars, pendUsd: f.pend_usd,
    importePendArs: Math.round(Number(f.importe_pend_ars) * 100), importePendUsd: Math.round(Number(f.importe_pend_usd) * 100),
    excepciones: f.excepciones, semaforoIbs: f.semaforo_ibs, semaforoBs: f.semaforo_bs,
    porTipo: (() => { try { return JSON.parse(f.excepciones_json || '{}'); } catch (err) { return {}; } })(),
    generadoEn: f.generado_en, generadoPor: f.generado_por,
  }));
}

module.exports = { resumenPorDia, guardarDias, historia, obtenerDatos, cargarBankService, historialCargas, detalleCarga, ultimaCarga, sumarDias, config };
