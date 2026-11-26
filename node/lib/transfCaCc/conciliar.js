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
  DEBITO_FAILED: 'Operación FAILED con movimientos en IBS',
  SIN_EJECUTAR_CON_MOVIMIENTOS: 'Operación sin ejecutar con movimientos en IBS',
  PEND_DEBITADO: 'Pendiente sobre comprobante ya debitado',
  PEND_SIN_OPERACION: 'Pendiente sin operación APPROVED',
  CREDITO_RELEVANTE: 'Crédito 25031 sin operación en BankService',
  DEBITO_MANUAL: 'Débito manual',
  SIN_EJECUTAR: 'Transfer sin ejecutar',
  DEBITO_PENDIENTE: 'Débito pendiente',
  DEBITO_PENDIENTE_CON_SALDO: 'Débito pendiente con saldo',
  DEBITO_PENDIENTE_SIN_SALDO: 'Débito pendiente sin saldo',
  DEBITO_POR_CONTABILIZAR: 'Débito por contabilizar',
  CREDITO_FALTANTE: 'Falta el crédito 25031',
  CREDITO_FALTANTE_PENDIENTE: 'Falta el crédito 25031 (débito pendiente)',
  ACTIVAR_CUENTAS: 'Activar Cuentas (1 centavo)',
  MAS_DE_UN_CREDITO: 'Más de un crédito 25031',
  CREDITO_IMPORTE: 'Importe del crédito 25031 distinto',
  CREDITO_SIN_DEBITO: 'Crédito 25031 sin débito',
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
      conOperacion: !!o,
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
  // Los tipos nombran el par 25030/25031; para otro par (25032/25033) se usan sus códigos.
  const conCodigos = (tipo) => tipo.replace('25031', config.movCredito).replace('25030', config.movDebito);
  const exc = (tipo, datos) => {
    const { fechaOriginal, ...resto } = datos;
    // CUIT del titular: el de la operación de BankService del comprobante (si hay).
    const opCuit = ops.get(String(resto.comprobante || ''));
    const e = { tipo: conCodigos(tipo), comprobante: '', cuit: opCuit && opCuit.cuit ? opCuit.cuit : '', cuenta: '', moneda: '', fecha: '', importe: null, usuario: '', estadoBs: '', detalle: '', ...resto };
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
        if (d.moncod !== o.moncod) exc(TIPOS.MONEDA, { ...base, usuario: d.usuario, detalle: `IBS debitó en ${etiqueta(d.moncod)} y BankService es ${etiqueta(o.moncod)}.` });
        if (d.importe !== o.monto) exc(TIPOS.IMPORTE, { ...base, usuario: d.usuario, detalle: `IBS debitó ${dinero(d.moncod, d.importe)} y BankService dice ${dinero(o.moncod, o.monto)}.` });
        if (d.cuecod !== o.cuecod) exc(TIPOS.CUENTA, { ...base, usuario: d.usuario, detalle: `IBS debitó la cuenta ${d.cuecod} y BankService es de la cuenta ${o.cuecod}.` });
        // Debitada pero sin su crédito 25031 en IBS (ni en fechas posteriores).
        const creditos = (creditosPorComp.get(o.comprobante) || []).filter((c) => c.moncod === o.moncod);
        if (creditos.length === 0) {
          exc(TIPOS.CREDITO_FALTANTE, { ...base, usuario: d.usuario, detalle: `IBS tiene el débito del ${d.fecha.split('-').reverse().join('/')} por ${dinero(d.moncod, d.importe)} y no tiene el crédito ${config.movCredito} de la operación.` });
        }
        if (creditos.length > 1) {
          exc(TIPOS.MAS_DE_UN_CREDITO, { ...base, importe: creditos.reduce((s, c) => s + c.importe, 0), usuario: creditos[0].usuario, detalle: `${creditos.length} créditos ${config.movCredito}: ${creditos.map((c) => `${dinero(c.moncod, c.importe)} (${c.fecha.split('-').reverse().join('/')}, cuenta ${c.cuecod})`).join(', ')}.` });
        }
        for (const c of creditos) {
          if (c.importe !== o.monto) exc(TIPOS.CREDITO_IMPORTE, { ...base, importe: c.importe, usuario: c.usuario, detalle: `IBS acreditó ${dinero(c.moncod, c.importe)} el ${c.fecha.split('-').reverse().join('/')} y BankService dice ${dinero(o.moncod, o.monto)}.` });
        }
      } else {
        const creditos = (creditosPorComp.get(o.comprobante) || []).filter((c) => c.moncod === o.moncod);
        r.tieneCredito = creditos.length > 0;
        const enPendientes = (pendPorClave.get(`${o.moncod}|${o.comprobante}`) || []).length > 0;
        // Con el débito en pendientes, que el crédito ya esté es normal: no es excepción.
        if (creditos.length > 0 && !enPendientes) {
          exc(TIPOS.CREDITO_SIN_DEBITO, { ...base, importe: creditos[0].importe, usuario: creditos[0].usuario, detalle: `IBS tiene ${creditos.length} crédito(s) ${config.movCredito} (${creditos.map((c) => `${dinero(c.moncod, c.importe)} del ${c.fecha.split('-').reverse().join('/')}`).join(', ')}) y no tiene el débito ${config.movDebito}.` });
        }
        const pend = (pendPorClave.get(`${o.moncod}|${o.comprobante}`) || [])[0];
        if (pend) {
          r.clase = 'pendiente';
          r.subclase = o.fecha === ultimoDiaIbs ? 'ultimoDia' : 'anterior';
          r.pendiente = pend.importe;
          if (pend.importe !== o.monto) exc(TIPOS.PEND_IMPORTE, { ...base, detalle: `El débito pendiente es de ${dinero(o.moncod, pend.importe)} y la operación de ${dinero(o.moncod, o.monto)}.` });
          // Con el saldo de la cuenta consultado: pendiente con saldo (se puede debitar) o sin saldo.
          const tipoPend = pend.saldo ? (pend.saldo.conSaldo ? TIPOS.DEBITO_PENDIENTE_CON_SALDO : TIPOS.DEBITO_PENDIENTE_SIN_SALDO) : TIPOS.DEBITO_PENDIENTE;
          exc(tipoPend, { ...base, cuenta: pend.cuecod || o.cuecod, importe: pend.importe, detalle: `Falta el débito en IBS: está en débitos pendientes desde el ${(pend.fechaOrigen || '').split('-').reverse().join('/') || 'sin fecha'} por ${dinero(o.moncod, pend.importe)} (${pend.motivo || 'sin motivo'}).${pend.saldo ? ` ${pend.saldo.texto}` : ''}` });
          // Tampoco tiene el crédito: se informa aparte (amarillo, como el pendiente).
          if (creditos.length === 0) {
            exc(TIPOS.CREDITO_FALTANTE_PENDIENTE, { ...base, detalle: `Falta el crédito ${config.movCredito} de ${dinero(o.moncod, o.monto)}: el débito está en débitos pendientes y el crédito todavía no se hizo.` });
          }
        } else if (numero(o.comprobante) < mayorComprobante || (ultimoDiaIbs && o.fecha < ultimoDiaIbs)) {
          r.clase = 'sinRegistro';
          exc(TIPOS.SIN_REGISTRO, { ...base, detalle: `Falta el débito en IBS: sin débito ni débito pendiente (mayor comprobante de IBS: ${mayorComprobante}; último día de IBS: ${ultimoDiaIbs}).` });
        } else {
          r.clase = 'porContabilizar';
          exc(TIPOS.DEBITO_POR_CONTABILIZAR, { ...base, detalle: `Falta el débito en IBS: el comprobante es posterior al mayor de IBS (${mayorComprobante}), todavía puede contabilizarse.` });
        }
      }
    } else {
      // Operación FAILED / sin ejecutar: una sola excepción con todo lo que IBS tiene
      // (débitos y créditos). Sin movimientos, una PENDING_EXECUTION es "Transfer sin ejecutar".
      const creditos = (creditosPorComp.get(o.comprobante) || []).filter((c) => c.moncod === o.moncod);
      const fmt = (m) => `${dinero(m.moncod, m.importe)} del ${m.fecha.split('-').reverse().join('/')}`;
      if (debitos.length > 0) r.clase = 'debitadaNoAprobada';
      if (debitos.length > 0 || creditos.length > 0) {
        const partes = [];
        if (debitos.length) partes.push(`${debitos.length} débito(s) ${config.movDebito} (${debitos.map(fmt).join(', ')})`);
        if (creditos.length) partes.push(`${creditos.length} crédito(s) ${config.movCredito} (${creditos.map(fmt).join(', ')})`);
        const primero = debitos[0] || creditos[0];
        exc(o.estado === 'PENDING_EXECUTION' ? TIPOS.SIN_EJECUTAR_CON_MOVIMIENTOS : TIPOS.DEBITO_FAILED, {
          ...base,
          usuario: primero.usuario,
          importe: primero.importe,
          detalle: `BankService la tiene ${o.estado}${o.estado === 'PENDING_EXECUTION' ? ` (creada el ${o.creada})` : ''} e IBS tiene ${partes.join(' y ')}.` +
            (o.estado === 'PENDING_EXECUTION' ? ' Si se ejecutó después, cargá el CSV de BankService más nuevo.' : ''),
        });
      } else if (o.estado === 'PENDING_EXECUTION') {
        exc(TIPOS.SIN_EJECUTAR, { ...base, fecha: o.creada.slice(0, 10), detalle: `Creada el ${o.creada}; sin ejecutar.` });
      }
    }
    return r;
  });

  // Excepciones sobre los débitos de IBS.
  for (const [comprobante, debitos] of debitosPorComp) {
    const o = ops.get(comprobante);
    const base = { comprobante, cuenta: debitos[0].cuecod, moneda: etiqueta(debitos[0].moncod), fecha: debitos[0].fechaFiltro || debitos[0].fecha, usuario: debitos[0].usuario, estadoBs: o ? o.estado : '' };
    if (debitos.length > 1) {
      exc(TIPOS.MAS_DE_UN_DEBITO, { ...base, importe: debitos.reduce((s, d) => s + d.importe, 0), detalle: `${debitos.length} débitos ${config.movDebito}: ${debitos.map((d) => `${dinero(d.moncod, d.importe)} (${d.fecha})`).join(', ')}.` });
    }
    if (!o) {
      for (const d of debitos) {
        exc(TIPOS.DEBITO_SIN_OPERACION, { ...base, fecha: d.fecha, usuario: d.usuario, importe: d.importe, detalle: `Débito de ${dinero(d.moncod, d.importe)} sin operación en BankService.` });
      }
    }
  }
  for (const m of movs) {
    // Movimientos de 1 centavo sin operación en BankService: se listan (informativo) para
    // poder ver el detalle de lo que suma "IBS - Activar Cuentas".
    if (m.activarCuentas) {
      exc(TIPOS.ACTIVAR_CUENTAS, {
        comprobante: m.comprobante, cuenta: m.cuecod, moneda: etiqueta(m.moncod), fecha: m.fecha, usuario: m.usuario, importe: m.importe,
        detalle: `${m.movcod === config.movDebito ? 'Débito' : 'Crédito'} ${m.movcod} de ${dinero(m.moncod, m.importe)} (sistcod ${m.sistcod || '?'}) sin operación en BankService. Informativo.`,
      });
      continue;
    }
    const o = ops.get(m.comprobante);
    const base = { comprobante: m.comprobante, cuenta: m.cuecod, moneda: etiqueta(m.moncod), fecha: m.fechaFiltro || m.fecha, usuario: m.usuario, importe: m.importe, estadoBs: o ? o.estado : '' };
    // Un crédito 25031 que es la contrapartida de una operación APPROVED (mismo
    // comprobante, moneda e importe) es normal; cualquier otro mayor a 1 centavo se revisa.
    const contrapartida = o && o.estado === 'APPROVED' && o.moncod === m.moncod && o.monto === m.importe;
    if (m.movcod === config.movCredito && !m.centavo && !contrapartida && !o) {
      exc(TIPOS.CREDITO_RELEVANTE, { ...base, detalle: `Crédito ${config.movCredito} de ${dinero(m.moncod, m.importe)} (sistcod ${m.sistcod || '?'})${o ? '' : ' sin operación en BankService'}: a revisar.` });
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
