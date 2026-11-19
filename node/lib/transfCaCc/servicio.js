'use strict';

// Capa de datos del dashboard "Conciliación Transferencias CA -> CC": ejecuta las
// dos consultas de IBS, lee BankService de la base (nunca del archivo), guarda la
// foto diaria de los pendientes y arma lo que consume el dashboard.

const config = require('./config');
const ibs = require('./ibs');
const bankservice = require('./bankservice');
const { conciliar } = require('./conciliar');

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

module.exports = { obtenerDatos, cargarBankService, historialCargas, detalleCarga, ultimaCarga, sumarDias, config };
