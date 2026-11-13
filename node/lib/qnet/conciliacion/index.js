'use strict';

// Conciliación Loop: Loop (partidas) + débitos pendientes + BankService.
// Función pura (sin E/S): recibe filas ya normalizadas y devuelve el resultado.

const { claveDe, agruparComprobantes } = require('./comprobantes');
const { MARCAS, MARCAS_PENDIENTE, marcar } = require('./marcas');
const { TIPOS, cruzar } = require('./cruce');
const { calcularTotales, calcularAntiguedad } = require('./totales');

const TIPO_PENDIENTE_SIN_ASIENTO = 'Débito pendiente sin asiento en Loop';

function conciliar({ partidas, pendientes, transfers, config }) {
  const avisos = [];
  const fechas = partidas.map((p) => p.fecha).sort();
  const periodo = { primerDia: fechas[0] || '', ultimoDia: fechas[fechas.length - 1] || '' };
  const ejecutadas = transfers.map((t) => t.ejecutada).filter(Boolean).sort();
  const corteEjecutada = ejecutadas[ejecutadas.length - 1] || '';
  const corte = { ejecutada: corteEjecutada, dia: corteEjecutada.slice(0, 10) };

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
    const { marca, detalle } = marcar(c, { pendiente, ultimoDia: periodo.ultimoDia, config, debitosPorCuentaImporte });
    const t = transferPorClave.get(c.clave);
    // Cuenta: la del cliente en Loop; si falta, la del débito pendiente y, si tampoco, la de BankService.
    const cuenta = c.cuenta || (pendiente && pendiente.cuecod ? String(parseInt(pendiente.cuecod, 10)) : '') || (t ? t.cuenta : '');
    const fila = { ...c, cuenta, marca, detalle, pendiente: pendiente || null, estadoBankService: t ? t.estado : '' };
    lista.push(fila);
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
  const cruce = cruzar({ comprobantes, transfers, pendientesPorClave, periodo, corte, config });
  excepciones.push(...cruce.excepciones);

  // Débitos pendientes sin comprobante en Loop.
  const pendientesPosteriores = [];
  for (const [clave, p] of pendientesPorClave) {
    if (comprobantes.has(clave)) continue;
    const fila = { comprobante: p.comnro, cuenta: p.cuecod ? String(parseInt(p.cuecod, 10)) : '', moneda: config.etiquetasMoneda[p.moncod] || p.moncod, fecha: p.fechaOrigen, importe: p.importedeb };
    if (p.fechaOrigen > periodo.ultimoDia) {
      pendientesPosteriores.push(fila);
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

  const resumenPorTipo = {};
  for (const e of excepciones) {
    const k = `${e.tipo}|${e.moneda}`;
    const r = (resumenPorTipo[k] = resumenPorTipo[k] || { tipo: e.tipo, moneda: e.moneda, cantidad: 0, importe: 0 });
    r.cantidad++;
    r.importe += e.importe || 0;
  }

  return {
    periodo,
    corte,
    partidasTotal: partidas.length,
    comprobantesTotal: lista.length,
    comprobantesConMarca: lista.filter((c) => c.marca !== MARCAS.CORRECTO).length,
    comprobantes: lista,
    excepciones,
    pendientesPosteriores,
    cruce: cruce.stats,
    totales: calcularTotales(lista, config),
    antiguedad: calcularAntiguedad(lista, periodo.ultimoDia, config),
    resumenPorTipo: Object.values(resumenPorTipo).sort((a, b) => a.tipo.localeCompare(b.tipo) || a.moneda.localeCompare(b.moneda)),
    avisos,
  };
}

module.exports = { conciliar, MARCAS, TIPOS, TIPO_PENDIENTE_SIN_ASIENTO };
