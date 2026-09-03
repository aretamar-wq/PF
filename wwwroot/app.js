const state = {
  profiles: [],
  flows: [],
  selectedFlow: null,
  lastLog: [],
  pfDetailRows: [],
  errorRows: [],
  successfulOperations: [],
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
  document.getElementById('parametriaBtn').style.display = state.currentUser.canManageParametria ? '' : 'none';

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
  hideSqlResult();
  state.pfDetailRows = [];
  state.errorRows = [];
  state.successfulOperations = [];

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
    // Un flow con un step SQL tampoco muestra la tabla de log: la respuesta
    // es una tabla más legible en su propio panel (#sqlResultPanel) que como
    // fila de la tabla genérica. El detalle completo sigue en logs/http.log
    // y en "Guardar log...".
    document.getElementById('logTable').style.display = isSqlFlow(state.selectedFlow) ? 'none' : '';

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

// Parsea una línea de CSV respetando comillas envolventes: un campo que
// arranca con " puede contener comas (no corta ahí) hasta la comilla de
// cierre, y "" adentro de un campo entrecomillado es una comilla literal
// (misma regla que usa Excel al exportar). Sin esto, "Apellido y Nombre"
// con el formato típico "APELLIDO, Nombre" partía la fila en dos columnas
// de más y desalineaba todo lo que venía después (importe/plazo/etc. en la
// columna equivocada, sin ningún error visible).
function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function parseCsvText(text) {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseCsvLine);
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
    const { ok, error, skipped } = stepCounts[idx];
    const skippedHtml = skipped > 0 ? ` / <span>${skipped} sin ejecutar (Circuito = 1)</span>` : '';
    lines.push(
      `<div>${escapeHtml(step.name)}: ` +
        `<span class="status-Success">${ok} correcto(s)</span> / ` +
        `<span class="status-Error">${error} con error</span>${skippedHtml}</div>`
    );
  });
  summaryEl.innerHTML = lines.join('');
  summaryEl.style.display = '';
}

// Genérico para cualquier flow cuyo último step sea "type": "sql" — hoy solo
// "Recupera cuentas (SQL)" (oculto de la lista pero se puede correr por
// nombre), pero sirve para cualquier otro flow SQL que se agregue después.
function isSqlFlow(flow) {
  return !!flow && Array.isArray(flow.steps) && flow.steps.some((step) => step.type === 'sql');
}

// Mismo formato que modules/FlowEngine.psm1 genera para {{idMensajeGenerado}}
// (PFC + yyyyMMddHHmmssfff, con milisegundos al final para que no se repita
// entre filas de un mismo archivo). Se genera acá (no solo en el servidor) y
// se manda como input por fila para que "Alta de Plazo Fijos - File" lo
// use (un input del usuario pisa la variable de sistema del mismo nombre) —
// así el cliente sabe el valor exacto que se usó en cada fila, para poder
// agregarlo al final de "Descargar detalle de Plazos Fijos..." (el
// servidor no lo devuelve en la respuesta).
function generateIdMensaje() {
  const now = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const stamp =
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds()) +
    pad(now.getMilliseconds(), 3);
  return `PFC${stamp}`;
}

// Acoplado a este flow puntual: no tiene ningún step SQL propio (a
// diferencia de la primera versión) — la búsqueda de cuentas se hace UNA
// sola vez para todo el archivo, antes del loop de filas (ver
// fetchAccountsByCuit / runFlowFromCsv), en vez de una consulta por fila.
function isPlazoFijoCocosFilesSqlFlow(flow) {
  return !!flow && flow.name === 'Alta de Plazo Fijos - File';
}

// Cuando la columna Circuito de una fila viene en 1, no se ejecutan los
// steps de débito en Cuenta Corriente ni crédito en Caja de Ahorro: se corre
// este flow oculto, que tiene solo el step "3. Alta de Plazo Fijo" (mismo
// body). Las cuentas (cuecodSistema5/cuecodSistema4) igual se resuelven para
// TODAS las filas antes del loop, vía fetchAccountsByCuit — no depende de
// Circuito.
const PLAZO_FIJO_SOLO_ALTA_FLOW_NAME = 'Alta de Plazo Fijo (solo)';

// Manda al servidor las (cuit, numeroComprobante) de TODAS las filas del
// archivo en una sola consulta (evita duplicar una operación bancaria real
// por subir el mismo archivo dos veces, o por repetir un comprobante en
// otro archivo distinto). Devuelve un Set con "cuit|numeroComprobante" de
// las que ya se habían procesado antes, para bloquear esas filas puntuales
// sin llegar a llamar a ningún endpoint del banco.
async function checkDuplicateOperations(rows) {
  const operations = rows.map((row) => ({
    cuit: (row[0] || '').trim(),
    numeroComprobante: (row[4] || '').trim(),
  }));

  const res = await apiFetch('/api/check-operations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operations }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Error desconocido.');
  }

  return new Set((data.duplicates || []).map((d) => `${d.cuit}|${d.numeroComprobante}`));
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
    // Comparar como string, no como number: el backend PowerShell (ODBC)
    // devuelve sistcod como número real de .NET (columna INT sin castear en
    // la query), pero el backend Node.js (parsea texto de isql, sin tipos)
    // siempre lo devuelve como string — "5" === 5 da false y ninguna fila
    // matchea nunca, aunque Sybase sí haya encontrado la cuenta.
    const sistcod = String(sqlRow.sistcod);
    if (sistcod === '5') entry.cuecodSistema5 = sqlRow.cuecod == null ? '' : String(sqlRow.cuecod);
    else if (sistcod === '4') entry.cuecodSistema4 = sqlRow.cuecod == null ? '' : String(sqlRow.cuecod);
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
    if (isSqlFlow(state.selectedFlow)) {
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
  state.errorRows = [];
  state.successfulOperations = [];

  // stepCounts[i] cuenta, para el paso flow.steps[i], cuántas filas lo
  // completaron con éxito ('ok'), cuántas no ('error') — ya sea porque ese
  // paso falló, porque no llegó a ejecutarse (un paso anterior de la misma
  // fila falló), o porque la fila entera no se pudo correr (columnas de
  // más/menos, o un error de red/servidor antes de tener respuesta) — y
  // cuántas se saltearon a propósito ('skipped', fila con Circuito = 1: no
  // se ejecutan los steps de débito/crédito, solo el alta de Plazo Fijo).
  const stepCounts = flow.steps.map(() => ({ ok: 0, error: 0, skipped: 0 }));

  try {
    const text = await readFileAsText(file);
    const rows = parseCsvText(text);

    if (rows.length === 0) {
      alert('El archivo CSV no tiene ninguna fila con datos.');
      return;
    }

    // Antes de tocar nada: chequear qué (cuit, numeroComprobante) del archivo
    // ya se procesaron con éxito antes — evita duplicar una operación
    // bancaria real por subir el mismo archivo dos veces (o repetir un
    // comprobante en otro archivo). Si esto falla, se aborta el archivo
    // entero (fail-safe: no seguir de largo sin haber podido chequear).
    let duplicateOps = new Set();
    if (isPlazoFijoCocosFilesSqlFlow(flow)) {
      progressEl.textContent = 'Verificando operaciones ya procesadas...';
      try {
        duplicateOps = await checkDuplicateOperations(rows);
      } catch (err) {
        alert('No se pudo verificar operaciones duplicadas, se aborta el archivo por seguridad: ' + err.message);
        return;
      }
    }

    // Para "Alta de Plazo Fijos - File": UNA sola consulta a Sybase con
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
      let stepEntries = null; // solo se llena con la respuesta real de /api/run, alineada con expectedStepIndices
      // Por default (Circuito = 0, o fila que ni llega a leer Circuito) se
      // corren los 3 steps del flow. Circuito = 1 corre solo el step 3 (ver
      // más abajo) — expectedStepIndices son los índices de flow.steps que
      // esta fila debía correr, usados también para el resumen por step.
      let expectedStepIndices = flow.steps.map((_, idx) => idx);

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

        // Circuito = 0: flujo completo (débito CC + crédito CA + alta de PF,
        // como siempre). Circuito = 1: solo se recuperan las cuentas (ya
        // resueltas para todas las filas por fetchAccountsByCuit) y se
        // ejecuta únicamente la API de alta de Plazo Fijo, sin tocar Cuenta
        // Corriente ni Caja de Ahorro. Cualquier otro valor es inválido.
        let circuitoError = null;
        let runSoloAlta = false;
        if (isPlazoFijoCocosFilesSqlFlow(flow)) {
          const circuito = (row[row.length - 1] || '').trim();
          if (circuito === '1') {
            runSoloAlta = true;
            expectedStepIndices = [flow.steps.length - 1];
          } else if (circuito !== '0') {
            circuitoError = `El campo Circuito debe ser 0 o 1 (vino "${row[row.length - 1]}").`;
          }
        }

        // Cuentas ya resueltas por fetchAccountsByCuit (una sola consulta
        // para todo el archivo, antes del loop) — cuecodSistema5 (Caja de
        // Ahorro) es obligatoria: si no se encontró, la fila queda en error
        // sin llamar a ningún endpoint del banco (mismo criterio de
        // seguridad que antes tenía el step SQL con requireVariables, pero
        // ahora resuelto acá porque el flow ya no tiene ese step).
        // cuecodSistema4 (Plazo Fijo) es opcional: si no se encontró, se
        // manda 'null' (texto) para que el step 3 lo omita vía omitIfNull.
        // Operación ya procesada antes (mismo cuit + numeroComprobante) — se
        // bloquea sin llamar a ningún endpoint del banco, para no duplicar un
        // débito/crédito/alta de plazo fijo real. Se chequea antes que la
        // cuenta: si ya se hizo, no hace falta ni buscarla.
        let duplicateError = null;
        if (isPlazoFijoCocosFilesSqlFlow(flow)) {
          const key = `${(row[0] || '').trim()}|${(row[4] || '').trim()}`;
          if (duplicateOps.has(key)) {
            duplicateError = `Esta operación (CUIT ${row[0]}, comprobante ${row[4]}) ya fue procesada antes — se bloquea para evitar una operación bancaria duplicada.`;
          }
        }

        // Cuentas ya resueltas por fetchAccountsByCuit (una sola consulta
        // para todo el archivo, antes del loop) — cuecodSistema5 (Caja de
        // Ahorro) es obligatoria: si no se encontró, la fila queda en error
        // sin llamar a ningún endpoint del banco (mismo criterio de
        // seguridad que antes tenía el step SQL con requireVariables, pero
        // ahora resuelto acá porque el flow ya no tiene ese step).
        // cuecodSistema4 (Plazo Fijo) es opcional: si no se encontró, se
        // manda 'null' (texto) para que el step 3 lo omita vía omitIfNull.
        let accountLookupError = null;
        if (!duplicateError && isPlazoFijoCocosFilesSqlFlow(flow)) {
          const cuit = (row[0] || '').trim();
          const accounts = accountsByCuit.get(cuit);
          if (!accounts || !accounts.cuecodSistema5) {
            accountLookupError = `No se encontró cuenta de Caja de Ahorro (código de sistema 5) en Sybase para el CUIT ${cuit}.`;
          } else {
            inputs.cuecodSistema5 = accounts.cuecodSistema5;
            inputs.cuecodSistema4 = accounts.cuecodSistema4 || 'null';
          }
        }

        if (duplicateError || accountLookupError || circuitoError) {
          rowEntries = [
            {
              name: `Fila ${rowNumber}`,
              status: 'Error',
              requestSummary: null,
              responseSummary: null,
              httpStatusCode: null,
              durationMs: 0,
              errorMessage: duplicateError || accountLookupError || circuitoError,
            },
          ];
        } else {
          try {
            rowEntries = runSoloAlta
              ? await runFlowByName(PLAZO_FIJO_SOLO_ALTA_FLOW_NAME, inputs)
              : await runOnce(inputs);
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
        if (!expectedStepIndices.includes(s)) {
          stepCounts[s].skipped++;
          continue;
        }
        const entry = stepEntries ? stepEntries[expectedStepIndices.indexOf(s)] : null;
        const ok = !!entry && entry.status === 'Success';
        if (ok) stepCounts[s].ok++;
        else stepCounts[s].error++;
      }
      renderCsvSummary(flow, rows.length, stepCounts);

      // Fila fallada: columnas de más/menos, cuenta no encontrada (nunca
      // llegó a llamar a ningún endpoint), o algún paso terminó en error.
      // Se guarda la fila tal cual vino en el archivo (aunque esté mal
      // formada) + el IdMensaje que se le generó, para el archivo
      // pfouterror-... — ver saveOutputFiles.
      const rowFailed = rowEntries.some((entry) => entry.status !== 'Success');
      if (rowFailed) {
        state.errorRows.push([...row, rowIdMensaje]);
      }

      // El último paso de este flow es el alta del plazo fijo; si terminó
      // bien, su respuesta trae un array "output" con 2 items por plazo fijo
      // (función 1 = capital, función 3 = interés) que comparten operación/
      // vencimiento/tem/tna/importeNeto — se unifican en UNA sola fila por
      // plazo fijo en state.pfDetailRows, para guardar aparte como CSV al
      // terminar (ver saveOutputFiles). La tabla de log paso a paso ya no se
      // muestra en pantalla para flows CSV
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
                numeroComprobante: row[4],
                cuit: row[0],
                apellidoNombre: row[1],
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
              // Se registra como operación exitosa (para bloquear un futuro
              // reintento del mismo cuit+numeroComprobante) recién acá, con
              // el mismo criterio que decide si entra a pfDetailRows — nunca
              // antes de haber confirmado la alta real del plazo fijo.
              state.successfulOperations.push({
                cuit: (row[0] || '').trim(),
                numeroComprobante: (row[4] || '').trim(),
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

      const prefixed = rowEntries.map((entry) => ({ ...entry, name: `Fila ${rowNumber} — ${entry.name}` }));
      state.lastLog = state.lastLog.concat(prefixed);
      document.getElementById('saveLogBtn').disabled = state.lastLog.length === 0;
    }

    let doneText = `Listo: ${rows.length} fila(s) procesada(s) en ${formatDurationShort(Date.now() - startedAt)}.`;

    if (state.successfulOperations.length > 0) {
      try {
        await apiFetch('/api/register-operations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operations: state.successfulOperations }),
        });
      } catch (err) {
        // Si esto falla, las operaciones que sí se dieron de alta no quedan
        // protegidas contra un reintento futuro del mismo archivo — hay que
        // avisar, no fallar en silencio.
        alert('Atención: no se pudieron registrar las operaciones exitosas para evitar duplicados en el futuro: ' + err.message);
      }
    }

    const savedFiles = await saveOutputFiles();
    if (savedFiles.length > 0) {
      doneText += ` Guardado en files/: ${savedFiles.join(', ')}.`;
    }
    progressEl.textContent = doneText;
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

// Dispara la descarga del navegador para un archivo de texto ya generado en
// memoria (mismo patrón que saveLog para el log en .txt).
function downloadTextFile(fileName, content, mimeType) {
  const blob = new Blob([content], { type: mimeType || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
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

// yyyyMMddHHmmss (sin milisegundos, a diferencia de generateIdMensaje) —
// nombre de archivo, no necesita esa resolución.
function generateFileTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

// Guarda un archivo en el servidor, en la carpeta files/ (POST /api/save-output
// lo crea si no existe) — queda en una ubicación fija y predecible, accesible
// después desde "Archivos de salida" (ver loadOutputFiles) — y además dispara
// la descarga automática al navegador de quien corrió el flow.
async function saveOutputFile(prefix, timestamp, content) {
  try {
    const res = await apiFetch('/api/save-output', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, timestamp, content }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(`No se pudo guardar ${prefix}${timestamp}.csv: ` + (data.error || 'error desconocido.'));
      return null;
    }
    downloadTextFile(data.fileName, content, 'text/csv');
    return data.fileName;
  } catch (err) {
    alert(`Error de red guardando ${prefix}${timestamp}.csv: ` + err.message);
    return null;
  }
}

// Al terminar de procesar el CSV: guarda, si corresponde, hasta 2 archivos
// con el mismo timestamp (para que se identifiquen como del mismo lote) —
// pfout-<timestamp>.csv con el detalle de los plazos fijos dados de alta
// (una fila por PF, igual que antes armaba el botón de descarga) y
// pfouterror-<timestamp>.csv con la fila de entrada + IdMensaje de cada
// fila que falló (columnas de más/menos, cuenta no encontrada, o algún
// paso del banco en error), para poder revisarlas o reintentarlas.
async function saveOutputFiles() {
  const savedFiles = [];
  if (state.pfDetailRows.length === 0 && state.errorRows.length === 0) return savedFiles;

  const timestamp = generateFileTimestamp();

  if (state.pfDetailRows.length > 0) {
    const headers = ['numeroComprobante', 'cuit', 'apellidoNombre', 'operacion', 'vencimiento', 'tem', 'tna', 'importeNeto', 'montoCapital', 'montoInteres', 'otros', 'idMensaje'];
    const lines = [headers.join(',')];
    for (const row of state.pfDetailRows) {
      lines.push(headers.map((h) => csvEscape(row[h])).join(','));
    }
    const fileName = await saveOutputFile('pfout-', timestamp, lines.join('\r\n'));
    if (fileName) savedFiles.push(fileName);
  }

  if (state.errorRows.length > 0) {
    // Sin fila de encabezado, a propósito: cada fila queda igual a como
    // vino en el archivo de entrada (que tampoco lleva encabezado) más el
    // IdMensaje al final.
    const lines = state.errorRows.map((row) => row.map(csvEscape).join(','));
    const fileName = await saveOutputFile('pfouterror-', timestamp, lines.join('\r\n'));
    if (fileName) savedFiles.push(fileName);
  }

  return savedFiles;
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
    profileForm.elements.clientCertPath.value = existing.clientCertPath || '';
    profileForm.elements.clientKeyPath.value = existing.clientKeyPath || '';
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

// Drag & drop del CSV: asigna el archivo soltado al input nativo vía
// DataTransfer y dispara "change" sobre él, en vez de manejar el File por
// separado — así runFlowFromCsv (que lee csvFileInput.files[0]) y
// updateRunButtonState (que mira csvFileInput.files.length) funcionan igual
// que con el selector de archivos de toda la vida, sin tocar esa lógica.
const csvDropZone = document.getElementById('csvDropZone');

// Sin esto, soltar el archivo fuera de la zona (o en cualquier lado si el
// usuario erra) hace que el navegador navegue a mostrarlo como si fuera una
// URL local.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

['dragenter', 'dragover'].forEach((eventName) => {
  csvDropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    csvDropZone.classList.add('dragover');
  });
});

csvDropZone.addEventListener('dragleave', (event) => {
  // dragleave también dispara al pasar sobre el <label>/<input> de adentro;
  // sin este chequeo la zona parpadea (se saca y se pone el resaltado) todo
  // el tiempo que el mouse se mueve arriba.
  if (!csvDropZone.contains(event.relatedTarget)) {
    csvDropZone.classList.remove('dragover');
  }
});

csvDropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  csvDropZone.classList.remove('dragover');

  const file = event.dataTransfer.files && event.dataTransfer.files[0];
  if (!file) return;

  const csvFileInput = document.getElementById('csvFileInput');
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  csvFileInput.files = dataTransfer.files;
  csvFileInput.dispatchEvent(new Event('change'));
});

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

// --- Archivos de salida (pfout-.../pfouterror-... guardados en files/) -----
// Además de la descarga automática al terminar un CSV (ver saveOutputFile),
// este panel deja ver y volver a descargar cualquier archivo ya guardado en
// el servidor — útil si se cerró el navegador antes de que la descarga
// terminara, o si hace falta recuperar el de una corrida anterior.

const outputFilesDialog = document.getElementById('outputFilesDialog');
const outputFilesFromDate = document.getElementById('outputFilesFromDate');
const outputFilesToDate = document.getElementById('outputFilesToDate');
let allOutputFiles = []; // última lista traída del servidor, sin filtrar — el filtro de fecha se aplica en el cliente

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// pfout-... = detalle de plazos fijos dados de alta; pfouterror-... = filas
// que fallaron (ver "Archivos de salida (files/)" en el README).
function outputFileTypeLabel(name) {
  return name.startsWith('pfouterror-') ? 'Filas con error' : 'Detalle de Plazos Fijos';
}

function renderOutputFilesTable(files) {
  const tbody = document.getElementById('outputFilesTableBody');
  tbody.innerHTML = '';
  for (const file of files) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(file.name)}</td>
      <td>${escapeHtml(outputFileTypeLabel(file.name))}</td>
      <td>${new Date(file.mtime).toLocaleString()}</td>
      <td>${formatFileSize(file.size)}</td>
      <td><button type="button" class="downloadOutputFileBtn">Descargar</button></td>
    `;
    tr.querySelector('.downloadOutputFileBtn').addEventListener('click', () => downloadOutputFile(file.name));
    tbody.appendChild(tr);
  }
  document.getElementById('outputFilesEmptyHint').style.display = files.length === 0 ? '' : 'none';
}

// Compara solo la parte de fecha (yyyy-mm-dd, hora local) de file.mtime contra
// los <input type="date"> Desde/Hasta — ambos límites inclusive.
function applyOutputFilesFilter() {
  const from = outputFilesFromDate.value;
  const to = outputFilesToDate.value;
  const filtered = allOutputFiles.filter((file) => {
    const fileDate = formatDateOnlyLocal(new Date(file.mtime));
    if (from && fileDate < from) return false;
    if (to && fileDate > to) return false;
    return true;
  });
  renderOutputFilesTable(filtered);
}

function formatDateOnlyLocal(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function loadOutputFilesList() {
  const res = await apiFetch('/api/output-files');
  if (!res.ok) return;
  allOutputFiles = await res.json();
  applyOutputFilesFilter();
}

async function downloadOutputFile(name) {
  const res = await apiFetch('/api/output-files/content?name=' + encodeURIComponent(name));
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'No se pudo descargar el archivo.');
    return;
  }
  downloadTextFile(data.name, data.content, 'text/csv');
}

async function openOutputFilesDialog() {
  outputFilesFromDate.value = '';
  outputFilesToDate.value = '';
  await loadOutputFilesList();
  outputFilesDialog.showModal();
}

document.getElementById('outputFilesBtn').addEventListener('click', openOutputFilesDialog);
document.getElementById('closeOutputFilesDialogBtn').addEventListener('click', () => outputFilesDialog.close());
document.getElementById('refreshOutputFilesBtn').addEventListener('click', loadOutputFilesList);
document.getElementById('clearOutputFilesFilterBtn').addEventListener('click', () => {
  outputFilesFromDate.value = '';
  outputFilesToDate.value = '';
  applyOutputFilesFilter();
});
outputFilesFromDate.addEventListener('change', applyOutputFilesFilter);
outputFilesToDate.addEventListener('change', applyOutputFilesFilter);

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
