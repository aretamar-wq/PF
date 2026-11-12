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
function buildIbsQuery(fecha, filtros) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error(`Fecha inválida: '${fecha}'.`);
  const [y, m, d] = fecha.split('-').map(Number);
  const siguiente = new Date(Date.UTC(y, m - 1, d + 1));
  const desde = fecha.replace(/-/g, '');
  const hasta = siguiente.toISOString().slice(0, 10).replace(/-/g, '');
  const select = (filtro) => `select a.sistcod, a.moncod, a.cuecod, convert(varchar, a.fecmov, 103) 'Fecha_Mov', a.comnro, a.movcod, b.signo, b.accimp, b.signo * b.accimp 'Importe'
from tgl_movimientos a, tgl_movimientos_aper b
where a.fecmov >= '${desde}'
  and a.fecmov < '${hasta}'
  and a.concod = ' '
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
function ibsRowsToLines(rows) {
  const header = ['sistcod', 'moncod', 'cuecod', 'Fecha_Mov', 'comnro', 'movcod', 'signo', 'accimp', 'Importe'];
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

function conciliarAltasPf(altas, ibsLines, fecha) {
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
      concepto: 'Altas de Plazo Fijo desde Caja de Ahorro (152)',
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
      soloEnIbs: diferencias.filter((d) => d.tipo === 'Solo en IBS' || d.tipo === 'Repetido en IBS').length,
      otrosCanales: otrosCanales.length,
      otrosCanalesImporte: sumCents(otrosCanales.map((o) => Math.round(o.importe * 100))) / 100,
      filasOtraFecha,
    },
    totales,
    diferencias,
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
function conciliarPagosPf(operaciones, ibsLines, fecha, config) {
  const { movimientos, filasOtraFecha } = leerMovimientosIbs(ibsLines, fecha);
  const porClave = indexarPorClave(movimientos);

  const esDebitoCa = (m) => m.movcod === config.movDebitoCa && m.sistcod === config.sistCa;
  const esCreditoCc = (m) => m.movcod === config.movCreditoCc && m.sistcod === config.sistCc && m.cuecod === config.cuentaCc;
  const relevantes = movimientos.filter((m) => esDebitoCa(m) || esCreditoCc(m));
  const porClaveRelevante = indexarPorClave(relevantes);

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
      if (problemas.length === 0) pagosOk++;
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
      pendientesImporte: sumCents(pendientes.map((p) => Math.round(p.importe * 100))) / 100,
      pagadosEnIbsNoApicore: tipos('Pagado en IBS, no en ApiCore') + tipos('Pago incompleto en IBS'),
      soloEnIbs: tipos('Solo en IBS') + tipos('Repetido en IBS'),
      movimientosIbs: movimientos.length,
      filasOtraFecha,
    },
    totales: [
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
    otrosCanales: [],
  };
}

module.exports = { conciliarAltasPf, conciliarPagosPf, buildIbsAltasPfQuery, buildIbsPagosPfQuery, getPagoPfConfig, ibsRowsToLines };
