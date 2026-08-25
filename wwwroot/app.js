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

function selectFlow(name) {
  state.selectedFlow = state.flows.find((f) => f.name === name) || null;

  document.querySelectorAll('#flowList li').forEach((li) => {
    li.classList.toggle('selected', li.dataset.flowName === name);
  });

  document.getElementById('flowDescription').textContent = state.selectedFlow
    ? state.selectedFlow.description
    : 'Elegí un flow de la lista.';

  const form = document.getElementById('inputsForm');
  form.innerHTML = '';
  const inputs = (state.selectedFlow && state.selectedFlow.inputs) || [];
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

  document.getElementById('runBtn').disabled = !state.selectedFlow;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
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
      <td>${escapeHtml(entry.errorMessage || entry.responseSummary)}</td>
    `;
    logBody.appendChild(tr);
  }
}

async function runFlow() {
  if (!state.selectedFlow) return;

  const runBtn = document.getElementById('runBtn');
  runBtn.disabled = true;
  document.getElementById('logBody').innerHTML = '';

  const form = document.getElementById('inputsForm');
  const inputs = {};
  new FormData(form).forEach((value, key) => {
    inputs[key] = value;
  });

  try {
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
      alert((data && data.error) || 'Error ejecutando el flow.');
      return;
    }

    state.lastLog = Array.isArray(data) ? data : [data];
    renderLog(state.lastLog);
    document.getElementById('saveLogBtn').disabled = state.lastLog.length === 0;
  } catch (err) {
    alert('Error de red: ' + err.message);
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

(async function init() {
  await loadProfiles();
  await loadFlows();
})();
