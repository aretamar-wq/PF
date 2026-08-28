const state = {
  profiles: [],
  flows: [],
  selectedFlow: null,
  lastLog: [],
  pfDetailRows: [],
  enrichedCsvRows: [],
  token: sessionStorage.getItem('pf_token') || null,
  currentUser: null, // { username, role, displayName, canManageUsers } — se completa en loadMe()
};

// Wrapper de fetch para todas las llamadas a /api/*: agrega el token de sesión
// (Authorization: Bearer <token>, guardado en sessionStorage — se pierde si se
// cierra la pestaña, a propósito para una app que mueve plata) y, si el
// servidor contesta 401 (sesión inválida/expirada/usuario deshabilitado en el
// medio), limpia la sesión y vuelve a mostrar la pantalla de login en vez de
// dejar que cada llamador tenga que manejarlo por separado.
async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const res = await fetch(path, { ...options, headers });

  if (res.status === 401 && path !== '/api/login') {
    clearSession();
    showLoginScreen();
  }

  return res;
}

function clearSession() {
  state.token = null;
  state.currentUser = null;
  sessionStorage.removeItem('pf_token');
}

function showLoginScreen() {
  document.getElementById('loginScreen').style.display = '';
  document.getElementById('appShell').style.display = 'none';
}

function showAppShell() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appShell').style.display = '';
}

async function login(username, password) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();

  if (!res.ok) {
    throw new Error((data && data.error) || 'No se pudo iniciar sesión.');
  }

  state.token = data.token;
  sessionStorage.setItem('pf_token', data.token);
}

async function logout() {
  try {
    await apiFetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    // Si falla la llamada de red, igual se limpia la sesión del lado del cliente.
  }
  clearSession();
  showLoginScreen();
}

async function loadMe() {
  const res = await apiFetch('/api/me');
  if (!res.ok) throw new Error('Sesión inválida.');
  state.currentUser = await res.json();

  document.getElementById('currentUserInfo').textContent =
    `${state.currentUser.displayName || state.currentUser.username} (${state.currentUser.role})`;
  document.getElementById('usersBtn').style.display = state.currentUser.canManageUsers ? '' : 'none';

  const isReadOnly = state.currentUser.role === 'lectura';
  document.getElementById('readOnlyNotice').style.display = isReadOnly ? '' : 'none';
}

async function loadProfiles() {
  const res = await apiFetch('/api/profiles');
  state.profiles = await res.json();

  const select = document.getElementById('profileSelect');
  const previous = select.value;
  select.innerHTML = '';
  for (const p of state.profiles) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    select.appendChild(opt);
  }

  if (state.profiles.some((p) => p.name === previous)) {
    select.value = previous;
  } else if (state.profiles.length > 0) {
    select.value = state.profiles[0].name;
  }

  updateTestTokenButtonState();
}

function updateTestTokenButtonState() {
  const profileName = document.getElementById('profileSelect').value;
  const profile = state.profiles.find((p) => p.name === profileName);
  const authType = (profile && profile.authType) || '';
  document.getElementById('testTokenBtn').disabled = authType.trim().toLowerCase() !== 'oauth2clientcredentials';
  document.getElementById('tokenTestResult').textContent = '';
}

async function testToken() {
  const profileName = document.getElementById('profileSelect').value;
  if (!profileName) return;

  const btn = document.getElementById('testTokenBtn');
  const resultSpan = document.getElementById('tokenTestResult');
  btn.disabled = true;
  resultSpan.className = 'muted';
  resultSpan.textContent = 'Probando...';

  try {
    const res = await apiFetch('/api/test-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileName }),
    });
    const data = await res.json();

    if (data.ok) {
      resultSpan.className = 'status-Success';
      resultSpan.textContent = `OK (${data.durationMs} ms) — token: ${data.tokenPreview}`;
    } else {
      resultSpan.className = 'status-Error';
      resultSpan.textContent = `Error: ${data.message}`;
    }
  } catch (err) {
    resultSpan.className = 'status-Error';
    resultSpan.textContent = 'Error de red: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

async function loadFlows() {
  const res = await apiFetch('/api/flows');
  state.flows = await res.json();

  const list = document.getElementById('flowList');
  list.innerHTML = '';
  for (const flow of state.flows) {
    const li = document.createElement('li');
    li.textContent = flow.name;
    li.dataset.flowName = flow.name;
    li.addEventListener('click', () => selectFlow(flow.name));
    list.appendChild(li);
  }

  if (state.flows.length > 0) {
    selectFlow(state.flows[0].name);
  }
}

function isCsvFlow(flow) {
  return !!flow && flow.inputMode === 'csv';
}

function selectFlow(name) {
  state.selectedFlow = state.flows.find((f) => f.name === name) || null;

  document.querySelectorAll('#flowList li').forEach((li) => {
    li.classList.toggle('selected', li.dataset.flowName === name);
  });

  document.getElementById('flowDescription').textContent = state.selectedFlow
    ? state.selectedFlow.description
    : 'Elegí un flow de la lista.';

  const inputs = (state.selectedFlow && state.selectedFlow.inputs) || [];
  const form = document.getElementById('inputsForm');
  const csvSection = document.getElementById('csvInputSection');
  const csvFileInput = document.getElementById('csvFileInput');

  form.innerHTML = '';
  csvFileInput.value = '';
  document.getElementById('csvProgress').textContent = '';
  hideCsvSummary();
  hideRecuperaCuentasResult();
  hideSqlResult();
  state.pfDetailRows = [];
  document.getElementById('downloadPfDetailBtn').disabled = true;
  state.enrichedCsvRows = [];
  document.getElementById('downloadEnrichedCsvBtn').disabled = true;

  if (isCsvFlow(state.selectedFlow)) {
    form.style.display = 'none';
    csvSection.style.display = '';
    // Para flows con inputMode: "csv" no se muestra la tabla de log paso a
    // paso (queda solo el resumen ok/error por paso, en #csvSummary) — el
    // detalle completo de cada request/response sigue quedando en
    // logs/http.log si hace falta revisarlo.
    document.getElementById('logTable').style.display = 'none';
    const columnList = inputs.map((i) => i.label || i.variableName).join(', ');
    document.getElementById('csvColumnsHint').textContent =
      `El CSV no lleva encabezado. Orden de columnas: ${columnList}.`;
  } else {
    form.style.display = '';
    csvSection.style.display = 'none';
    // "Recupera cuentas" y cualquier flow con un step SQL tampoco muestran la
    // tabla de log: la respuesta es un volcado de JSON (o una tabla) más
    // legible en su propio panel (#recuperaCuentasResult / #sqlResultPanel)
    // que como fila de la tabla genérica. El detalle completo sigue en
    // logs/http.log y en "Guardar log...".
    document.getElementById('logTable').style.display =
      isRecuperaCuentasFlow(state.selectedFlow) || isSqlFlow(state.selectedFlow) ? 'none' : '';

    for (const input of inputs) {
      const label = document.createElement('label');
      label.textContent = input.label || input.variableName;

      let field;
      if (input.type === 'select' && Array.isArray(input.options)) {
        field = document.createElement('select');
        field.name = input.variableName;
        for (const opt of input.options) {
          const optionEl = document.createElement('option');
          optionEl.value = opt.value;
          optionEl.textContent = opt.label;
          field.appendChild(optionEl);
        }
        if (input.defaultValue != null) field.value = input.defaultValue;
      } else if (input.type === 'textarea') {
        field = document.createElement('textarea');
        field.name = input.variableName;
        field.rows = 4;
        field.value = input.defaultValue || '';
      } else {
        field = document.createElement('input');
        field.name = input.variableName;
        field.value = input.defaultValue || '';
        if (input.secret) field.type = 'password';
      }

      label.appendChild(field);
      form.appendChild(label);
    }
  }

  updateRunButtonState();
}

function updateRunButtonState() {
  const flow = state.selectedFlow;
  let enabled = !!flow;
  if (isCsvFlow(flow)) {
    const csvFileInput = document.getElementById('csvFileInput');
    enabled = enabled && csvFileInput.files && csvFileInput.files.length > 0;
  }
  // El servidor es quien realmente hace cumplir esto (rechaza /api/run con 403
  // para rol 'lectura', ver server.ps1) — acá solo se evita el viaje de ida y
  // vuelta ocultando/deshabilitando el botón para un rol que ya sabemos que no
  // puede ejecutar nada.
  if (state.currentUser && state.currentUser.role === 'lectura') {
    enabled = false;
  }
  document.getElementById('runBtn').disabled = !enabled;
}

// Parser CSV simple: separa por comas, saca comillas envolventes si las hay
// (ej. las que agrega Excel al guardar), y descarta líneas vacías. No maneja
// comas dentro de un campo entrecomillado — ninguno de los campos esperados
// por estos flows debería necesitarlas.
function parseCsvText(text) {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(',').map((cell) => cell.trim().replace(/^"(.*)"$/, '$1')));
}

function formatDurationShort(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function hideCsvSummary() {
  const summaryEl = document.getElementById('csvSummary');
  summaryEl.style.display = 'none';
  summaryEl.innerHTML = '';
}

// stepCounts es un array paralelo a flow.steps: stepCounts[i] = { ok, error }
// contando, por cada fila del CSV, si ese paso terminó en 'Success' o no
// (no ejecutado por una fila mal formada, por una falla de red, o porque un
// paso anterior de la misma fila falló, cuenta como error de ese paso).
function renderCsvSummary(flow, totalRows, stepCounts) {
  const summaryEl = document.getElementById('csvSummary');
  const lines = [`<div><strong>Total de registros: ${totalRows}</strong></div>`];
  flow.steps.forEach((step, idx) => {
    const { ok, error } = stepCounts[idx];
    lines.push(
      `<div>${escapeHtml(step.name)}: ` +
        `<span class="status-Success">${ok} correcto(s)</span> / ` +
        `<span class="status-Error">${error} con error</span></div>`
    );
  });
  summaryEl.innerHTML = lines.join('');
  summaryEl.style.display = '';
}

// Acoplado a este flow puntual por nombre (igual que el detalle de Plazo
// Fijo): sabemos que su única respuesta trae un array "output" con,
// entre otras cosas, codigoSistema/codigoCuenta por cada cuenta/operación
// del cliente.
function isRecuperaCuentasFlow(flow) {
  return !!flow && flow.name === 'Recupera cuentas';
}

function hideRecuperaCuentasResult() {
  const el = document.getElementById('recuperaCuentasResult');
  el.style.display = 'none';
  el.innerHTML = '';
}

// Filtra el array "output" de la respuesta a las cuentas con código de
// sistema 4 o 5 y código de estado de cuenta 1 o 2, sin repetir
// combinaciones código de sistema + código de cuenta + código de moneda ya
// vistas (la misma cuenta aparece una vez por cada operación
// histórica en el core, y lo que hace falta acá es la lista de cuentas,
// no de operaciones).
function renderRecuperaCuentasResult(entries) {
  const el = document.getElementById('recuperaCuentasResult');
  const lastEntry = entries[entries.length - 1];
  if (!lastEntry || lastEntry.status !== 'Success' || !lastEntry.responseSummary) {
    hideRecuperaCuentasResult();
    return;
  }

  let output;
  try {
    const parsed = JSON.parse(lastEntry.responseSummary);
    output = Array.isArray(parsed.output) ? parsed.output : [];
  } catch (err) {
    hideRecuperaCuentasResult();
    return;
  }

  const seen = new Set();
  const rows = [];
  for (const item of output) {
    if (item.codigoSistema !== 4 && item.codigoSistema !== 5) continue;
    if (item.codigoEstadoCuenta !== 1 && item.codigoEstadoCuenta !== 2) continue;
    const key = `${item.codigoSistema}|${item.codigoCuenta}|${item.codigoMoneda}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      codigoSistema: item.codigoSistema,
      codigoCuenta: item.codigoCuenta,
      codigoMoneda: item.codigoMoneda,
      codigoEstadoCuenta: item.codigoEstadoCuenta,
    });
  }

  if (rows.length === 0) {
    el.innerHTML = '<div>No se encontraron cuentas con código de sistema 4 o 5 y código de estado de cuenta 1 o 2 en la respuesta.</div>';
    el.style.display = '';
    return;
  }

  const lines = ['<div><strong>Cuentas (código de sistema 4 y 5, código de estado de cuenta 1 y 2)</strong></div>'];
  for (const row of rows) {
    lines.push(
      `<div>Código de sistema ${escapeHtml(row.codigoSistema)}: código de cuenta ${escapeHtml(row.codigoCuenta)}, ` +
        `código de moneda ${escapeHtml(row.codigoMoneda)}, código de estado de cuenta ${escapeHtml(row.codigoEstadoCuenta)}</div>`
    );
  }
  el.innerHTML = lines.join('');
  el.style.display = '';
}

// Genérico para cualquier flow cuyo último step sea "type": "sql" (no
// acoplado a un flow puntual, a diferencia de isRecuperaCuentasFlow): sirve
// tanto para "Consulta SQL (Sybase)" como para "Recupera cuentas (SQL)" y
// cualquier otro flow SQL que se agregue después.
function isSqlFlow(flow) {
  return !!flow && Array.isArray(flow.steps) && flow.steps.some((step) => step.type === 'sql');
}

// Mismo formato que modules/FlowEngine.psm1 genera para {{idMensajeGenerado}}
// (PFC + yyyyMMddHHmmss). Se genera acá (no solo en el servidor) y se manda
// como input por fila para que "Plazo Fijo Cocos Files"/"Plazo Fijo Cocos
// Files (SQL)" lo usen (un input del usuario pisa la variable de sistema del
// mismo nombre) — así el cliente sabe el valor exacto que se usó en cada
// fila, para poder agregarlo al final de "Descargar detalle de Plazos
// Fijos..." (el servidor no lo devuelve en la respuesta).
function generateIdMensaje() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds());
  return `PFC${stamp}`;
}

// Acoplado a este flow puntual: sabemos que su respuesta SQL trae
// {rows: [{sistcod, cuecod}, ...]}, y que arma un archivo de salida
// "fila original + cuecodSistema5 + cuecodSistema4" (ver runFlowFromCsv).
function isRecuperaCuentasSqlFilesFlow(flow) {
  return !!flow && flow.name === 'Recupera cuentas (SQL) Files';
}

// Acoplado a este flow puntual: no tiene ningún step SQL propio (a
// diferencia de la primera versión) — la búsqueda de cuentas se hace UNA
// sola vez para todo el archivo, antes del loop de filas (ver
// fetchAccountsByCuit / runFlowFromCsv), en vez de una consulta por fila.
function isPlazoFijoCocosFilesSqlFlow(flow) {
  return !!flow && flow.name === 'Plazo Fijo Cocos Files (SQL)';
}

// Junta los CUIT únicos de todas las filas (primera columna) y hace UNA
// sola consulta a Sybase para todos (reusando el flow "Recupera cuentas
// (SQL)", que ya soporta una lista de nrodoc separados por coma), en vez
// de una consulta por fila. Devuelve un Map cuit -> { cuecodSistema5,
// cuecodSistema4 } (cuecodSistema4 es 'null' en texto, no ausente, para
// que el step "Alta de Plazo Fijo" lo trate igual que un valor no
// encontrado vía omitIfNull). Un cuit sin ninguna cuenta simplemente no
// aparece en el Map.
async function fetchAccountsByCuit(rows) {
  const cuits = new Set();
  for (const row of rows) {
    const cuit = (row[0] || '').trim();
    if (!cuit) continue;
    if (!/^\d+$/.test(cuit)) {
      throw new Error(`El CUIT "${cuit}" tiene caracteres no numéricos — no se puede armar la consulta a Sybase.`);
    }
    cuits.add(cuit);
  }

  const accountsByCuit = new Map();
  if (cuits.size === 0) return accountsByCuit;

  const entries = await runFlowByName('Recupera cuentas (SQL)', { nrodoc: Array.from(cuits).join(',') });
  const lastEntry = entries[entries.length - 1];
  if (!lastEntry || lastEntry.status !== 'Success' || !lastEntry.responseSummary) {
    throw new Error('No se pudo buscar las cuentas en Sybase para los CUIT del archivo: ' + (lastEntry ? lastEntry.errorMessage : 'sin respuesta'));
  }

  const parsed = JSON.parse(lastEntry.responseSummary);
  const sqlRows = Array.isArray(parsed.rows) ? parsed.rows : [];
  for (const sqlRow of sqlRows) {
    const cuit = String(sqlRow.nrodoc);
    if (!accountsByCuit.has(cuit)) accountsByCuit.set(cuit, {});
    const entry = accountsByCuit.get(cuit);
    if (sqlRow.sistcod === 5) entry.cuecodSistema5 = sqlRow.cuecod == null ? '' : String(sqlRow.cuecod);
    else if (sqlRow.sistcod === 4) entry.cuecodSistema4 = sqlRow.cuecod == null ? '' : String(sqlRow.cuecod);
  }
  return accountsByCuit;
}

function hideSqlResult() {
  const el = document.getElementById('sqlResultPanel');
  el.style.display = 'none';
  el.innerHTML = '';
}

// Muestra el array "rows" de la respuesta del último step SQL como una
// tabla HTML (columnas = las claves del primer row, mismo orden en que las
// devolvió la consulta) en vez de como JSON crudo en la tabla de log.
function renderSqlResult(entries) {
  const el = document.getElementById('sqlResultPanel');
  const lastEntry = entries[entries.length - 1];
  if (!lastEntry || lastEntry.status !== 'Success' || !lastEntry.responseSummary) {
    hideSqlResult();
    return;
  }

  let rows;
  try {
    const parsed = JSON.parse(lastEntry.responseSummary);
    rows = Array.isArray(parsed.rows) ? parsed.rows : [];
  } catch (err) {
    hideSqlResult();
    return;
  }

  if (rows.length === 0) {
    el.innerHTML = '<p class="muted">La consulta no devolvió ninguna fila.</p>';
    el.style.display = '';
    return;
  }

  const columns = Object.keys(rows[0]);
  const headerHtml = columns.map((col) => `<th>${escapeHtml(col)}</th>`).join('');
  const rowsHtml = rows
    .map((row) => `<tr>${columns.map((col) => `<td>${escapeHtml(row[col])}</td>`).join('')}</tr>`)
    .join('');

  el.innerHTML = (
    `<p class="muted">${rows.length} fila(s)</p>` +
    `<table><thead><tr>${headerHtml}</tr></thead><tbody>${rowsHtml}</tbody></table>`
  );
  el.style.display = '';
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('No se pudo leer el archivo.'));
    reader.readAsText(file);
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function formatResultCell(entry) {
  const parts = [];
  if (entry.errorMessage) parts.push(escapeHtml(entry.errorMessage));
  if (entry.responseSummary) {
    const prefix = entry.errorMessage ? 'Respuesta del servidor: ' : '';
    parts.push(prefix + escapeHtml(entry.responseSummary));
  }
  return parts.join('<br>');
}

function renderLog(entries) {
  const logBody = document.getElementById('logBody');
  logBody.innerHTML = '';
  for (const entry of entries) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(entry.name)}</td>
      <td class="status-${entry.status}">${escapeHtml(entry.status)}</td>
      <td>${entry.httpStatusCode == null ? '' : entry.httpStatusCode}</td>
      <td>${entry.durationMs}</td>
      <td>${escapeHtml(entry.requestSummary)}</td>
      <td>${formatResultCell(entry)}</td>
    `;
    logBody.appendChild(tr);
  }
}

async function runFlowByName(flowName, inputs) {
  const res = await apiFetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profileName: document.getElementById('profileSelect').value,
      flowName,
      inputs,
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error((data && data.error) || 'Error ejecutando el flow.');
  }

  return Array.isArray(data) ? data : [data];
}

async function runOnce(inputs) {
  return runFlowByName(state.selectedFlow.name, inputs);
}

async function runFlow() {
  if (!state.selectedFlow) return;

  if (isCsvFlow(state.selectedFlow)) {
    await runFlowFromCsv();
    return;
  }

  const runBtn = document.getElementById('runBtn');
  runBtn.disabled = true;
  document.getElementById('logBody').innerHTML = '';
  hideRecuperaCuentasResult();
  hideSqlResult();

  const form = document.getElementById('inputsForm');
  const inputs = {};
  new FormData(form).forEach((value, key) => {
    inputs[key] = value;
  });

  try {
    state.lastLog = await runOnce(inputs);
    renderLog(state.lastLog);
    document.getElementById('saveLogBtn').disabled = state.lastLog.length === 0;
    if (isRecuperaCuentasFlow(state.selectedFlow)) {
      renderRecuperaCuentasResult(state.lastLog);
    } else if (isSqlFlow(state.selectedFlow)) {
      renderSqlResult(state.lastLog);
    }
  } catch (err) {
    alert(err.message);
  } finally {
    runBtn.disabled = false;
  }
}

async function runFlowFromCsv() {
  const flow = state.selectedFlow;
  const csvFileInput = document.getElementById('csvFileInput');
  const progressEl = document.getElementById('csvProgress');
  const file = csvFileInput.files && csvFileInput.files[0];
  if (!file) return;

  const runBtn = document.getElementById('runBtn');
  runBtn.disabled = true;
  document.getElementById('logBody').innerHTML = '';
  hideCsvSummary();
  state.lastLog = [];
  state.pfDetailRows = [];
  document.getElementById('downloadPfDetailBtn').disabled = true;
  state.enrichedCsvRows = [];
  document.getElementById('downloadEnrichedCsvBtn').disabled = true;

  // stepCounts[i] cuenta, para el paso flow.steps[i], cuántas filas lo
  // completaron con éxito ('ok') y cuántas no ('error') — ya sea porque ese
  // paso falló, porque no llegó a ejecutarse (un paso anterior de la misma
  // fila falló), o porque la fila entera no se pudo correr (columnas de
  // más/menos, o un error de red/servidor antes de tener respuesta).
  const stepCounts = flow.steps.map(() => ({ ok: 0, error: 0 }));

  try {
    const text = await readFileAsText(file);
    const rows = parseCsvText(text);

    if (rows.length === 0) {
      alert('El archivo CSV no tiene ninguna fila con datos.');
      return;
    }

    // Para "Plazo Fijo Cocos Files (SQL)": UNA sola consulta a Sybase con
    // todos los CUIT del archivo, antes de procesar ninguna fila — en vez
    // de una consulta por fila (o por CUIT repetido). Si esto falla, se
    // aborta todo el archivo: sin las cuentas no se puede procesar ninguna
    // fila de forma segura.
    let accountsByCuit = null;
    if (isPlazoFijoCocosFilesSqlFlow(flow)) {
      progressEl.textContent = 'Buscando cuentas en Sybase para todos los CUIT del archivo...';
      try {
        accountsByCuit = await fetchAccountsByCuit(rows);
      } catch (err) {
        alert('Error buscando las cuentas en Sybase: ' + err.message);
        return;
      }
    }

    const startedAt = Date.now();

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 1;
      const elapsedMs = Date.now() - startedAt;
      // Cada fila hace varias llamadas reales a la API del banco (no algo que
      // dependa de nuestro código): el ETA es solo un promedio de lo que ya
      // tardaron las filas anteriores, no una estimación exacta.
      let etaText = '';
      if (rowNumber > 1) {
        const avgMsPerRow = elapsedMs / (rowNumber - 1);
        const remainingMs = avgMsPerRow * (rows.length - rowNumber + 1);
        etaText = ` (transcurrido ${formatDurationShort(elapsedMs)}, restante estimado ~${formatDurationShort(remainingMs)})`;
      }
      progressEl.textContent = `Procesando fila ${rowNumber} de ${rows.length}...${etaText}`;

      const row = rows[i];
      const rowIdMensaje = generateIdMensaje();
      let rowEntries;
      let stepEntries = null; // solo se llena con la respuesta real de /api/run, alineada 1:1 con flow.steps

      if (row.length !== flow.inputs.length) {
        rowEntries = [
          {
            name: `Fila ${rowNumber}`,
            status: 'Error',
            requestSummary: null,
            responseSummary: null,
            httpStatusCode: null,
            durationMs: 0,
            errorMessage: `La fila tiene ${row.length} columna(s), se esperaban ${flow.inputs.length}.`,
          },
        ];
      } else {
        const inputs = {};
        flow.inputs.forEach((inputDef, idx) => {
          inputs[inputDef.variableName] = row[idx];
        });
        inputs.idMensajeGenerado = rowIdMensaje;

        // Cuentas ya resueltas por fetchAccountsByCuit (una sola consulta
        // para todo el archivo, antes del loop) — cuecodSistema5 (Caja de
        // Ahorro) es obligatoria: si no se encontró, la fila queda en error
        // sin llamar a ningún endpoint del banco (mismo criterio de
        // seguridad que antes tenía el step SQL con requireVariables, pero
        // ahora resuelto acá porque el flow ya no tiene ese step).
        // cuecodSistema4 (Plazo Fijo) es opcional: si no se encontró, se
        // manda 'null' (texto) para que el step 3 lo omita vía omitIfNull.
        let accountLookupError = null;
        if (isPlazoFijoCocosFilesSqlFlow(flow)) {
          const cuit = (row[0] || '').trim();
          const accounts = accountsByCuit.get(cuit);
          if (!accounts || !accounts.cuecodSistema5) {
            accountLookupError = `No se encontró cuenta de Caja de Ahorro (código de sistema 5) en Sybase para el CUIT ${cuit}.`;
          } else {
            inputs.cuecodSistema5 = accounts.cuecodSistema5;
            inputs.cuecodSistema4 = accounts.cuecodSistema4 || 'null';
          }
        }

        if (accountLookupError) {
          rowEntries = [
            {
              name: `Fila ${rowNumber}`,
              status: 'Error',
              requestSummary: null,
              responseSummary: null,
              httpStatusCode: null,
              durationMs: 0,
              errorMessage: accountLookupError,
            },
          ];
        } else {
          try {
            rowEntries = await runOnce(inputs);
            stepEntries = rowEntries;
          } catch (err) {
            rowEntries = [
              {
                name: `Fila ${rowNumber}`,
                status: 'Error',
                requestSummary: null,
                responseSummary: null,
                httpStatusCode: null,
                durationMs: 0,
                errorMessage: err.message,
              },
            ];
          }
        }
      }

      for (let s = 0; s < flow.steps.length; s++) {
        const entry = stepEntries ? stepEntries[s] : null;
        const ok = !!entry && entry.status === 'Success';
        if (ok) stepCounts[s].ok++;
        else stepCounts[s].error++;
      }
      renderCsvSummary(flow, rows.length, stepCounts);

      // El último paso de este flow es el alta del plazo fijo; si terminó
      // bien, su respuesta trae un array "output" con 2 items por plazo fijo
      // (función 1 = capital, función 3 = interés) que comparten operación/
      // vencimiento/tem/tna/importeNeto — se unifican en UNA sola fila por
      // plazo fijo en state.pfDetailRows para descargar aparte como CSV. La
      // tabla de log paso a paso ya no se muestra en pantalla para flows CSV
      // (ver selectFlow); el detalle completo de cada request/response
      // sigue en logs/http.log.
      if (stepEntries) {
        const lastEntry = stepEntries[stepEntries.length - 1];
        if (lastEntry && lastEntry.status === 'Success' && lastEntry.responseSummary) {
          try {
            const parsed = JSON.parse(lastEntry.responseSummary);
            const output = Array.isArray(parsed.output) ? parsed.output : [];
            if (output.length > 0) {
              const capital = output.find((item) => item.funcion === 1);
              const interes = output.find((item) => item.funcion === 3);
              // Items con una función distinta de 1 (capital) o 3 (interés) no
              // deberían aparecer en la práctica, pero por si el banco agrega
              // otro concepto en el futuro, no se pierden en silencio.
              const otros = output.filter((item) => item.funcion !== 1 && item.funcion !== 3);
              const first = output[0];
              state.pfDetailRows.push({
                fila: rowNumber,
                operacion: first.operacion,
                vencimiento: first.vencimiento,
                tem: first.tem,
                tna: first.tna,
                importeNeto: first.importeNeto,
                montoCapital: capital ? capital.monto : '',
                montoInteres: interes ? interes.monto : '',
                otros: otros.length > 0
                  ? otros.map((item) => `función ${item.funcion}: ${item.monto} (${item.accesorio})`).join(' | ')
                  : '',
                idMensaje: rowIdMensaje,
              });
            }
          } catch (err) {
            // La respuesta no vino en el formato esperado (JSON con "output": [...]);
            // no se agrega detalle de esta fila, pero la fila sigue contando
            // como éxito en el resumen de arriba.
          }
        }
      }
      document.getElementById('downloadPfDetailBtn').disabled = state.pfDetailRows.length === 0;

      // Para "Recupera cuentas (SQL) Files": el último step SQL devuelve
      // {rows: [{sistcod, cuecod}, ...]} (a lo sumo un row por sistema 5 y
      // por sistema 4). Se arma la fila original del CSV + cuecodSistema5 +
      // cuecodSistema4 al final — siempre se agrega la fila (para no perder
      // la correspondencia 1:1 con el archivo de entrada), aunque no se
      // haya encontrado cuenta para alguno de los dos sistemas (queda "").
      if (isRecuperaCuentasSqlFilesFlow(flow)) {
        let cuecodSistema5 = '';
        let cuecodSistema4 = '';
        if (stepEntries) {
          const lastEntry = stepEntries[stepEntries.length - 1];
          if (lastEntry && lastEntry.status === 'Success' && lastEntry.responseSummary) {
            try {
              const parsed = JSON.parse(lastEntry.responseSummary);
              const sqlRows = Array.isArray(parsed.rows) ? parsed.rows : [];
              for (const sqlRow of sqlRows) {
                if (sqlRow.sistcod === 5) cuecodSistema5 = sqlRow.cuecod == null ? '' : String(sqlRow.cuecod);
                else if (sqlRow.sistcod === 4) cuecodSistema4 = sqlRow.cuecod == null ? '' : String(sqlRow.cuecod);
              }
            } catch (err) {
              // Respuesta no parseable como JSON: se agrega la fila igual, con
              // las dos columnas de cuecod en blanco.
            }
          }
        }
        state.enrichedCsvRows.push([...row, cuecodSistema5, cuecodSistema4]);
        document.getElementById('downloadEnrichedCsvBtn').disabled = state.enrichedCsvRows.length === 0;
      }

      const prefixed = rowEntries.map((entry) => ({ ...entry, name: `Fila ${rowNumber} — ${entry.name}` }));
      state.lastLog = state.lastLog.concat(prefixed);
      document.getElementById('saveLogBtn').disabled = state.lastLog.length === 0;
    }

    progressEl.textContent = `Listo: ${rows.length} fila(s) procesada(s) en ${formatDurationShort(Date.now() - startedAt)}.`;
  } catch (err) {
    alert('Error leyendo el CSV: ' + err.message);
  } finally {
    runBtn.disabled = false;
  }
}

function saveLog() {
  const lines = state.lastLog
    .map((e) => {
      let text = `[${e.status}] ${e.name} (${e.durationMs} ms)\n`;
      text += `  Request : ${e.requestSummary || ''}\n`;
      text += `  Response: HTTP ${e.httpStatusCode == null ? '' : e.httpStatusCode} - ${e.responseSummary || ''}\n`;
      if (e.errorMessage) text += `  Error   : ${e.errorMessage}\n`;
      return text;
    })
    .join('\n');

  const blob = new Blob([lines], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `flow-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const str = value == null ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function downloadPfDetail() {
  if (state.pfDetailRows.length === 0) return;

  const headers = ['fila', 'operacion', 'vencimiento', 'tem', 'tna', 'importeNeto', 'montoCapital', 'montoInteres', 'otros', 'idMensaje'];
  const lines = [headers.join(',')];
  for (const row of state.pfDetailRows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }

  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `plazos-fijos-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadEnrichedCsv() {
  if (state.enrichedCsvRows.length === 0) return;

  // Sin fila de encabezado, a propósito: este archivo está pensado para
  // subirse tal cual como entrada de "Plazo Fijo Cocos Files" (mismo orden
  // de columnas), que espera un CSV sin encabezado como cualquier otro flow
  // inputMode: "csv" de esta app.
  const lines = state.enrichedCsvRows.map((row) => row.map(csvEscape).join(','));

  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cuentas-agregadas-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const profileDialog = document.getElementById('profileDialog');
const profileForm = document.getElementById('profileForm');

function openProfileDialog(existing) {
  profileForm.reset();
  document.getElementById('profileDialogTitle').textContent = existing ? 'Editar perfil' : 'Nuevo perfil';

  if (existing) {
    profileForm.elements.name.value = existing.name || '';
    profileForm.elements.name.readOnly = true;
    profileForm.elements.baseUrl.value = existing.baseUrl || '';
    profileForm.elements.authType.value = existing.authType || 'Bearer';
    profileForm.elements.apiKeyHeaderName.value = existing.apiKeyHeaderName || '';
    profileForm.elements.tokenUrl.value = existing.tokenUrl || '';
    profileForm.elements.clientId.value = existing.clientId || '';
  } else {
    profileForm.elements.name.readOnly = false;
    profileForm.elements.authType.value = 'Bearer';
  }

  profileDialog.showModal();
}

document.getElementById('newProfileBtn').addEventListener('click', () => openProfileDialog(null));

document.getElementById('editProfileBtn').addEventListener('click', () => {
  const current = state.profiles.find((p) => p.name === document.getElementById('profileSelect').value);
  if (current) openProfileDialog(current);
});

document.getElementById('cancelProfileBtn').addEventListener('click', () => profileDialog.close());

document.getElementById('deleteProfileBtn').addEventListener('click', async () => {
  const name = document.getElementById('profileSelect').value;
  if (!name) return;
  if (!confirm(`¿Eliminar el perfil "${name}"?`)) return;
  await apiFetch('/api/profiles?name=' + encodeURIComponent(name), { method: 'DELETE' });
  await loadProfiles();
});

profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(profileForm);
  const payload = {};
  formData.forEach((value, key) => {
    payload[key] = value;
  });

  await apiFetch('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  profileDialog.close();
  await loadProfiles();
});

document.getElementById('runBtn').addEventListener('click', runFlow);
document.getElementById('saveLogBtn').addEventListener('click', saveLog);
document.getElementById('testTokenBtn').addEventListener('click', testToken);
document.getElementById('profileSelect').addEventListener('change', updateTestTokenButtonState);
document.getElementById('csvFileInput').addEventListener('change', updateRunButtonState);
document.getElementById('downloadPfDetailBtn').addEventListener('click', downloadPfDetail);
document.getElementById('downloadEnrichedCsvBtn').addEventListener('click', downloadEnrichedCsv);

const parametriaDialog = document.getElementById('parametriaDialog');
const parametriaForm = document.getElementById('parametriaForm');

async function openParametriaDialog() {
  parametriaForm.reset();

  const res = await apiFetch('/api/parametria');
  const data = await res.json();

  for (const [category, fields] of Object.entries(data || {})) {
    for (const [field, value] of Object.entries(fields || {})) {
      const el = parametriaForm.elements[`${category}.${field}`];
      if (el) el.value = value || '';
    }
  }

  parametriaDialog.showModal();
}

document.getElementById('parametriaBtn').addEventListener('click', openParametriaDialog);
document.getElementById('cancelParametriaBtn').addEventListener('click', () => parametriaDialog.close());

async function testSybaseConnection() {
  const btn = document.getElementById('testSybaseBtn');
  const resultSpan = document.getElementById('sybaseTestResult');
  const connectionString = parametriaForm.elements['sybase.connectionString'].value;
  const usuario = parametriaForm.elements['sybase.usuario'].value;
  const password = parametriaForm.elements['sybase.password'].value;

  btn.disabled = true;
  resultSpan.className = 'muted';
  resultSpan.textContent = 'Probando...';

  try {
    const res = await apiFetch('/api/test-sybase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionString, usuario, password }),
    });
    const data = await res.json();

    if (data.ok) {
      resultSpan.className = 'status-Success';
      resultSpan.textContent = `OK (${data.durationMs} ms)`;
    } else {
      resultSpan.className = 'status-Error';
      resultSpan.textContent = `Error: ${data.message}`;
    }
  } catch (err) {
    resultSpan.className = 'status-Error';
    resultSpan.textContent = 'Error de red: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('testSybaseBtn').addEventListener('click', testSybaseConnection);

parametriaForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(parametriaForm);
  const payload = {};
  formData.forEach((value, key) => {
    const [category, field] = key.split('.');
    if (!payload[category]) payload[category] = {};
    payload[category][field] = value;
  });

  await apiFetch('/api/parametria', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  parametriaDialog.close();
});

// --- Administración de usuarios y configuración de Active Directory --------
// Panel solo visible para rol 'admin' (usersBtn queda oculto para los demás en
// loadMe()); el servidor igual vuelve a chequear el rol en cada request de
// /api/users y /api/security-config, así que ocultar el botón acá es solo UX.

const usersDialog = document.getElementById('usersDialog');
const adConfigForm = document.getElementById('adConfigForm');
const userForm = document.getElementById('userForm');
let editingUsername = null; // null = alta de un usuario nuevo; si no, username que se está editando

async function loadAdConfig() {
  const res = await apiFetch('/api/security-config');
  if (!res.ok) return;
  const data = await res.json();
  const ad = data.ad || {};
  adConfigForm.elements.server.value = ad.server || '';
  adConfigForm.elements.port.value = ad.port || 389;
  adConfigForm.elements.useSsl.checked = !!ad.useSsl;
  adConfigForm.elements.domain.value = ad.domain || '';
}

function renderUsersTable(users) {
  const tbody = document.getElementById('usersTableBody');
  tbody.innerHTML = '';
  for (const user of users) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(user.username)}</td>
      <td>${escapeHtml(user.displayName)}</td>
      <td>${escapeHtml(user.role)}</td>
      <td>${user.enabled ? 'Sí' : 'No'}</td>
      <td>
        <button type="button" class="editUserBtn">Editar</button>
        <button type="button" class="deleteUserBtn">Eliminar</button>
      </td>
    `;
    tr.querySelector('.editUserBtn').addEventListener('click', () => startEditUser(user));
    tr.querySelector('.deleteUserBtn').addEventListener('click', () => deleteUser(user.username));
    tbody.appendChild(tr);
  }
}

async function loadUsersList() {
  const res = await apiFetch('/api/users');
  if (!res.ok) return;
  const users = await res.json();
  renderUsersTable(users);
}

function startEditUser(user) {
  editingUsername = user.username;
  document.getElementById('userFormLegend').textContent = `Editando "${user.username}"`;
  userForm.elements.username.value = user.username;
  userForm.elements.username.readOnly = true;
  userForm.elements.displayName.value = user.displayName || '';
  userForm.elements.role.value = user.role;
  userForm.elements.enabled.checked = !!user.enabled;
  document.getElementById('cancelUserEditBtn').style.display = '';
}

function resetUserForm() {
  editingUsername = null;
  userForm.reset();
  userForm.elements.username.readOnly = false;
  document.getElementById('userFormLegend').textContent = 'Nuevo usuario';
  document.getElementById('cancelUserEditBtn').style.display = 'none';
  document.getElementById('userFormResult').textContent = '';
}

async function deleteUser(username) {
  if (!confirm(`¿Eliminar el acceso de "${username}" a la aplicación? (esto no toca su cuenta de Active Directory)`)) return;
  const res = await apiFetch('/api/users?username=' + encodeURIComponent(username), { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'No se pudo eliminar el usuario.');
    return;
  }
  if (editingUsername === username) resetUserForm();
  await loadUsersList();
}

async function openUsersDialog() {
  resetUserForm();
  document.getElementById('adConfigSaveResult').textContent = '';
  await loadAdConfig();
  await loadUsersList();
  usersDialog.showModal();
}

document.getElementById('usersBtn').addEventListener('click', openUsersDialog);
document.getElementById('closeUsersDialogBtn').addEventListener('click', () => usersDialog.close());
document.getElementById('cancelUserEditBtn').addEventListener('click', resetUserForm);

adConfigForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const resultSpan = document.getElementById('adConfigSaveResult');
  const payload = {
    server: adConfigForm.elements.server.value,
    port: Number(adConfigForm.elements.port.value) || 389,
    useSsl: adConfigForm.elements.useSsl.checked,
    domain: adConfigForm.elements.domain.value,
  };

  const res = await apiFetch('/api/security-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();

  resultSpan.className = res.ok ? 'status-Success' : 'status-Error';
  resultSpan.textContent = res.ok ? 'Guardado.' : data.error || 'Error al guardar.';
});

userForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const resultSpan = document.getElementById('userFormResult');
  const payload = {
    username: userForm.elements.username.value.trim(),
    displayName: userForm.elements.displayName.value,
    role: userForm.elements.role.value,
    enabled: userForm.elements.enabled.checked,
  };

  const res = await apiFetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();

  if (!res.ok) {
    resultSpan.className = 'status-Error';
    resultSpan.textContent = data.error || 'Error al guardar el usuario.';
    return;
  }

  resetUserForm();
  await loadUsersList();
});

// --- Login / logout ---------------------------------------------------------

const loginForm = document.getElementById('loginForm');

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = document.getElementById('loginError');
  const btn = document.getElementById('loginSubmitBtn');
  const username = loginForm.elements.username.value.trim();
  const password = loginForm.elements.password.value;

  errorEl.style.display = 'none';
  btn.disabled = true;
  try {
    await login(username, password);
    await startApp();
    loginForm.reset();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = '';
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('logoutBtn').addEventListener('click', logout);

async function startApp() {
  await loadMe();
  showAppShell();
  await loadProfiles();
  await loadFlows();
}

(async function init() {
  if (!state.token) {
    showLoginScreen();
    return;
  }
  try {
    await startApp();
  } catch (err) {
    // El token guardado ya no sirve (servidor reiniciado, sesión vencida, etc.)
    clearSession();
    showLoginScreen();
  }
})();
