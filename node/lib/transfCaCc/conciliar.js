'use strict';

// Reglas de la conciliación "Transferencias CA -> CC". Función pura: recibe lo
// que devuelve la capa de datos (movimientos y pendientes de IBS ya normalizados,
// operaciones de BankService de la base) y devuelve, fila por fila, cómo quedó
// cada cosa clasificada. El dashboard filtra y suma sobre esto (ver
// wwwroot/transf-ca-cc-calculo.js), así que el corte (último día de IBS y mayor
// comprobante) no depende de los filtros.
//
// Importes en centavos: "igual" con tolerancia 0,005 sobre 2 decimales = mismos centavos.

const TIPOS = {
  IMPORTE: 'Importe distinto',
  MONEDA: 'Moneda distinta',
  CUENTA: 'Cuenta distinta',
  PEND_IMPORTE: 'Pendiente con importe distinto',
  SIN_REGISTRO: 'APPROVED sin registro en IBS',
  MAS_DE_UN_DEBITO: 'Más de un débito',
  DEBITO_SIN_OPERACION: 'Débito sin operación en BankService',
  DEBITO_FAILED: 'Débito de operación FAILED / sin ejecutar',
  PEND_DEBITADO: 'Pendiente sobre comprobante ya debitado',
  PEND_SIN_OPERACION: 'Pendiente sin operación APPROVED',
  CREDITO_RELEVANTE: 'Crédito 25031 de importe relevante',
  DEBITO_MANUAL: 'Débito manual',
  SIN_EJECUTAR: 'Transfer sin ejecutar',
  DEBITO_PENDIENTE: 'Débito pendiente',
  DEBITO_POR_CONTABILIZAR: 'Débito por contabilizar',
  CREDITO_FALTANTE: 'Falta el crédito 25031',
};

const numero = (c) => Number(c) || 0;
const pesos = (c) => (c / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function conciliar({ movimientos, pendientes, operaciones, config }) {
  const etiqueta = (moncod) => config.etiquetaMoneda[moncod] || String(moncod);
  const dinero = (moncod, c) => `${moncod === '2' ? 'US$' : '$'} ${pesos(c)}`;
  const esCentavo = (m) => m.importe <= config.maxCentavo;
  const proceso = new Set((config.usuariosProceso || []).map(String));

  // Corte: no cambia con los filtros del dashboard.
  // Los movimientos imputados en fechas posteriores al período (posterior: true) se
  // usan para cruzar, pero no mueven el corte ni los indicadores de IBS del período.
  const delPeriodo = movimientos.filter((m) => !m.posterior);
  const ultimoDiaIbs = delPeriodo.reduce((max, m) => (m.fecha > max ? m.fecha : max), '');
  const mayorComprobante = delPeriodo.filter((m) => m.movcod === config.movDebito).reduce((max, m) => Math.max(max, numero(m.comprobante)), 0);

  const ops = new Map(operaciones.map((o) => [o.comprobante, o]));

  // Movimientos de IBS: de 1 centavo, de Activar Cuentas (1 centavo sin operación en
  // BankService: se excluyen de los indicadores de transferencias) y manuales.
  const movs = movimientos.map((m) => {
    const centavo = esCentavo(m);
    const o = ops.get(m.comprobante);
    return {
      ...m,
      // Un movimiento imputado después del período se cuenta en el día de su operación
      // (así entra en los indicadores de IBS del período y en el filtro por día).
      // BankService manda: un movimiento de una operación de BankService se cuenta en el
      // día de esa operación (aunque IBS lo haya imputado otro día).
      fechaFiltro: o && o.fecha ? o.fecha : m.fecha,
      aprobada: !!(o && o.estado === 'APPROVED'),
      fechaOperacion: o && o.fecha ? o.fecha : '',
      centavo,
      activarCuentas: centavo && !ops.has(m.comprobante),
      manual: m.movcod === config.movDebito && !proceso.has(String(m.usuario)),
    };
  });
  const debitosPorComp = new Map();
  for (const m of movs) {
    if (m.activarCuentas || m.movcod !== config.movDebito) continue;
    if (!debitosPorComp.has(m.comprobante)) debitosPorComp.set(m.comprobante, []);
    debitosPorComp.get(m.comprobante).push(m);
  }
  const creditosPorComp = new Map();
  for (const m of movs) {
    if (m.activarCuentas || m.movcod !== config.movCredito) continue;
    if (!creditosPorComp.has(m.comprobante)) creditosPorComp.set(m.comprobante, []);
    creditosPorComp.get(m.comprobante).push(m);
  }
  const pendPorClave = new Map();
  for (const p of pendientes) {
    if (p.movcod !== config.movDebito) continue;
    const clave = `${p.moncod}|${p.comprobante}`;
    if (!pendPorClave.has(clave)) pendPorClave.set(clave, []);
    pendPorClave.get(clave).push(p);
  }

  const excepciones = [];
  const exc = (tipo, datos) => {
    const { fechaOriginal, ...resto } = datos;
    const e = { tipo, comprobante: '', cuenta: '', moneda: '', fecha: '', importe: null, usuario: '', estadoBs: '', detalle: '', ...resto };
    // Operación de un día no hábil: se informa el día real.
    if (fechaOriginal) e.detalle += ` Operación del ${fechaOriginal.split('-').reverse().join('/')} (no hábil), asignada al próximo día hábil.`;
    excepciones.push(e);
  };

  // Operaciones de BankService.
  const clasificadas = operaciones.map((o) => {
    const r = { ...o, clase: '', subclase: '' };
    const debitos = debitosPorComp.get(o.comprobante) || [];
    const base = { comprobante: o.comprobante, cuenta: o.cuecod, moneda: etiqueta(o.moncod), fecha: o.fecha, importe: o.monto, estadoBs: o.estado, fechaOriginal: o.fechaOriginal };
    if (o.estado === 'APPROVED') {
      if (debitos.length > 0) {
        r.clase = 'ejecutada';
        const d = debitos[0];
        if (debitos.every((x) => x.posterior)) {
          r.posterior = true;
          r.fechaDebito = d.fecha;
        }
        if (d.moncod !== o.moncod) exc(TIPOS.MONEDA, { ...base, fecha: d.fecha, usuario: d.usuario, detalle: `IBS debitó en ${etiqueta(d.moncod)} y BankService es ${etiqueta(o.moncod)}.` });
        if (d.importe !== o.monto) exc(TIPOS.IMPORTE, { ...base, fecha: d.fecha, usuario: d.usuario, detalle: `IBS debitó ${dinero(d.moncod, d.importe)} y BankService dice ${dinero(o.moncod, o.monto)}.` });
        if (d.cuecod !== o.cuecod) exc(TIPOS.CUENTA, { ...base, fecha: d.fecha, usuario: d.usuario, detalle: `IBS debitó la cuenta ${d.cuecod} y BankService es de la cuenta ${o.cuecod}.` });
        // Debitada pero sin su crédito 25031 en IBS (ni en fechas posteriores).
        if (!(creditosPorComp.get(o.comprobante) || []).some((c) => c.moncod === o.moncod)) {
          exc(TIPOS.CREDITO_FALTANTE, { ...base, usuario: d.usuario, detalle: `IBS tiene el débito del ${d.fecha.split('-').reverse().join('/')} por ${dinero(d.moncod, d.importe)} y no tiene el crédito 25031 de la operación.` });
        }
      } else {
        const pend = (pendPorClave.get(`${o.moncod}|${o.comprobante}`) || [])[0];
        if (pend) {
          r.clase = 'pendiente';
          r.subclase = o.fecha === ultimoDiaIbs ? 'ultimoDia' : 'anterior';
          r.pendiente = pend.importe;
          if (pend.importe !== o.monto) exc(TIPOS.PEND_IMPORTE, { ...base, detalle: `El débito pendiente es de ${dinero(o.moncod, pend.importe)} y la operación de ${dinero(o.moncod, o.monto)}.` });
          exc(TIPOS.DEBITO_PENDIENTE, { ...base, cuenta: pend.cuecod || o.cuecod, importe: pend.importe, detalle: `Falta el débito en IBS: está en débitos pendientes desde el ${(pend.fechaOrigen || '').split('-').reverse().join('/') || 'sin fecha'} por ${dinero(o.moncod, pend.importe)} (${pend.motivo || 'sin motivo'}).` });
        } else if (numero(o.comprobante) < mayorComprobante || (ultimoDiaIbs && o.fecha < ultimoDiaIbs)) {
          r.clase = 'sinRegistro';
          exc(TIPOS.SIN_REGISTRO, { ...base, detalle: `Falta el débito en IBS: sin débito ni débito pendiente (mayor comprobante de IBS: ${mayorComprobante}; último día de IBS: ${ultimoDiaIbs}).` });
        } else {
          r.clase = 'porContabilizar';
          exc(TIPOS.DEBITO_POR_CONTABILIZAR, { ...base, detalle: `Falta el débito en IBS: el comprobante es posterior al mayor de IBS (${mayorComprobante}), todavía puede contabilizarse.` });
        }
      }
    } else {
      if (debitos.length > 0) {
        r.clase = 'debitadaNoAprobada';
        const d = debitos[0];
        exc(TIPOS.DEBITO_FAILED, { ...base, fecha: d.fecha, usuario: d.usuario, importe: d.importe, detalle: `IBS tiene ${debitos.length} débito(s) por ${dinero(d.moncod, d.importe)} para una operación ${o.estado}.` });
      }
      if (o.estado === 'PENDING_EXECUTION') {
        exc(TIPOS.SIN_EJECUTAR, { ...base, fecha: o.creada.slice(0, 10), detalle: `Creada el ${o.creada}; sin ejecutar.` });
      }
    }
    return r;
  });

  // Excepciones sobre los débitos de IBS.
  for (const [comprobante, debitos] of debitosPorComp) {
    const o = ops.get(comprobante);
    const base = { comprobante, cuenta: debitos[0].cuecod, moneda: etiqueta(debitos[0].moncod), fecha: debitos[0].fecha, usuario: debitos[0].usuario, estadoBs: o ? o.estado : '' };
    if (debitos.length > 1) {
      exc(TIPOS.MAS_DE_UN_DEBITO, { ...base, importe: debitos.reduce((s, d) => s + d.importe, 0), detalle: `${debitos.length} débitos 25030: ${debitos.map((d) => `${dinero(d.moncod, d.importe)} (${d.fecha})`).join(', ')}.` });
    }
    if (!o) {
      for (const d of debitos) {
        exc(TIPOS.DEBITO_SIN_OPERACION, { ...base, fecha: d.fecha, usuario: d.usuario, importe: d.importe, detalle: `Débito de ${dinero(d.moncod, d.importe)} sin operación en BankService.` });
      }
    }
  }
  for (const m of movs) {
    if (m.activarCuentas) continue;
    const o = ops.get(m.comprobante);
    const base = { comprobante: m.comprobante, cuenta: m.cuecod, moneda: etiqueta(m.moncod), fecha: m.fecha, usuario: m.usuario, importe: m.importe, estadoBs: o ? o.estado : '' };
    // Un crédito 25031 que es la contrapartida de una operación APPROVED (mismo
    // comprobante, moneda e importe) es normal; cualquier otro mayor a 1 centavo se revisa.
    const contrapartida = o && o.estado === 'APPROVED' && o.moncod === m.moncod && o.monto === m.importe;
    if (m.movcod === config.movCredito && !m.centavo && !contrapartida) {
      exc(TIPOS.CREDITO_RELEVANTE, { ...base, detalle: `Crédito 25031 de ${dinero(m.moncod, m.importe)} (sistcod ${m.sistcod || '?'})${o ? '' : ' sin operación en BankService'}: a revisar.` });
    }
    if (m.manual) {
      exc(TIPOS.DEBITO_MANUAL, { ...base, detalle: `Débito cargado por el usuario ${m.usuario} (no es de proceso). Informativo.` });
    }
  }

  // Excepciones sobre los débitos pendientes.
  const pendientesOut = pendientes.map((p) => {
    const o = ops.get(p.comprobante);
    const aprobada = !!(o && o.estado === 'APPROVED' && o.moncod === p.moncod);
    const fecha = aprobada ? o.fecha : p.fechaOrigen;
    const base = { comprobante: p.comprobante, cuenta: p.cuecod, moneda: etiqueta(p.moncod), fecha, importe: p.importe, estadoBs: o ? o.estado : '' };
    if (p.movcod === config.movDebito) {
      if ((debitosPorComp.get(p.comprobante) || []).some((d) => d.moncod === p.moncod)) {
        exc(TIPOS.PEND_DEBITADO, { ...base, detalle: `Figura en pendientes (${p.motivo || 'sin motivo'}) y el comprobante ya tiene débito en IBS.` });
      }
      if (!aprobada) {
        exc(TIPOS.PEND_SIN_OPERACION, { ...base, detalle: `Débito pendiente del ${p.fechaOrigen || 'sin fecha'} (${p.motivo || 'sin motivo'}) sin operación APPROVED en BankService${o ? ` (está ${o.estado})` : ''}.` });
      }
    }
    return { ...p, fecha, aprobada };
  });

  return {
    corte: { ultimoDiaIbs, mayorComprobante },
    movimientos: movs,
    pendientes: pendientesOut,
    operaciones: clasificadas,
    excepciones,
  };
}

module.exports = { conciliar, TIPOS };
