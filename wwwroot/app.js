const state = {
  profiles: [],
  flows: [],
  selectedFlow: null,
  lastLog: [],
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

  if (isCsvFlow(state.selectedFlow)) {
    form.style.display = 'none';
    csvSection.style.display = '';
    const columnList = inputs.map((i) => i.label || i.variableName).join(', ');
    document.getElementById('csvColumnsHint').textContent =
      `El CSV no lleva encabezado. Orden de columnas: ${columnList}.`;
  } else {
    form.style.display = '';
    csvSection.style.display = 'none';

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

  const form = document.getElementById('inputsForm');
  const inputs = {};
  new FormData(form).forEach((value, key) => {
    inputs[key] = value;
  });

  try {
    state.lastLog = await runOnce(inputs);
    renderLog(state.lastLog);
    document.getElementById('saveLogBtn').disabled = state.lastLog.length === 0;
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

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 1;
      progressEl.textContent = `Procesando fila ${rowNumber} de ${rows.length}...`;

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

      const prefixed = rowEntries.map((entry) => ({ ...entry, name: `Fila ${rowNumber} — ${entry.name}` }));
      state.lastLog = state.lastLog.concat(prefixed);
      renderLog(state.lastLog);
      document.getElementById('saveLogBtn').disabled = state.lastLog.length === 0;
    }

    progressEl.textContent = `Listo: ${rows.length} fila(s) procesada(s).`;
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
