'use strict';

// Conciliación Loop de las transferencias QNET para UN día: Loop (partidas de
// ese día) + débitos pendientes + BankService. Función pura (sin E/S): recibe
// filas ya normalizadas y devuelve el resultado.

const { claveDe, agruparComprobantes } = require('./comprobantes');
const { MARCAS, MARCAS_PENDIENTE, marcar } = require('./marcas');
const { TIPOS, cruzar } = require('./cruce');
const { calcularTotales, calcularAntiguedad } = require('./totales');

const TIPO_PENDIENTE_SIN_ASIENTO = 'Débito pendiente sin asiento en Loop';

// Sin calendario de feriados: solo se salta el fin de semana.
function diaHabilSimple(iso) {
  let d = new Date(`${iso}T00:00:00Z`);
  while ([0, 6].includes(d.getUTCDay())) d = new Date(d.getTime() + 86400000);
  return d.toISOString().slice(0, 10);
}

// fecha: el día a conciliar (aaaa-mm-dd). hoy: hoy; si fecha >= hoy el día sigue abierto.
// diaContable(iso): primer día hábil igual o posterior (calendario de feriados).
function conciliar({ partidas, pendientes, transfers, config, fecha, hoy, diaContable = diaHabilSimple }) {
  const avisos = [];
  const periodo = { primerDia: fecha, ultimoDia: fecha };
  const ejecutadas = transfers.map((t) => t.ejecutada).filter(Boolean).sort();
  const corteEjecutada = ejecutadas[ejecutadas.length - 1] || '';
  const corte = { ejecutada: corteEjecutada, dia: corteEjecutada.slice(0, 10) };
  const hoyEfectivo = hoy || new Date().toISOString().slice(0, 10);

  const comprobantes = agruparComprobantes(partidas, config);
  const transferPorClave = new Map(transfers.map((t) => [t.clave, t]));

  const pendientesPorClave = new Map();
  for (const p of pendientes) {
    const clave = claveDe(p.moncod, p.comnro);
    if (pendientesPorClave.has(clave)) avisos.push(`Débito pendiente repetido para el comprobante ${clave}: se toma el primero.`);
    else pendientesPorClave.set(clave, p);
  }

  // Débitos por cuenta e importe, para señalar un posible débito cruzado.
  const debitosPorCuentaImporte = new Map();
  for (const c of comprobantes.values()) {
    if (c.debito <= 0 || !c.cuenta) continue;
    const k = `${c.moncod}|${c.cuenta}|${c.debito}`;
    if (!debitosPorCuentaImporte.has(k)) debitosPorCuentaImporte.set(k, []);
    debitosPorCuentaImporte.get(k).push(c.comnro);
  }

  const lista = [];
  const excepciones = [];
  for (const c of comprobantes.values()) {
    const pendiente = pendientesPorClave.get(c.clave);
    const { marca, detalle } = marcar(c, { pendiente, ultimoDia: fecha, config, debitosPorCuentaImporte });
    const t = transferPorClave.get(c.clave);
    // Cuenta: la del cliente en Loop; si falta, la del débito pendiente y, si tampoco, la de BankService.
    const cuenta = c.cuenta || (pendiente && pendiente.cuecod ? String(parseInt(pendiente.cuecod, 10)) : '') || (t ? t.cuenta : '');
    lista.push({ ...c, cuenta, marca, detalle, pendiente: pendiente || null, estadoBankService: t ? t.estado : '' });
    if (pendiente && c.partidas === 2) avisos.push(`El comprobante ${c.clave} tiene un débito pendiente pero ya tiene las 2 partidas en Loop.`);
    if (marca === MARCAS.CORRECTO) continue;
    const esPend = MARCAS_PENDIENTE.includes(marca);
    excepciones.push({
      tipo: marca,
      comprobante: c.comnro,
      cuenta,
      moneda: config.etiquetasMoneda[c.moncod] || c.moncod,
      fecha: c.fechaCredito || c.fechaDebito,
      importe: esPend ? pendiente.importedeb : marca === MARCAS.IMPORTES_DISTINTOS ? c.neto : c.credito || c.debito,
      estadoTransfer: t ? t.estado : '',
      debitoPendiente: pendiente ? pendiente.importedeb : null,
      detalle,
    });
  }

  // Cruce con BankService.
  const cruce = cruzar({ comprobantes, transfers, pendientesPorClave, fecha, hoy: hoyEfectivo, corte, config, diaContable });
  excepciones.push(...cruce.excepciones);

  // Débitos pendientes sin comprobante en Loop del día:
  //  - posteriores al día: se informan aparte;
  //  - del día: excepción;
  //  - de días anteriores: no son del día; solo entran en la antigüedad.
  const pendientesPosteriores = [];
  const pendientesAnteriores = [];
  for (const [clave, p] of pendientesPorClave) {
    if (comprobantes.has(clave)) continue;
    const fila = { comprobante: p.comnro, cuenta: p.cuecod ? String(parseInt(p.cuecod, 10)) : '', moneda: config.etiquetasMoneda[p.moncod] || p.moncod, fecha: p.fechaOrigen, importe: p.importedeb };
    if (p.fechaOrigen > fecha) {
      pendientesPosteriores.push(fila);
    } else if (p.fechaOrigen < fecha) {
      pendientesAnteriores.push(fila);
    } else {
      excepciones.push({
        tipo: TIPO_PENDIENTE_SIN_ASIENTO,
        ...fila,
        estadoTransfer: (transferPorClave.get(clave) || {}).estado || '',
        debitoPendiente: p.importedeb,
        detalle: `Débito pendiente del ${p.fechaOrigen} sin ninguna partida en Loop.`,
      });
    }
  }

  // Antigüedad del saldo pendiente: el crédito del día de Loop y los pendientes de días anteriores.
  const itemsAntiguedad = [
    ...lista.filter((c) => MARCAS_PENDIENTE.includes(c.marca)).map((c) => ({ moneda: config.etiquetasMoneda[c.moncod] || c.moncod, fecha: c.fechaCredito, importe: c.pendiente.importedeb })),
    ...pendientesAnteriores.map((p) => ({ moneda: p.moneda, fecha: p.fecha, importe: p.importe })),
    ...excepciones.filter((e) => e.tipo === TIPO_PENDIENTE_SIN_ASIENTO).map((e) => ({ moneda: e.moneda, fecha: e.fecha, importe: e.importe })),
  ];

  const resumenPorTipo = {};
  for (const e of excepciones) {
    const k = `${e.tipo}|${e.moneda}`;
    const r = (resumenPorTipo[k] = resumenPorTipo[k] || { tipo: e.tipo, moneda: e.moneda, cantidad: 0, importe: 0 });
    r.cantidad++;
    r.importe += e.importe || 0;
  }

  return {
    fecha,
    hoy: hoyEfectivo,
    diaAbierto: fecha >= hoyEfectivo,
    periodo,
    corte,
    partidasTotal: partidas.length,
    comprobantesTotal: lista.length,
    comprobantesConMarca: lista.filter((c) => c.marca !== MARCAS.CORRECTO).length,
    comprobantes: lista,
    excepciones,
    pendientesPosteriores,
    pendientesAnteriores,
    cruce: cruce.stats,
    totales: calcularTotales(lista, config),
    antiguedad: calcularAntiguedad(itemsAntiguedad, fecha),
    resumenPorTipo: Object.values(resumenPorTipo).sort((a, b) => a.tipo.localeCompare(b.tipo) || a.moneda.localeCompare(b.moneda)),
    avisos,
  };
}

module.exports = { conciliar, diaHabilSimple, MARCAS, TIPOS, TIPO_PENDIENTE_SIN_ASIENTO };
