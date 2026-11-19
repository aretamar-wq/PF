'use strict';

// Cálculos del dashboard "Conciliación Transferencias CA -> CC" sobre los datos ya
// clasificados por el servidor (node/lib/transfCaCc/conciliar.js). Corre en el
// navegador y en Node (tests). Importes en centavos; monedas por moncod ('0' pesos, '2' USD).
(function (raiz) {
  const MONEDAS = ['0', '2'];
  const nuevo = () => ({ 0: 0, 2: 0 });
  const total = (o) => (o[0] || 0) + (o[2] || 0);

  // Filtro por día: IBS por Fecha_Mov, BankService por la fecha de la operación,
  // pendientes por la fecha de su operación (o la de origen si no tiene).
  const enDia = (dia) => (fecha) => !dia || fecha === dia;

  function indicadores(datos, dia) {
    const ok = enDia(dia);
    // Los movimientos imputados después del período suman en el día de su operación (fechaFiltro).
    const movs = datos.movimientos.filter((m) => ok(m.fechaFiltro || m.fecha));
    const ops = datos.operaciones.filter((o) => ok(o.fecha));
    const pends = datos.pendientes.filter((p) => p.movcod === datos.config.movDebito && ok(p.fecha));
    const deb = datos.config.movDebito;
    const cre = datos.config.movCredito;

    const ibs = {
      comprobantes: nuevo(), debitos: nuevo(), creditos: nuevo(), pendientes: nuevo(),
      saldoDebitos: nuevo(), saldoCreditos: nuevo(), saldoPendientes: nuevo(),
      manuales: nuevo(), importeManuales: nuevo(), posteriores: nuevo(),
    };
    const comps = { 0: new Set(), 2: new Set() };
    const activar = { comprobantes: nuevo(), creditos: nuevo(), debitos: nuevo(), sinOperacion: 0 };
    const compsCentavo = { 0: new Set(), 2: new Set() };
    for (const m of movs) {
      const k = m.moncod;
      if (!(k in comps)) continue;
      if (m.centavo) {
        compsCentavo[k].add(m.comprobante);
        if (m.movcod === deb) activar.debitos[k]++;
        else activar.creditos[k]++;
        if (m.activarCuentas) activar.sinOperacion++;
      } else {
        comps[k].add(m.comprobante);
      }
      if (m.activarCuentas) continue; // Activar Cuentas: fuera de los indicadores de transferencias
      if (m.posterior && (m.movcod === deb || !m.centavo)) ibs.posteriores[k]++;
      if (m.movcod === deb) {
        ibs.debitos[k]++;
        ibs.saldoDebitos[k] += m.importe;
        if (m.manual) { ibs.manuales[k]++; ibs.importeManuales[k] += m.importe; }
      } else if (m.movcod === cre && !m.centavo) {
        ibs.creditos[k]++;
        ibs.saldoCreditos[k] += m.importe;
      }
    }
    for (const k of MONEDAS) { ibs.comprobantes[k] = comps[k].size; activar.comprobantes[k] = compsCentavo[k].size; }
    for (const p of pends) {
      if (!(p.moncod in ibs.pendientes)) continue;
      ibs.pendientes[p.moncod]++;
      ibs.saldoPendientes[p.moncod] += p.importe;
    }

    const bs = {
      aprobadas: nuevo(), ejecutadas: nuevo(), pendientes: nuevo(), pendientesUltimoDia: nuevo(), pendientesAnteriores: nuevo(),
      sinRegistro: nuevo(), porContabilizar: nuevo(), importePendiente: nuevo(), failed: 0, failedEnIbs: 0,
    };
    for (const o of ops) {
      const k = o.moncod;
      if (o.estado === 'FAILED') {
        bs.failed++;
        if (o.clase === 'debitadaNoAprobada') bs.failedEnIbs++;
      }
      if (o.estado !== 'APPROVED' || !(k in bs.aprobadas)) continue;
      bs.aprobadas[k]++;
      if (o.clase === 'ejecutada') bs.ejecutadas[k]++;
      else if (o.clase === 'pendiente') {
        bs.pendientes[k]++;
        bs.importePendiente[k] += o.pendiente || 0;
        if (o.subclase === 'ultimoDia') bs.pendientesUltimoDia[k]++;
        else bs.pendientesAnteriores[k]++;
      } else if (o.clase === 'sinRegistro') bs.sinRegistro[k]++;
      else if (o.clase === 'porContabilizar') bs.porContabilizar[k]++;
    }
    const suma = total(bs.ejecutadas) + total(bs.pendientes) + total(bs.sinRegistro) + total(bs.porContabilizar);
    bs.control = { aprobadas: total(bs.aprobadas), suma, diferencia: total(bs.aprobadas) - suma };

    const excepciones = datos.excepciones.filter((e) => ok(e.fecha));
    return { ibs, activar, bs, excepciones, total };
  }

  // Gráfico y saldo de pendientes por día, en el período Desde - Hasta (fecha de
  // la operación en BankService). El acumulado se calcula dentro del período.
  function porDia(datos, desde, hasta) {
    const dentro = (f) => (!desde || f >= desde) && (!hasta || f <= hasta);
    const dias = new Map();
    const dia = (f) => {
      if (!dias.has(f)) dias.set(f, { fecha: f, ejecutadas: 0, pendientes: 0, sinRegistro: 0, nPend: nuevo(), importePend: nuevo() });
      return dias.get(f);
    };
    for (const o of datos.operaciones) {
      if (o.estado !== 'APPROVED' || !o.fecha || !dentro(o.fecha)) continue;
      const d = dia(o.fecha);
      if (o.clase === 'ejecutada') d.ejecutadas++;
      else if (o.clase === 'pendiente') {
        d.pendientes++;
        if (o.moncod in d.nPend) { d.nPend[o.moncod]++; d.importePend[o.moncod] += o.pendiente || 0; }
      } else d.sinRegistro++;
    }
    const filas = [...dias.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));
    const acumulado = nuevo();
    const saldo = [];
    for (const d of filas) {
      if (total(d.nPend) === 0) continue;
      for (const k of MONEDAS) acumulado[k] += d.importePend[k];
      saldo.push({ fecha: d.fecha, nPend: d.nPend, importePend: d.importePend, acumulado: { ...acumulado } });
    }
    return { grafico: filas, saldo };
  }

  // Semáforo de cada sección (sobre el filtro de día activo): rojo si hay diferencias,
  // amarillo si hay débitos pendientes (o algo a revisar que no es diferencia), verde
  // si está todo bien. Cada uno trae los motivos para el tooltip.
  const EXC_IBS = ['Más de un débito', 'Débito sin operación en BankService', 'Débito de operación FAILED / sin ejecutar', 'Crédito 25031 de importe relevante', 'Pendiente sobre comprobante ya debitado', 'Pendiente sin operación APPROVED'];
  const EXC_BS = ['Importe distinto', 'Moneda distinta', 'Cuenta distinta', 'Pendiente con importe distinto', 'APPROVED sin registro en IBS', 'Débito de operación FAILED / sin ejecutar'];

  function semaforos(ind) {
    const contar = (tipos) => {
      const n = {};
      for (const e of ind.excepciones) if (tipos.includes(e.tipo)) n[e.tipo] = (n[e.tipo] || 0) + 1;
      return Object.entries(n).map(([tipo, c]) => `${c} ${tipo}`);
    };
    const armar = (rojos, amarillos) => ({
      color: rojos.length ? 'rojo' : amarillos.length ? 'amarillo' : 'verde',
      motivos: rojos.length || amarillos.length ? [...rojos, ...amarillos] : ['Todo OK'],
    });

    const pendIbs = total(ind.ibs.pendientes);
    const ibs = armar(contar(EXC_IBS), pendIbs ? [`${pendIbs} débito(s) pendiente(s)`] : []);

    const sinOp = ind.activar.sinOperacion;
    const activar = armar([], sinOp ? [`${sinOp} movimiento(s) de 1 centavo sin operación en BankService (a revisar)`] : []);

    const b = ind.bs;
    const rojosBs = contar(EXC_BS);
    if (b.failedEnIbs && !rojosBs.some((m) => m.includes('FAILED'))) rojosBs.push(`${b.failedEnIbs} FAILED con débito en IBS`);
    if (b.control.diferencia !== 0) rojosBs.push(`El control no cierra (diferencia ${b.control.diferencia})`);
    const amarillosBs = [];
    if (total(b.pendientes)) amarillosBs.push(`${total(b.pendientes)} operación(es) con débito pendiente`);
    if (total(b.porContabilizar)) amarillosBs.push(`${total(b.porContabilizar)} pendiente(s) de contabilizar`);
    const bs = armar(rojosBs, amarillosBs);
    return { ibs, activar, bs };
  }

  const api = { indicadores, porDia, semaforos };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.TransfCaCcCalculo = api;
})(typeof window !== 'undefined' ? window : globalThis);
