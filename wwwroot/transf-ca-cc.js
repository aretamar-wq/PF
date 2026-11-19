'use strict';

// Dashboard "Conciliación Transferencias CA -> CC". Los datos vienen ya
// clasificados de /api/transf-ca-cc/datos (IBS + pendientes + BankService de la
// base); acá solo se filtra, se suma (TransfCaCcCalculo) y se dibuja. Todo texto que
// viene de los datos pasa por escapeHtml (app.js).
(function () {
  const C = window.TransfCaCcCalculo;
  const $ = (id) => document.getElementById(id);
  const estado = { datos: null, dia: '', orden: { campo: 'fecha', asc: true } };

  // --- Formato (es-AR) ----------------------------------------------------------
  const fmtNum = (n) => Number(n || 0).toLocaleString('es-AR');
  const fmtImporte = (c) => (Number(c || 0) / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const simbolo = (moncod) => (String(moncod) === '2' || moncod === 'USD' ? 'US$' : '$');
  const dinero = (moncod, c) => `${simbolo(moncod)} ${fmtImporte(c)}`;
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

  const tile = (titulo, valor, detalle, clase, tooltip) =>
    `<div class="tcc-tile ${clase || ''}"${tooltip ? ` title="${esc(tooltip)}"` : ''}><div class="t">${esc(titulo)}</div><div class="v">${valor}</div>${detalle ? `<div class="d">${detalle}</div>` : ''}</div>`;
  const porMoneda = (o) => `Pesos ${fmtNum(o[0])} · USD ${fmtNum(o[2])}`;

  // --- Carga de BankService -------------------------------------------------------
  async function cargarCsv() {
    const files = $('tccArchivos').files;
    if (!files || files.length === 0) {
      alert('Elegí al menos un CSV de BankService.');
      return;
    }
    const btn = $('tccCargarBtn');
    btn.disabled = true;
    $('tccEstado').textContent = 'Cargando BankService...';
    try {
      const archivos = [];
      for (const f of files) archivos.push({ nombre: f.name, contenido: await readFileAsText(f) });
      const res = await apiFetch('/api/transf-ca-cc/bankservice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archivos }) });
      const data = await res.json();
      if (!res.ok) {
        $('tccEstado').textContent = data.error || 'No se pudo cargar.';
        return;
      }
      $('tccArchivos').value = '';
      $('tccCargasBox').open = true;
      $('tccCargaResultado').innerHTML = data.resultados.map((r) => {
        if (r.error) return `<p class="tcc-aviso">${esc(r.nombre)}: ${esc(r.error)}</p>`;
        if (r.yaCargado) return `<p class="tcc-aviso">${esc(r.nombre)}: archivo ya cargado (${esc(r.cargaPrevia.nombre)}, ${esc(r.cargaPrevia.cargado_en)}). No se procesó de nuevo.</p>`;
        const problemas = [...r.rechazos.map((x) => `Fila ${x.fila}${x.comprobante ? ` (comprobante ${esc(x.comprobante)})` : ''}: rechazada, ${esc(x.motivo)}`), ...r.conflictos.map((x) => `Fila ${x.fila} (comprobante ${esc(x.comprobante)}): conflicto, ${esc(x.motivo)}`)];
        return `<p>${esc(r.nombre)}: ${fmtNum(r.leidas)} leídas, ${fmtNum(r.insertadas)} insertadas, ${fmtNum(r.actualizadas)} actualizadas, ${fmtNum(r.sinCambios)} sin cambios, ${fmtNum(r.rechazadas)} rechazadas, ${fmtNum(r.conflictos.length)} conflictos.</p>` +
          (problemas.length ? `<details><summary>Ver ${problemas.length} fila(s) con problemas</summary><div class="tcc-suave">${problemas.slice(0, 500).join('<br>')}</div></details>` : '');
      }).join('');
      $('tccEstado').textContent = 'Carga terminada.';
      await cargarHistorial();
    } catch (err) {
      $('tccEstado').textContent = 'Error: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  }

  async function cargarHistorial() {
    try {
      const res = await apiFetch('/api/transf-ca-cc/cargas');
      const data = await res.json();
      if (!res.ok) {
        $('tccUltimaCarga').textContent = data.error || 'No se pudo leer el historial de cargas.';
        return;
      }
      pintarUltimaCarga(data.ultimaCarga);
      $('tccCargas').querySelector('tbody').innerHTML = data.cargas.map((c) => `<tr>
        <td class="num">${esc(c.id)}</td><td>${esc(c.nombre)}</td><td>${esc(dmy(c.cargado_en))} ${esc(String(c.cargado_en).slice(11, 19))}</td><td>${esc(c.cargado_por)}</td>
        <td class="num">${fmtNum(c.filas_leidas)}</td><td class="num">${fmtNum(c.insertadas)}</td><td class="num">${fmtNum(c.actualizadas)}</td><td class="num">${fmtNum(c.sin_cambios)}</td>
        <td class="num">${fmtNum(c.rechazadas)}</td><td class="num">${fmtNum(c.conflictos)}</td><td>${esc(dmy(c.fecha_min))}</td><td>${esc(dmy(c.fecha_max))}</td>
        <td>${c.rechazadas || c.conflictos ? `<button type="button" data-tcc-carga="${esc(c.id)}">Detalle</button>` : ''}</td></tr>`).join('');
    } catch (err) {
      $('tccUltimaCarga').textContent = 'Error leyendo el historial de cargas: ' + err.message;
    }
  }

  async function detalleCarga(id) {
    const res = await apiFetch(`/api/transf-ca-cc/cargas?id=${encodeURIComponent(id)}`);
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'No se pudo leer el detalle.');
    const lineas = [...(data.rechazos || []).map((x) => `Fila ${x.fila}${x.comprobante ? ` (comprobante ${esc(x.comprobante)})` : ''}: rechazada, ${esc(x.motivo)}`), ...(data.conflictos || []).map((x) => `Fila ${x.fila} (comprobante ${esc(x.comprobante)}): conflicto, ${esc(x.motivo)}`)];
    $('tccCargaResultado').innerHTML = `<p>Carga #${esc(id)}:</p><div class="tcc-suave">${lineas.join('<br>') || 'Sin problemas.'}</div>`;
  }

  function pintarUltimaCarga(u) {
    $('tccUltimaCarga').textContent = u
      ? `Última carga de BankService: ${u.nombre} · ${dmy(u.cargado_en)} ${String(u.cargado_en).slice(11, 19)} · corte (mayor Ejecutada): ${u.corte ? `${dmy(u.corte)} ${String(u.corte).slice(11, 19)}` : '—'}`
      : 'Última carga de BankService: todavía no se cargó ningún archivo.';
  }

  // --- Datos ----------------------------------------------------------------------
  async function actualizar() {
    const desde = $('tccIbsDesde').value;
    const hastaIncl = $('tccIbsHasta').value;
    if (!desde || !hastaIncl || desde > hastaIncl) {
      alert('Elegí el período de IBS (desde y hasta, con desde anterior o igual a hasta).');
      return;
    }
    const btn = $('tccActualizarBtn');
    btn.disabled = true;
    $('tccEstado').textContent = 'Consultando IBS y conciliando...';
    try {
      const res = await apiFetch(`/api/transf-ca-cc/datos?desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(sumarDias(hastaIncl, 1))}`);
      const data = await res.json();
      if (!res.ok) {
        $('tccEstado').textContent = data.error || 'No se pudieron obtener los datos.';
        return;
      }
      estado.datos = data;
      estado.dia = data.corte.ultimoDiaIbs || '';
      prepararFiltros();
      pintarUltimaCarga(data.ultimaCarga);
      $('tccAvisos').innerHTML = (data.avisos || []).map((a) => `<div class="tcc-aviso">${esc(a)}</div>`).join('');
      $('tccContenido').style.display = '';
      $('tccEstado').textContent = `Datos al ${dmy(data.generado)} ${String(data.generado).slice(11, 19)}.`;
      pintar();
    } catch (err) {
      $('tccEstado').textContent = 'Error: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  }

  function rangoFechas() {
    const d = estado.datos;
    const fechas = [...d.movimientos.map((m) => m.fecha), ...d.operaciones.map((o) => o.fecha)].filter(Boolean).sort();
    return { min: fechas[0] || '', max: fechas[fechas.length - 1] || '' };
  }

  function prepararFiltros() {
    const { min, max } = rangoFechas();
    for (const id of ['tccDia', 'tccPerDesde', 'tccPerHasta']) {
      $(id).min = min;
      $(id).max = max;
    }
    $('tccDia').value = estado.dia;
    $('tccPerDesde').value = min;
    $('tccPerHasta').value = max;
    const tipos = [...new Set(estado.datos.excepciones.map((e) => e.tipo))].sort((a, b) => a.localeCompare(b, 'es'));
    $('tccExcTipo').innerHTML = '<option value="">Todos</option>' + tipos.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  }

  // --- Pintado ----------------------------------------------------------------------
  function pintar() {
    const d = estado.datos;
    if (!d) return;
    const ind = C.indicadores(d, estado.dia);
    const { ibs, activar, bs, total } = ind;
    $('tccDiaTexto').textContent = estado.dia
      ? `Mostrando el ${dmy(estado.dia)}${estado.dia === d.corte.ultimoDiaIbs ? ' (último día de IBS)' : ''}. IBS por fecha del movimiento; BankService por fecha de la operación. Corte: último día de IBS ${dmy(d.corte.ultimoDiaIbs)}, mayor comprobante ${fmtNum(d.corte.mayorComprobante)}.`
      : `Mostrando todos los días (${dmy(d.rango.desde)} al ${dmy(sumarDias(d.rango.hasta, -1))}). Corte: último día de IBS ${dmy(d.corte.ultimoDiaIbs)}, mayor comprobante ${fmtNum(d.corte.mayorComprobante)}.`;

    $('tccResumen').textContent = `${fmtNum(total(bs.pendientes))} operación(es) con débito pendiente (${fmtNum(total(bs.pendientesUltimoDia))} del último día y ${fmtNum(total(bs.pendientesAnteriores))} anteriores), ` +
      `${fmtNum(total(bs.sinRegistro))} sin registro en IBS y ${fmtNum(total(bs.porContabilizar))} pendientes de contabilizar. Importe pendiente: ${dinero('0', bs.importePendiente[0])} y ${dinero('2', bs.importePendiente[2])}.`;

    $('tccIbs').innerHTML =
      `<div class="tcc-grilla">` +
      tile('Comprobantes en IBS (sin los de 1 centavo)', fmtNum(total(ibs.comprobantes)), porMoneda(ibs.comprobantes)) +
      tile('Débitos 25030', fmtNum(total(ibs.debitos)), porMoneda(ibs.debitos)) +
      tile('Créditos 25031 (sin los de 1 centavo)', fmtNum(total(ibs.creditos)), porMoneda(ibs.creditos)) +
      tile('Débitos pendientes', fmtNum(total(ibs.pendientes)), porMoneda(ibs.pendientes)) +
      `</div><div class="tcc-grilla" style="margin-top: 10px;">` +
      tile('Débitos en pesos', dinero('0', ibs.saldoDebitos[0])) +
      tile('Créditos 25031 en pesos', dinero('0', ibs.saldoCreditos[0])) +
      tile('Débitos pendientes en pesos', dinero('0', ibs.saldoPendientes[0])) +
      `</div><div class="tcc-grilla" style="margin-top: 10px;">` +
      tile('Débitos en USD', dinero('2', ibs.saldoDebitos[2])) +
      tile('Créditos 25031 en USD', dinero('2', ibs.saldoCreditos[2])) +
      tile('Débitos pendientes en USD', dinero('2', ibs.saldoPendientes[2])) +
      `</div><div class="tcc-grilla" style="margin-top: 10px;">` +
      tile('Débitos manuales en pesos', fmtNum(ibs.manuales[0]), dinero('0', ibs.importeManuales[0])) +
      tile('Débitos manuales en USD', fmtNum(ibs.manuales[2]), dinero('2', ibs.importeManuales[2])) +
      `</div>` +
      (total(ibs.posteriores) ? `<p class="tcc-suave">Incluye ${fmtNum(total(ibs.posteriores))} movimiento(s) imputados en fechas posteriores al período (${porMoneda(ibs.posteriores)}), sumados en el día de su operación.</p>` : '');

    $('tccActivar').innerHTML = `<div class="tcc-grilla">` +
      tile('Transacciones de 1 centavo (comprobantes)', fmtNum(total(activar.comprobantes)), porMoneda(activar.comprobantes)) +
      tile('Créditos de 1 centavo', fmtNum(total(activar.creditos)), porMoneda(activar.creditos)) +
      tile('Débitos de 1 centavo', fmtNum(total(activar.debitos)), porMoneda(activar.debitos)) +
      `</div><p class="tcc-suave">${fmtNum(activar.sinOperacion)} movimiento(s) de 1 centavo sin operación en BankService: se informan acá y no cuentan en los indicadores de transferencias.</p>`;

    const sinReg = total(bs.sinRegistro);
    $('tccBs').innerHTML = `<div class="tcc-linea">` +
      tile('Operaciones en BankService (APPROVED)', fmtNum(total(bs.aprobadas)), porMoneda(bs.aprobadas)) +
      tile('Operaciones en IBS', fmtNum(total(bs.ejecutadas)), porMoneda(bs.ejecutadas)) +
      tile('Operaciones con débito pendiente', fmtNum(total(bs.pendientes)), porMoneda(bs.pendientes)) +
      tile('APPROVED que no figuran en IBS ni en pendientes', fmtNum(sinReg), `${porMoneda(bs.sinRegistro)}${total(bs.porContabilizar) ? ` · ${fmtNum(total(bs.porContabilizar))} pendientes de contabilizar` : ''}`, sinReg === 0 ? 'ok' : 'err') +
      tile('Operaciones FAILED en BS que figuran en IBS', fmtNum(bs.failedEnIbs), `de ${fmtNum(bs.failed)} operaciones FAILED en BankService`, bs.failedEnIbs === 0 ? 'ok' : 'err') +
      `</div>` +
      `<div class="tcc-control ${bs.control.diferencia === 0 ? 'ok' : 'err'}" title="${esc(`Diferencia: ${fmtNum(bs.control.diferencia)}`)}">Control: ${fmtNum(bs.control.aprobadas)} operaciones en BankService ${bs.control.diferencia === 0 ? '=' : '≠'} ${fmtNum(total(bs.ejecutadas))} ejecutadas + ${fmtNum(total(bs.pendientes))} con débito pendiente + ${fmtNum(sinReg)} sin registro + ${fmtNum(total(bs.porContabilizar))} pendientes de contabilizar (${fmtNum(bs.control.suma)}).</div>`;

    const sem = C.semaforos(ind);
    const etiquetas = { verde: 'Verde: todo OK', amarillo: 'Amarillo: débitos pendientes o a revisar', rojo: 'Rojo: hay diferencias' };
    for (const [id, s] of [['tccSemIbs', sem.ibs], ['tccSemActivar', sem.activar], ['tccSemBs', sem.bs]]) {
      $(id).className = `tcc-semaforo ${s.color}`;
      $(id).title = `${etiquetas[s.color]}\n${s.motivos.join('\n')}`;
      $(id).setAttribute('aria-label', `${etiquetas[s.color]}. ${s.motivos.join('. ')}`);
    }
    pintarPeriodo();
    pintarExcepciones(ind.excepciones);
  }

  function pintarPeriodo() {
    const desde = $('tccPerDesde').value;
    const hasta = $('tccPerHasta').value;
    if (desde && hasta && desde > hasta) {
      $('tccPerAviso').textContent = 'Desde es posterior a Hasta.';
      $('tccGrafico').innerHTML = '<p class="tcc-suave">Revisá el período.</p>';
      $('tccSaldo').innerHTML = '';
      return;
    }
    $('tccPerAviso').textContent = '';
    const { grafico, saldo } = C.porDia(estado.datos, desde, hasta);
    pintarGrafico(grafico);
    if (saldo.length === 0) {
      $('tccSaldo').innerHTML = '<p class="tcc-suave">No hay débitos pendientes en el período.</p>';
      return;
    }
    $('tccSaldo').innerHTML = `<table><thead><tr><th>Fecha</th><th class="num">Operaciones en pesos</th><th class="num">Pesos</th><th class="num">Acumulado en pesos</th><th class="num">Operaciones en USD</th><th class="num">USD</th><th class="num">Acumulado en USD</th></tr></thead><tbody>` +
      saldo.map((s) => `<tr class="${s.fecha === estado.dia ? 'resaltado' : ''}"><td>${dmy(s.fecha)}</td>
        <td class="num">${fmtNum(s.nPend[0])}</td><td class="num">${dinero('0', s.importePend[0])}</td><td class="num">${dinero('0', s.acumulado[0])}</td>
        <td class="num">${fmtNum(s.nPend[2])}</td><td class="num">${dinero('2', s.importePend[2])}</td><td class="num">${dinero('2', s.acumulado[2])}</td></tr>`).join('') +
      '</tbody></table>';
  }

  const SERIES = [
    { campo: 'ejecutadas', nombre: 'Con débito en IBS', color: 'var(--tcc-s1)' },
    { campo: 'pendientes', nombre: 'Con débito pendiente', color: 'var(--tcc-s2)' },
    { campo: 'sinRegistro', nombre: 'Sin registro', color: 'var(--tcc-s3)' },
  ];

  function pintarGrafico(filas) {
    const box = $('tccGrafico');
    if (filas.length === 0) {
      box.innerHTML = '<p class="tcc-suave">No hay operaciones en el período.</p>';
      return;
    }
    const W = Math.max(box.clientWidth - 16, 320);
    const H = 240;
    const m = { izq: 48, der: 8, arr: 10, aba: 26 };
    const ancho = (W - m.izq - m.der) / filas.length;
    const max = Math.max(1, ...filas.map((f) => f.ejecutadas + f.pendientes + f.sinRegistro));
    const y = (v) => m.arr + (H - m.arr - m.aba) * (1 - v / max);
    // Etiquetas dd/mm sin superponerse: una cada `paso` barras (~38 px por etiqueta).
    const paso = Math.max(1, Math.ceil(38 / ancho));
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Operaciones por fecha">`;
    for (let i = 0; i <= 4; i++) {
      const v = Math.round((max * i) / 4);
      svg += `<line x1="${m.izq}" x2="${W - m.der}" y1="${y(v)}" y2="${y(v)}" stroke="var(--tcc-borde)" stroke-width="1"/><text x="${m.izq - 6}" y="${y(v) + 3}" text-anchor="end">${fmtNum(v)}</text>`;
    }
    filas.forEach((f, i) => {
      const x = m.izq + i * ancho + ancho * 0.12;
      const w = Math.max(ancho * 0.76, 1);
      let base = 0;
      for (const s of SERIES) {
        const v = f[s.campo];
        if (!v) continue;
        svg += `<rect class="barra" data-fecha="${f.fecha}" x="${x}" y="${y(base + v)}" width="${w}" height="${y(base) - y(base + v)}" fill="${s.color}"${f.fecha === estado.dia ? ' stroke="var(--tcc-texto)" stroke-width="1.5"' : ''}/>`;
        base += v;
      }
      if (i % paso === 0) svg += `<text x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${dm(f.fecha)}</text>`;
    });
    svg += '</svg>';
    box.innerHTML = svg + '<div class="tcc-tooltip"></div><div class="tcc-leyenda">' + SERIES.map((s) => `<span><i style="background:${s.color}"></i>${s.nombre}</span>`).join('') + '</div>';
    const tip = box.querySelector('.tcc-tooltip');
    const porFecha = new Map(filas.map((f) => [f.fecha, f]));
    box.querySelectorAll('rect.barra').forEach((r) => {
      r.addEventListener('mousemove', (ev) => {
        const f = porFecha.get(r.dataset.fecha);
        tip.innerHTML = `<b>${dmy(f.fecha)}</b><br>` + SERIES.map((s) => `${s.nombre}: ${fmtNum(f[s.campo])}`).join('<br>');
        const rect = box.getBoundingClientRect();
        tip.style.left = `${Math.min(ev.clientX - rect.left + 12, rect.width - 180)}px`;
        tip.style.top = `${ev.clientY - rect.top + 12}px`;
        tip.style.display = 'block';
      });
      r.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
      r.addEventListener('click', () => setDia(r.dataset.fecha));
    });
  }

  // Colores fijos por tipo de excepción (etiqueta).
  const PALETA = ['#1f4e8c', '#b42318', '#d9822b', '#2e9d6b', '#7a5af8', '#0e9384', '#c4320a', '#667085', '#dd2590', '#4e9f3d', '#9e77ed', '#ca8504', '#155eef'];
  const colorTipo = (tipo) => {
    let h = 0;
    for (const ch of String(tipo)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETA[h % PALETA.length];
  };

  function pintarExcepciones(lista) {
    const tipo = $('tccExcTipo').value;
    const q = $('tccExcBuscar').value.trim().toLowerCase();
    let filas = lista.filter((e) => !tipo || e.tipo === tipo);
    if (q) filas = filas.filter((e) => [e.comprobante, e.cuenta, e.moneda, dmy(e.fecha), e.fecha, e.detalle].some((v) => String(v || '').toLowerCase().includes(q)));
    const { campo, asc } = estado.orden;
    const numericos = ['comprobante', 'cuenta', 'importe'];
    filas.sort((a, b) => {
      let r;
      if (numericos.includes(campo)) r = (Number(a[campo]) || 0) - (Number(b[campo]) || 0);
      else r = String(a[campo] || '').localeCompare(String(b[campo] || ''), 'es'); // fechas aaaa-mm-dd: orden real
      return asc ? r : -r;
    });
    $('tccExcCuenta').textContent = `${fmtNum(filas.length)} de ${fmtNum(lista.length)} excepciones`;
    const monedaCod = (m) => (m === 'USD' ? '2' : '0');
    $('tccExc').querySelector('tbody').innerHTML = filas.slice(0, 5000).map((e) => `<tr>
      <td><span class="tcc-pill" style="background:${colorTipo(e.tipo)}">${esc(e.tipo)}</span></td>
      <td class="num">${esc(e.comprobante)}</td><td class="num">${esc(e.cuenta || '—')}</td><td>${esc(e.moneda)}</td>
      <td>${esc(dmy(e.fecha))}</td><td class="num">${e.importe == null ? '—' : esc(dinero(monedaCod(e.moneda), e.importe))}</td>
      <td>${esc(e.usuario || '—')}</td><td>${esc(e.estadoBs || '—')}</td><td class="detalle">${esc(e.detalle)}</td></tr>`).join('');
    document.querySelectorAll('#tccExc th.ordenable').forEach((th) => {
      th.textContent = th.textContent.replace(/ [▲▼]$/, '') + (th.dataset.orden === campo ? (asc ? ' ▲' : ' ▼') : '');
    });
  }

  function setDia(dia) {
    estado.dia = dia || '';
    $('tccDia').value = estado.dia;
    pintar();
  }

  // --- Eventos ----------------------------------------------------------------------
  function abrir() {
    const hoy = formatDateOnlyLocal(new Date());
    if (!$('tccIbsHasta').value) $('tccIbsHasta').value = hoy;
    if (!$('tccIbsDesde').value) $('tccIbsDesde').value = `${sumarDias(hoy.slice(0, 8) + '01', -1).slice(0, 8)}01`;
    showMainSection('transfCaCcSection');
    cargarHistorial();
  }

  $('tccBtn').addEventListener('click', abrir);
  $('tccCerrarBtn').addEventListener('click', () => showMainSection('flowDetail'));
  $('tccCargarBtn').addEventListener('click', cargarCsv);
  $('tccActualizarBtn').addEventListener('click', actualizar);
  $('tccDia').addEventListener('change', () => setDia($('tccDia').value));
  $('tccUltimoDiaBtn').addEventListener('click', () => estado.datos && setDia(estado.datos.corte.ultimoDiaIbs));
  $('tccTodosBtn').addEventListener('click', () => setDia(''));
  $('tccPerDesde').addEventListener('change', () => estado.datos && pintarPeriodo());
  $('tccPerHasta').addEventListener('change', () => estado.datos && pintarPeriodo());
  $('tccExcTipo').addEventListener('change', () => estado.datos && pintar());
  $('tccExcBuscar').addEventListener('input', () => estado.datos && pintarExcepciones(C.indicadores(estado.datos, estado.dia).excepciones));
  document.querySelectorAll('#tccExc th.ordenable').forEach((th) => th.addEventListener('click', () => {
    const campo = th.dataset.orden;
    estado.orden = { campo, asc: estado.orden.campo === campo ? !estado.orden.asc : true };
    if (estado.datos) pintarExcepciones(C.indicadores(estado.datos, estado.dia).excepciones);
  }));
  $('tccCargas').addEventListener('click', (ev) => {
    const id = ev.target && ev.target.dataset && ev.target.dataset.tccCarga;
    if (id) detalleCarga(id);
  });
})();
