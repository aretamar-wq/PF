'use strict';

// Reglas de la Conciliación FX (función pura). BankService manda: cada orden COMPLETED
// del día tiene que tener en IBS sus 6 movimientos (comprobante = receiptNumber), por los
// importes de la orden: los de pesos por el importe en pesos y los de dólares por el
// importe en dólares. Lo que falta y está en débitos pendientes es amarillo; lo demás,
// diferencia. Importes en centavos (mismos centavos = igual, tolerancia 0,005).

const TIPOS = {
  FALTAN: 'Faltan movimientos en IBS',
  PENDIENTE: 'Débito pendiente',
  PENDIENTE_CON_SALDO: 'Débito pendiente con saldo',
  PENDIENTE_SIN_SALDO: 'Débito pendiente sin saldo',
  DUPLICADO: 'Movimiento duplicado',
  IMPORTE: 'Importe distinto',
  SIN_REGISTRO: 'COMPLETED sin registro en IBS',
  POR_CONTABILIZAR: 'Por contabilizar',
  OTRO_LADO: 'Movimiento de otro tipo de operación',
  FAILED_CON_MOV: 'Operación FAILED con movimientos en IBS',
  REVISION_CON_MOV: 'Operación en revisión manual con movimientos en IBS',
  REVISION: 'Operación en revisión manual',
  SIN_OPERACION: 'Movimiento sin operación en BankService',
  PEND_SIN_OPERACION: 'Pendiente sin operación COMPLETED',
  MANUAL: 'Movimiento manual',
};
// Rojas (diferencias) y amarillas (pendientes / a revisar); el resto es informativo.
const ROJAS = [TIPOS.FALTAN, TIPOS.DUPLICADO, TIPOS.IMPORTE, TIPOS.SIN_REGISTRO, TIPOS.OTRO_LADO, TIPOS.FAILED_CON_MOV, TIPOS.REVISION_CON_MOV, TIPOS.SIN_OPERACION, TIPOS.PEND_SIN_OPERACION];
const AMARILLAS = [TIPOS.PENDIENTE, TIPOS.PENDIENTE_CON_SALDO, TIPOS.PENDIENTE_SIN_SALDO, TIPOS.POR_CONTABILIZAR, TIPOS.REVISION];

const pesos = (c) => (c / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dinero = (moneda, c) => `${moneda === 'USD' ? 'US$' : '$'} ${pesos(c)}`;
const dmy = (iso) => String(iso || '').slice(0, 10).split('-').reverse().join('/');

function conciliar({ movimientos, pendientes, ordenes, config }) {
  const proceso = new Set((config.usuariosProceso || []).map(String));
  const ladoDe = new Map(config.lados.map((l) => [l.lado, l]));
  const ladoDeMov = new Map();
  const defMov = new Map();
  for (const l of config.lados) for (const m of l.movs) { ladoDeMov.set(m.cod, l); defMov.set(m.cod, m); }

  // Órdenes con comprobante (las FAILED no tienen: nunca llegan a IBS).
  const ops = new Map();
  for (const o of ordenes) if (o.comprobante) ops.set(o.comprobante, o);
  const delPeriodo = movimientos.filter((m) => !m.posterior);
  const mayorComprobante = delPeriodo.reduce((max, m) => Math.max(max, Number(m.comprobante) || 0), 0);
  const ultimoDiaIbs = delPeriodo.reduce((max, m) => (m.fecha > max ? m.fecha : max), '');

  const movs = movimientos.map((m) => {
    const o = ops.get(m.comprobante);
    const lado = ladoDeMov.get(m.movcod);
    return {
      ...m,
      lado: lado ? lado.lado : '',
      monedaEsperada: defMov.has(m.movcod) ? defMov.get(m.movcod).moneda : '',
      fechaFiltro: o && o.fecha ? o.fecha : m.fecha,
      conOperacion: !!o,
      completada: !!(o && o.status === 'COMPLETED'),
      manual: !proceso.has(String(m.usuario)),
    };
  });
  const movsPorComp = new Map();
  for (const m of movs) {
    if (!movsPorComp.has(m.comprobante)) movsPorComp.set(m.comprobante, []);
    movsPorComp.get(m.comprobante).push(m);
  }
  const pendPorComp = new Map();
  for (const p of pendientes) {
    if (!pendPorComp.has(p.comprobante)) pendPorComp.set(p.comprobante, []);
    pendPorComp.get(p.comprobante).push(p);
  }

  const excepciones = [];
  const exc = (tipo, datos) => excepciones.push({ tipo, comprobante: '', lado: '', cuit: '', cuenta: '', moneda: '', fecha: '', importe: null, usuario: '', estadoBs: '', detalle: '', ...datos });

  const clasificadas = ordenes.map((o) => {
    const lado = ladoDe.get(o.side);
    const r = { ...o, clase: '', faltan: [], pendientesMov: [] };
    const propios = (movsPorComp.get(o.comprobante) || []);
    // Cuenta del cliente: la de un movimiento de cliente (no la de un puente).
    const deCliente = propios.find((m) => defMov.has(m.movcod) && /cliente/.test(defMov.get(m.movcod).nombre));
    const base = { comprobante: o.comprobante || o.id, lado: o.side, cuit: o.cuit, cuenta: deCliente ? deCliente.cuecod : '', fecha: o.fecha, estadoBs: o.status, importe: o.ars, moneda: 'ARS' };
    const pends = (pendPorComp.get(o.comprobante) || []);
    if (o.status !== 'COMPLETED') {
      if (propios.length > 0) {
        r.clase = 'noCompletadaEnIbs';
        exc(o.status === 'FAILED' ? TIPOS.FAILED_CON_MOV : TIPOS.REVISION_CON_MOV, { ...base, usuario: propios[0].usuario, detalle: `BankService la tiene ${o.status} e IBS tiene ${propios.length} movimiento(s): ${propios.map((m) => `${m.movcod} ${dinero(m.monedaEsperada, m.importe)} (${dmy(m.fecha)})`).join(', ')}.` });
      } else if (o.status !== 'FAILED') {
        exc(TIPOS.REVISION, { ...base, detalle: `BankService la tiene ${o.status} (creada el ${o.creada}).${o.failReason ? ` ${o.failReason}.` : ''}` });
      }
      return r;
    }
    // COMPLETED: los 6 movimientos de su lado, por los importes de la orden.
    const esperado = (mon) => (mon === 'USD' ? o.usd : o.ars);
    const otros = propios.filter((m) => m.lado !== o.side);
    if (otros.length > 0) exc(TIPOS.OTRO_LADO, { ...base, usuario: otros[0].usuario, detalle: `La orden es ${o.side} y IBS tiene movimientos ${otros.map((m) => m.movcod).join(', ')} de la otra operación.` });
    for (const def of lado.movs) {
      const lista = propios.filter((m) => m.movcod === def.cod);
      if (lista.length === 0) {
        const pend = pends.find((p) => p.movcod === def.cod);
        if (pend) r.pendientesMov.push({ cod: def.cod, moneda: def.moneda, importe: pend.importe, motivo: pend.motivo, fechaOrigen: pend.fechaOrigen, cuecod: pend.cuecod, saldo: pend.saldo || null });
        else r.faltan.push(def.cod);
        continue;
      }
      if (lista.length > 1) exc(TIPOS.DUPLICADO, { ...base, moneda: def.moneda, importe: lista.reduce((s, m) => s + m.importe, 0), usuario: lista[0].usuario, detalle: `${lista.length} movimientos ${def.cod} (${def.nombre}): ${lista.map((m) => `${dinero(def.moneda, m.importe)} del ${dmy(m.fecha)}`).join(', ')}.` });
      for (const m of lista) {
        if (m.importe !== esperado(def.moneda)) exc(TIPOS.IMPORTE, { ...base, moneda: def.moneda, cuenta: m.cuecod, importe: m.importe, usuario: m.usuario, detalle: `${def.cod} (${def.nombre}) por ${dinero(def.moneda, m.importe)} y la orden es de ${dinero(def.moneda, esperado(def.moneda))}.` });
      }
    }
    const conMovs = propios.some((m) => m.lado === o.side);
    for (const p of r.pendientesMov) {
      // Con el saldo de la cuenta consultado: pendiente con saldo (se puede debitar) o sin saldo.
      const tipoPend = p.saldo ? (p.saldo.conSaldo ? TIPOS.PENDIENTE_CON_SALDO : TIPOS.PENDIENTE_SIN_SALDO) : TIPOS.PENDIENTE;
      exc(tipoPend, { ...base, cuenta: p.cuecod || base.cuenta, moneda: p.moneda, importe: p.importe, detalle: `Falta el ${p.cod} en IBS: está en débitos pendientes desde el ${dmy(p.fechaOrigen) || 'sin fecha'} por ${dinero(p.moneda, p.importe)} (${p.motivo || 'sin motivo'}).${p.saldo ? ` ${p.saldo.texto}` : ''}` });
    }
    if (!conMovs && r.pendientesMov.length === 0) {
      if ((Number(o.comprobante) || 0) < mayorComprobante || (ultimoDiaIbs && o.fecha < ultimoDiaIbs)) {
        r.clase = 'sinRegistro';
        exc(TIPOS.SIN_REGISTRO, { ...base, detalle: `IBS no tiene ninguno de sus movimientos ni débitos pendientes (orden ${o.side} por ${dinero('ARS', o.ars)} / ${dinero('USD', o.usd)}).` });
      } else {
        r.clase = 'porContabilizar';
        exc(TIPOS.POR_CONTABILIZAR, { ...base, detalle: `Faltan sus movimientos en IBS: el comprobante es posterior al mayor de IBS (${mayorComprobante}), todavía puede contabilizarse.` });
      }
      return r;
    }
    if (r.faltan.length > 0) {
      r.clase = 'incompleta';
      exc(TIPOS.FALTAN, { ...base, usuario: (propios[0] || {}).usuario || '', detalle: `Faltan ${r.faltan.map((c) => `${c} (${defMov.get(c).nombre})`).join(', ')}${r.pendientesMov.length ? `; en pendientes: ${r.pendientesMov.map((p) => p.cod).join(', ')}` : ''}.` });
    } else if (r.pendientesMov.length > 0) {
      r.clase = 'pendiente';
      r.pendienteArs = r.pendientesMov.filter((p) => p.moneda === 'ARS').reduce((s, p) => s + p.importe, 0);
      r.pendienteUsd = r.pendientesMov.filter((p) => p.moneda === 'USD').reduce((s, p) => s + p.importe, 0);
    } else {
      r.clase = 'completa';
    }
    return r;
  });

  // Movimientos de IBS sin orden en BankService (uno por comprobante) y manuales: un
  // movimiento manual se informa solo si su comprobante no está en BankService FX.
  for (const [comprobante, lista] of movsPorComp) {
    const m0 = lista[0];
    if (!ops.has(comprobante)) {
      exc(TIPOS.SIN_OPERACION, { comprobante, lado: m0.lado, cuenta: m0.cuecod, moneda: m0.monedaEsperada, fecha: m0.fecha, importe: m0.importe, usuario: m0.usuario, detalle: `El comprobante no figura en la base de BankService FX (MariaDB) e IBS tiene ${lista.length} movimiento(s): ${lista.map((m) => `${m.movcod} ${dinero(m.monedaEsperada, m.importe)} (cuenta ${m.cuecod})`).join(', ')}.` });
    }
    const manuales = ops.has(comprobante) ? [] : lista.filter((m) => m.manual);
    if (manuales.length > 0) {
      const o = ops.get(comprobante);
      exc(TIPOS.MANUAL, { comprobante, lado: m0.lado, cuit: o ? o.cuit : '', cuenta: manuales[0].cuecod, moneda: manuales[0].monedaEsperada, fecha: m0.fechaFiltro, importe: manuales[0].importe, usuario: manuales[0].usuario, estadoBs: o ? o.status : '', detalle: `${manuales.length} movimiento(s) cargado(s) por el usuario ${manuales[0].usuario} (no es de proceso): ${manuales.map((m) => m.movcod).join(', ')}. Informativo.` });
    }
  }
  // Débitos pendientes sin orden COMPLETED.
  const pendientesOut = pendientes.map((p) => {
    const o = ops.get(p.comprobante);
    const ok = !!(o && o.status === 'COMPLETED');
    if (!ok) {
      exc(TIPOS.PEND_SIN_OPERACION, { comprobante: p.comprobante, lado: (ladoDeMov.get(p.movcod) || {}).lado || '', cuit: o ? o.cuit : '', cuenta: p.cuecod, moneda: (defMov.get(p.movcod) || {}).moneda || '', fecha: o ? o.fecha : p.fechaOrigen, importe: p.importe, estadoBs: o ? o.status : '', detalle: `Débito pendiente ${p.movcod} del ${dmy(p.fechaOrigen) || 'sin fecha'} (${p.motivo || 'sin motivo'}) sin orden COMPLETED en BankService FX${o ? ` (está ${o.status})` : ''}.` });
    }
    return { ...p, fecha: ok ? o.fecha : p.fechaOrigen, lado: (ladoDeMov.get(p.movcod) || {}).lado || '', conOperacion: ok };
  });

  return { corte: { ultimoDiaIbs, mayorComprobante }, movimientos: movs, pendientes: pendientesOut, ordenes: clasificadas, excepciones };
}

module.exports = { conciliar, TIPOS, ROJAS, AMARILLAS };
