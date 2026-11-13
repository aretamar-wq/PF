'use strict';

// Cruce de Loop (un día) contra BankService (transferencias QNET). Comprobante de
// BankService = comnro de Loop; la clave es moneda + número.
//
// Alcance de un día D:
// - Loop trae solo los movimientos con Fecha_Mov = D;
// - de BankService cuentan para D las operaciones cuya fecha contable es D: la
//   fecha de Ejecutada (o de Creada si no se ejecutó), pasada al próximo día hábil
//   (lo de un fin de semana o feriado se contabiliza el siguiente día hábil);
// - un comprobante que está en Loop(D) se compara contra BankService sin importar
//   la fecha de la operación.

const TIPOS = {
  FAILED_CONTABILIZADO: 'FAILED contabilizado',
  SIN_EJECUTAR: 'Transfer sin ejecutar',
  APPROVED_SIN_REGISTRO: 'APPROVED sin registro',
  SIN_OPERACION: 'Sin operación en transfers',
  MONTO_DISTINTO: 'Monto distinto',
  MONEDA_DISTINTA: 'Moneda distinta',
  CUENTA_DISTINTA: 'Cuenta distinta',
  CBU_MONEDA: 'CBU no coincide con la moneda',
};

const dinero = (c) => (c / 100).toFixed(2);
const soloFecha = (s) => String(s || '').slice(0, 10);
const cuentaNum = (c) => (c ? String(parseInt(c, 10)) : '');

// fecha: el día D. hoy: hoy (aaaa-mm-dd): si D es hoy o futuro el día todavía está
// abierto y lo que falta en Loop no es excepción. corte: { dia } = última Ejecutada
// de BankService (hasta ahí hay datos para decir "no existe la operación").
function cruzar({ comprobantes, transfers, pendientesPorClave, fecha, hoy, corte, config, diaContable }) {
  const excepciones = [];
  const abierto = fecha >= hoy;
  const stats = {
    totalEnArchivos: transfers.length, delDia: 0, approved: 0, failed: 0, pending: 0, otrosDias: 0,
    encontradas: 0, sinDiferencias: 0, approvedSinRegistro: 0, pendientesDeContabilizar: 0,
  };
  const porComnro = new Map();
  for (const c of comprobantes.values()) {
    if (!porComnro.has(c.comnro)) porComnro.set(c.comnro, []);
    porComnro.get(c.comnro).push(c);
  }
  const claves = new Set(transfers.map((t) => t.clave));

  const base = (t, extra) => ({
    comprobante: t.comprobante,
    cuenta: t.cuenta,
    moneda: config.etiquetasMoneda[t.moncod] || t.moncod,
    fecha: soloFecha(t.ejecutada) || soloFecha(t.creada),
    importe: t.monto,
    estadoTransfer: t.estado,
    debitoPendiente: null,
    ...extra,
  });

  for (const t of transfers) {
    const c = comprobantes.get(t.clave);
    const pend = pendientesPorClave.get(t.clave);
    const fechaOp = soloFecha(t.ejecutada) || soloFecha(t.creada);
    const esDelDia = diaContable(fechaOp) === fecha;
    const sinEjecutarVigente = t.estado === 'PENDING_EXECUTION' && fechaOp <= fecha;
    if (!esDelDia && !c && !sinEjecutarVigente) {
      stats.otrosDias++;
      continue;
    }
    if (esDelDia) {
      stats.delDia++;
      if (t.estado === 'APPROVED') stats.approved++;
      else if (t.estado === 'FAILED') stats.failed++;
    }
    if (!t.cbuMonedaOk) {
      excepciones.push(base(t, { tipo: TIPOS.CBU_MONEDA, detalle: `Los dígitos 9 y 10 del CBU origen no corresponden a la moneda ${t.moneda}.` }));
    }

    if (t.estado === 'FAILED') {
      if (c) excepciones.push(base(t, { tipo: TIPOS.FAILED_CONTABILIZADO, detalle: `La operación está FAILED (${t.error || 'sin error'}) pero tiene ${c.partidas} partida(s) en Loop.` }));
      continue;
    }
    if (t.estado === 'PENDING_EXECUTION') {
      stats.pending++;
      excepciones.push(base(t, {
        tipo: TIPOS.SIN_EJECUTAR,
        fecha: soloFecha(t.creada),
        detalle: `Creada ${t.creada}; ${c ? `tiene ${c.partidas} partida(s) en Loop` : 'sin asiento en Loop'}.`,
      }));
      continue;
    }

    // APPROVED
    if (!c) {
      const otraMoneda = (porComnro.get(t.comprobante) || []).find((x) => x.moncod !== t.moncod);
      if (otraMoneda) {
        excepciones.push(base(t, { tipo: TIPOS.MONEDA_DISTINTA, detalle: `BankService la informa en ${t.moneda} y Loop la tiene en moncod ${otraMoneda.moncod}.` }));
      } else if (abierto) {
        stats.pendientesDeContabilizar++; // el día no cerró: todavía le toca estar en Loop
      } else {
        stats.approvedSinRegistro++;
        excepciones.push(base(t, {
          tipo: TIPOS.APPROVED_SIN_REGISTRO,
          debitoPendiente: pend ? pend.importedeb : null,
          detalle: pend ? `Tiene un débito pendiente por ${dinero(pend.importedeb)}: falta el crédito.` : 'No figura en Loop ni en los débitos pendientes.',
        }));
      }
      continue;
    }

    stats.encontradas++;
    let diferencias = 0;
    if (c.credito > 0 && Math.abs(t.monto - c.credito) > config.tolerancia) {
      diferencias++;
      excepciones.push(base(t, { tipo: TIPOS.MONTO_DISTINTO, detalle: `BankService ${dinero(t.monto)} y crédito en Loop ${dinero(c.credito)}.` }));
    }
    const cuentaLoop = c.cuenta || cuentaNum(pend && pend.cuecod);
    if (cuentaLoop && t.cuenta && cuentaNum(cuentaLoop) !== cuentaNum(t.cuenta)) {
      diferencias++;
      excepciones.push(base(t, { tipo: TIPOS.CUENTA_DISTINTA, detalle: `La cuenta del CBU origen es ${t.cuenta} y Loop la tiene en ${cuentaLoop}.` }));
    }
    if (diferencias === 0) stats.sinDiferencias++;
  }

  // Comprobantes de Loop con las 2 partidas que no están en BankService (en ningún día).
  for (const c of comprobantes.values()) {
    if (c.partidas !== 2 || claves.has(c.clave)) continue;
    if (transfers.some((t) => t.comprobante === c.comnro && t.moncod !== c.moncod)) continue; // ya es "Moneda distinta"
    if (corte.dia && fecha < corte.dia) {
      excepciones.push({
        tipo: TIPOS.SIN_OPERACION,
        comprobante: c.comnro,
        cuenta: c.cuenta,
        moneda: config.etiquetasMoneda[c.moncod] || c.moncod,
        fecha,
        importe: c.credito || c.debito,
        estadoTransfer: '',
        debitoPendiente: null,
        detalle: `Tiene las 2 partidas en Loop (${fecha}) pero no existe la operación en BankService.`,
      });
    }
  }
  return { excepciones, stats };
}

module.exports = { TIPOS, cruzar };
