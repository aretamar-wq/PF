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

function conciliarAltasPf(altas, ibsLines, fecha) {
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

  const porClave = new Map();
  for (const mov of movimientos) {
    const key = `${mov.movcod}|${mov.comnro}`;
    if (!porClave.has(key)) porClave.set(key, []);
    porClave.get(key).push(mov);
  }

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

module.exports = { conciliarAltasPf };
