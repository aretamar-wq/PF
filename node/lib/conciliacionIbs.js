'use strict';

// Conciliación de las altas de Plazo Fijo de ApiCore (operaciones_procesadas
// de un día, ver getAltasDelDia) contra el extracto de movimientos de IBS
// (sistcod,moncod,cuecod,Fecha_Mov,comnro,movcod,signo,accimp,Importe).
// Cada alta de ApiCore se espera en IBS como:
// - circuito 0: 25020 (débito Cuenta Corriente) y 25021 (crédito Caja de
//   Ahorro) con comnro = numero_comprobante, y 152 (alta del PF) con
//   comnro = operacion — los tres por el monto, 25021 y 152 en caja_ahorro;
// - circuito 1: solo el 152 (sin 25020/25021).
// Lo que sobra en IBS es "solo en IBS", salvo los 152 debitados de una
// Cuenta Corriente (sistcod 3): ApiCore nunca da de alta un PF así, son de
// otro canal y se informan aparte.

const COLUMNAS_IBS = ['sistcod', 'cuecod', 'Fecha_Mov', 'comnro', 'movcod', 'accimp'];
const MOV_DEBITO_CC = '25020';
const MOV_CREDITO_CA = '25021';
const MOV_ALTA_PF = '152';
// Crédito en la Caja de Ahorro cuando vence un plazo fijo (capital + interés); comnro = número de operación del PF.
const MOV_VENCIMIENTO_PF = '1200';

// Importes a centavos enteros: comparar sumas en float acumula error.
function toCents(value) {
  const n = Number(String(value == null ? '' : value).trim());
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function formatCents(cents) {
  return (cents / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function isoToDMY(fecha) {
  const [y, m, d] = fecha.split('-');
  return `${d}/${m}/${y}`;
}

// Extracto de IBS de un día (tgl_movimientos + tgl_movimientos_aper),
// mismas columnas que el CSV que se puede subir a mano. concod = ' ' deja
// afuera los movimientos con contra-asiento. Fechas como 'yyyymmdd': Sybase
// las interpreta igual sea cual sea el dateformat de la sesión. UNION ALL
// (no UNION) para que un mismo movimiento registrado dos veces no se
// colapse en una sola fila y se vea como "Repetido en IBS". Cada filtro es
// una condición SQL ya armada por quien llama (solo con valores numéricos
// validados, nunca texto del usuario).
function buildIbsQuery(fecha, filtros, opciones = {}) {
  const hastaFecha = opciones.hasta || fecha;
  for (const f of [fecha, hastaFecha]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) throw new Error(`Fecha inválida: '${f}'.`);
  }
  const [y, m, d] = hastaFecha.split('-').map(Number);
  const siguiente = new Date(Date.UTC(y, m - 1, d + 1));
  const desde = fecha.replace(/-/g, '');
  const hasta = siguiente.toISOString().slice(0, 10).replace(/-/g, '');
  // conConcod: trae también los movimientos con contra-asiento (concod M/C)
  // y la columna concod — hace falta para ver débitos que se hicieron y se
  // revirtieron (transferencias DEBIN rechazadas por el otro sistema).
  const colConcod = opciones.conConcod ? 'a.concod, ' : '';
  const filtroConcod = opciones.conConcod ? '' : "\n  and a.concod = ' '";
  const select = (filtro) => `select a.sistcod, a.moncod, a.cuecod, convert(varchar, a.fecmov, 103) 'Fecha_Mov', a.comnro, a.movcod, ${colConcod}b.signo, b.accimp, b.signo * b.accimp 'Importe'
from tgl_movimientos a, tgl_movimientos_aper b
where a.fecmov >= '${desde}'
  and a.fecmov < '${hasta}'${filtroConcod}
  and a.fecreal = b.fecreal
  and a.tercod = b.tercod
  and b.funcod = 1
  and ${filtro}`;
  return filtros.map(select).join('\nunion all\n');
}

function buildIbsAltasPfQuery(fecha) {
  return buildIbsQuery(fecha, ['a.movcod in (25020, 25021)', 'a.movcod in (152) and a.sistcod = 5']);
}

// Pagos de Plazo Fijo: débito en Caja de Ahorro y crédito en la Cuenta
// Corriente de Cocos, con las transacciones y cuentas de Parametría (ver
// getPagoPfConfig) — no hay códigos fijos en el código.
function buildIbsPagosPfQuery(fecha, config) {
  return buildIbsQuery(fecha, [
    `a.movcod = ${config.movDebitoCa} and a.sistcod = ${config.sistCa}`,
    `a.movcod = ${config.movCreditoCc} and a.sistcod = ${config.sistCc} and a.cuecod = ${config.cuentaCc}`,
    `a.movcod = ${MOV_VENCIMIENTO_PF} and a.sistcod = ${config.sistCa}`,
  ]);
}

// Lo que el cruce de pagos necesita de Parametría (cajaDeAhorro/
// cuentaCorriente). Todo tiene que ser numérico: además de ser lo que
// espera IBS, es lo que permite armar la query sin riesgo de inyección.
function getPagoPfConfig(parametria) {
  const cc = (parametria && parametria.cuentaCorriente) || {};
  const ca = (parametria && parametria.cajaDeAhorro) || {};
  const config = {
    movDebitoCa: String(ca.transaccionDebito || '').trim(),
    sistCa: String(ca.codigoSistema || '').trim(),
    movCreditoCc: String(cc.transaccionCredito || '').trim(),
    sistCc: String(cc.codigoSistema || '').trim(),
    cuentaCc: String(cc.codigoCuenta || '').trim(),
  };
  const etiquetas = {
    movDebitoCa: 'transacción de débito de Caja de Ahorro',
    sistCa: 'código de sistema de Caja de Ahorro',
    movCreditoCc: 'transacción de crédito de Cuenta Corriente',
    sistCc: 'código de sistema de Cuenta Corriente',
    cuentaCc: 'código de cuenta de Cuenta Corriente',
  };
  const invalidos = Object.keys(config).filter((k) => !/^\d+$/.test(config[k]));
  if (invalidos.length > 0) {
    const error = new Error(`Falta configurar en Parametría (valores numéricos): ${invalidos.map((k) => etiquetas[k]).join(', ')}.`);
    error.statusCode = 400;
    throw error;
  }
  return config;
}

// Filas de querySybase (objetos por columna) al mismo formato que un CSV
// parseado (encabezado + filas), para pasarlas por conciliarAltasPf.
function ibsRowsToLines(rows, opciones = {}) {
  const header = ['sistcod', 'moncod', 'cuecod', 'Fecha_Mov', 'comnro', 'movcod'];
  if (opciones.conConcod) header.push('concod');
  header.push('signo', 'accimp', 'Importe');
  return [header, ...rows.map((row) => header.map((col) => (row[col] == null ? '' : String(row[col]))))];
}

// Extracto (encabezado + filas) a movimientos de la fecha pedida; los de otra
// fecha se cuentan aparte (filasOtraFecha) y no participan del cruce.
function leerMovimientosIbs(ibsLines, fecha) {
  const [header, ...data] = ibsLines;
  const faltantes = COLUMNAS_IBS.filter((c) => !(header || []).includes(c));
  if (faltantes.length > 0) {
    const error = new Error(`El archivo no tiene el formato del extracto de IBS (faltan las columnas: ${faltantes.join(', ')}).`);
    error.statusCode = 400;
    throw error;
  }
  const col = (row, name) => String(row[header.indexOf(name)] == null ? '' : row[header.indexOf(name)]).trim();

  const fechaDMY = isoToDMY(fecha);
  const movimientos = [];
  let filasOtraFecha = 0;
  for (const row of data) {
    if (row.length === 1 && row[0].trim() === '') continue;
    const mov = {
      sistcod: col(row, 'sistcod'),
      cuecod: col(row, 'cuecod'),
      fechaMov: col(row, 'Fecha_Mov'),
      comnro: col(row, 'comnro'),
      movcod: col(row, 'movcod'),
      cents: toCents(col(row, 'accimp')),
      usado: false,
    };
    if (mov.fechaMov !== fechaDMY) {
      filasOtraFecha++;
      continue;
    }
    movimientos.push(mov);
  }
  return { movimientos, filasOtraFecha };
}

function indexarPorClave(movimientos) {
  const porClave = new Map();
  for (const mov of movimientos) {
    const key = `${mov.movcod}|${mov.comnro}`;
    if (!porClave.has(key)) porClave.set(key, []);
    porClave.get(key).push(mov);
  }
  return porClave;
}

// Lo que ApiCore rechazó (o nunca llegó a hacer) tiene que NO figurar en IBS.
// Estados de cada rechazado: 'no-figura' (correcto), 'figura' (IBS tiene
// movimientos sin revertir: diferencia), 'revertida' (IBS lo debitó y lo
// revirtió, neto cero: solo transferencias) y 'reintentada' (se volvió a
// procesar y quedó realizada, así que sus movimientos son los de la realizada).
function resumenRechazados(rechazados) {
  const cuenta = (estado) => rechazados.filter((r) => r.estado === estado).length;
  return {
    rechazadosApicore: rechazados.length,
    rechazadosEnIbs: cuenta('figura'),
    rechazadosRevertidos: cuenta('revertida'),
    rechazadosReintentados: cuenta('reintentada'),
  };
}

const claveCuitComprobante = (cuit, comprobante) => `${String(cuit == null ? '' : cuit).trim()}|${String(comprobante == null ? '' : comprobante).trim()}`;

function importeRechazado(r) {
  return toCents(r.importe) / 100;
}

// opciones.rechazados: filas rechazadas de ApiCore del día, ya normalizadas
// ({ fecha, idMensaje, cuit, apellidoNombre, numeroComprobante, circuito,
// importe, motivo, usuario }).
function conciliarAltasPf(altas, ibsLines, fecha, opciones = {}) {
  const { movimientos, filasOtraFecha } = leerMovimientosIbs(ibsLines, fecha);

  const porClave = indexarPorClave(movimientos);

  const diferencias = [];
  let altasOk = 0;
  for (const alta of altas) {
    const circuito = String(alta.tipo_circuito || '').trim();
    const montoCents = toCents(alta.monto);
    const base = {
      numeroComprobante: alta.numero_comprobante,
      operacion: alta.operacion,
      circuito,
      cuit: alta.cuit,
      apellidoNombre: alta.apellido_nombre,
      cajaAhorro: alta.caja_ahorro,
      importe: montoCents / 100,
    };
    const problemas = [];

    const esperar = (movcod, comnro, cuentaEsperada, etiqueta) => {
      const candidatos = porClave.get(`${movcod}|${comnro}`) || [];
      const mov = candidatos.find((m) => !m.usado);
      if (!mov) {
        problemas.push({ tipo: 'Falta en IBS', detalle: `No está el ${etiqueta} (${movcod}, comnro ${comnro}).` });
        return;
      }
      mov.usado = true;
      if (cuentaEsperada && mov.cuecod !== String(cuentaEsperada).trim()) {
        problemas.push({ tipo: 'Cuenta distinta', detalle: `${etiqueta} (${movcod}): IBS en cuenta ${mov.cuecod}, ApiCore en ${cuentaEsperada}.` });
      }
      if (mov.cents !== montoCents) {
        problemas.push({
          tipo: 'Importe distinto',
          detalle: `${etiqueta} (${movcod}): IBS $ ${formatCents(mov.cents)}, ApiCore $ ${formatCents(montoCents)}.`,
        });
      }
    };

    if (circuito === '1') {
      for (const movcod of [MOV_DEBITO_CC, MOV_CREDITO_CA]) {
        for (const mov of porClave.get(`${movcod}|${alta.numero_comprobante}`) || []) {
          if (mov.usado) continue;
          mov.usado = true;
          problemas.push({ tipo: 'Movimiento de más en IBS', detalle: `Circuito 1 (sin débito/crédito), pero IBS tiene un ${movcod} con comnro ${mov.comnro}.` });
        }
      }
    } else {
      esperar(MOV_DEBITO_CC, alta.numero_comprobante, null, 'débito en Cuenta Corriente');
      esperar(MOV_CREDITO_CA, alta.numero_comprobante, alta.caja_ahorro, 'crédito en Caja de Ahorro');
    }
    esperar(MOV_ALTA_PF, alta.operacion, alta.caja_ahorro, 'alta del Plazo Fijo');

    if (problemas.length === 0) altasOk++;
    for (const p of problemas) diferencias.push({ ...base, ...p });
  }

  // Rechazadas por ApiCore: no tendrían que tener débito ni crédito en IBS.
  const realizadasClaves = new Set(altas.map((a) => claveCuitComprobante(a.cuit, a.numero_comprobante)));
  const rechazados = [];
  for (const r of opciones.rechazados || []) {
    const comprobante = String(r.numeroComprobante || '').trim();
    const fila = { ...r, numeroComprobante: comprobante, importe: importeRechazado(r) };
    if (realizadasClaves.has(claveCuitComprobante(r.cuit, comprobante))) {
      rechazados.push({ ...fila, estado: 'reintentada', detalle: 'Se volvió a procesar y quedó realizada.' });
      continue;
    }
    const movs = comprobante ? [...(porClave.get(`${MOV_DEBITO_CC}|${comprobante}`) || []), ...(porClave.get(`${MOV_CREDITO_CA}|${comprobante}`) || [])] : [];
    if (movs.length === 0) {
      rechazados.push({ ...fila, estado: 'no-figura', detalle: '' });
      continue;
    }
    rechazados.push({ ...fila, estado: 'figura', detalle: `IBS tiene ${movs.map((m) => m.movcod).join(' y ')} con comnro ${comprobante}.` });
    for (const mov of movs) {
      if (mov.usado) continue;
      mov.usado = true;
      diferencias.push({
        tipo: 'Rechazada en ApiCore, con movimientos en IBS',
        numeroComprobante: comprobante,
        operacion: '',
        circuito: r.circuito || '',
        cuit: r.cuit,
        apellidoNombre: r.apellidoNombre,
        cajaAhorro: mov.sistcod === '5' ? mov.cuecod : '',
        importe: mov.cents / 100,
        detalle: `ApiCore la rechazó (${r.motivo || 'sin motivo'}), pero IBS tiene el ${mov.movcod} (cuenta ${mov.cuecod}, comnro ${comprobante}) por $ ${formatCents(mov.cents)}.`,
      });
    }
  }

  const otrosCanales = [];
  for (const mov of movimientos) {
    if (mov.usado) continue;
    if (mov.movcod === MOV_ALTA_PF && mov.sistcod === '3') {
      otrosCanales.push({ cuecod: mov.cuecod, comnro: mov.comnro, importe: mov.cents / 100 });
      continue;
    }
    const repetido = (porClave.get(`${mov.movcod}|${mov.comnro}`) || []).length > 1;
    diferencias.push({
      tipo: repetido ? 'Repetido en IBS' : 'Solo en IBS',
      numeroComprobante: mov.movcod === MOV_ALTA_PF ? '' : mov.comnro,
      operacion: mov.movcod === MOV_ALTA_PF ? mov.comnro : '',
      circuito: '',
      cuit: '',
      apellidoNombre: '',
      cajaAhorro: mov.sistcod === '5' ? mov.cuecod : '',
      importe: mov.cents / 100,
      detalle: `Movimiento ${mov.movcod} en cuenta ${mov.cuecod} (sistcod ${mov.sistcod}, comnro ${mov.comnro}) sin alta en ApiCore${repetido ? ': el mismo movimiento está más de una vez en IBS' : ''}.`,
    });
  }

  const sumCents = (list) => list.reduce((s, x) => s + x, 0);
  const circuito0 = altas.filter((a) => String(a.tipo_circuito || '').trim() === '0');
  const circuito1 = altas.filter((a) => String(a.tipo_circuito || '').trim() !== '0');
  const circuitoPorOperacion = new Map(altas.map((a) => [String(a.operacion).trim(), String(a.tipo_circuito || '').trim()]));
  const totalIbs = (pred) => {
    const list = movimientos.filter(pred);
    return { cantidad: list.length, importe: sumCents(list.map((m) => m.cents)) / 100 };
  };
  const totales = [
    {
      concepto: 'Débitos en Cuenta Corriente (25020)',
      apicore: { cantidad: circuito0.length, importe: sumCents(circuito0.map((a) => toCents(a.monto))) / 100 },
      ibs: totalIbs((m) => m.movcod === MOV_DEBITO_CC),
    },
    {
      concepto: 'Créditos en Caja de Ahorro (25021)',
      apicore: { cantidad: circuito0.length, importe: sumCents(circuito0.map((a) => toCents(a.monto))) / 100 },
      ibs: totalIbs((m) => m.movcod === MOV_CREDITO_CA),
    },
    {
      concepto: 'Altas de Plazo Fijo, circuito 0 — con débito de Cuenta Corriente (152)',
      apicore: { cantidad: circuito0.length, importe: sumCents(circuito0.map((a) => toCents(a.monto))) / 100 },
      ibs: totalIbs((m) => m.movcod === MOV_ALTA_PF && m.sistcod !== '3' && circuitoPorOperacion.get(m.comnro) === '0'),
    },
    {
      concepto: 'Altas de Plazo Fijo, circuito 1 — directo desde Caja de Ahorro (152)',
      apicore: { cantidad: circuito1.length, importe: sumCents(circuito1.map((a) => toCents(a.monto))) / 100 },
      ibs: totalIbs((m) => m.movcod === MOV_ALTA_PF && m.sistcod !== '3' && circuitoPorOperacion.get(m.comnro) !== '0'),
    },
    {
      concepto: 'Total altas de Plazo Fijo (152)',
      apicore: { cantidad: altas.length, importe: sumCents(altas.map((a) => toCents(a.monto))) / 100 },
      ibs: totalIbs((m) => m.movcod === MOV_ALTA_PF && m.sistcod !== '3'),
    },
  ];

  return {
    tipo: 'altas',
    fecha,
    resumen: {
      altasApicore: altas.length,
      altasCircuito0: circuito0.length,
      altasCircuito1: altas.length - circuito0.length,
      movimientosIbs: movimientos.length,
      altasOk,
      altasConDiferencias: altas.length - altasOk,
      ...resumenRechazados(rechazados),
      soloEnIbs: diferencias.filter((d) => d.tipo === 'Solo en IBS' || d.tipo === 'Repetido en IBS').length,
      otrosCanales: otrosCanales.length,
      otrosCanalesImporte: sumCents(otrosCanales.map((o) => Math.round(o.importe * 100))) / 100,
      filasOtraFecha,
    },
    totales,
    diferencias,
    rechazados,
    otrosCanales,
  };
}

// Conciliación de los pagos de Plazo Fijo ("Pago de Plazo Fijos") contra IBS.
// "operaciones" son TODAS las operaciones de operaciones_procesadas cuyo
// vencimiento es la fecha pedida (fecha_vencimiento = fecha de proceso, que
// es la fecha con la que el flow registra el pago en IBS — por eso se parte
// del vencimiento y no de cuándo se pagó según el reloj del servidor).
// - circuito 0 y pf_pagado = 1: en IBS tiene que estar el débito en Caja de
//   Ahorro (config.movDebitoCa, en caja_ahorro) y el crédito en la Cuenta
//   Corriente (config.movCreditoCc, en config.cuentaCc), ambos con comnro =
//   numero_comprobante y por importe_neto;
// - circuito 0 y pf_pagado = 0: no tendría que haber ningún movimiento; si
//   hay, es un pago que se hizo en IBS pero ApiCore no lo marcó como pagado
//   (o un pago a medias: débito sin crédito) — es la diferencia más delicada;
// - circuito 1: ApiCore nunca lo paga, no tendría que haber movimientos.
// Los que vencían y no se pagaron (sin movimientos en IBS) no son una
// diferencia: se informan aparte como "pendientes".
function conciliarPagosPf(operaciones, ibsLines, fecha, config, opciones = {}) {
  const { movimientos, filasOtraFecha } = leerMovimientosIbs(ibsLines, fecha);
  const porClave = indexarPorClave(movimientos);

  const esDebitoCa = (m) => m.movcod === config.movDebitoCa && m.sistcod === config.sistCa;
  const esCreditoCc = (m) => m.movcod === config.movCreditoCc && m.sistcod === config.sistCc && m.cuecod === config.cuentaCc;
  const relevantes = movimientos.filter((m) => esDebitoCa(m) || esCreditoCc(m));
  const porClaveRelevante = indexarPorClave(relevantes);

  // Crédito de vencimiento del plazo fijo (1200, comnro = operación): IBS lo
  // acredita en la Caja de Ahorro antes de que ApiCore la debite para pagar.
  // Solo se verifica si el extracto lo trae (los extractos anteriores no).
  const vencimientos = movimientos.filter((m) => m.movcod === MOV_VENCIMIENTO_PF && m.sistcod === config.sistCa);
  const hayVencimientos = vencimientos.length > 0;
  const vencPorOperacion = indexarPorClave(vencimientos);
  const vencimientosCasados = [];

  const diferencias = [];
  const pendientes = [];
  let pagosOk = 0;
  let pagadosApicore = 0;
  let sinPagar = 0;
  const vencenCircuito0 = operaciones.filter((o) => String(o.tipo_circuito || '').trim() === '0');

  for (const op of operaciones) {
    const circuito = String(op.tipo_circuito || '').trim();
    const pagado = Number(op.pf_pagado) === 1;
    const importeCents = toCents(op.importe_neto);
    const base = {
      numeroComprobante: op.numero_comprobante,
      operacion: op.operacion,
      circuito,
      cuit: op.cuit,
      apellidoNombre: op.apellido_nombre,
      cajaAhorro: op.caja_ahorro,
      importe: importeCents / 100,
    };
    const candidatos = (movcod) => (porClaveRelevante.get(`${movcod}|${op.numero_comprobante}`) || []).filter((m) => !m.usado);

    // Vencimiento acreditado en IBS (todas las operaciones que vencen, pagadas o no, circuito 0 o 1).
    let problemasVencimiento = 0;
    const operacionPf = String(op.operacion || '').trim();
    if (hayVencimientos && operacionPf) {
      const lista = (vencPorOperacion.get(`${MOV_VENCIMIENTO_PF}|${operacionPf}`) || []).filter((m) => !m.usado);
      const venc = lista.find((m) => m.cuecod === String(op.caja_ahorro).trim() && m.cents === importeCents) || lista[0];
      if (!venc) {
        problemasVencimiento++;
        diferencias.push({
          ...base,
          tipo: 'Vencimiento sin acreditar en IBS',
          detalle: `IBS no tiene el crédito del vencimiento del plazo fijo (${MOV_VENCIMIENTO_PF}, operación ${operacionPf}) en la Caja de Ahorro ${op.caja_ahorro}.`,
        });
      } else {
        venc.usado = true;
        vencimientosCasados.push(venc);
        if (venc.cuecod !== String(op.caja_ahorro).trim()) {
          problemasVencimiento++;
          diferencias.push({ ...base, tipo: 'Cuenta de vencimiento distinta', detalle: `IBS acreditó el vencimiento (${MOV_VENCIMIENTO_PF}) en la cuenta ${venc.cuecod} y ApiCore tiene la ${op.caja_ahorro}.` });
        }
        if (venc.cents !== importeCents) {
          problemasVencimiento++;
          diferencias.push({
            ...base,
            tipo: 'Importe de vencimiento distinto',
            detalle: `IBS acreditó $ ${formatCents(venc.cents)} por el vencimiento (${MOV_VENCIMIENTO_PF}) y el importe neto de ApiCore es $ ${formatCents(importeCents)}.`,
          });
        }
      }
    }

    if (circuito === '0' && pagado) {
      pagadosApicore++;
      const problemas = [];
      const esperar = (movcod, cuentaEsperada, etiqueta) => {
        const lista = candidatos(movcod);
        // Con comprobantes repetidos entre CUIT distintos, primero el que
        // coincide en cuenta e importe, para no cruzar el de otro cliente.
        const mov = lista.find((m) => m.cuecod === String(cuentaEsperada) && m.cents === importeCents) || lista[0];
        if (!mov) {
          problemas.push({ tipo: 'Falta en IBS', detalle: `No está el ${etiqueta} (${movcod}, comnro ${op.numero_comprobante}).` });
          return;
        }
        mov.usado = true;
        if (mov.cuecod !== String(cuentaEsperada).trim()) {
          problemas.push({ tipo: 'Cuenta distinta', detalle: `${etiqueta} (${movcod}): IBS en cuenta ${mov.cuecod}, ApiCore en ${cuentaEsperada}.` });
        }
        if (mov.cents !== importeCents) {
          problemas.push({ tipo: 'Importe distinto', detalle: `${etiqueta} (${movcod}): IBS $ ${formatCents(mov.cents)}, ApiCore $ ${formatCents(importeCents)}.` });
        }
      };
      esperar(config.movDebitoCa, op.caja_ahorro, 'débito en Caja de Ahorro');
      esperar(config.movCreditoCc, config.cuentaCc, 'crédito en Cuenta Corriente');
      if (problemas.length === 0 && problemasVencimiento === 0) pagosOk++;
      for (const p of problemas) diferencias.push({ ...base, ...p });
      continue;
    }

    // Sin pago en ApiCore (circuito 1, o circuito 0 sin pagar): cualquier movimiento es una diferencia.
    const debito = candidatos(config.movDebitoCa);
    const credito = candidatos(config.movCreditoCc);
    for (const m of [...debito, ...credito]) m.usado = true;
    if (circuito === '0') sinPagar++;
    if (debito.length === 0 && credito.length === 0) {
      if (circuito === '0') pendientes.push(base);
    } else if (circuito === '0') {
      const soloDebito = debito.length > 0 && credito.length === 0;
      diferencias.push({
        ...base,
        tipo: soloDebito ? 'Pago incompleto en IBS' : 'Pagado en IBS, no en ApiCore',
        detalle: soloDebito
          ? `IBS tiene el débito en Caja de Ahorro (${config.movDebitoCa}, $ ${formatCents(debito[0].cents)}) pero no el crédito en Cuenta Corriente, y ApiCore no lo marcó como pagado.`
          : `IBS tiene el pago (${debito.length ? 'débito en Caja de Ahorro' : ''}${debito.length && credito.length ? ' y ' : ''}${credito.length ? 'crédito en Cuenta Corriente' : ''}), pero ApiCore no lo marcó como pagado.`,
      });
    } else {
      diferencias.push({
        ...base,
        tipo: 'Movimiento de más en IBS',
        detalle: `Circuito ${circuito || '?'} (ApiCore no lo paga), pero IBS tiene movimientos de pago con comnro ${op.numero_comprobante}.`,
      });
    }
  }

  // Rechazados por ApiCore (archivo de error del flow): no tendrían que tener
  // débito ni crédito en IBS.
  const pagadosClaves = new Set(operaciones.filter((o) => Number(o.pf_pagado) === 1).map((o) => claveCuitComprobante(o.cuit, o.numero_comprobante)));
  const rechazados = [];
  for (const r of opciones.rechazados || []) {
    const comprobante = String(r.numeroComprobante || '').trim();
    const fila = { ...r, numeroComprobante: comprobante, importe: importeRechazado(r) };
    if (pagadosClaves.has(claveCuitComprobante(r.cuit, comprobante))) {
      rechazados.push({ ...fila, estado: 'reintentada', detalle: 'Se volvió a procesar y quedó pagado.' });
      continue;
    }
    const movs = comprobante ? [...(porClaveRelevante.get(`${config.movDebitoCa}|${comprobante}`) || []), ...(porClaveRelevante.get(`${config.movCreditoCc}|${comprobante}`) || [])] : [];
    if (movs.length === 0) {
      rechazados.push({ ...fila, estado: 'no-figura', detalle: '' });
      continue;
    }
    rechazados.push({ ...fila, estado: 'figura', detalle: `IBS tiene ${movs.map((m) => m.movcod).join(' y ')} con comnro ${comprobante}.` });
    for (const mov of movs) {
      if (mov.usado) continue;
      mov.usado = true;
      diferencias.push({
        tipo: 'Rechazado en ApiCore, con movimientos en IBS',
        numeroComprobante: comprobante,
        operacion: '',
        circuito: r.circuito || '',
        cuit: r.cuit,
        apellidoNombre: r.apellidoNombre,
        cajaAhorro: mov.sistcod === config.sistCa ? mov.cuecod : '',
        importe: mov.cents / 100,
        detalle: `ApiCore rechazó el pago (${r.motivo || 'sin motivo'}), pero IBS tiene el ${mov.movcod} (cuenta ${mov.cuecod}, comnro ${comprobante}) por $ ${formatCents(mov.cents)}.`,
      });
    }
  }

  for (const mov of relevantes) {
    if (mov.usado) continue;
    const repetido = (porClaveRelevante.get(`${mov.movcod}|${mov.comnro}`) || []).length > 1;
    diferencias.push({
      tipo: repetido ? 'Repetido en IBS' : 'Solo en IBS',
      numeroComprobante: mov.comnro,
      operacion: '',
      circuito: '',
      cuit: '',
      apellidoNombre: '',
      cajaAhorro: mov.sistcod === config.sistCa ? mov.cuecod : '',
      importe: mov.cents / 100,
      detalle: `Movimiento ${mov.movcod} en cuenta ${mov.cuecod} (sistcod ${mov.sistcod}, comnro ${mov.comnro}) sin un plazo fijo que venza ese día en ApiCore${repetido ? ': el mismo movimiento está más de una vez en IBS' : ''}.`,
    });
  }

  const sumCents = (list) => list.reduce((acc, x) => acc + x, 0);
  const pagados = operaciones.filter((o) => String(o.tipo_circuito || '').trim() === '0' && Number(o.pf_pagado) === 1);
  const importePagados = sumCents(pagados.map((o) => toCents(o.importe_neto))) / 100;
  const totalIbs = (pred) => {
    const list = relevantes.filter(pred);
    return { cantidad: list.length, importe: sumCents(list.map((m) => m.cents)) / 100 };
  };
  const tipos = (d) => diferencias.filter((x) => x.tipo === d).length;
  const otrosVencimientos = vencimientos.filter((m) => !m.usado);
  const conOperacion = operaciones.filter((o) => String(o.operacion || '').trim());

  return {
    tipo: 'pagos',
    fecha,
    resumen: {
      vencenCircuito0: vencenCircuito0.length,
      vencenCircuito1: operaciones.length - vencenCircuito0.length,
      pagadosApicore,
      pagosOk,
      pagosConDiferencias: pagadosApicore - pagosOk,
      sinPagar,
      pendientes: pendientes.length,
      ...resumenRechazados(rechazados),
      pendientesImporte: sumCents(pendientes.map((p) => Math.round(p.importe * 100))) / 100,
      pagadosEnIbsNoApicore: tipos('Pagado en IBS, no en ApiCore') + tipos('Pago incompleto en IBS'),
      soloEnIbs: tipos('Solo en IBS') + tipos('Repetido en IBS'),
      movimientosIbs: movimientos.length,
      filasOtraFecha,
      verificaVencimientos: hayVencimientos,
      vencimientosSinAcreditar: tipos('Vencimiento sin acreditar en IBS'),
      // Vencimientos (1200) de plazos fijos que no son de ApiCore: informativo.
      otrosCanales: otrosVencimientos.length,
      otrosCanalesImporte: sumCents(otrosVencimientos.map((m) => m.cents)) / 100,
    },
    totales: [
      ...(hayVencimientos
        ? [
            {
              concepto: `Créditos de vencimiento en Caja de Ahorro (${MOV_VENCIMIENTO_PF})`,
              apicore: { cantidad: conOperacion.length, importe: sumCents(conOperacion.map((o) => toCents(o.importe_neto))) / 100 },
              ibs: { cantidad: vencimientosCasados.length, importe: sumCents(vencimientosCasados.map((m) => m.cents)) / 100 },
            },
          ]
        : []),
      {
        concepto: `Débitos en Caja de Ahorro (${config.movDebitoCa})`,
        apicore: { cantidad: pagados.length, importe: importePagados },
        ibs: totalIbs(esDebitoCa),
      },
      {
        concepto: `Créditos en Cuenta Corriente ${config.cuentaCc} (${config.movCreditoCc})`,
        apicore: { cantidad: pagados.length, importe: importePagados },
        ibs: totalIbs(esCreditoCc),
      },
    ],
    diferencias,
    pendientes,
    rechazados,
    otrosCanales: otrosVencimientos.map((m) => ({ cuecod: m.cuecod, comnro: m.comnro, importe: m.cents / 100 })),
  };
}

// ---------------------------------------------------------------------------
// Transferencias DEBIN ("Transferencia DEBIN - File")
//
// Cada transferencia realizada de ApiCore (dbn_consulta, realizado = 's') se
// espera en IBS como UN débito en la Caja de Ahorro del cliente
// (sistcod 5) con comnro = id_comprobante: movimiento 28600 si es a su
// propia cuenta (mismo CUIT) y 28601 si es a terceros, por el importe, en la
// moneda (moncod 0 = pesos, 2 = dólares) y en la cuenta que sale del CBU de
// débito. Las transferencias que el otro sistema rechaza también se debitan
// y se revierten enseguida: un débito (signo -1, concod 'M') y su
// contra-asiento (signo +1, concod 'C') que netean cero — por eso los
// débitos "vigentes" de un comprobante son (débitos - contra-asientos).
//
// La fecha del débito en IBS no es la de la transferencia: los fines de
// semana y feriados pasan al próximo día hábil (calendario de feriados en
// Parametría, ver parseFeriados/proximoDiaHabil).
// ---------------------------------------------------------------------------

const MOV_TRANSFERENCIA_MISMO_TITULAR = '28600';
const MOV_TRANSFERENCIA_TERCEROS = '28601';
const MONEDA_IBS = { 32: '0', '032': '0', 840: '2' };
const MONEDA_ETIQUETA = { 32: 'ARS', '032': 'ARS', 840: 'USD' };
const MONEDA_IBS_ETIQUETA = { 0: 'ARS', 2: 'USD' };

function sumarDias(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function esFinDeSemana(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dia = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dia === 0 || dia === 6;
}

// Primer día hábil igual o posterior a la fecha (yyyy-MM-dd): no sábado ni
// domingo ni feriado. El tope de iteraciones evita un bucle infinito con un
// calendario absurdo.
function proximoDiaHabil(iso, feriados) {
  let fecha = iso;
  for (let i = 0; i < 60 && (esFinDeSemana(fecha) || feriados.has(fecha)); i++) fecha = sumarDias(fecha, 1);
  return fecha;
}

// Texto libre de Parametría (calendario.feriados): fechas separadas por
// salto de línea, coma, punto y coma o espacio, como yyyy-MM-dd o dd/MM/yyyy.
// Lo que no se reconoce se devuelve en "invalidos" para avisarlo — no se
// rechaza al guardar la Parametría.
function parseFeriados(texto) {
  const fechas = new Set();
  const invalidos = [];
  for (const crudo of String(texto || '').split(/[\s,;]+/)) {
    const token = crudo.trim();
    if (!token) continue;
    let y;
    let mo;
    let d;
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(token);
    if (m) {
      [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    } else {
      m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(token);
      if (m) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    }
    const fecha = m ? new Date(Date.UTC(y, mo - 1, d)) : null;
    if (!fecha || fecha.getUTCFullYear() !== y || fecha.getUTCMonth() !== mo - 1 || fecha.getUTCDate() !== d) {
      invalidos.push(token);
      continue;
    }
    fechas.add(fecha.toISOString().slice(0, 10));
  }
  return { fechas, invalidos };
}

function dmyAIso(dmy) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(dmy || '').trim());
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
}

// Número de cuenta de IBS (cuecod) que está dentro del CBU: 22 dígitos =
// banco(3) sucursal(4) DV(1) tipo(2) cuenta(11) DV(1) — la cuenta son los 11
// dígitos de la posición 11 a la 21, sin ceros a la izquierda.
function cuentaDesdeCbu(cbu) {
  const c = String(cbu || '').trim();
  return /^\d{22}$/.test(c) ? String(parseInt(c.slice(10, 21), 10)) : '';
}

function buildIbsTransferenciasQuery(desde, hasta) {
  return buildIbsQuery(desde, [`a.movcod in (${MOV_TRANSFERENCIA_MISMO_TITULAR}, ${MOV_TRANSFERENCIA_TERCEROS}) and a.sistcod = 5`], {
    hasta,
    conConcod: true,
  });
}

// Extracto de IBS -> movimientos de transferencia agrupados por comprobante,
// ya con los débitos vigentes (los que no fueron revertidos).
function leerIbsTransferencias(ibsLines, desde, hastaEsperado) {
  const [header, ...data] = ibsLines;
  const requeridas = ['sistcod', 'moncod', 'cuecod', 'Fecha_Mov', 'comnro', 'movcod', 'signo', 'accimp'];
  const faltantes = requeridas.filter((c) => !(header || []).includes(c));
  if (faltantes.length > 0) {
    const error = new Error(`El archivo no tiene el formato del extracto de IBS (faltan las columnas: ${faltantes.join(', ')}).`);
    error.statusCode = 400;
    throw error;
  }
  const tieneConcod = header.includes('concod');
  const col = (row, name) => String(row[header.indexOf(name)] == null ? '' : row[header.indexOf(name)]).trim();

  const porComprobante = new Map();
  let filasOtraFecha = 0;
  let movimientos = 0;
  for (const row of data) {
    if (row.length === 1 && row[0].trim() === '') continue;
    const movcod = col(row, 'movcod');
    if (movcod !== MOV_TRANSFERENCIA_MISMO_TITULAR && movcod !== MOV_TRANSFERENCIA_TERCEROS) continue;
    const mov = {
      sistcod: col(row, 'sistcod'),
      moncod: col(row, 'moncod'),
      cuecod: col(row, 'cuecod'),
      fecha: dmyAIso(col(row, 'Fecha_Mov')),
      comnro: col(row, 'comnro'),
      movcod,
      concod: tieneConcod ? col(row, 'concod') : '',
      signo: Number(col(row, 'signo')) < 0 ? -1 : 1,
      cents: toCents(col(row, 'accimp')),
    };
    if (!mov.fecha || mov.fecha < desde || mov.fecha > hastaEsperado) {
      filasOtraFecha++;
      continue;
    }
    movimientos++;
    if (!porComprobante.has(mov.comnro)) porComprobante.set(mov.comnro, []);
    porComprobante.get(mov.comnro).push(mov);
  }

  const grupos = new Map();
  for (const [comnro, movs] of porComprobante) {
    const debitos = movs.filter((m) => m.signo < 0);
    const reversas = movs.filter((m) => m.signo > 0);
    // Con la columna concod, vigente = débito sin marca (los 'M' son los
    // anulados); sin ella, los débitos que sobran después de descontar las reversas.
    const vigentes = tieneConcod ? debitos.filter((m) => m.concod === '') : debitos.slice(0, Math.max(debitos.length - reversas.length, 0));
    grupos.set(comnro, { movs, vigentes, hayReversa: reversas.length > 0 });
  }
  return { grupos, filasOtraFecha, movimientos };
}

// Comprobantes de IBS dentro del período (para que el servidor busque en
// ApiCore los que no están en el rango pedido).
function comprobantesIbsTransferencias(ibsLines, desde, hastaEsperado) {
  return [...leerIbsTransferencias(ibsLines, desde, hastaEsperado).grupos.keys()];
}

// apiRows: filas de dbn_consulta del rango (ejecutado_en, id_comprobante,
// id_operacion, debito_cuit/cbu/titular, credito_cuit, moneda, importe,
// realizado, estado_codigo, estado_descripcion). opciones: desde/hasta
// (yyyy-MM-dd, el rango de ejecución), hoy, feriados (Set), otrasFechas (Map
// comprobante -> filas de dbn_consulta de fuera del rango, para explicar
// débitos de transferencias de otros días) y feriadosInvalidos.
function conciliarTransferencias(apiRows, ibsLines, opciones) {
  const { desde, hasta, hoy } = opciones;
  const feriados = opciones.feriados || new Set();
  const otrasFechas = opciones.otrasFechas || new Map();
  const rechazadosArchivo = opciones.rechazadosArchivo || [];
  const hastaEsperado = proximoDiaHabil(hasta, feriados);
  const { grupos, filasOtraFecha, movimientos } = leerIbsTransferencias(ibsLines, desde, hastaEsperado);

  const tipoDe = (r) => (String(r.debito_cuit || '').trim() === String(r.credito_cuit || '').trim() ? 'mismo' : 'terceros');
  const etiquetaTipo = (tipo) => (tipo === 'mismo' ? 'mismo titular' : 'terceros');
  const monedaDe = (r) => MONEDA_ETIQUETA[String(r.moneda).trim()] || String(r.moneda || '');
  const estadoCodigo = (r) => String(r.estado_codigo || '').trim();
  const estadoDescripcion = (r) => String(r.estado_descripcion || '').trim();
  const esExitoso = (r) => estadoCodigo(r) === 'ACREDITADO';
  const sinEstado = (r) => estadoCodigo(r) === '';
  const esError = (r) => !esExitoso(r) && !sinEstado(r);
  const dinero = (cents) => `$ ${formatCents(cents)}`;
  const dineroMoneda = (moneda, cents) => `${moneda === 'USD' ? 'USD' : '$'} ${formatCents(cents)}`;

  const base = (r, extra) => ({
    fecha: r.ejecutado_en,
    numeroComprobante: String(r.id_comprobante || '').trim(),
    operacion: r.id_operacion || '',
    circuito: tipoDe(r),
    cuit: r.debito_cuit,
    apellidoNombre: r.debito_titular,
    cajaAhorro: cuentaDesdeCbu(r.debito_cbu),
    importe: toCents(r.importe) / 100,
    moneda: monedaDe(r),
    ...extra,
  });

  // Agrupa lo de ApiCore por comprobante: envíos realizados (puede haber
  // más de uno si se mandó dos veces) y rechazos.
  const apiGrupos = new Map();
  const rechazados = [];
  const filaRechazada = (r, extra) => ({
    fecha: r.ejecutado_en,
    idMensaje: r.id_mensaje || '',
    numeroComprobante: String(r.id_comprobante || '').trim(),
    operacion: r.id_operacion || '',
    cuit: r.debito_cuit,
    apellidoNombre: r.debito_titular,
    importe: toCents(r.importe) / 100,
    moneda: monedaDe(r),
    motivo: estadoDescripcion(r) || String(r.descripcion_respuesta || '').trim() || String(r.error_consulta || '').trim(),
    usuario: r.ejecutado_por || '',
    ...extra,
  });
  for (const r of apiRows) {
    const c = String(r.id_comprobante || '').trim();
    if (!c) {
      if (r.realizado !== 's') rechazados.push(filaRechazada(r, { estado: 'no-figura', detalle: 'Sin número de comprobante.' }));
      continue;
    }
    if (!apiGrupos.has(c)) apiGrupos.set(c, { envios: [], rechazos: [] });
    apiGrupos.get(c)[r.realizado === 's' ? 'envios' : 'rechazos'].push(r);
  }

  const diferencias = [];
  const pendientes = [];
  const explicadas = [];
  const totApi = new Map();
  const totIbs = new Map();
  const sumar = (mapa, clave, cents) => {
    const acc = mapa.get(clave) || { cantidad: 0, cents: 0 };
    acc.cantidad++;
    acc.cents += cents;
    mapa.set(clave, acc);
  };
  const claveIbs = (m) => `${MONEDA_IBS_ETIQUETA[Number(m.moncod)] || m.moncod}|${m.movcod === MOV_TRANSFERENCIA_MISMO_TITULAR ? 'mismo' : 'terceros'}`;

  let ok = 0;
  let revertidasOk = 0;
  let rechazadasRevertidas = 0;
  let realizadas = 0;
  let enviosRealizados = 0;
  let rechazadas = 0;
  let comprobantesConDiferencias = 0;

  for (const [comprobante, g] of apiGrupos) {
    const ibsGrupo = grupos.get(comprobante);
    const vigentes = ibsGrupo ? ibsGrupo.vigentes : [];
    const hayReversa = ibsGrupo ? ibsGrupo.hayReversa : false;

    if (g.envios.length === 0) {
      rechazadas++;
      const r = g.rechazos[0];
      const estado = vigentes.length > 0 ? 'figura' : hayReversa ? 'revertida' : 'no-figura';
      const detalleRechazo = estado === 'figura'
        ? `IBS tiene ${vigentes.length} débito(s) sin revertir por ${dineroMoneda(monedaDe(r), vigentes[0].cents)} (${vigentes[0].fecha}).`
        : estado === 'revertida' ? 'IBS la debitó y la revirtió (neto cero).' : '';
      rechazados.push(filaRechazada(r, { estado, detalle: detalleRechazo, intentos: g.rechazos.length }));
      if (vigentes.length > 0) {
        comprobantesConDiferencias++;
        diferencias.push({
          ...base(r, { tipo: 'Rechazada con débito en IBS' }),
          detalle: `ApiCore la rechazó (${estadoDescripcion(r) || 'sin motivo'}), pero IBS tiene ${vigentes.length} débito(s) sin revertir por ${dineroMoneda(monedaDe(r), vigentes[0].cents)} (${vigentes[0].fecha}).`,
        });
        for (const m of vigentes) sumar(totIbs, claveIbs(m), m.cents);
      } else if (hayReversa) {
        rechazadasRevertidas++;
      }
      continue;
    }

    realizadas++;
    enviosRealizados += g.envios.length;
    const primero = g.envios[0];
    const k = g.envios.length;
    const j = vigentes.length;
    const tipo = tipoDe(primero);
    const movEsperado = tipo === 'mismo' ? MOV_TRANSFERENCIA_MISMO_TITULAR : MOV_TRANSFERENCIA_TERCEROS;
    const cuentaEsperada = cuentaDesdeCbu(primero.debito_cbu);
    const esperada = proximoDiaHabil(String(primero.ejecutado_en).slice(0, 10), feriados);
    const errores = [];
    const pendiente = j === 0 && !hayReversa && esperada >= hoy && g.envios.some((r) => !esError(r));

    if (k > 1) {
      errores.push({
        tipo: 'Enviada más de una vez',
        detalle: `Se realizó ${k} veces (DEBIN ${g.envios.map((r) => r.id_operacion || '?').join(', ')}). Pedir la devolución de las de más.`,
      });
    }

    if (j === 0) {
      if (hayReversa) {
        if (g.envios.some(esExitoso)) {
          errores.push({
            tipo: 'Revertida en IBS estando acreditada',
            detalle: `El débito se hizo y se revirtió en IBS, pero la transferencia figura acreditada (${estadoDescripcion(primero)}): el cliente no pagó.`,
          });
        } else {
          revertidasOk++;
        }
      } else if (pendiente) {
        pendientes.push(base(primero, { detalle: `El débito corresponde al ${esperada}.` }));
      } else if (g.envios.some((r) => !esError(r))) {
        errores.push({
          tipo: 'Sin débito en IBS',
          detalle: `Realizada y ${estadoDescripcion(primero) || 'sin estado'}, pero IBS no tiene ningún débito ${movEsperado} para este comprobante (correspondía el ${esperada}; si hubo un feriado, revisá que esté cargado en Parametría).`,
        });
      }
      // Realizada con error de acreditación y sin ningún movimiento: no se debitó ni se acreditó, es coherente.
    } else {
      if (j > k) errores.push({ tipo: 'Débitos de más en IBS', detalle: `IBS tiene ${j} débitos sin revertir y ApiCore ${k} transferencia(s) realizada(s).` });
      if (j < k) errores.push({ tipo: 'Débitos de menos en IBS', detalle: `IBS tiene ${j} débito(s) sin revertir y ApiCore ${k} transferencia(s) realizadas.` });
      for (let i = 0; i < Math.min(j, k); i++) {
        const d = vigentes[i];
        const e = g.envios[i];
        const monedaIbs = MONEDA_IBS[String(e.moneda).trim()];
        if (d.movcod !== movEsperado) {
          errores.push({ tipo: 'Movimiento distinto al esperado', detalle: `IBS la debitó con el ${d.movcod} y por ser ${etiquetaTipo(tipo)} correspondía el ${movEsperado}.` });
        }
        if (monedaIbs && d.moncod !== monedaIbs) {
          errores.push({ tipo: 'Moneda distinta', detalle: `IBS debitó en moneda ${d.moncod} y ApiCore transfirió ${monedaDe(e)}.` });
        }
        if (cuentaEsperada && d.cuecod !== cuentaEsperada) {
          errores.push({ tipo: 'Cuenta distinta', detalle: `IBS debitó la cuenta ${d.cuecod} y el CBU de débito de ApiCore es de la cuenta ${cuentaEsperada}.` });
        }
        if (d.cents !== toCents(e.importe)) {
          errores.push({ tipo: 'Importe distinto', detalle: `IBS debitó ${dinero(d.cents)} y ApiCore transfirió ${dinero(toCents(e.importe))}.` });
        }
        if (i === 0 && k === 1 && d.fecha !== esperada) {
          errores.push({
            tipo: 'Débito fuera de fecha',
            detalle: `IBS la debitó el ${d.fecha} y correspondía el ${esperada} (próximo día hábil de la transferencia). Si hubo un feriado, revisá que esté cargado en Parametría.`,
          });
        }
      }
      if (!hayReversa || vigentes.length > 0) {
        if (g.envios.some(esError)) {
          const e = g.envios.find(esError);
          errores.push({
            tipo: 'Acreditación no exitosa, sin reversa',
            detalle: `La acreditación terminó en "${estadoDescripcion(e) || estadoCodigo(e)}", pero el débito sigue vigente en IBS: hay que revertirlo.`,
          });
        } else if (g.envios.every(sinEstado)) {
          errores.push({ tipo: 'Sin estado de acreditación', detalle: 'ApiCore no tiene el estado de acreditación de esta transferencia (la consulta no lo devolvió): verificar cómo terminó el DEBIN.' });
        }
      }
    }

    if (errores.length > 0) {
      comprobantesConDiferencias++;
      for (const err of errores) diferencias.push({ ...base(primero, {}), ...err });
    } else if (!pendiente && !(j === 0 && hayReversa)) {
      ok++;
    }

    // Totales: lo que ApiCore espera debitado (sin las pendientes de débito ni
    // las acreditaciones con error) contra lo que IBS tiene vigente.
    if (!pendiente) {
      for (const e of g.envios) if (!esError(e)) sumar(totApi, `${monedaDe(e)}|${tipo}`, toCents(e.importe));
    }
    for (const m of vigentes) sumar(totIbs, claveIbs(m), m.cents);
  }

  // Rechazos del archivo de error que nunca llegaron a dbn_consulta (CBU
  // inválido, error de comunicación): tampoco tendrían que figurar en IBS.
  const archivoPorComp = new Map();
  for (const r of rechazadosArchivo) {
    const c = String(r.id_comprobante || '').trim();
    const g = c ? apiGrupos.get(c) : null;
    if (g) {
      if (g.envios.length > 0) rechazados.push(filaRechazada(r, { estado: 'reintentada', detalle: 'Se volvió a procesar y quedó realizada.' }));
      continue; // si solo tiene rechazos, ya está listada con los de dbn_consulta
    }
    const ibsGrupo = c ? grupos.get(c) : null;
    const vigentes = ibsGrupo ? ibsGrupo.vigentes : [];
    const estado = vigentes.length > 0 ? 'figura' : ibsGrupo && ibsGrupo.hayReversa ? 'revertida' : 'no-figura';
    const detalle = estado === 'figura'
      ? `IBS tiene ${vigentes.length} débito(s) sin revertir por ${dineroMoneda(monedaDe(r), vigentes[0].cents)} (${vigentes[0].fecha}).`
      : estado === 'revertida' ? 'IBS la debitó y la revirtió (neto cero).' : '';
    rechazados.push(filaRechazada(r, { estado, detalle }));
    if (estado === 'figura') {
      if (!archivoPorComp.has(c)) archivoPorComp.set(c, []);
      archivoPorComp.get(c).push(r);
    }
  }

  // Lo de IBS que ApiCore no tiene en este rango.
  let soloEnIbs = 0;
  for (const [comprobante, g] of grupos) {
    if (apiGrupos.has(comprobante) || g.vigentes.length === 0) continue;
    const m = g.vigentes[0];
    const otras = [...(otrasFechas.get(comprobante) || []), ...(archivoPorComp.get(comprobante) || [])];
    const monedaEtiqueta = MONEDA_IBS_ETIQUETA[Number(m.moncod)] || m.moncod;
    if (otras.some((r) => r.realizado === 's')) {
      const r = otras.find((x) => x.realizado === 's');
      explicadas.push({
        numeroComprobante: comprobante,
        fecha: r.ejecutado_en,
        fechaDebito: m.fecha,
        importe: m.cents / 100,
        moneda: monedaEtiqueta,
      });
      continue;
    }
    if (otras.length > 0) {
      const r = otras[0];
      comprobantesConDiferencias++;
      diferencias.push({
        ...base(r, { tipo: 'Rechazada con débito en IBS' }),
        detalle: `ApiCore la rechazó (${estadoDescripcion(r) || 'sin motivo'}) y IBS la debitó el ${m.fecha} por ${dineroMoneda(monedaEtiqueta, m.cents)} sin revertir.`,
      });
    } else {
      soloEnIbs++;
      comprobantesConDiferencias++;
      diferencias.push({
        tipo: 'Solo en IBS',
        fecha: m.fecha,
        numeroComprobante: comprobante,
        operacion: '',
        circuito: m.movcod === MOV_TRANSFERENCIA_MISMO_TITULAR ? 'mismo' : 'terceros',
        cuit: '',
        apellidoNombre: '',
        cajaAhorro: m.cuecod,
        importe: m.cents / 100,
        moneda: monedaEtiqueta,
        detalle: `Débito ${m.movcod} en la cuenta ${m.cuecod} (${m.fecha}) sin ninguna transferencia en ApiCore.`,
      });
    }
    sumar(totIbs, claveIbs(m), m.cents);
  }

  const orden = ['ARS|mismo', 'ARS|terceros', 'USD|mismo', 'USD|terceros'];
  const totales = [];
  for (const clave of orden) {
    const a = totApi.get(clave) || { cantidad: 0, cents: 0 };
    const i = totIbs.get(clave) || { cantidad: 0, cents: 0 };
    if (a.cantidad === 0 && i.cantidad === 0) continue;
    const [moneda, tipo] = clave.split('|');
    totales.push({
      concepto: `${moneda === 'ARS' ? 'Pesos' : 'Dólares'} — ${tipo === 'mismo' ? 'mismo titular (28600)' : 'terceros (28601)'}`,
      apicore: { cantidad: a.cantidad, importe: a.cents / 100 },
      ibs: { cantidad: i.cantidad, importe: i.cents / 100 },
    });
  }

  const avisos = [];
  if ((opciones.feriadosInvalidos || []).length > 0) {
    avisos.push(`Feriados de Parametría que no se reconocieron y se ignoraron: ${opciones.feriadosInvalidos.join(', ')}.`);
  }
  if (feriados.size === 0) {
    avisos.push('No hay feriados cargados en Parametría: solo se toman como no hábiles los sábados y domingos. Si hubo un feriado, las transferencias de ese día van a figurar con el débito fuera de fecha.');
  }

  diferencias.sort((x, y) => String(x.fecha).localeCompare(String(y.fecha)));
  return {
    tipo: 'transferencias',
    fecha: desde,
    hasta,
    resumen: {
      desde,
      hasta,
      hastaEsperado,
      realizadasApicore: realizadas,
      enviosRealizados,
      rechazadasApicore: rechazadas,
      rechazadasRevertidas,
      ...resumenRechazados(rechazados),
      revertidasOk,
      transferenciasOk: ok,
      transferenciasConDiferencias: comprobantesConDiferencias,
      pendientes: pendientes.length,
      soloEnIbs,
      debitosOtrasFechas: explicadas.length,
      movimientosIbs: movimientos,
      filasOtraFecha,
      feriadosCargados: feriados.size,
    },
    totales,
    diferencias,
    pendientes,
    explicadas,
    rechazados,
    otrosCanales: [],
    avisos,
  };
}

module.exports = {
  conciliarAltasPf,
  conciliarPagosPf,
  conciliarTransferencias,
  buildIbsAltasPfQuery,
  buildIbsPagosPfQuery,
  buildIbsTransferenciasQuery,
  getPagoPfConfig,
  ibsRowsToLines,
  comprobantesIbsTransferencias,
  parseFeriados,
  proximoDiaHabil,
  cuentaDesdeCbu,
};
