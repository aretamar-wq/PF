'use strict';

// Cálculos de la "Conciliación FX" sobre los datos clasificados por el servidor
// (node/lib/fx/conciliar.js). Corre en el navegador y en Node. Importes en centavos.
(function (raiz) {
  const ROJAS = ['Faltan movimientos en IBS', 'Movimiento duplicado', 'Importe distinto', 'COMPLETED sin registro en IBS', 'Movimiento de otro tipo de operación', 'Operación FAILED con movimientos en IBS', 'Operación en revisión manual con movimientos en IBS', 'Movimiento sin operación en BankService', 'Pendiente sin operación COMPLETED'];
  const AMARILLAS = ['Débito pendiente', 'Por contabilizar', 'Operación en revisión manual'];

  // Indicadores de un lado (BUY / SELL) para el día (fecha de la orden en BankService).
  function indicadores(datos, dia, ladoDef) {
    const lado = ladoDef.lado;
    const ok = (f) => !dia || f === dia;
    const ordenes = datos.ordenes.filter((o) => o.side === lado && ok(o.fecha));
    const bs = { completadas: 0, ars: 0, usd: 0, completas: 0, pendientes: 0, incompletas: 0, sinRegistro: 0, porContabilizar: 0, failed: 0, revision: 0, noCompletadasEnIbs: 0, pendArs: 0, pendUsd: 0 };
    // Por movimiento: lo que BankService espera y lo que falta "con explicación" (pendiente o por contabilizar).
    const esperado = {};
    for (const m of ladoDef.movs) esperado[m.cod] = { n: 0, importe: 0, nExplicado: 0, importeExplicado: 0 };
    for (const o of ordenes) {
      if (o.status === 'FAILED') bs.failed++;
      else if (o.status !== 'COMPLETED') bs.revision++;
      if (o.clase === 'noCompletadaEnIbs') bs.noCompletadasEnIbs++;
      if (o.status !== 'COMPLETED') continue;
      bs.completadas++;
      bs.ars += o.ars;
      bs.usd += o.usd;
      if (o.clase === 'completa') bs.completas++;
      else if (o.clase === 'pendiente') { bs.pendientes++; bs.pendArs += o.pendienteArs || 0; bs.pendUsd += o.pendienteUsd || 0; }
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
    for (const m of datos.movimientos) {
      // Manuales: todos los del lado en el día (tengan o no orden en BankService).
      if (m.lado === lado && m.manual && ok(m.fechaFiltro || m.fecha)) manuales++;
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
    return { lado, bs, ibs, esperado, colores, pendientes, manuales, posteriores, excepciones };
  }

  // Semáforo de un lado: el más crítico entre excepciones e indicadores.
  function semaforo(ind, ladoDef) {
    const cuenta = {};
    for (const e of ind.excepciones) cuenta[e.tipo] = (cuenta[e.tipo] || 0) + 1;
    const rojos = Object.entries(cuenta).filter(([t]) => ROJAS.includes(t)).map(([t, n]) => `${n} ${t}`);
    const amarillos = Object.entries(cuenta).filter(([t]) => AMARILLAS.includes(t)).map(([t, n]) => `${n} ${t}`);
    for (const m of ladoDef.movs) {
      const c = ind.colores[m.cod];
      if (c.n === 'err' || c.importe === 'err') rojos.push(`${m.cod} (${m.nombre}) no coincide con BankService`);
      else if (c.n === 'warn' || c.importe === 'warn') amarillos.push(`${m.cod} (${m.nombre}): la diferencia son pendientes`);
    }
    const color = rojos.length ? 'rojo' : amarillos.length ? 'amarillo' : 'verde';
    return { color, motivos: rojos.length || amarillos.length ? [...rojos, ...amarillos] : ['Todo OK'] };
  }

  const api = { indicadores, semaforo, ROJAS, AMARILLAS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.FxCalculo = api;
})(typeof window !== 'undefined' ? window : globalThis);
