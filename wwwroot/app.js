const state = {
  profiles: [],
  flows: [],
  selectedFlow: null,
  lastLog: [],
  pfDetailRows: [],
};

async function loadProfiles() {
  const res = await fetch('/api/profiles');
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
    const res = await fetch('/api/test-token', {
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
  const res = await fetch('/api/flows');
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
  state.pfDetailRows = [];
  document.getElementById('downloadPfDetailBtn').disabled = true;

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
    // "Recupera cuentas" tampoco muestra la tabla de log: la respuesta es un
    // volcado de JSON enorme e ilegible en la tabla, y el panel filtrado
    // (#recuperaCuentasResult) ya muestra lo que hace falta. El detalle
    // completo sigue en logs/http.log y en "Guardar log...".
    document.getElementById('logTable').style.display = isRecuperaCuentasFlow(state.selectedFlow) ? 'none' : '';

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
// sistema 4 o 5 y código de estado de cuenta 1 (activa), sin repetir
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
    if (item.codigoEstadoCuenta !== 1) continue;
    const key = `${item.codigoSistema}|${item.codigoCuenta}|${item.codigoMoneda}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ codigoSistema: item.codigoSistema, codigoCuenta: item.codigoCuenta, codigoMoneda: item.codigoMoneda });
  }

  if (rows.length === 0) {
    el.innerHTML = '<div>No se encontraron cuentas con código de sistema 4 o 5 y código de estado de cuenta 1 en la respuesta.</div>';
    el.style.display = '';
    return;
  }

  const lines = ['<div><strong>Cuentas (código de sistema 4 y 5, código de estado de cuenta 1)</strong></div>'];
  for (const row of rows) {
    lines.push(
      `<div>Código de sistema ${escapeHtml(row.codigoSistema)}: código de cuenta ${escapeHtml(row.codigoCuenta)}, ` +
        `código de moneda ${escapeHtml(row.codigoMoneda)}</div>`
    );
  }
  el.innerHTML = lines.join('');
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

async function runOnce(inputs) {
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profileName: document.getElementById('profileSelect').value,
      flowName: state.selectedFlow.name,
      inputs,
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error((data && data.error) || 'Error ejecutando el flow.');
  }

  return Array.isArray(data) ? data : [data];
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

  const headers = ['fila', 'operacion', 'vencimiento', 'tem', 'tna', 'importeNeto', 'montoCapital', 'montoInteres', 'otros'];
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
  await fetch('/api/profiles?name=' + encodeURIComponent(name), { method: 'DELETE' });
  await loadProfiles();
});

profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(profileForm);
  const payload = {};
  formData.forEach((value, key) => {
    payload[key] = value;
  });

  await fetch('/api/profiles', {
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

const parametriaDialog = document.getElementById('parametriaDialog');
const parametriaForm = document.getElementById('parametriaForm');

async function openParametriaDialog() {
  parametriaForm.reset();

  const res = await fetch('/api/parametria');
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

parametriaForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(parametriaForm);
  const payload = {};
  formData.forEach((value, key) => {
    const [category, field] = key.split('.');
    if (!payload[category]) payload[category] = {};
    payload[category][field] = value;
  });

  await fetch('/api/parametria', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  parametriaDialog.close();
});

(async function init() {
  await loadProfiles();
  await loadFlows();
})();
