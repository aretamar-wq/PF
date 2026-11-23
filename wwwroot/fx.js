'use strict';

// Dashboard "Conciliación FX": órdenes de compra / venta de dólares de BankService
// contra los movimientos 25001 a 25012 de IBS y los débitos pendientes. Los datos vienen
// ya clasificados de /api/fx/datos; acá solo se filtra, se suma (FxCalculo) y se dibuja.
// Todo texto que viene de los datos pasa por escapeHtml (app.js).
(function () {
  const C = window.FxCalculo;
  const $ = (id) => document.getElementById(id);
  const estado = { datos: null, dia: '', orden: { campo: 'tipo', asc: true }, historia: null, historiaClave: '', feriados: new Set() };

  // --- Formato (es-AR) ----------------------------------------------------------
  const fmtNum = (n) => Number(n || 0).toLocaleString('es-AR');
  const fmtImporte = (c) => (Number(c || 0) / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dinero = (moneda, c) => `${moneda === 'USD' ? 'US$' : '$'} ${fmtImporte(c)}`;
  const dmy = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  };
  const dm = (iso) => dmy(iso).slice(0, 5);
  const sumarDias = (iso, n) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const esc = (v) => escapeHtml(v == null ? '' : String(v));
  const NOMBRE_LADO = { BUY: 'Compra de USD', SELL: 'Venta de USD' };

  const tile = (titulo, valor, detalle, clase, tooltip) =>
    `<div class="tcc-tile ${clase || ''}"${tooltip ? ` title="${esc(tooltip)}"` : ''}><div class="t">${esc(titulo)}</div><div class="v">${valor}</div>${detalle ? `<div class="d">${detalle}</div>` : ''}</div>`;

  // --- Carga de BankService FX ------------------------------------------------------
  // El archivo trae nombres y otros datos del cliente que la conciliación no usa: se
  // mandan al servidor solo las columnas necesarias (además pesa ~5 veces menos).
  const COLUMNAS_FX = ['id', 'status', 'side', 'currency', 'amount', 'counterCurrency', 'counterAmount', 'price', 'receiptNumber', 'ticketNumber', 'failReason', 'failureCategory', 'createdAt', 'confirmedAt', 'settlementDate', 'customerCUIT'];
  function parseCsv(texto) {
    const filas = [];
    let fila = [];
    let campo = '';
    let comillas = false;
    for (let i = 0; i < texto.length; i++) {
      const ch = texto[i];
      if (comillas) {
        if (ch === '"') {
          if (texto[i + 1] === '"') { campo += '"'; i++; } else comillas = false;
        } else campo += ch;
      } else if (ch === '"') comillas = true;
      else if (ch === ',') { fila.push(campo); campo = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && texto[i + 1] === '\n') i++;
        fila.push(campo);
        filas.push(fila);
        fila = [];
        campo = '';
      } else campo += ch;
    }
    if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
    return filas;
  }
  function reducirCsv(texto) {
    const filas = parseCsv(texto.replace(/^\uFEFF/, ''));
    const enc = (filas[0] || []).map((h) => h.trim());
    const idx = COLUMNAS_FX.map((c) => enc.indexOf(c));
    if (idx.some((i) => i < 0)) return texto; // el servidor informa las columnas que faltan
    const celda = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    return filas.filter((f) => f.some((v) => v.trim() !== ''))
      .map((f, n) => (n === 0 ? COLUMNAS_FX : idx.map((i) => (f[i] == null ? '' : f[i]))).map(celda).join(','))
      .join('\n') + '\n';
  }

  async function cargarCsv() {
    const files = $('fxArchivos').files;
    if (!files || files.length === 0) {
      alert('Elegí al menos un CSV de FX de BankService.');
      return;
    }
    const btn = $('fxCargarBtn');
    btn.disabled = true;
    $('fxEstado').textContent = 'Cargando BankService FX...';
    try {
      const archivos = [];
      for (const f of files) archivos.push({ nombre: f.name, contenido: reducirCsv(await readFileAsText(f)) });
      const res = await apiFetch('/api/fx/bankservice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archivos }) });
      const data = await res.json();
      if (!res.ok) {
        $('fxEstado').textContent = data.error || 'No se pudo cargar.';
        return;
      }
      $('fxArchivos').value = '';
      $('fxCargaResultado').innerHTML = data.resultados.map((r) => {
        if (r.error) return `<p class="tcc-aviso">${esc(r.nombre)}: ${esc(r.error)}</p>`;
        if (r.yaCargado) return `<p class="tcc-aviso">${esc(r.nombre)}: archivo ya cargado (${esc(r.cargaPrevia.nombre)}, ${esc(r.cargaPrevia.cargado_en)}). No se procesó de nuevo.</p>`;
        const problemas = [...r.rechazos.map((x) => `Fila ${x.fila}${x.comprobante ? ` (${esc(x.comprobante)})` : ''}: rechazada, ${esc(x.motivo)}`), ...r.conflictos.map((x) => `Fila ${x.fila} (${esc(x.comprobante)}): conflicto, ${esc(x.motivo)}`)];
        return `<p>${esc(r.nombre)}: ${fmtNum(r.leidas)} leídas, ${fmtNum(r.insertadas)} insertadas, ${fmtNum(r.actualizadas)} actualizadas, ${fmtNum(r.sinCambios)} sin cambios, ${fmtNum(r.rechazadas)} rechazadas, ${fmtNum(r.conflictos.length)} conflictos.</p>` +
          (problemas.length ? `<details><summary>Ver ${problemas.length} fila(s) con problemas</summary><div class="tcc-suave">${problemas.slice(0, 500).join('<br>')}</div></details>` : '');
      }).join('');
      $('fxEstado').textContent = 'Carga terminada.';
      await cargarUltimaCarga();
    } catch (err) {
      $('fxEstado').textContent = 'Error: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  }

  async function cargarUltimaCarga() {
    try {
      const res = await apiFetch('/api/fx/cargas');
      const data = await res.json();
      if (!res.ok) {
        $('fxUltimaCarga').textContent = data.error || 'No se pudo leer la última carga de BankService FX.';
        return;
      }
      pintarUltimaCarga(data.ultimaCarga);
      estado.feriados = new Set(data.feriados || []);
      if (ajustarFechas()) pintarPeriodo();
    } catch (err) {
      $('fxUltimaCarga').textContent = 'Error leyendo la última carga de BankService FX: ' + err.message;
    }
  }

  function pintarUltimaCarga(u) {
    $('fxUltimaCarga').textContent = u
      ? `Última carga de BankService FX: ${u.nombre} · ${dmy(u.cargado_en)} ${String(u.cargado_en).slice(11, 19)} · órdenes hasta el ${u.corte ? dmy(u.corte) : '—'}`
      : 'Última carga de BankService FX: todavía no se cargó ningún archivo.';
  }

  // --- Datos ----------------------------------------------------------------------
  async function actualizar() {
    corregirFecha('fxFecha', true);
    const fecha = $('fxFecha').value;
    if (!fecha) {
      alert('Elegí la fecha a conciliar.');
      return;
    }
    const btn = $('fxActualizarBtn');
    btn.disabled = true;
    $('fxEstado').textContent = `Consultando IBS y conciliando el ${dmy(fecha)}...`;
    try {
      const res = await apiFetch(`/api/fx/datos?desde=${encodeURIComponent(fecha)}&hasta=${encodeURIComponent(sumarDias(fecha, 1))}`);
      const data = await res.json();
      if (!res.ok) {
        $('fxEstado').textContent = data.error || 'No se pudieron obtener los datos.';
        return;
      }
      estado.datos = data;
      estado.dia = fecha;
      prepararFiltros();
      pintarUltimaCarga(data.ultimaCarga);
      $('fxAvisos').innerHTML = (data.avisos || []).map((a) => `<div class="tcc-aviso">${esc(a)}</div>`).join('');
      $('fxContenido').style.display = '';
      $('fxContenidoExc').style.display = '';
      if (!$('fxPerDesde').value || $('fxPerDesde').value > fecha) $('fxPerDesde').value = fecha;
      if (!$('fxPerHasta').value || $('fxPerHasta').value < fecha) $('fxPerHasta').value = fecha;
      estado.historiaClave = '';
      $('fxEstado').textContent = `Datos al ${dmy(data.generado)} ${String(data.generado).slice(11, 19)}.`;
      pintar();
    } catch (err) {
      $('fxEstado').textContent = 'Error: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  }

  const indicadoresDe = () => estado.datos.lados.map((l) => ({ l, ind: C.indicadores(estado.datos, estado.dia, l) }));
  const excepcionesDelDia = () => indicadoresDe().flatMap(({ ind }) => ind.excepciones);

  function prepararFiltros() {
    const sel = $('fxExcTipo');
    const elegido = sel.value;
    const cuenta = new Map();
    for (const e of excepcionesDelDia()) cuenta.set(e.tipo, (cuenta.get(e.tipo) || 0) + 1);
    const tipos = [...cuenta.keys()].sort((a, b) => a.localeCompare(b, 'es'));
    sel.innerHTML = `<option value="">Todos (${fmtNum([...cuenta.values()].reduce((s, n) => s + n, 0))})</option>` +
      tipos.map((t) => `<option value="${esc(t)}">${esc(t)} (${fmtNum(cuenta.get(t))})</option>`).join('');
    sel.value = cuenta.has(elegido) ? elegido : '';
  }

  // --- Pintado ----------------------------------------------------------------------
  function htmlLado(l, ind) {
    const { bs, ibs, esperado, colores } = ind;
    const tc = bs.usd ? Math.round((bs.ars / bs.usd) * 100) : 0;
    const pendIbs = ind.pendDia;
    const est = C.estados(ind, l);
    const diferencias = bs.incompletas + bs.sinRegistro;
    return `<div class="tcc-grilla">` +
      tile('Órdenes COMPLETED en BankService', fmtNum(bs.completadas), `FAILED ${fmtNum(bs.failed)}${bs.revision ? ` · en revisión ${fmtNum(bs.revision)}` : ''}`) +
      tile('Importe en pesos', dinero('ARS', bs.ars), `${fmtNum(bs.completadas)} COMPLETED`) +
      tile('Importe en USD', dinero('USD', bs.usd), `${fmtNum(bs.completadas)} COMPLETED`) +
      tile('Tipo de cambio promedio', bs.usd ? dinero('ARS', tc) : '—', 'pesos / USD de las órdenes COMPLETED') +
      `</div><div class="tcc-grilla" style="margin-top: 10px;">` +
      l.movs.map((m) => {
        const c = colores[m.cod];
        const e = esperado[m.cod];
        const tip = `BankService espera ${fmtNum(e.n)} movimiento(s) por ${dinero(m.moneda, e.importe)}` + (e.nExplicado ? `; ${fmtNum(e.nExplicado)} por ${dinero(m.moneda, e.importeExplicado)} están en débitos pendientes o por contabilizar` : '');
        return tile(`${m.cod} ${m.nombre}`, fmtNum(ibs[m.cod].n), dinero(m.moneda, ibs[m.cod].importe), est.movs[m.cod], tip);
      }).join('') +
      `</div><div class="tcc-grilla" style="margin-top: 10px;">` +
      tile('Órdenes completas en IBS', fmtNum(bs.completas), `de ${fmtNum(bs.completadas)} COMPLETED`, est.completas) +
      tile('Órdenes con débito pendiente', fmtNum(bs.pendientes), `${dinero('ARS', bs.pendArs)} · ${dinero('USD', bs.pendUsd)}`, est.conPendiente) +
      tile('Órdenes con movimientos faltantes', fmtNum(diferencias), `${fmtNum(bs.incompletas)} incompletas · ${fmtNum(bs.sinRegistro)} sin registro en IBS${bs.porContabilizar ? ` · ${fmtNum(bs.porContabilizar)} por contabilizar` : ''}`, est.faltantes) +
      tile('FAILED o en revisión con movimientos en IBS', fmtNum(bs.noCompletadasEnIbs), `de ${fmtNum(bs.failed + bs.revision)} no COMPLETED`, est.noCompletadas) +
      `</div><div class="tcc-grilla" style="margin-top: 10px;">` +
      tile('Débitos pendientes del día en pesos', fmtNum(pendIbs.ARS.n), dinero('ARS', pendIbs.ARS.importe), est.pendArs) +
      tile('Débitos pendientes del día en USD', fmtNum(pendIbs.USD.n), dinero('USD', pendIbs.USD.importe), est.pendUsd) +
      tile('Débitos pendientes del día', fmtNum(pendIbs.ARS.n + pendIbs.USD.n), `${dinero('ARS', pendIbs.ARS.importe)} · ${dinero('USD', pendIbs.USD.importe)}`, est.pendDia, 'Débitos pendientes de IBS de las órdenes del día conciliado (el detalle de todas las fechas está en Saldo de débitos pendientes por día)') +
      tile('Movimientos manuales', fmtNum(ind.manuales), 'cargados por usuarios que no son de proceso') +
      `</div>` +
      (ind.posteriores ? `<p class="tcc-suave">Incluye ${fmtNum(ind.posteriores)} movimiento(s) imputados en fechas posteriores, sumados en el día de su orden.</p>` : '');
  }

  const ETIQUETAS = { verde: 'Verde: todo OK', amarillo: 'Amarillo: débitos pendientes o a revisar', rojo: 'Rojo: hay diferencias' };
  function pintar() {
    const d = estado.datos;
    if (!d) return;
    const lados = indicadoresDe();
    $('fxDiaTexto').textContent = `Conciliación del ${dmy(estado.dia)}: BankService por fecha de liquidación de la orden (día hábil); IBS por comprobante (receiptNumber). Mayor comprobante de IBS: ${fmtNum(d.corte.mayorComprobante)}.`;
    const t = lados.reduce((a, { ind }) => ({ n: a.n + ind.bs.completadas, ars: a.ars + ind.bs.ars, usd: a.usd + ind.bs.usd, pend: a.pend + ind.bs.pendientes, dif: a.dif + ind.bs.incompletas + ind.bs.sinRegistro }), { n: 0, ars: 0, usd: 0, pend: 0, dif: 0 });
    $('fxResumen').textContent = `${fmtNum(t.n)} órdenes COMPLETED (${dinero('ARS', t.ars)} · ${dinero('USD', t.usd)}): ${fmtNum(t.pend)} con débito pendiente y ${fmtNum(t.dif)} con movimientos faltantes en IBS.`;
    $('fxLados').innerHTML = lados.map(({ l, ind }) => {
      const s = C.semaforo(ind, l);
      const etiqueta = `${ETIQUETAS[s.color]}. ${s.motivos.join('. ')}`;
      return `<h3><span class="tcc-semaforo ${s.color}" role="img" title="${esc(`${ETIQUETAS[s.color]}\n${s.motivos.join('\n')}`)}" aria-label="${esc(etiqueta)}"></span>${esc(l.titulo)}</h3>` + htmlLado(l, ind);
    }).join('');
    pintarPeriodo();
    pintarExcepciones();
  }

  // --- Historia -------------------------------------------------------------------
  async function pintarPeriodo() {
    // El saldo de pendientes no depende del historial: se pinta siempre.
    pintarSaldo();
    const desde = $('fxPerDesde').value;
    const hasta = $('fxPerHasta').value;
    if (!desde || !hasta || desde > hasta) {
      $('fxPerAviso').textContent = desde && hasta ? 'Desde es posterior a Hasta.' : 'Elegí Desde y Hasta.';
      $('fxGrafico').innerHTML = '<p class="tcc-suave">Revisá el período.</p>';
      $('fxGraficoImporte').innerHTML = '';
      return;
    }
    $('fxPerAviso').textContent = '';
    const clave = `${desde}|${hasta}`;
    if (estado.historiaClave !== clave) {
      try {
        const res = await apiFetch(`/api/fx/historia?desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(hasta)}`);
        const data = await res.json();
        if (!res.ok) {
          $('fxPerAviso').textContent = data.error || 'No se pudo leer el historial de conciliaciones.';
          return;
        }
        estado.historia = data.dias;
        estado.historiaClave = clave;
      } catch (err) {
        $('fxPerAviso').textContent = 'Error leyendo el historial: ' + err.message;
        return;
      }
    }
    // Un registro por día y lado; el gráfico suma los lados elegidos.
    const lado = $('fxGraficoLado').value;
    const porFecha = new Map();
    for (const r of estado.historia || []) {
      if (lado && r.lado !== lado) continue;
      if (!porFecha.has(r.fecha)) porFecha.set(r.fecha, { fecha: r.fecha, completas: 0, pendientes: 0, diferencias: 0, importeUsd: 0, importeArs: 0, pendArs: 0, pendUsd: 0, lados: {}, generadoEn: r.generadoEn });
      const f = porFecha.get(r.fecha);
      f.completas += r.completas;
      f.pendientes += r.pendientes;
      f.diferencias += r.diferencias;
      f.importeUsd += r.importeUsd;
      f.importeArs += r.importeArs;
      f.pendArs += r.pendArs;
      f.pendUsd += r.pendUsd;
      f.lados[r.lado] = r;
    }
    const dias = [...porFecha.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));
    if (dias.length === 0) {
      $('fxGrafico').innerHTML = '<p class="tcc-suave">No hay días conciliados en el período.</p>';
      $('fxGraficoImporte').innerHTML = '';
      return;
    }
    const solo = $('fxSoloProblemas').checked;
    const diasGrafico = solo ? dias.filter((d) => d.pendientes > 0 || d.diferencias > 0) : dias;
    if (diasGrafico.length === 0) {
      $('fxGrafico').innerHTML = '<p class="tcc-suave">No hay días con débitos pendientes ni diferencias en el período.</p>';
      $('fxGraficoImporte').innerHTML = '';
    } else {
      grafico($('fxGrafico'), diasGrafico, SERIES_ORDENES, (v) => fmtNum(v), 'Órdenes por fecha');
      grafico($('fxGraficoImporte'), diasGrafico.map((d) => ({ ...d, compraUsd: (d.lados.BUY || {}).importeUsd || 0, ventaUsd: (d.lados.SELL || {}).importeUsd || 0 })), SERIES_IMPORTE, (v) => fmtNum(Math.round(v / 100)), 'Importe operado por fecha en USD');
    }
  }

  // Saldo de débitos pendientes: los que IBS tiene hoy en débitos pendientes (de
  // cualquier fecha), traídos en la última conciliación, agrupados por la fecha de su
  // orden en BankService (o la de origen del pendiente si no tiene orden COMPLETED).
  function pintarSaldo() {
    const d = estado.datos;
    if (!d) {
      $('fxSaldo').innerHTML = '<p class="tcc-suave">Conciliá un día para ver los débitos pendientes de IBS.</p>';
      return;
    }
    const lado = $('fxGraficoLado').value;
    const porFecha = new Map();
    for (const p of d.pendientes || []) {
      if (lado && p.lado !== lado) continue;
      const fecha = p.fecha || p.fechaOrigen || '';
      if (!porFecha.has(fecha)) porFecha.set(fecha, { fecha, BUY: 0, SELL: 0, ARS: 0, USD: 0, sinOrden: 0 });
      const f = porFecha.get(fecha);
      if (p.lado === 'BUY' || p.lado === 'SELL') f[p.lado]++;
      f[String(p.moncod) === '2' ? 'USD' : 'ARS'] += p.importe;
      if (!p.conOperacion) f.sinOrden++;
    }
    const filas = [...porFecha.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));
    if (filas.length === 0) {
      $('fxSaldo').innerHTML = `<p class="tcc-suave">IBS no tiene débitos pendientes de FX (al ${esc(dmy(d.generado))} ${esc(String(d.generado).slice(11, 16))}).</p>`;
      return;
    }
    const acum = { ARS: 0, USD: 0 };
    const tot = filas.reduce((t, f) => ({ BUY: t.BUY + f.BUY, SELL: t.SELL + f.SELL, sinOrden: t.sinOrden + f.sinOrden }), { BUY: 0, SELL: 0, sinOrden: 0 });
    $('fxSaldo').innerHTML = `<p class="tcc-suave">Débitos pendientes de IBS al ${esc(dmy(d.generado))} ${esc(String(d.generado).slice(11, 16))}, por fecha de la orden en BankService.</p>` +
      `<table><thead><tr><th>Fecha</th><th class="num">Compra de USD</th><th class="num">Venta de USD</th><th class="num">Pesos</th><th class="num">Acumulado en pesos</th><th class="num">USD</th><th class="num">Acumulado en USD</th><th class="num">Sin orden COMPLETED</th></tr></thead><tbody>` +
      filas.map((f) => {
        acum.ARS += f.ARS;
        acum.USD += f.USD;
        return `<tr class="${f.fecha === estado.dia ? 'resaltado' : ''}"><td>${f.fecha ? dmy(f.fecha) : '—'}</td><td class="num">${fmtNum(f.BUY)}</td><td class="num">${fmtNum(f.SELL)}</td>
        <td class="num">${dinero('ARS', f.ARS)}</td><td class="num">${dinero('ARS', acum.ARS)}</td>
        <td class="num">${dinero('USD', f.USD)}</td><td class="num">${dinero('USD', acum.USD)}</td><td class="num">${fmtNum(f.sinOrden)}</td></tr>`;
      }).join('') +
      `<tr><td><b>Total</b></td><td class="num"><b>${fmtNum(tot.BUY)}</b></td><td class="num"><b>${fmtNum(tot.SELL)}</b></td><td class="num"><b>${dinero('ARS', acum.ARS)}</b></td><td></td><td class="num"><b>${dinero('USD', acum.USD)}</b></td><td></td><td class="num"><b>${fmtNum(tot.sinOrden)}</b></td></tr></tbody></table>` +
      htmlDetallePendientes(lado);
  }

  // Detalle: cada débito pendiente de IBS con su orden de BankService.
  function htmlDetallePendientes(lado) {
    const d = estado.datos;
    const nombreMov = new Map(d.lados.flatMap((l) => l.movs.map((m) => [m.cod, m.nombre])));
    const ordenDe = new Map(d.ordenes.filter((o) => o.comprobante).map((o) => [o.comprobante, o]));
    const filas = (d.pendientes || []).filter((p) => !lado || p.lado === lado)
      .sort((a, b) => String(a.fechaOrigen).localeCompare(String(b.fechaOrigen)) || (Number(a.comprobante) || 0) - (Number(b.comprobante) || 0));
    return `<h4>Detalle de los débitos pendientes (${fmtNum(filas.length)})</h4>` +
      `<table><thead><tr><th>Fecha origen</th><th class="num">Comprobante</th><th>Operación</th><th>Movimiento</th><th class="num">Cuenta</th><th>Moneda</th><th class="num">Importe</th><th>Fecha orden BS</th><th>Estado BankService</th><th>CUIT</th><th>Motivo</th></tr></thead><tbody>` +
      filas.map((p) => {
        const o = ordenDe.get(p.comprobante);
        const moneda = String(p.moncod) === '2' ? 'USD' : 'ARS';
        return `<tr class="${o && o.fecha === estado.dia ? 'resaltado' : ''}"><td>${esc(dmy(p.fechaOrigen) || '—')}</td><td class="num">${esc(p.comprobante)}</td><td>${esc(NOMBRE_LADO[p.lado] || '—')}</td>
        <td>${esc(p.movcod)} ${esc(nombreMov.get(p.movcod) || '')}</td><td class="num">${esc(p.cuecod)}</td><td>${moneda}</td><td class="num">${esc(dinero(moneda, p.importe))}</td>
        <td>${o ? esc(dmy(o.fecha)) : '—'}</td><td>${o ? esc(o.status) : 'Sin orden'}</td><td class="mono">${o ? esc(o.cuit || '—') : '—'}</td><td class="detalle">${esc(p.motivo || '—')}</td></tr>`;
      }).join('') + '</tbody></table>';
  }

  const SERIES_ORDENES = [
    { campo: 'completas', nombre: 'Completas en IBS', color: 'var(--tcc-s1)' },
    { campo: 'pendientes', nombre: 'Con débito pendiente', color: 'var(--tcc-s2)' },
    { campo: 'diferencias', nombre: 'Con diferencias', color: 'var(--tcc-s3)' },
  ];
  const SERIES_IMPORTE = [
    { campo: 'compraUsd', nombre: 'Compra de USD', color: 'var(--tcc-s1)', importe: true },
    { campo: 'ventaUsd', nombre: 'Venta de USD', color: 'var(--tcc-s2)', importe: true },
  ];

  // Barras apiladas por fecha (SVG). fmt: etiqueta del eje.
  function grafico(box, filas, series, fmt, titulo) {
    const W = Math.max(box.clientWidth - 16, 320);
    const H = 220;
    const m = { izq: 64, der: 8, arr: 10, aba: 26 };
    const ancho = (W - m.izq - m.der) / filas.length;
    const max = Math.max(1, ...filas.map((f) => series.reduce((s, x) => s + (f[x.campo] || 0), 0)));
    const y = (v) => m.arr + (H - m.arr - m.aba) * (1 - v / max);
    const paso = Math.max(1, Math.ceil(38 / ancho));
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(titulo)}">`;
    for (let i = 0; i <= 4; i++) {
      const v = (max * i) / 4;
      svg += `<line x1="${m.izq}" x2="${W - m.der}" y1="${y(v)}" y2="${y(v)}" stroke="var(--tcc-borde)" stroke-width="1"/><text x="${m.izq - 6}" y="${y(v) + 3}" text-anchor="end">${fmt(v)}</text>`;
    }
    filas.forEach((f, i) => {
      const x = m.izq + i * ancho + ancho * 0.12;
      const w = Math.max(ancho * 0.76, 1);
      let base = 0;
      for (const s of series) {
        const v = f[s.campo];
        if (!v) continue;
        svg += `<rect class="barra" data-fecha="${f.fecha}" x="${x}" y="${y(base + v)}" width="${w}" height="${y(base) - y(base + v)}" fill="${s.color}"${f.fecha === estado.dia ? ' stroke="var(--tcc-texto)" stroke-width="1.5"' : ''}/>`;
        base += v;
      }
      if (i % paso === 0) svg += `<text x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${dm(f.fecha)}</text>`;
    });
    svg += '</svg>';
    box.innerHTML = svg + '<div class="tcc-tooltip"></div><div class="tcc-leyenda">' + series.map((s) => `<span><i style="background:${s.color}"></i>${s.nombre}</span>`).join('') + '</div>';
    const tip = box.querySelector('.tcc-tooltip');
    const porFecha = new Map(filas.map((f) => [f.fecha, f]));
    box.querySelectorAll('rect.barra').forEach((r) => {
      r.addEventListener('mousemove', (ev) => {
        const f = porFecha.get(r.dataset.fecha);
        tip.innerHTML = `<b>${dmy(f.fecha)}</b><br>` + series.map((s) => `${s.nombre}: ${s.importe ? dinero('USD', f[s.campo]) : fmtNum(f[s.campo])}`).join('<br>') + (f.generadoEn ? `<br>Conciliado: ${dmy(f.generadoEn)} ${String(f.generadoEn).slice(11, 16)}` : '');
        const rect = box.getBoundingClientRect();
        tip.style.left = `${Math.min(ev.clientX - rect.left + 12, rect.width - 180)}px`;
        tip.style.top = `${ev.clientY - rect.top + 12}px`;
        tip.style.display = 'block';
      });
      r.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
      r.addEventListener('click', () => clicEnDia(r.dataset.fecha));
    });
  }

  function clicEnDia(dia) {
    if (!esHabil(dia)) {
      $('fxPerAviso').textContent = `El ${dmy(dia)} ${motivoNoHabil(dia)}: no se puede elegir.`;
      return;
    }
    $('fxFecha').value = dia;
    $('fxPerAviso').textContent = `Fecha a conciliar: ${dmy(dia)}. Apretá Conciliar para ver su detalle.`;
  }

  // --- Excepciones ----------------------------------------------------------------
  const PALETA = ['#1f4e8c', '#b42318', '#d9822b', '#2e9d6b', '#7a5af8', '#0e9384', '#c4320a', '#667085', '#dd2590', '#4e9f3d', '#9e77ed', '#ca8504', '#155eef'];
  const colorTipo = (tipo) => {
    let h = 0;
    for (const ch of String(tipo)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETA[h % PALETA.length];
  };

  function excepcionesVisibles() {
    const lista = excepcionesDelDia();
    const tipo = $('fxExcTipo').value;
    const lado = $('fxExcLado').value;
    const q = $('fxExcBuscar').value.trim().toLowerCase();
    let filas = lista.filter((e) => (!tipo || e.tipo === tipo) && (!lado || e.lado === lado));
    if (q) filas = filas.filter((e) => [e.comprobante, e.cuit, e.cuenta, e.moneda, dmy(e.fecha), e.fecha, e.detalle].some((v) => String(v || '').toLowerCase().includes(q)));
    const { campo, asc } = estado.orden;
    const numericos = ['comprobante', 'cuenta', 'importe'];
    filas.sort((a, b) => {
      let r = numericos.includes(campo) ? (Number(a[campo]) || 0) - (Number(b[campo]) || 0) : String(a[campo] || '').localeCompare(String(b[campo] || ''), 'es');
      if (r === 0) r = (Number(a.comprobante) || 0) - (Number(b.comprobante) || 0);
      return asc ? r : -r;
    });
    return { filas, total: lista.length };
  }

  function pintarExcepciones() {
    if (!estado.datos) return;
    const { filas, total } = excepcionesVisibles();
    const { campo, asc } = estado.orden;
    $('fxExcCuenta').textContent = `${fmtNum(filas.length)} de ${fmtNum(total)} excepciones`;
    $('fxExc').querySelector('tbody').innerHTML = filas.slice(0, 5000).map((e) => `<tr>
      <td><span class="tcc-pill" style="background:${colorTipo(e.tipo)}">${esc(e.tipo)}</span></td><td>${esc(NOMBRE_LADO[e.lado] || e.lado || '—')}</td>
      <td class="num">${esc(e.comprobante)}</td><td class="num">${esc(e.cuenta || '—')}</td><td class="mono">${esc(e.cuit || '—')}</td><td>${esc(e.moneda)}</td>
      <td>${esc(dmy(e.fecha))}</td><td class="num">${e.importe == null ? '—' : esc(dinero(e.moneda, e.importe))}</td>
      <td>${esc(e.usuario || '—')}</td><td>${esc(e.estadoBs || '—')}</td><td class="detalle">${esc(e.detalle)}</td></tr>`).join('');
    document.querySelectorAll('#fxExc th.ordenable').forEach((th) => {
      th.textContent = th.textContent.replace(/ [▲▼]$/, '') + (th.dataset.orden === campo ? (asc ? ' ▲' : ' ▼') : '');
    });
  }

  function exportarExcepciones() {
    if (!estado.datos) return;
    const { filas } = excepcionesVisibles();
    if (filas.length === 0) {
      alert('No hay excepciones para exportar con los filtros actuales.');
      return;
    }
    const lineas = [csvExcelLine(['Tipo', 'Operación', 'Comprobante', 'Cuenta', 'CUIT', 'Moneda', 'Fecha', 'Importe', 'Usuario', 'Estado BankService', 'Detalle'])];
    for (const e of filas) {
      lineas.push(csvExcelLine([e.tipo, NOMBRE_LADO[e.lado] || e.lado, e.comprobante, e.cuenta, e.cuit, e.moneda, dmy(e.fecha), e.importe == null ? '' : (e.importe / 100).toFixed(2).replace('.', ','), e.usuario, e.estadoBs, e.detalle]));
    }
    downloadCsvExcel(`excepciones-fx-${estado.dia}.csv`, lineas);
  }

  async function descargarPdf() {
    if (!estado.datos) return;
    const btn = $('fxPdfBtn');
    btn.disabled = true;
    $('fxEstado').textContent = 'Generando el reporte PDF...';
    try {
      const res = await apiFetch(`/api/fx/reporte?dia=${encodeURIComponent(estado.dia)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        $('fxEstado').textContent = data.error || 'No se pudo generar el reporte.';
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.headers.get('x-reporte-nombre') || 'conciliacion-fx.pdf';
      a.click();
      URL.revokeObjectURL(url);
      $('fxEstado').textContent = `Reporte generado (SHA-256 ${res.headers.get('x-reporte-sha256') || '—'}); queda una copia en el servidor.`;
    } catch (err) {
      $('fxEstado').textContent = 'Error: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  }

  // --- Días hábiles -------------------------------------------------------------------
  const esHabil = (iso) => {
    const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
    return d !== 0 && d !== 6 && !estado.feriados.has(iso);
  };
  function diaHabil(iso, paso) {
    let f = iso;
    for (let i = 0; i < 30 && !esHabil(f); i++) f = sumarDias(f, paso);
    return f;
  }
  const CAMPOS_FECHA = { fxFecha: -1, fxPerDesde: 1, fxPerHasta: -1 };
  function motivoNoHabil(iso) {
    if (estado.feriados.has(iso)) return 'es feriado';
    return new Date(`${iso}T00:00:00Z`).getUTCDay() === 6 ? 'es sábado' : 'es domingo';
  }
  function corregirFecha(id, avisar) {
    const el = $(id);
    if (!el.value || esHabil(el.value)) return false;
    const antes = el.value;
    el.value = diaHabil(antes, CAMPOS_FECHA[id]);
    if (avisar) $('fxEstado').textContent = `El ${dmy(antes)} ${motivoNoHabil(antes)}: se tomó el ${dmy(el.value)}.`;
    return true;
  }
  function ajustarFechas() {
    let periodo = false;
    for (const id of Object.keys(CAMPOS_FECHA)) if (corregirFecha(id, false) && id.startsWith('fxPer')) periodo = true;
    return periodo;
  }

  // --- Eventos ----------------------------------------------------------------------
  function abrir() {
    const hoy = formatDateOnlyLocal(new Date());
    $('fxFecha').value = sumarDias(hoy, -1);
    if (!$('fxPerHasta').value) $('fxPerHasta').value = hoy;
    if (!$('fxPerDesde').value) $('fxPerDesde').value = sumarDias(hoy, -30);
    ajustarFechas();
    showMainSection('fxSection');
    cargarUltimaCarga();
    pintarPeriodo();
  }

  $('fxBtn').addEventListener('click', abrir);
  $('fxCerrarBtn').addEventListener('click', () => showMainSection('flowDetail'));
  $('fxCargarBtn').addEventListener('click', cargarCsv);
  $('fxActualizarBtn').addEventListener('click', actualizar);
  $('fxFecha').addEventListener('change', () => corregirFecha('fxFecha', true));
  $('fxPerDesde').addEventListener('change', () => {
    corregirFecha('fxPerDesde', true);
    pintarPeriodo();
  });
  $('fxPerHasta').addEventListener('change', () => {
    corregirFecha('fxPerHasta', true);
    pintarPeriodo();
  });
  $('fxSoloProblemas').addEventListener('change', pintarPeriodo);
  $('fxGraficoLado').addEventListener('change', pintarPeriodo);
  $('fxExcTipo').addEventListener('change', pintarExcepciones);
  $('fxExcLado').addEventListener('change', pintarExcepciones);
  $('fxExcBuscar').addEventListener('input', pintarExcepciones);
  $('fxExcCsvBtn').addEventListener('click', exportarExcepciones);
  $('fxPdfBtn').addEventListener('click', descargarPdf);
  document.querySelectorAll('#fxExc th.ordenable').forEach((th) => th.addEventListener('click', () => {
    const campo = th.dataset.orden;
    estado.orden = { campo, asc: estado.orden.campo === campo ? !estado.orden.asc : true };
    pintarExcepciones();
  }));
})();
