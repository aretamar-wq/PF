'use strict';

// Cálculos de la "Conciliación FX" sobre los datos clasificados por el servidor
// (node/lib/fx/conciliar.js). Corre en el navegador y en Node. Importes en centavos.
(function (raiz) {
  const ROJAS = ['Faltan movimientos en IBS', 'Movimiento duplicado', 'Importe distinto', 'COMPLETED sin registro en IBS', 'Movimiento de otro tipo de operación', 'Operación FAILED con movimientos en IBS', 'Operación en revisión manual con movimientos en IBS', 'Movimiento sin operación en BankService', 'Pendiente sin operación COMPLETED'];
  const AMARILLAS = ['Débito pendiente', 'Débito pendiente con saldo', 'Débito pendiente sin saldo', 'Por contabilizar', 'Operación en revisión manual'];

  // Indicadores de un lado (BUY / SELL) para el día (fecha de la orden en BankService).
  function indicadores(datos, dia, ladoDef) {
    const lado = ladoDef.lado;
    const ok = (f) => !dia || f === dia;
    const ordenes = datos.ordenes.filter((o) => o.side === lado && ok(o.fecha));
    const bs = { completadas: 0, ars: 0, usd: 0, completas: 0, pendientes: 0, incompletas: 0, sinRegistro: 0, porContabilizar: 0, failed: 0, revision: 0, noCompletadasEnIbs: 0, pendArs: 0, pendUsd: 0, pendArsN: 0, pendUsdN: 0 };
    // Por movimiento: lo que BankService espera y lo que falta "con explicación" (pendiente o por contabilizar).
    const esperado = {};
    for (const m of ladoDef.movs) esperado[m.cod] = { n: 0, importe: 0, nExplicado: 0, importeExplicado: 0 };
    for (const o of ordenes) {
      if (o.clase === 'ignorada') continue; // ABANDONED sin movimientos: no se tiene en cuenta
      if (o.status === 'FAILED') bs.failed++;
      else if (o.status !== 'COMPLETED') bs.revision++;
      if (o.clase === 'noCompletadaEnIbs') bs.noCompletadasEnIbs++;
      if (o.status !== 'COMPLETED') continue;
      bs.completadas++;
      bs.ars += o.ars;
      bs.usd += o.usd;
      if (o.clase === 'completa') bs.completas++;
      else if (o.clase === 'pendiente') {
        bs.pendientes++;
        bs.pendArs += o.pendienteArs || 0;
        bs.pendUsd += o.pendienteUsd || 0;
        // Cantidad de órdenes con algún débito pendiente en cada moneda.
        if ((o.pendientesMov || []).some((p) => p.moneda === 'ARS')) bs.pendArsN++;
        if ((o.pendientesMov || []).some((p) => p.moneda === 'USD')) bs.pendUsdN++;
      }
      else if (o.clase === 'incompleta') bs.incompletas++;
      else if (o.clase === 'sinRegistro') bs.sinRegistro++;
      else if (o.clase === 'porContabilizar') bs.porContabilizar++;
      const pend = new Set((o.pendientesMov || []).map((p) => p.cod));
      for (const m of ladoDef.movs) {
        const imp = m.moneda === 'USD' ? o.usd : o.ars;
        esperado[m.cod].n++;
        esperado[m.cod].importe += imp;
        if (pend.has(m.cod) || o.clase === 'porContabilizar') { esperado[m.cod].nExplicado++; esperado[m.cod].importeExplicado += imp; }
      }
    }
    // IBS: movimientos de órdenes COMPLETED de BankService, en el día de la orden (los de
    // órdenes FAILED o en revisión van aparte, en su indicador y en excepciones).
    const ibs = {};
    for (const m of ladoDef.movs) ibs[m.cod] = { n: 0, importe: 0 };
    let manuales = 0;
    let posteriores = 0;
    // Movimientos de IBS cuyo comprobante no figura en BankService FX: diferencia.
    const sinOrden = { comprobantes: new Set(), n: 0, ARS: 0, USD: 0 };
    for (const m of datos.movimientos) {
      if (m.lado === lado && !m.conOperacion && ok(m.fechaFiltro || m.fecha)) {
        sinOrden.comprobantes.add(m.comprobante);
        sinOrden.n++;
        sinOrden[m.monedaEsperada === 'USD' ? 'USD' : 'ARS'] += m.importe;
      }
      // Manuales: los del lado en el día cuyo comprobante no está en BankService FX.
      if (m.lado === lado && m.manual && !m.conOperacion && ok(m.fechaFiltro || m.fecha)) manuales++;
      if (m.lado !== lado || !m.completada || !ok(m.fechaFiltro || m.fecha) || !ibs[m.movcod]) continue;
      ibs[m.movcod].n++;
      ibs[m.movcod].importe += m.importe;
      if (m.posterior) posteriores++;
    }
    const pendientes = datos.pendientes.filter((p) => p.lado === lado && ok(p.fecha));
    const comparar = (valor, total, explicado) => (valor === total ? 'ok' : explicado > 0 && valor + explicado === total ? 'warn' : 'err');
    const colores = {};
    for (const m of ladoDef.movs) {
      const e = esperado[m.cod];
      colores[m.cod] = { n: comparar(ibs[m.cod].n, e.n, e.nExplicado), importe: comparar(ibs[m.cod].importe, e.importe, e.importeExplicado) };
    }
    const excepciones = datos.excepciones.filter((x) => x.lado === lado && ok(x.fecha));
    // Débitos pendientes del día por moneda (la del movimiento).
    const monedaDe = new Map(ladoDef.movs.map((m) => [m.cod, m.moneda]));
    const pendDia = { ARS: { n: 0, importe: 0 }, USD: { n: 0, importe: 0 } };
    for (const p of pendientes) {
      const mon = monedaDe.get(p.movcod) || 'ARS';
      pendDia[mon].n++;
      pendDia[mon].importe += p.importe;
    }
    return { lado, bs, ibs, esperado, colores, pendientes, pendDia, manuales, posteriores, sinOrden: { ...sinOrden, comprobantes: sinOrden.comprobantes.size }, excepciones };
  }

  const peor = (...cs) => (cs.includes('err') ? 'err' : cs.includes('warn') ? 'warn' : cs.every((c) => c === 'ok') ? 'ok' : '');

  // Color de cada indicador con color (ok / warn / err); los mismos que pinta la pantalla.
  function estados(ind, ladoDef) {
    const { bs, colores, pendDia } = ind;
    const dif = bs.incompletas + bs.sinRegistro;
    const nPend = pendDia.ARS.n + pendDia.USD.n;
    return {
      movs: Object.fromEntries(ladoDef.movs.map((m) => [m.cod, peor(colores[m.cod].n, colores[m.cod].importe)])),
      completas: bs.completas === bs.completadas ? 'ok' : '',
      conPendiente: bs.pendientes ? 'warn' : 'ok',
      faltantes: dif ? 'err' : bs.porContabilizar ? 'warn' : 'ok',
      noCompletadas: bs.noCompletadasEnIbs ? 'err' : 'ok',
      sinOrden: ind.sinOrden.comprobantes ? 'err' : 'ok',
      pendArs: pendDia.ARS.n ? 'warn' : 'ok',
      pendUsd: pendDia.USD.n ? 'warn' : 'ok',
      pendDia: nPend ? 'warn' : 'ok',
    };
  }

  // Semáforo de un lado: el color del peor indicador (rojo > amarillo > verde).
  function semaforo(ind, ladoDef) {
    const e = estados(ind, ladoDef);
    const { bs, pendDia } = ind;
    const rojos = [];
    const amarillos = [];
    for (const m of ladoDef.movs) {
      if (e.movs[m.cod] === 'err') rojos.push(`${m.cod} (${m.nombre}) no coincide con BankService`);
      else if (e.movs[m.cod] === 'warn') amarillos.push(`${m.cod} (${m.nombre}): la diferencia son pendientes o por contabilizar`);
    }
    if (e.faltantes === 'err') rojos.push(`${bs.incompletas + bs.sinRegistro} orden(es) con movimientos faltantes`);
    else if (e.faltantes === 'warn') amarillos.push(`${bs.porContabilizar} orden(es) por contabilizar`);
    if (e.sinOrden === 'err') rojos.push(`${ind.sinOrden.comprobantes} comprobante(s) de IBS que no figuran en BankService FX`);
    if (e.noCompletadas === 'err') rojos.push(`${bs.noCompletadasEnIbs} orden(es) FAILED o en revisión con movimientos en IBS`);
    if (e.conPendiente === 'warn') amarillos.push(`${bs.pendientes} orden(es) con débito pendiente`);
    if (e.pendDia === 'warn') amarillos.push(`${pendDia.ARS.n + pendDia.USD.n} débito(s) pendiente(s) del día`);
    const color = rojos.length ? 'rojo' : amarillos.length ? 'amarillo' : 'verde';
    return { color, motivos: rojos.length || amarillos.length ? [...rojos, ...amarillos] : ['Todo OK'] };
  }

  const api = { indicadores, estados, semaforo, ROJAS, AMARILLAS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.FxCalculo = api;
})(typeof window !== 'undefined' ? window : globalThis);
