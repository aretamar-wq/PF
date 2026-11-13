'use strict';

// Dashboard de una corrida: un HTML autocontenido (sin librerías ni pedidos de
// red) con los datos embebidos. Sirve de archivo por corrida (dashboard.html) y
// la app lo muestra tal cual en el panel "Conciliación Loop". No lleva nombres,
// CUIT ni CBU: solo comprobante, cuenta, moneda e importes.

const ESTILO = `
:root { --bg:#f6f4ee; --card:#fff; --ink:#1d2433; --mut:#667085; --line:#e4e1d8; --ok:#1a7f4b; --err:#b42318; --warn:#b54708; --acc:#1f4e8c; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#14171f; --card:#1d222d; --ink:#e8eaf0; --mut:#98a2b3; --line:#2f3645; --ok:#47c585; --err:#f97066; --warn:#fdb022; --acc:#7aa7e6; } }
* { box-sizing:border-box; }
body { margin:0; padding:16px; background:var(--bg); color:var(--ink); font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:16px; margin:24px 0 8px; }
.mut { color:var(--mut); } .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
.ok { color:var(--ok); } .err { color:var(--err); } .warn { color:var(--warn); }
.badge { display:inline-block; padding:2px 8px; border-radius:10px; font-size:12px; border:1px solid var(--line); }
.cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(100%,215px),1fr)); gap:10px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
.card .t { color:var(--mut); font-size:12px; } .card .v { font-size:19px; font-weight:600; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; } .card .s { color:var(--mut); font-size:12px; }
.grupo { margin:14px 0 6px; font-weight:600; color:var(--mut); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
.tabla { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); }
.tabla th, .tabla td { padding:6px 8px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
.tabla th { font-size:12px; color:var(--mut); cursor:default; user-select:none; } .tabla th.ord { cursor:pointer; } .tabla th.num { text-align:right; }
.scroll { overflow-x:auto; }
.filtros { display:flex; gap:8px; flex-wrap:wrap; margin:6px 0; } .filtros select, .filtros input { flex:1 1 170px; min-width:0; max-width:100%; padding:5px 8px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink); }
.aviso { padding:6px 10px; margin:4px 0; border-left:3px solid var(--warn); background:var(--card); } .aviso.error { border-color:var(--err); }
svg text { fill:var(--mut); font-size:10px; } .leyenda { display:flex; flex-wrap:wrap; gap:4px 14px; margin-top:6px; font-size:12px; } .leyenda i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; }
button { padding:5px 10px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink); cursor:pointer; }
@media (max-width:600px) { body { padding:12px; } .card .v { font-size:17px; } }
`;

// Código del navegador. Se escribe como función para poder revisarlo y se embebe con toString().
function cliente() {
  const D = JSON.parse(document.getElementById('datos').textContent);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (c) => (c / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (c, m) => (m === 'USD' ? 'US$\u00a0' : '$\u00a0') + num(c); // espacio fijo: el símbolo no queda solo en una línea
  const fecha = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');
  const monedas = Object.keys(D.totales).sort();
  const tarjeta = (t, v, s, cls) => `<div class="card"><div class="t">${esc(t)}</div><div class="v ${cls || ''}">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;

  // Encabezado y avisos
  const estado = D.exitCode === 0 ? '<span class="badge ok">sin avisos</span>' : D.exitCode === 2 ? '<span class="badge warn">con advertencias</span>' : '<span class="badge err">con errores</span>';
  $('cab').innerHTML =
    `<h1>Conciliación Loop del ${fecha(D.fecha)} ${estado}${D.diaAbierto ? ' <span class="badge warn">día abierto</span>' : ''}</h1>` +
    `<div class="mut">Corrida ${esc(D.id)} · corte de BankService ${esc(D.corte.ejecutada)}</div>`;
  const avisos = (D.avisos || []).filter((a) => a.nivel !== 'info');
  $('avisos').innerHTML = avisos.map((a) => `<div class="aviso ${a.nivel === 'error' ? 'error' : ''}">${esc(a.mensaje)}</div>`).join('');

  // Indicadores: partidas, desbalance, cruce
  const c = D.cruce;
  const correctos = D.comprobantesTotal - D.comprobantesConMarca;
  $('kpis').innerHTML =
    '<div class="grupo">Partidas</div><div class="cards">' +
    tarjeta('Partidas en Loop', D.partidasTotal.toLocaleString('es-AR')) +
    tarjeta('Comprobantes', D.comprobantesTotal.toLocaleString('es-AR'), `${correctos.toLocaleString('es-AR')} correctos`) +
    tarjeta('Con marca', D.comprobantesConMarca.toLocaleString('es-AR'), '', D.comprobantesConMarca ? 'warn' : 'ok') + '</div>' +
    '<div class="grupo">Desbalance</div><div class="cards">' +
    monedas.map((m) => {
      const t = D.totales[m];
      return tarjeta(`Neto en Loop ${m}`, money(t.neto, m)) + tarjeta(`Débitos pendientes ${m}`, money(t.pendientes, m)) +
        tarjeta(`Sin cubrir ${m}`, money(t.sinCubrir, m), t.sinCubrir < 0 ? 'pendientes de más' : 'debe tender a 0', t.sinCubrir === 0 ? 'ok' : 'err');
    }).join('') + '</div>' +
    '<div class="grupo">Cruce con transfers</div><div class="cards">' +
    tarjeta('Operaciones del día', c.delDia.toLocaleString('es-AR'), `${c.approved.toLocaleString('es-AR')} APPROVED · ${c.failed} FAILED`) +
    tarjeta('APPROVED en Loop', c.encontradas.toLocaleString('es-AR'), `${c.sinDiferencias.toLocaleString('es-AR')} sin diferencias`, c.encontradas === c.sinDiferencias ? 'ok' : 'warn') +
    tarjeta('APPROVED sin registro', c.approvedSinRegistro, '', c.approvedSinRegistro ? 'err' : 'ok') +
    tarjeta('Pendientes de contabilizar', c.pendientesDeContabilizar, D.diaAbierto ? 'el día sigue abierto' : 'día cerrado'  ) +
    tarjeta('Transfers sin ejecutar', c.pending, 'PENDING_EXECUTION hasta el día', c.pending ? 'warn' : 'ok') +
    tarjeta('Operaciones de otros días', c.otrosDias.toLocaleString('es-AR'), 'en los archivos, fuera de este día') + '</div>';

  // Gráfico: excepciones del día por tipo (la evolución entre días está en el histórico de la app)
  const excs = D.excepciones;
  const tipos = [...new Set(excs.map((e) => e.tipo))].sort();
  const colores = ['#1f4e8c', '#d9822b', '#2e9d6b', '#b42318', '#7a5af8', '#0e9384', '#c4320a', '#667085', '#dd2590', '#4e9f3d', '#9e77ed', '#ca8504'];
  const cantidadDe = (t) => excs.filter((e) => e.tipo === t).length;
  if (tipos.length === 0) {
    $('grafico').innerHTML = '<div class="mut">Sin excepciones.</div>';
  } else {
    const maximo = Math.max(...tipos.map(cantidadDe));
    $('grafico').innerHTML = '<div class="scroll"><table class="tabla">' + tipos.map((t, i) => {
      const n = cantidadDe(t);
      return `<tr><td style="width:34%">${esc(t)}</td><td><div style="background:${colores[i % colores.length]};height:14px;border-radius:3px;width:${Math.max(2, Math.round((100 * n) / maximo))}%"></div></td><td class="num" style="width:70px">${n.toLocaleString('es-AR')}</td></tr>`;
    }).join('') + '</table></div>';
  }

  // Débitos pendientes: último día vs días anteriores, y saldo por día
  const A = D.antiguedad;
  $('tramos').innerHTML =
    '<table class="tabla"><tr><th>Tramo</th><th>Moneda</th><th class="num">Cantidad</th><th class="num">Importe</th></tr>' +
    (A.tramos.length ? A.tramos.sort((x, y) => (x.tramo === y.tramo ? x.moneda.localeCompare(y.moneda) : x.tramo === 'Último día' ? -1 : 1))
      .map((t) => `<tr><td>${esc(t.tramo)}</td><td>${esc(t.moneda)}</td><td class="num">${t.cantidad}</td><td class="num">${money(t.importe, t.moneda)}</td></tr>`).join('') : '<tr><td colspan="4" class="mut">Sin débitos pendientes.</td></tr>') + '</table>';
  $('saldo').innerHTML =
    '<table class="tabla"><tr><th>Fecha del crédito</th><th>Moneda</th><th class="num">Cantidad</th><th class="num">Importe</th><th class="num">Acumulado</th><th>Tramo</th></tr>' +
    (A.filas.length ? A.filas.map((f) => `<tr><td>${fecha(f.fecha)}</td><td>${esc(f.moneda)}</td><td class="num">${f.cantidad}</td><td class="num">${money(f.importe, f.moneda)}</td><td class="num">${money(f.acumulado, f.moneda)}</td><td>${esc(f.tramo)}</td></tr>`).join('') : '<tr><td colspan="6" class="mut">Sin débitos pendientes.</td></tr>') + '</table>';
  $('posteriores').innerHTML = D.pendientesPosteriores.length
    ? '<h2>Débitos pendientes posteriores al día</h2><div class="scroll"><table class="tabla"><tr><th>Comprobante</th><th>Cuenta</th><th>Fecha</th><th class="num">Importe</th></tr>' +
      D.pendientesPosteriores.map((p) => `<tr><td>${esc(p.comprobante)}</td><td>${esc(p.cuenta)}</td><td>${fecha(p.fecha)}</td><td class="num">${money(p.importe, p.moneda)}</td></tr>`).join('') + '</table></div>'
    : '';

  // Excepciones: filtros, búsqueda y orden
  const est = { tipo: '', moneda: '', q: '', col: 'tipo', dir: 1, pag: 0 };
  const COLS = [['tipo', 'Tipo'], ['comprobante', 'Comprobante'], ['cuenta', 'Cuenta'], ['moneda', 'Moneda'], ['fecha', 'Fecha'], ['importe', 'Importe'], ['estadoTransfer', 'Estado transfer'], ['debitoPendiente', 'Débito pendiente'], ['detalle', 'Detalle']];
  const POR_PAGINA = 200;
  $('ftipo').innerHTML = '<option value="">Todos los tipos</option>' + tipos.map((t) => `<option value="${esc(t)}">${esc(t)} (${excs.filter((e) => e.tipo === t).length})</option>`).join('');
  $('fmoneda').innerHTML = '<option value="">Todas las monedas</option>' + monedas.map((m) => `<option>${m}</option>`).join('');
  function dibujar() {
    const q = est.q.toLowerCase();
    let f = excs.filter((e) => (!est.tipo || e.tipo === est.tipo) && (!est.moneda || e.moneda === est.moneda) &&
      (!q || [e.tipo, e.comprobante, e.cuenta, e.detalle, e.estadoTransfer].some((x) => String(x || '').toLowerCase().includes(q))));
    f.sort((a, b) => {
      const x = a[est.col], y = b[est.col];
      const r = ['importe', 'debitoPendiente'].includes(est.col) || (est.col === 'comprobante' && !isNaN(x) && !isNaN(y)) ? (Number(x) || 0) - (Number(y) || 0) : String(x == null ? '' : x).localeCompare(String(y == null ? '' : y), 'es');
      return r * est.dir;
    });
    const paginas = Math.max(1, Math.ceil(f.length / POR_PAGINA));
    est.pag = Math.min(est.pag, paginas - 1);
    $('cuenta').textContent = `${f.length.toLocaleString('es-AR')} de ${excs.length.toLocaleString('es-AR')} excepciones` + (paginas > 1 ? ` · página ${est.pag + 1} de ${paginas}` : '');
    $('pagina').style.display = paginas > 1 ? '' : 'none';
    $('texc').innerHTML = '<tr>' + COLS.map(([k, t]) => `<th class="ord ${['importe', 'debitoPendiente'].includes(k) ? 'num' : ''}" data-col="${k}">${t}${est.col === k ? (est.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr>' +
      f.slice(est.pag * POR_PAGINA, (est.pag + 1) * POR_PAGINA).map((e) => `<tr><td>${esc(e.tipo)}</td><td>${esc(e.comprobante)}</td><td>${esc(e.cuenta)}</td><td>${esc(e.moneda)}</td><td>${fecha(e.fecha)}</td>` +
        `<td class="num">${e.importe == null ? '' : money(e.importe, e.moneda)}</td><td>${esc(e.estadoTransfer)}</td><td class="num">${e.debitoPendiente == null ? '' : money(e.debitoPendiente, e.moneda)}</td><td>${esc(e.detalle)}</td></tr>`).join('');
  }
  $('ftipo').onchange = (e) => { est.tipo = e.target.value; est.pag = 0; dibujar(); };
  $('fmoneda').onchange = (e) => { est.moneda = e.target.value; est.pag = 0; dibujar(); };
  $('fq').oninput = (e) => { est.q = e.target.value; est.pag = 0; dibujar(); };
  $('anterior').onclick = () => { est.pag = Math.max(0, est.pag - 1); dibujar(); };
  $('siguiente').onclick = () => { est.pag++; dibujar(); };
  $('texc').onclick = (e) => { const th = e.target.closest('th[data-col]'); if (!th) return; const k = th.dataset.col; est.dir = est.col === k ? -est.dir : 1; est.col = k; dibujar(); };
  dibujar();
}

const ESQUELETO = `
<div id="cab"></div><div id="avisos"></div><div id="kpis"></div>
<h2>Excepciones del día por tipo</h2><div id="grafico"></div>
<h2>Débitos pendientes</h2><div class="scroll" id="tramos"></div>
<h2>Saldo de débitos pendientes por día</h2><div class="scroll" id="saldo"></div>
<div id="posteriores"></div>
<h2>Excepciones</h2>
<div class="filtros"><select id="ftipo"></select><select id="fmoneda"></select><input id="fq" type="search" placeholder="Buscar comprobante, cuenta o detalle"><span class="mut" id="cuenta" style="align-self:center"></span>
<span id="pagina"><button id="anterior" type="button">‹</button> <button id="siguiente" type="button">›</button></span></div>
<div class="scroll"><table class="tabla" id="texc"></table></div>`;

// data: lo mismo que resultado.json (ver corrida.js).
function construirDashboardHtml(data) {
  // Dentro de <script>: escapar "<" y los separadores de línea unicode.
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(new RegExp('[\\u2028\\u2029]', 'g'), (c) => '\\u' + c.charCodeAt(0).toString(16));
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conciliación Loop</title><style>${ESTILO}</style></head><body>
${ESQUELETO}
<script id="datos" type="application/json">${json}</script>
<script>(${cliente.toString()})();</script>
</body></html>
`;
}

module.exports = { construirDashboardHtml };
