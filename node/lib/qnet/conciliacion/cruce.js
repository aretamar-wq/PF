'use strict';

// Cruce de Loop contra BankService (transferencias QNET). Comprobante de
// BankService = comnro de Loop; la clave es moneda + número.

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

// periodo: { primerDia, ultimoDia } de Loop; corte: { dia } = fecha de la última Ejecutada.
function cruzar({ comprobantes, transfers, pendientesPorClave, periodo, corte, config }) {
  const excepciones = [];
  const stats = { total: transfers.length, approved: 0, failed: 0, pending: 0, encontradas: 0, sinDiferencias: 0, approvedSinRegistro: 0, pendientesDeContabilizar: 0, fueraDelPeriodo: 0 };
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
    if (!t.cbuMonedaOk) {
      excepciones.push(base(t, { tipo: TIPOS.CBU_MONEDA, detalle: `Los dígitos 9 y 10 del CBU origen no corresponden a la moneda ${t.moneda}.` }));
    }
    if (t.estado === 'FAILED') {
      stats.failed++;
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

    stats.approved++;
    if (!c) {
      const otraMoneda = (porComnro.get(t.comprobante) || []).find((x) => x.moncod !== t.moncod);
      if (otraMoneda) {
        excepciones.push(base(t, { tipo: TIPOS.MONEDA_DISTINTA, detalle: `BankService la informa en ${t.moneda} y Loop la tiene en moncod ${otraMoneda.moncod}.` }));
        continue;
      }
      const fecha = soloFecha(t.ejecutada) || soloFecha(t.creada);
      if (fecha >= periodo.primerDia && fecha < periodo.ultimoDia) {
        stats.approvedSinRegistro++;
        excepciones.push(base(t, {
          tipo: TIPOS.APPROVED_SIN_REGISTRO,
          debitoPendiente: pend ? pend.importedeb : null,
          detalle: pend ? `Tiene un débito pendiente por ${dinero(pend.importedeb)}: falta el crédito.` : 'No figura en Loop ni en los débitos pendientes.',
        }));
      } else if (fecha >= periodo.ultimoDia) {
        stats.pendientesDeContabilizar++; // todavía no le toca estar en Loop: no es excepción
      } else {
        stats.fueraDelPeriodo++; // anterior al período de Loop: no es excepción
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

  // Comprobantes de Loop con las 2 partidas que no están en BankService (y anteriores al corte).
  for (const c of comprobantes.values()) {
    if (c.partidas !== 2 || claves.has(c.clave)) continue;
    // Si BankService la tiene en otra moneda ya se informó como "Moneda distinta".
    if (transfers.some((t) => t.comprobante === c.comnro && t.moncod !== c.moncod)) continue;
    const fecha = c.fechaDebito || c.fechaCredito;
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
