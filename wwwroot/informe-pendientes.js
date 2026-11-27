'use strict';

// "Informe de movimientos pendientes": débitos pendientes de IBS de los códigos de
// movimiento de Parametría, con el documento del cliente y si la cuenta tiene saldo
// (GET /api/informe-pendientes). Acá solo se filtra, se resume y se exporta. Todo
// texto que viene de los datos pasa por escapeHtml (app.js). También maneja el
// editor de los códigos de movimiento en Parametría (solo admin).
(function () {
  const $ = (id) => document.getElementById(id);
  const estado = { datos: null };

  const fmtNum = (n) => Number(n || 0).toLocaleString('es-AR');
  const fmtImporte = (c) => (Number(c || 0) / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dinero = (moneda, c) => `${moneda === 'USD' ? 'US$' : '$'} ${fmtImporte(c)}`;
  const dmy = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  };
  const esc = (v) => escapeHtml(v == null ? '' : String(v));
  const tile = (titulo, valor, detalle, clase) =>
    `<div class="tcc-tile ${clase || ''}"><div class="t">${esc(titulo)}</div><div class="v">${valor}</div>${detalle ? `<div class="d">${detalle}</div>` : ''}</div>`;
  const porMoneda = (g) => `Pesos ${fmtNum(g.nARS)}: ${dinero('ARS', g.ARS)} · USD ${fmtNum(g.nUSD)}: ${dinero('USD', g.USD)}`;
  const etiquetaSaldo = (f) => (!f.saldo ? 'Sin consultar' : f.saldo.conSaldo ? 'Con saldo' : 'Sin saldo');

  // --- Informe ------------------------------------------------------------------
  async function generar() {
    const btn = $('ipGenerarBtn');
    btn.disabled = true;
    $('ipEstado').textContent = 'Consultando IBS...';
    try {
      const res = await apiFetch('/api/informe-pendientes');
      const data = await res.json();
      if (!res.ok) {
        $('ipEstado').textContent = data.error || 'No se pudo generar el informe.';
        return;
      }
      estado.datos = data;
      $('ipEstado').textContent = `Datos al ${dmy(data.generado)} ${String(data.generado).slice(11, 19)}.`;
      $('ipAvisos').innerHTML = (data.avisos || []).map((a) => `<div class="tcc-aviso">${esc(a)}</div>`).join('');
      const sel = $('ipFiltroMov');
      const elegido = sel.value;
      sel.innerHTML = '<option value="">Todos</option>' + data.movimientos.map((m) => `<option value="${esc(m.movcod)}">${esc(m.movcod)}${m.descripcion ? ` — ${esc(m.descripcion)}` : ''}</option>`).join('');
      sel.value = data.movimientos.some((m) => m.movcod === elegido) ? elegido : '';
      $('ipMovimientos').textContent = `Códigos de movimiento del informe (Parametría): ${data.movimientos.map((m) => `${m.movcod}${m.descripcion ? ` ${m.descripcion}` : ''}`).join(', ')}.`;
      $('ipContenido').style.display = '';
      pintar();
    } catch (err) {
      $('ipEstado').textContent = 'Error: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  }

  function visibles() {
    const d = estado.datos;
    if (!d) return [];
    const saldo = $('ipFiltroSaldo').value;
    const moneda = $('ipFiltroMoneda').value;
    const mov = $('ipFiltroMov').value;
    const q = $('ipBuscar').value.trim().toLowerCase();
    return d.filas.filter((f) =>
      (!saldo || (saldo === 'con' ? f.saldo && f.saldo.conSaldo : !(f.saldo && f.saldo.conSaldo))) &&
      (!moneda || f.moneda === moneda) &&
      (!mov || f.movcod === mov) &&
      (!q || [f.cuecod, f.comprobante, f.documentos.join(' '), f.descdet].some((v) => String(v || '').toLowerCase().includes(q))));
  }

  function pintar() {
    const d = estado.datos;
    if (!d) return;
    const r = d.resumen;
    $('ipTiles').innerHTML = '<div class="tcc-grilla">' +
      tile('Movimientos pendientes', fmtNum(r.total.n), porMoneda(r.total), r.total.n ? 'warn' : 'ok') +
      tile('Pendientes con saldo', fmtNum(r.conSaldo.n), porMoneda(r.conSaldo), r.conSaldo.n ? 'warn' : 'ok') +
      tile('Pendientes sin saldo', fmtNum(r.sinSaldo.n), porMoneda(r.sinSaldo), r.sinSaldo.n ? 'warn' : 'ok') +
      (r.aReclamar ? tile('Saldo a reclamar', fmtNum(r.aReclamar.n), porMoneda(r.aReclamar), r.aReclamar.n ? 'warn' : 'ok') : '') +
      (r.sinConsulta.n ? tile('Sin consultar el saldo', fmtNum(r.sinConsulta.n), porMoneda(r.sinConsulta), 'err') : '') +
      '</div>';
    const filas = visibles();
    $('ipCuenta').textContent = `${fmtNum(filas.length)} de ${fmtNum(d.filas.length)} movimientos`;
    $('ipTabla').querySelector('tbody').innerHTML = filas.map((f) => `<tr>
      <td>${esc(dmy(f.fechaOrigen) || '—')}</td><td>${esc(f.sistema)}</td><td>${esc(f.moneda)}</td><td class="num">${esc(f.cuecod)}</td>
      <td class="mono">${esc(f.documentos.join(' / ') || '—')}</td><td>${esc(f.movcod)}${f.descripcion ? ` ${esc(f.descripcion)}` : ''}</td>
      <td>${esc(f.descdet || '—')}</td><td class="num">${esc(f.comprobante)}</td><td class="num">${esc(dinero(f.moneda, f.importe))}</td>
      <td class="num">${f.saldo && f.saldo.sdodiaope != null ? esc(dinero(f.moneda, f.saldo.sdodiaope)) : '—'}</td>
      <td class="num">${f.aReclamar == null ? '—' : esc(dinero(f.moneda, f.aReclamar))}</td>
      <td><span class="tcc-pill" style="background:${!f.saldo ? '#667085' : f.saldo.conSaldo ? '#2e9d6b' : '#d9822b'}">${etiquetaSaldo(f)}</span></td></tr>`).join('');
  }

  // CSV para Excel (UTF-8 con BOM, ";" y coma decimal) de lo que muestra la tabla.
  function exportarCsv() {
    const filas = visibles();
    if (filas.length === 0) {
      alert('No hay movimientos para exportar con los filtros actuales.');
      return;
    }
    const imp = (c) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
    const lineas = [csvExcelLine(['Fecha origen', 'Sistema', 'Moneda', 'Cuenta', 'Documento', 'Movimiento', 'Descripción movimiento', 'Descripción IBS', 'Comprobante', 'Importe', 'Saldo disponible', 'Saldo a Reclamar', 'Saldo'])];
    for (const f of filas) {
      lineas.push(csvExcelLine([dmy(f.fechaOrigen), f.sistema, f.moneda, f.cuecod, f.documentos.join(' / '), f.movcod, f.descripcion, f.descdet, f.comprobante, imp(f.importe), f.saldo && f.saldo.sdodiaope != null ? imp(f.saldo.sdodiaope) : '', f.aReclamar == null ? '' : imp(f.aReclamar), etiquetaSaldo(f)]));
    }
    downloadCsvExcel(`movimientos-pendientes-${String(estado.datos.generado).slice(0, 10)}.csv`, lineas);
  }

  // --- Parametría: códigos de movimiento ------------------------------------------
  function filaParam(m = { movcod: '', descripcion: '' }) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input class="ip-movcod" inputmode="numeric" size="8" value="${esc(m.movcod)}" /></td>
      <td><input class="ip-desc" size="40" value="${esc(m.descripcion)}" /></td>
      <td><button type="button" class="ip-quitar">Quitar</button></td>`;
    tr.querySelector('.ip-quitar').addEventListener('click', () => tr.remove());
    return tr;
  }

  async function cargarParam() {
    const tbody = $('ipParamTabla').querySelector('tbody');
    $('ipParamEstado').textContent = '';
    try {
      const res = await apiFetch('/api/informe-pendientes/movimientos');
      const data = await res.json();
      if (!res.ok) {
        $('ipParamEstado').textContent = data.error || 'No se pudieron leer los códigos.';
        return;
      }
      tbody.innerHTML = '';
      for (const m of data.movimientos) tbody.appendChild(filaParam(m));
    } catch (err) {
      $('ipParamEstado').textContent = 'Error: ' + err.message;
    }
  }

  async function guardarParam() {
    const movimientos = [...$('ipParamTabla').querySelectorAll('tbody tr')].map((tr) => ({
      movcod: tr.querySelector('.ip-movcod').value.trim(),
      descripcion: tr.querySelector('.ip-desc').value.trim(),
    }));
    $('ipParamEstado').textContent = 'Guardando...';
    try {
      const res = await apiFetch('/api/informe-pendientes/movimientos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ movimientos }) });
      const data = await res.json();
      if (!res.ok) {
        $('ipParamEstado').textContent = data.error || 'No se pudieron guardar.';
        return;
      }
      const tbody = $('ipParamTabla').querySelector('tbody');
      tbody.innerHTML = '';
      for (const m of data.movimientos) tbody.appendChild(filaParam(m));
      $('ipParamEstado').textContent = `Guardados ${data.movimientos.length} código(s).`;
    } catch (err) {
      $('ipParamEstado').textContent = 'Error: ' + err.message;
    }
  }

  // El encabezado de la tabla se arma acá, con las mismas columnas que las filas, así
  // no se desalinea si el index.html publicado quedó de una versión anterior.
  const COLUMNAS = [['Fecha origen'], ['Sistema'], ['Moneda'], ['Cuenta', 'num'], ['Documento'], ['Movimiento'], ['Descripción IBS'], ['Comprobante', 'num'],
    ['Importe', 'num'], ['Saldo disponible', 'num'], ['Saldo a Reclamar', 'num'], ['Saldo']];
  $('ipTabla').querySelector('thead').innerHTML = `<tr>${COLUMNAS.map(([t, c]) => `<th${c ? ` class="${c}"` : ''}>${t}</th>`).join('')}</tr>`;

  // --- Eventos ----------------------------------------------------------------------
  $('ipBtn').addEventListener('click', () => showMainSection('informePendientesSection'));
  $('ipGenerarBtn').addEventListener('click', generar);
  for (const id of ['ipFiltroSaldo', 'ipFiltroMoneda', 'ipFiltroMov']) $(id).addEventListener('change', pintar);
  $('ipBuscar').addEventListener('input', pintar);
  $('ipCsvBtn').addEventListener('click', exportarCsv);
  $('parametriaBtn').addEventListener('click', cargarParam);
  $('ipParamAgregarBtn').addEventListener('click', () => $('ipParamTabla').querySelector('tbody').appendChild(filaParam()));
  $('ipParamGuardarBtn').addEventListener('click', guardarParam);
})();
