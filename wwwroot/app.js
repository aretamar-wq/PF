const state = {
  profiles: [],
  flows: [],
  selectedFlow: null,
  lastLog: [],
  pfDetailRows: [],
  debinDetailRows: [],
  debinConsultaRows: [],
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
  // El buscador de certificado/clave pega contra /api/certs-browse, que el
  // servidor rechaza igual que Parametría para roles sin ese permiso — acá
  // solo se oculta el botón, no es la única defensa.
  document.getElementById('browseCertPathBtn').style.display = state.currentUser.canManageParametria ? '' : 'none';

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

// Todas las secciones que ocupan el área principal (a la derecha del listado
// de flows) se muestran de una a la vez: mostrar una implica ocultar el
// resto. Ningún panel (perfil, parametría, usuarios, archivos de salida) se
// abre como <dialog> flotante, todos reemplazan el contenido de esta área.
const MAIN_SECTION_IDS = ['flowDetail', 'outputFilesSection', 'profileSection', 'parametriaSection', 'usersSection'];

function showMainSection(id) {
  for (const sectionId of MAIN_SECTION_IDS) {
    document.getElementById(sectionId).style.display = sectionId === id ? '' : 'none';
  }
}

function selectFlow(name) {
  // Si algún otro panel está mostrado en vez de flowDetail, elegir un flow de
  // la lista tiene que volver a la vista normal.
  showMainSection('flowDetail');

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
  state.debinDetailRows = [];
  state.debinConsultaRows = [];
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
      `La primera línea del CSV es el encabezado (se ignora). Orden de columnas: ${columnList}.`;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hideCsvSummary() {
  const summaryEl = document.getElementById('csvSummary');
  summaryEl.style.display = 'none';
  summaryEl.innerHTML = '';
}

// Traduce una entry en Error a una etiqueta corta de motivo, cuando el step
// sabe distinguir POR QUÉ falló (ver isVariableMismatch/isBusinessRejection
// en flowEngine.js — hoy solo los steps de "Transferencia DEBIN - File" los
// usan). Un step que no distingue motivos, o una entry que ni siquiera llegó
// a correr (un step anterior de la misma fila falló antes), cae en un cubo
// genérico — sigue sumando al total de "con error" igual, solo que sin
// desglose.
function classifyStepErrorType(entry) {
  if (!entry) return 'No se llegó a ejecutar';
  if (entry.isVariableMismatch) return 'CUIT no coincide con el CBU';
  if (entry.isBusinessRejection) return entry.businessRejectionMessage || 'Rechazo de negocio';
  return 'Otro motivo';
}

// stepCounts es un array paralelo a flow.steps: stepCounts[i] = { ok, error }
// contando, por cada fila del CSV, si ese paso terminó en 'Success' o no
// (no ejecutado por una fila mal formada, por una falla de red, o porque un
// paso anterior de la misma fila falló, cuenta como error de ese paso).
// contraasientoCounts (opcional) cuenta, por fila, si se dispararon
// contra-asientos (onFailureSteps del flow, ver flowEngine.js) y si
// terminaron bien o no — ver runFlowFromCsv. Solo se muestra la línea si
// alguna fila los disparó (la mayoría de las corridas nunca los necesita).
function renderCsvSummary(flow, totalRows, stepCounts, contraasientoCounts) {
  const summaryEl = document.getElementById('csvSummary');
  const lines = [`<div><strong>Total de registros: ${totalRows}</strong></div>`];
  flow.steps.forEach((step, idx) => {
    const { ok, error, skipped, errorTypes } = stepCounts[idx];
    const skippedHtml = skipped > 0 ? ` / <span>${skipped} sin ejecutar (Circuito = 1)</span>` : '';
    // Desglose de motivos de error (opcional): además de cuántas filas
    // fallaron, cuántas por cada motivo puntual que el step sepa distinguir
    // (ver classifyStepErrorType) — así el semáforo no solo dice "hay
    // errores", dice de qué tipo son sin tener que abrir el CSV de errores.
    const errorTypeEntries = Object.entries(errorTypes || {}).filter(([, count]) => count > 0);
    const errorTypesHtml =
      errorTypeEntries.length > 0
        ? ` <span class="muted">(${errorTypeEntries.map(([label, count]) => `${count} ${escapeHtml(label)}`).join(', ')})</span>`
        : '';
    lines.push(
      `<div>${escapeHtml(step.name)}: ` +
        `<span class="status-Success">${ok} correcto(s)</span> / ` +
        `<span class="status-Error">${error} con error</span>${errorTypesHtml}${skippedHtml}</div>`
    );
  });
  if (contraasientoCounts && (contraasientoCounts.ok > 0 || contraasientoCounts.error > 0)) {
    lines.push(
      `<div>Contra-asientos (reversión por alta de PF fallida): ` +
        `<span class="status-Success">${contraasientoCounts.ok} correcto(s)</span> / ` +
        `<span class="status-Error">${contraasientoCounts.error} con error</span></div>`
    );
  }
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

// Banco/Sucursal (crédito y débito) y mismoTitular no vienen como columna del
// CSV: se calculan acá a partir del CBU y el CUIT de cada fila (el motor de
// templates solo hace reemplazo de {{var}}, no puede recortar strings ni
// comparar valores) y se inyectan como inputs extra antes de correr la fila —
// ver runFlowFromCsv.
function isTransferenciaDebinFilesFlow(flow) {
  return !!flow && flow.name === 'Transferencia DEBIN - File';
}

// Cuando la columna Circuito de una fila viene en 1, no se ejecutan los
// steps de débito en Cuenta Corriente ni crédito en Caja de Ahorro: se corre
// este flow oculto, que tiene solo el step "3. Alta de Plazo Fijo" (mismo
// body). Las cuentas (cuecodSistema5/cuecodSistema4) igual se resuelven para
// TODAS las filas antes del loop, vía fetchAccountsByCuit — no depende de
// Circuito.
const PLAZO_FIJO_SOLO_ALTA_FLOW_NAME = 'Alta de Plazo Fijo (solo)';

// Al terminar de procesar todas las filas de "Transferencia DEBIN - File",
// se consulta el estado de cada transferencia que sí se hizo (GET
// /api/debin/cuenta/consultar/{id}) — la respuesta de la transferencia en
// sí solo trae el resultado de la evaluación inicial, no necesariamente el
// estado final de acreditación. Se corre DESPUÉS de todo el archivo (no
// intercalado fila por fila) porque así lo pidieron: primero todas las
// transferencias, después todas las consultas.
const DEBIN_CONSULTAR_FLOW_NAME = 'Consulta DEBIN (solo)';

// Espera antes de arrancar las consultas (ver runFlowFromCsv) — le da tiempo
// a Nova-Link a terminar de resolver el DEBIN antes de preguntar por su
// estado.
const DEBIN_CONSULTA_DELAY_SECONDS = 30;

// Todas las columnas de dbnconsulta-...csv que salen de la respuesta de
// "Consulta DEBIN (solo)" (todo lo que trae params.response, sin recortar
// nada — se pidió explícitamente el detalle completo, no un resumen) más
// las 3 de identificación (idMensaje/idComprobante/idOperacion, agregadas
// aparte) y errorConsulta. Usado tanto para inicializar la fila en blanco
// como para el encabezado del CSV (ver saveOutputFiles) — un solo lugar
// donde agregar una columna si Nova-Link suma un campo nuevo al futuro.
const DEBIN_CONSULTA_COLUMNS = [
  'numError', 'titulo', 'mensaje', 'debugSrc', 'debugDesc', 'responseId',
  'codigoRespuesta', 'descripcionRespuesta', 'evaluacionReglas', 'evaluacionPuntaje',
  'operacionId',
  'compradorCodigo', 'compradorTitular', 'compradorCuit',
  'compradorCuentaBanco', 'compradorCuentaSucursal', 'compradorCuentaTerminal',
  'compradorCuentaAlias', 'compradorCuentaCbu', 'compradorCuentaEsTitular',
  'compradorCuentaMoneda', 'compradorCuentaTipo', 'compradorCuentaEndpointId',
  'compradorEstadoDescripcion', 'compradorEstadoCodigo',
  'detalleFecha', 'detalleConcepto', 'detalleIdUsuario', 'detalleIdComprobante',
  'detalleMoneda', 'detalleImporte', 'detalleDevolucion', 'detalleImporteComision',
  'detalleComision', 'detalleFechaExpiracion', 'detalleDescripcion',
  'detalleIdOperacionOriginal', 'detallePaymentReference', 'detalleCodigoPostal',
  'detalleMcc', 'detalleDevolucionParcial', 'detalleForzado',
  'vendedorCodigo', 'vendedorTitular', 'vendedorCuit',
  'vendedorCuentaBanco', 'vendedorCuentaSucursal', 'vendedorCuentaTerminal',
  'vendedorCuentaAlias', 'vendedorCuentaCbu', 'vendedorCuentaEsTitular',
  'vendedorCuentaMoneda', 'vendedorCuentaTipo', 'vendedorCuentaEndpointId',
  'estadoCodigo', 'estadoDescripcion', 'garantiaOk', 'tipoOperacion', 'loteId', 'fechaNegocio',
];

function debinVal(x) {
  return x != null ? x : '';
}

// Aplana la respuesta completa de "Consulta DEBIN (solo)" (ver
// DEBIN_CONSULTA_COLUMNS) en un objeto plano para volcar en
// dbnconsulta-...csv — una entrada por columna, '' si esa rama del JSON no
// vino (nunca revienta si Nova-Link no manda algún campo opcional).
function extractDebinConsultaFields(parsed) {
  const response = (parsed && parsed.params && parsed.params.response) || {};
  const respuesta = response.respuesta || {};
  const evaluacion = respuesta.evaluacion || {};
  const operacion = response.operacion || {};
  const comprador = operacion.comprador || {};
  const compradorCuenta = comprador.cuenta || {};
  const estadoComprador = comprador.estadoComprador || {};
  const detalle = operacion.detalle || {};
  const vendedor = operacion.vendedor || {};
  const vendedorCuenta = vendedor.cuenta || {};
  const estado = operacion.estado || {};

  return {
    numError: debinVal(parsed && parsed.numError),
    titulo: debinVal(parsed && parsed.titulo),
    mensaje: debinVal(parsed && parsed.mensaje),
    debugSrc: debinVal(parsed && parsed.debug_src),
    debugDesc: debinVal(parsed && parsed.debug_desc),
    responseId: debinVal(response.id),
    codigoRespuesta: debinVal(respuesta.codigo),
    descripcionRespuesta: debinVal(respuesta.descripcion),
    evaluacionReglas: debinVal(evaluacion.reglas),
    evaluacionPuntaje: debinVal(evaluacion.puntaje),
    operacionId: debinVal(operacion.id),
    compradorCodigo: debinVal(comprador.codigo),
    compradorTitular: debinVal(comprador.titular),
    compradorCuit: debinVal(comprador.cuit),
    compradorCuentaBanco: debinVal(compradorCuenta.banco),
    compradorCuentaSucursal: debinVal(compradorCuenta.sucursal),
    compradorCuentaTerminal: debinVal(compradorCuenta.terminal),
    compradorCuentaAlias: debinVal(compradorCuenta.alias),
    compradorCuentaCbu: debinVal(compradorCuenta.cbu),
    compradorCuentaEsTitular: debinVal(compradorCuenta.esTitular),
    compradorCuentaMoneda: debinVal(compradorCuenta.moneda),
    compradorCuentaTipo: debinVal(compradorCuenta.tipo),
    compradorCuentaEndpointId: debinVal(compradorCuenta.endpointId),
    compradorEstadoDescripcion: debinVal(estadoComprador.descripcion),
    compradorEstadoCodigo: debinVal(estadoComprador.codigo),
    detalleFecha: debinVal(detalle.fecha),
    detalleConcepto: debinVal(detalle.concepto),
    detalleIdUsuario: debinVal(detalle.idUsuario),
    detalleIdComprobante: debinVal(detalle.idComprobante),
    detalleMoneda: debinVal(detalle.moneda),
    detalleImporte: debinVal(detalle.importe),
    detalleDevolucion: debinVal(detalle.devolucion),
    detalleImporteComision: debinVal(detalle.importeComision),
    detalleComision: debinVal(detalle.comision),
    detalleFechaExpiracion: debinVal(detalle.fechaExpiracion),
    detalleDescripcion: debinVal(detalle.descripcion),
    detalleIdOperacionOriginal: debinVal(detalle.idOperacionOriginal),
    detallePaymentReference: debinVal(detalle.paymentReference),
    detalleCodigoPostal: debinVal(detalle.codigoPostal),
    detalleMcc: debinVal(detalle.mcc),
    detalleDevolucionParcial: debinVal(detalle.devolucionParcial),
    detalleForzado: debinVal(detalle.forzado),
    vendedorCodigo: debinVal(vendedor.codigo),
    vendedorTitular: debinVal(vendedor.titular),
    vendedorCuit: debinVal(vendedor.cuit),
    vendedorCuentaBanco: debinVal(vendedorCuenta.banco),
    vendedorCuentaSucursal: debinVal(vendedorCuenta.sucursal),
    vendedorCuentaTerminal: debinVal(vendedorCuenta.terminal),
    vendedorCuentaAlias: debinVal(vendedorCuenta.alias),
    vendedorCuentaCbu: debinVal(vendedorCuenta.cbu),
    vendedorCuentaEsTitular: debinVal(vendedorCuenta.esTitular),
    vendedorCuentaMoneda: debinVal(vendedorCuenta.moneda),
    vendedorCuentaTipo: debinVal(vendedorCuenta.tipo),
    vendedorCuentaEndpointId: debinVal(vendedorCuenta.endpointId),
    estadoCodigo: debinVal(estado.codigo),
    estadoDescripcion: debinVal(estado.descripcion),
    garantiaOk: debinVal(operacion.garantiaOk),
    tipoOperacion: debinVal(operacion.tipo),
    loteId: debinVal(operacion.loteId),
    fechaNegocio: debinVal(operacion.fechaNegocio),
  };
}

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
async function fetchAccountsByCuit(rows, runLogFileName) {
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

  const entries = await runFlowByName('Recupera cuentas (SQL)', { nrodoc: Array.from(cuits).join(',') }, runLogFileName);
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

async function runFlowByName(flowName, inputs, runLogFileName) {
  const body = {
    profileName: document.getElementById('profileSelect').value,
    flowName,
    inputs,
  };
  // runLogFileName (opcional): para que varias filas de un mismo archivo CSV
  // terminen en un solo log de logs/http/ en vez de uno por fila (ver
  // runFlowFromCsv) — el servidor valida el formato antes de reusarlo, y
  // devuelve en el header X-Run-Log-File el nombre que efectivamente usó
  // (puede no ser este mismo valor, si vino vacío o inválido).
  if (runLogFileName) body.runLogFileName = runLogFileName;

  const res = await apiFetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error((data && data.error) || 'Error ejecutando el flow.');
  }

  const entries = Array.isArray(data) ? data : [data];
  // Propiedad extra sobre el array de entries (no interfiere con su uso
  // normal como log de pasos) — nombre de archivo de log que usó el
  // servidor para esta corrida, para que el llamador lo reuse en la
  // siguiente fila del mismo archivo CSV.
  entries.runLogFileName = res.headers.get('x-run-log-file') || null;
  return entries;
}

async function runOnce(inputs, runLogFileName) {
  return runFlowByName(state.selectedFlow.name, inputs, runLogFileName);
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
  state.debinDetailRows = [];
  state.debinConsultaRows = [];
  state.errorRows = [];
  state.successfulOperations = [];

  // stepCounts[i] cuenta, para el paso flow.steps[i], cuántas filas lo
  // completaron con éxito ('ok'), cuántas no ('error') — ya sea porque ese
  // paso falló, porque no llegó a ejecutarse (un paso anterior de la misma
  // fila falló), o porque la fila entera no se pudo correr (columnas de
  // más/menos, o un error de red/servidor antes de tener respuesta) — y
  // cuántas se saltearon a propósito ('skipped', fila con Circuito = 1: no
  // se ejecutan los steps de débito/crédito, solo el alta de Plazo Fijo).
  const stepCounts = flow.steps.map(() => ({ ok: 0, error: 0, skipped: 0, errorTypes: {} }));
  // Cuenta, por fila, si se dispararon contra-asientos (onFailureSteps del
  // último step que falló, ver flowEngine.js) y si todos ellos terminaron en
  // 'Success' ('ok') o no ('error', aunque haya sido solo uno de los dos:
  // los libros quedan sin cuadrar igual). Una fila sin contra-asientos
  // (alta de PF exitosa, o un error anterior sin llegar a esa etapa) no
  // suma a ninguno de los dos.
  const contraasientoCounts = { ok: 0, error: 0 };

  try {
    const text = await readFileAsText(file);
    const parsedRows = parseCsvText(text);
    // La primera línea del archivo es encabezado (nombres de columna), no
    // una fila de datos — se descarta antes de procesar nada. Vale para
    // cualquier flow CSV: los archivos de entrada ahora vienen todos con
    // esa cabecera.
    const rows = parsedRows.slice(1);

    if (rows.length === 0) {
      alert('El archivo CSV no tiene ninguna fila con datos (además del encabezado).');
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

    // Nombre de log compartido por TODA la corrida de este archivo — incluida
    // "Recupera cuentas (SQL)" de más abajo (para "Alta de Plazo Fijos -
    // File") y "Consulta DEBIN (solo)" de más abajo (para "Transferencia
    // DEBIN - File"), que si no quedarían en su propio log separado en vez
    // de en el mismo log que el resto de la corrida — un solo archivo con
    // todo lo que pasó, en vez de dos para revisar por separado. Se genera
    // client-side (mismo formato que generateRunId en
    // node/lib/flowEngine.js) porque hace falta ANTES de la primera llamada a
    // /api/run — el servidor lo valida y lo reusa tal cual en vez de generar
    // uno nuevo (ver runFlowByName/runOnce).
    let batchLogFileName = `http/${generateFallbackStamp()}-${flowLogNameFallback(flow)}.log`;

    // Para "Alta de Plazo Fijos - File": UNA sola consulta a Sybase con
    // todos los CUIT del archivo, antes de procesar ninguna fila — en vez
    // de una consulta por fila (o por CUIT repetido). Si esto falla, se
    // aborta todo el archivo: sin las cuentas no se puede procesar ninguna
    // fila de forma segura.
    let accountsByCuit = null;
    if (isPlazoFijoCocosFilesSqlFlow(flow)) {
      progressEl.textContent = 'Buscando cuentas en Sybase para todos los CUIT del archivo...';
      try {
        accountsByCuit = await fetchAccountsByCuit(rows, batchLogFileName);
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

        // Banco = primeros 3 dígitos del CBU, Sucursal = los 4 siguientes
        // (mismo criterio para crédito y débito). mismoTitular = "1" si el
        // CUIT destino y el CUIT origen de la fila coinciden, "0" si no.
        let debinCbuError = null;
        if (isTransferenciaDebinFilesFlow(flow)) {
          const creditoCbu = (inputs.creditoCbu || '').trim();
          const debitoCbu = (inputs.debitoCbu || '').trim();
          if (!/^\d{22}$/.test(creditoCbu)) {
            debinCbuError = `El CBU destino "${inputs.creditoCbu}" no tiene 22 dígitos numéricos.`;
          } else if (!/^\d{22}$/.test(debitoCbu)) {
            debinCbuError = `El CBU origen "${inputs.debitoCbu}" no tiene 22 dígitos numéricos.`;
          } else {
            inputs.creditoBanco = creditoCbu.slice(0, 3);
            inputs.creditoSucursal = creditoCbu.slice(3, 7);
            inputs.debitoBanco = debitoCbu.slice(0, 3);
            inputs.debitoSucursal = debitoCbu.slice(3, 7);
            inputs.mismoTitular = (inputs.creditoCuit || '').trim() === (inputs.debitoCuit || '').trim() ? '1' : '0';
          }
        }

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

        if (duplicateError || accountLookupError || circuitoError || debinCbuError) {
          rowEntries = [
            {
              name: `Fila ${rowNumber}`,
              status: 'Error',
              requestSummary: null,
              responseSummary: null,
              httpStatusCode: null,
              durationMs: 0,
              errorMessage: duplicateError || accountLookupError || circuitoError || debinCbuError,
            },
          ];
        } else {
          try {
            rowEntries = runSoloAlta
              ? await runFlowByName(PLAZO_FIJO_SOLO_ALTA_FLOW_NAME, inputs, batchLogFileName)
              : await runOnce(inputs, batchLogFileName);
            stepEntries = rowEntries;
            batchLogFileName = rowEntries.runLogFileName || batchLogFileName;
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

      // flowEngine marca con isCompensationStep las entries de onFailureSteps
      // (contra-asientos u otra compensación) — separarlas de las entries de
      // steps "normales" del flow ANTES de indexar por expectedStepIndices,
      // porque un contra-asiento puede haber ocupado la misma posición de
      // array que hubiera tenido el step siguiente que nunca llegó a
      // correrse (ej. si falla "2. Crédito en Caja de Ahorro", el contra-
      // asiento de Cuenta Corriente queda en la posición 2, la misma que
      // tendría "3. Alta de Plazo Fijo" en el camino feliz).
      const realStepEntries = stepEntries ? stepEntries.filter((entry) => !entry.isCompensationStep) : null;
      const compensationEntries = stepEntries ? stepEntries.filter((entry) => entry.isCompensationStep) : [];

      for (let s = 0; s < flow.steps.length; s++) {
        if (!expectedStepIndices.includes(s)) {
          stepCounts[s].skipped++;
          continue;
        }
        const entry = realStepEntries ? realStepEntries[expectedStepIndices.indexOf(s)] : null;
        const ok = !!entry && entry.status === 'Success';
        if (ok) {
          stepCounts[s].ok++;
        } else {
          stepCounts[s].error++;
          const errorType = classifyStepErrorType(entry);
          stepCounts[s].errorTypes[errorType] = (stepCounts[s].errorTypes[errorType] || 0) + 1;
        }
      }

      // Todos los contra-asientos de esta fila (si los hubo) tienen que haber
      // terminado en 'Success' para que la fila cuente como corregida.
      if (compensationEntries.length > 0) {
        const allOk = compensationEntries.every((entry) => entry && entry.status === 'Success');
        if (allOk) contraasientoCounts.ok++;
        else contraasientoCounts.error++;
      }

      renderCsvSummary(flow, rows.length, stepCounts, contraasientoCounts);

      // Fila fallada: columnas de más/menos, cuenta no encontrada (nunca
      // llegó a llamar a ningún endpoint), o algún paso terminó en error.
      // Se guarda la fila tal cual vino en el archivo (aunque esté mal
      // formada) + el IdMensaje que se le generó + el motivo del error, para
      // el archivo pfouterror-.../dbnouterror-... (mismo formato para los dos
      // flows, ver saveOutputFiles) — como cada corrida es de un solo flow,
      // el mismo state.errorRows sirve para cualquiera de los dos sin
      // mezclarse. Un flow CSV no muestra la tabla de log en pantalla (ver
      // selectFlow) — sin el motivo acá, para una fila que nunca llegó a
      // llamar a ningún endpoint (validación de columnas, CBU inválido,
      // cuenta no encontrada) no queda registrado en ningún lado por qué
      // falló: no hay request/response que loguear en logs/http/, y la UI
      // solo muestra el conteo ok/error por paso, no el mensaje de cada fila.
      const rowFailed = rowEntries.some((entry) => entry.status !== 'Success');
      if (rowFailed && (isPlazoFijoCocosFilesSqlFlow(flow) || isTransferenciaDebinFilesFlow(flow))) {
        const failedEntry = rowEntries.find((entry) => entry.status !== 'Success' && entry.errorMessage);
        const rowErrorMessage = failedEntry ? failedEntry.errorMessage : '';
        state.errorRows.push([...row, rowIdMensaje, rowErrorMessage]);
      }

      // El último paso de este flow es el alta del plazo fijo; si terminó
      // bien, su respuesta trae un array "output" con 2 items por plazo fijo
      // (función 1 = capital, función 3 = interés) que comparten operación/
      // vencimiento/tem/tna/importeNeto — se unifican en UNA sola fila por
      // plazo fijo en state.pfDetailRows, para guardar aparte como CSV al
      // terminar (ver saveOutputFiles). La tabla de log paso a paso ya no se
      // muestra en pantalla para flows CSV
      // (ver selectFlow); el detalle completo de cada request/response
      // sigue en logs/http.log. Este bloque (y pfout-...csv en general) es
      // específico de "Alta de Plazo Fijos - File": otros flows CSV (como
      // "Transferencia DEBIN - File") no generan ese archivo de salida.
      if (realStepEntries && isPlazoFijoCocosFilesSqlFlow(flow)) {
        // realStepEntries (no stepEntries): si "2. Crédito en Caja de
        // Ahorro" o "3. Alta de Plazo Fijo" fallaron, el último elemento de
        // stepEntries sería el contra-asiento, no la respuesta de la alta —
        // acá interesa específicamente la respuesta del último step REAL que
        // se haya llegado a correr.
        const lastEntry = realStepEntries[realStepEntries.length - 1];
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
                realizado: 's',
              });
              // Se registra como operación exitosa (para bloquear un futuro
              // reintento del mismo cuit+numeroComprobante) recién acá, con
              // el mismo criterio que decide si entra a pfDetailRows — nunca
              // antes de haber confirmado la alta real del plazo fijo.
              // cajaAhorro/importeNeto/fechaVencimiento/tipoCircuito
              // quedan en operaciones_procesadas además de en
              // pfDetailRows/pfout-...csv — mismos valores, pero acá quedan
              // ligados al registro antiduplicado en vez de a un archivo.
              // pfPagado arranca siempre en false/0 acá: confirmar el alta
              // no es lo mismo que confirmar que el plazo fijo se pagó —
              // eso lo marca otro proceso más adelante.
              const rowCuit = (row[0] || '').trim();
              const rowAccounts = accountsByCuit ? accountsByCuit.get(rowCuit) : null;
              state.successfulOperations.push({
                cuit: rowCuit,
                numeroComprobante: (row[4] || '').trim(),
                idMensaje: rowIdMensaje,
                cajaAhorro: (rowAccounts && rowAccounts.cuecodSistema5) || '',
                importeNeto: first.importeNeto,
                fechaVencimiento: first.vencimiento,
                tipoCircuito: (row[row.length - 1] || '').trim(),
                pfPagado: false,
              });
            }
          } catch (err) {
            // La respuesta no vino en el formato esperado (JSON con "output": [...]);
            // no se agrega detalle de esta fila, pero la fila sigue contando
            // como éxito en el resumen de arriba.
          }
        }
      }

      // Análogo al bloque de arriba, pero para "Transferencia DEBIN - File":
      // la respuesta trae el resultado de la evaluación en
      // params.response.respuesta (codigo/descripcion/id — mismo jsonPath
      // que extractVariables usa para codigoRespuesta/descripcionRespuesta/
      // idRespuesta, ver Flows/transferencia-debin-files.json) — se vuelca
      // en dbnout-...csv (ver saveOutputFiles) junto con los 9 valores de la
      // fila de entrada, para no tener que cruzar ese archivo con el CSV
      // original.
      if (realStepEntries && isTransferenciaDebinFilesFlow(flow)) {
        const lastEntry = realStepEntries[realStepEntries.length - 1];
        if (lastEntry && lastEntry.status === 'Success' && lastEntry.responseSummary) {
          try {
            const parsed = JSON.parse(lastEntry.responseSummary);
            const respuesta = (parsed.params && parsed.params.response && parsed.params.response.respuesta) || {};
            state.debinDetailRows.push({
              creditoCuit: row[0] || '',
              creditoCbu: row[1] || '',
              creditoTitular: row[2] || '',
              debitoCuit: row[3] || '',
              debitoCbu: row[4] || '',
              debitoTitular: row[5] || '',
              idComprobante: row[6] || '',
              moneda: row[7] || '',
              importe: row[8] || '',
              codigoRespuesta: respuesta.codigo != null ? respuesta.codigo : '',
              descripcionRespuesta: respuesta.descripcion != null ? respuesta.descripcion : '',
              idRespuesta: respuesta.id != null ? respuesta.id : '',
              idMensaje: rowIdMensaje,
              realizado: 's',
            });
          } catch (err) {
            // La respuesta no vino en el formato esperado; no se agrega
            // detalle de esta fila, pero la fila sigue contando como éxito
            // en el resumen de arriba.
          }
        }
      }

      // Fila fallada (mismo criterio que errorRows más arriba): también entra
      // a pfout-...csv, con los datos que sí tenemos del archivo de entrada
      // (numeroComprobante/cuit/apellidoNombre) y en blanco el resto de las
      // columnas del plazo fijo (nunca se llegó a dar de alta) — así el
      // archivo de salida queda con una fila por cada fila del archivo de
      // entrada, se haya completado o no, y "realizado" = "n" marca cuál es
      // cuál sin tener que cruzar con pfouterror-....
      if (rowFailed && isPlazoFijoCocosFilesSqlFlow(flow)) {
        state.pfDetailRows.push({
          numeroComprobante: row[4] || '',
          cuit: row[0] || '',
          apellidoNombre: row[1] || '',
          operacion: '',
          vencimiento: '',
          tem: '',
          tna: '',
          importeNeto: '',
          montoCapital: '',
          montoInteres: '',
          otros: '',
          idMensaje: rowIdMensaje,
          realizado: 'n',
        });
      }

      // Análogo al bloque de arriba, para "Transferencia DEBIN - File":
      // columnas de la respuesta en blanco (nunca se llegó a transferir).
      if (rowFailed && isTransferenciaDebinFilesFlow(flow)) {
        state.debinDetailRows.push({
          creditoCuit: row[0] || '',
          creditoCbu: row[1] || '',
          creditoTitular: row[2] || '',
          debitoCuit: row[3] || '',
          debitoCbu: row[4] || '',
          debitoTitular: row[5] || '',
          idComprobante: row[6] || '',
          moneda: row[7] || '',
          importe: row[8] || '',
          codigoRespuesta: '',
          descripcionRespuesta: '',
          idRespuesta: '',
          idMensaje: rowIdMensaje,
          realizado: 'n',
        });

        // Si la fila falló puntualmente porque (a) el titular real del CBU
        // destino (ConsultaCBU) no coincide con el CUIT destino del
        // archivo, o (b) Nova-Link rechazó la transferencia por un motivo
        // de negocio (HTTP 200 con una descripcionRespuesta puntual — ver
        // failIfEquals en el step "2. Transferencia DEBIN": hoy cubre
        // "ERROR GENERAL GARANTIAS" y "No existe saldo para efectuar el
        // debito", agregar otro motivo es solo otra tupla ahí), también se
        // agrega una fila a dbnconsulta-...csv (además de
        // dbnouterror-...csv) con el mismo formato fijo para todos los
        // casos (compradorCuentaCbu/estadoCodigo/estadoDescripcion, no
        // errorConsulta) — solo cambia el texto de estadoDescripcion.
        const mismatchEntry = rowEntries.find((entry) => entry.isVariableMismatch);
        const businessRejectionEntry = rowEntries.find((entry) => entry.isBusinessRejection);
        if (mismatchEntry || businessRejectionEntry) {
          const consultaRow = {
            idMensaje: rowIdMensaje,
            idComprobante: row[6] || '',
            idOperacion: '',
            errorConsulta: '',
          };
          for (const col of DEBIN_CONSULTA_COLUMNS) consultaRow[col] = '';
          consultaRow.compradorCuentaCbu = row[4] || ''; // CBU origen (debitoCbu)
          consultaRow.estadoCodigo = 'Error';
          consultaRow.estadoDescripcion = mismatchEntry
            ? 'El CUIT no coincide con el CBU Destino'
            : businessRejectionEntry.businessRejectionMessage;
          state.debinConsultaRows.push(consultaRow);
        }
      }

      const prefixed = rowEntries.map((entry) => ({ ...entry, name: `Fila ${rowNumber} — ${entry.name}` }));
      state.lastLog = state.lastLog.concat(prefixed);
      document.getElementById('saveLogBtn').disabled = state.lastLog.length === 0;
    }

    let doneText = `Listo: ${rows.length} fila(s) procesada(s) en ${formatDurationShort(Date.now() - startedAt)}.`;

    if (state.successfulOperations.length > 0) {
      try {
        const res = await apiFetch('/api/register-operations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operations: state.successfulOperations }),
        });
        if (!res.ok) {
          // apiFetch no tira excepción para un 4xx/5xx (devuelve la Response
          // tal cual) — sin este chequeo, un error del servidor acá (ej. la
          // tabla operaciones_procesadas sin las columnas nuevas todavía)
          // pasaba desapercibido: el catch de abajo solo agarra fallas de
          // red, nunca una respuesta de error real.
          let data = null;
          try {
            data = await res.json();
          } catch (err) {
            // Respuesta de error sin body JSON (ej. un 500 crudo del server) — se
            // avisa igual, solo que sin el detalle de data.error.
          }
          throw new Error((data && data.error) || `HTTP ${res.status}`);
        }
      } catch (err) {
        // Si esto falla, las operaciones que sí se dieron de alta no quedan
        // protegidas contra un reintento futuro del mismo archivo — hay que
        // avisar, no fallar en silencio.
        alert('Atención: no se pudieron registrar las operaciones exitosas para evitar duplicados en el futuro: ' + err.message);
      }
    }

    // "Transferencia DEBIN - File": una consulta por cada transferencia que
    // sí se hizo (realizado = "s" y con idRespuesta), usando
    // DEBIN_CONSULTAR_FLOW_NAME. Un error puntual en una consulta (red,
    // HTTP distinto de 200, respuesta con formato inesperado) no aborta el
    // resto — queda registrado en la columna errorConsulta de esa fila, ya
    // que la transferencia en sí ya se hizo y no depende de esto.
    if (isTransferenciaDebinFilesFlow(flow)) {
      const toQuery = state.debinDetailRows.filter((row) => row.realizado === 's' && row.idRespuesta);

      // Espera DEBIN_CONSULTA_DELAY_SECONDS antes de la primera consulta:
      // Nova-Link puede tardar en terminar de resolver el DEBIN, así que
      // consultar de entrada podría traer un estado todavía no definitivo.
      // Con contador visible en pantalla para que se note que la app sigue
      // viva mientras espera (no es que se colgó).
      if (toQuery.length > 0) {
        for (let remaining = DEBIN_CONSULTA_DELAY_SECONDS; remaining > 0; remaining--) {
          progressEl.textContent = `Esperando ${remaining}s antes de consultar el estado de las transferencias...`;
          await sleep(1000);
        }
      }

      for (let i = 0; i < toQuery.length; i++) {
        const detailRow = toQuery[i];
        progressEl.textContent = `Consultando estado de transferencias (${i + 1} de ${toQuery.length})...`;

        const consultaRow = {
          idMensaje: detailRow.idMensaje,
          idComprobante: detailRow.idComprobante,
          idOperacion: detailRow.idRespuesta,
          errorConsulta: '',
        };
        for (const col of DEBIN_CONSULTA_COLUMNS) consultaRow[col] = '';

        try {
          const consultaEntries = await runFlowByName(
            DEBIN_CONSULTAR_FLOW_NAME,
            { idOperacion: detailRow.idRespuesta },
            batchLogFileName
          );
          batchLogFileName = consultaEntries.runLogFileName || batchLogFileName;
          const lastEntry = consultaEntries[consultaEntries.length - 1];
          if (lastEntry && lastEntry.status === 'Success' && lastEntry.responseSummary) {
            const parsed = JSON.parse(lastEntry.responseSummary);
            Object.assign(consultaRow, extractDebinConsultaFields(parsed));
          } else {
            consultaRow.errorConsulta = (lastEntry && lastEntry.errorMessage) || 'No se pudo consultar el estado de la transferencia.';
          }
        } catch (err) {
          consultaRow.errorConsulta = err.message;
        }

        state.debinConsultaRows.push(consultaRow);
      }
    }

    const saved = await saveOutputFiles(flow, batchLogFileName);
    const savedFiles = [saved.batchOkFileName, saved.batchErrorFileName, saved.consultaOkFileName].filter(Boolean);
    if (savedFiles.length > 0) {
      doneText += ` Guardado en files/: ${savedFiles.join(', ')}.`;
    }

    // "Archivos de salida" arma sus filas leyendo esto de logs/http/ (ver
    // handleOutputFilesGet en server.js) — sin este resumen, la corrida
    // sigue apareciendo en la lista (por el log), solo que sin flow/usuario/
    // pasos. pasosOk/pasosError son por FILA del CSV, no por step HTTP
    // individual (más útil de leer que el conteo de steps que ya guarda
    // security.log). Un solo resumen para toda la corrida (batchLogFileName
    // es también el log de "Consulta DEBIN (solo)" ahora, ver más arriba) —
    // ya no hace falta un segundo postRunSummary aparte para la consulta.
    const pasosOk =
      state.pfDetailRows.filter((r) => r.realizado === 's').length +
      state.debinDetailRows.filter((r) => r.realizado === 's').length;
    const pasosError = state.errorRows.length;
    if (batchLogFileName) {
      await postRunSummary(batchLogFileName, flow.name, saved.batchOkFileName, saved.batchErrorFileName, pasosOk, pasosError);
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

// Mismo algoritmo de slug que flowNameSlug en node/lib/flowEngine.js — tiene
// que dar exactamente el mismo resultado, si no un log y sus archivos de
// salida terminan con nombres que no matchean.
function flowNameSlugFallback(name) {
  return (
    String(name || 'flow')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'flow'
  );
}

// Mismo criterio que flowLogName en node/lib/flowEngine.js: si el flow trae
// logAlias (ver /api/flows), se usa tal cual (sanitizado, sin forzar
// minúscula) en vez del slug automático del name completo — ver "Alta-PF"
// en Flows/plazo-fijo-cocos-files-sql.json. flowLike puede ser el flow
// entero o directamente un nombre (string) cuando no hay flow object a
// mano (ej. DEBIN_CONSULTAR_FLOW_NAME).
function flowLogNameFallback(flowLike) {
  const flowObj = typeof flowLike === 'string' ? { name: flowLike } : flowLike || {};
  const alias = flowObj.logAlias ? String(flowObj.logAlias).trim() : '';
  if (!alias) return flowNameSlugFallback(flowObj.name);
  const sanitized = alias.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || flowNameSlugFallback(flowObj.name);
}

// ddMMyyyyHHmmss + 4 dígitos (milisegundos, para que no choque con otra
// corrida en el mismo segundo) — 18 dígitos en total, mismo largo que
// espera RUN_ID_PATTERN del lado del servidor. Solo se usa en el fallback
// de deriveRunId.
function generateFallbackStamp() {
  const now = new Date();
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return (
    pad(now.getDate()) +
    pad(now.getMonth() + 1) +
    now.getFullYear() +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds()) +
    pad(now.getMilliseconds(), 4).slice(0, 4)
  );
}

// El runId de los archivos de salida es EL MISMO que ya tiene el log de esa
// corrida (logFileName, devuelto por /api/run — ver batchLogFileName en
// runFlowFromCsv): así "Archivos de salida" los encuentra por nombre sin
// tener que parsear nada (ver handleOutputFilesGet en server.js). El
// fallback (sin logFileName) es para el caso raro de que ninguna fila del
// CSV haya llegado a completar ni un solo /api/run (todas fallaron
// validación del lado del navegador antes de llegar al servidor) — ahí no
// hay ningún log con el que emparejar, pero el archivo se guarda igual.
function deriveRunId(logFileName, flowLike) {
  if (logFileName) return logFileName.replace(/^http\//, '').replace(/\.log$/, '');
  return `${generateFallbackStamp()}-${flowLogNameFallback(flowLike)}`;
}

// Guarda un archivo en el servidor, en la carpeta files/ (POST /api/save-output
// lo crea si no existe) — queda en una ubicación fija y predecible, accesible
// después desde "Archivos de salida" (ver loadOutputFiles) — y además dispara
// la descarga automática al navegador de quien corrió el flow. "kind" es
// solo para que el servidor sepa si además tiene que registrar el contenido
// en MariaDB (dbn_out/dbn_consulta) — no forma parte del nombre del archivo.
async function saveOutputFile(runId, variant, kind, content) {
  try {
    const res = await apiFetch('/api/save-output', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, variant, kind, content }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(`No se pudo guardar el archivo de salida: ` + (data.error || 'error desconocido.'));
      return null;
    }
    downloadTextFile(data.fileName, content, 'text/csv');
    return data.fileName;
  } catch (err) {
    alert(`Error de red guardando el archivo de salida: ` + err.message);
    return null;
  }
}

// Al terminar de procesar el CSV: guarda, si corresponde, hasta 3 archivos.
// El de la corrida principal (pfout, más el de error si hubo filas
// fallidas) comparte runId con batchLogFileName. El de la consulta DEBIN
// (dbnconsulta, solo para "Transferencia DEBIN - File") tiene su propio
// runId — un timestamp propio, no atado a ningún log — porque el nombre
// tiene que seguir empezando con su propio slug ("...-consulta-debin-solo",
// no el de la corrida principal), aunque el log de esa consulta ahora sea
// el MISMO archivo que batchLogFileName (ver runFlowFromCsv: ya no hay un
// consultaLogFileName aparte, todo el detalle HTTP de una corrida de
// "Transferencia DEBIN - File" — transferencias y consultas — queda en un
// solo .log). "Transferencia DEBIN - File" ya NO genera su propio archivo
// "ok" (dbnout): con dbnouterror-... (las filas que fallaron) y
// dbnconsulta-... (el estado de las que sí se transfirieron, incluidos los
// rechazos de negocio que ya arman su propia fila ahí) alcanza — el
// contenido de dbnout terminaba duplicando lo que ya se puede ver en esos
// dos. Como cada corrida es de un solo flow CSV, nunca se mezclan
// pfDetailRows con debinDetailRows en la misma corrida — alcanza con mirar
// cuál de los dos tiene filas para saber cuál generar. debinDetailRows
// sigue existiendo en memoria igual (lo usa el loop de consultas y el
// conteo de pasosOk más abajo), solo dejó de volcarse a un archivo propio.
async function saveOutputFiles(flow, batchLogFileName) {
  const result = { batchOkFileName: null, batchErrorFileName: null, consultaOkFileName: null };
  if (
    state.pfDetailRows.length === 0 &&
    state.debinConsultaRows.length === 0 &&
    state.errorRows.length === 0
  ) {
    return result;
  }

  const batchRunId = deriveRunId(batchLogFileName, flow);

  if (state.pfDetailRows.length > 0) {
    const headers = ['numeroComprobante', 'cuit', 'apellidoNombre', 'operacion', 'vencimiento', 'tem', 'tna', 'importeNeto', 'montoCapital', 'montoInteres', 'otros', 'idMensaje', 'realizado'];
    const lines = [headers.join(',')];
    for (const row of state.pfDetailRows) {
      lines.push(headers.map((h) => csvEscape(row[h])).join(','));
    }
    result.batchOkFileName = await saveOutputFile(batchRunId, 'ok', 'pfout', lines.join('\r\n'));
  }

  if (state.errorRows.length > 0) {
    // Sin fila de encabezado, a propósito: cada fila queda igual a como
    // vino en el archivo de entrada (que tampoco lleva encabezado) más el
    // IdMensaje al final.
    const lines = state.errorRows.map((row) => row.map(csvEscape).join(','));
    result.batchErrorFileName = await saveOutputFile(batchRunId, 'error', null, lines.join('\r\n'));
  }

  if (state.debinConsultaRows.length > 0) {
    const consultaRunId = deriveRunId(null, DEBIN_CONSULTAR_FLOW_NAME);
    const headers = ['idMensaje', 'idComprobante', 'idOperacion', ...DEBIN_CONSULTA_COLUMNS, 'errorConsulta'];
    const lines = [headers.join(',')];
    for (const row of state.debinConsultaRows) {
      lines.push(headers.map((h) => csvEscape(row[h])).join(','));
    }
    result.consultaOkFileName = await saveOutputFile(consultaRunId, 'ok', 'dbnconsulta', lines.join('\r\n'));
  }

  return result;
}

// Anexa, al log de esa corrida, quién la corrió y qué archivos quedaron
// guardados (ver appendRunSummary en flowEngine.js) — así "Archivos de
// salida" puede mostrar esos datos sin tener que abrir el log. Si esto
// falla (ej. se cerró el navegador antes de que termine) no bloquea nada:
// el/los archivo(s) ya se guardaron bien, la corrida sigue apareciendo en
// la lista, solo sin este resumen.
async function postRunSummary(logFileName, flowName, okFileName, errorFileName, pasosOk, pasosError) {
  try {
    await apiFetch('/api/run-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logFileName, flowName, okFileName, errorFileName, pasosOk, pasosError }),
    });
  } catch (err) {
    // Ver comentario de la función.
  }
}

const profileForm = document.getElementById('profileForm');

function openProfileSection(existing) {
  profileForm.reset();
  document.getElementById('profileDialogTitle').textContent = existing ? 'Editar perfil' : 'Nuevo perfil';

  if (existing) {
    profileForm.elements.name.value = existing.name || '';
    profileForm.elements.name.readOnly = true;
    profileForm.elements.baseUrl.value = existing.baseUrl || '';
    profileForm.elements.novaBaseUrl.value = existing.novaBaseUrl || '';
    profileForm.elements.authType.value = existing.authType || 'Bearer';
    profileForm.elements.apiKeyHeaderName.value = existing.apiKeyHeaderName || '';
    profileForm.elements.tokenUrl.value = existing.tokenUrl || '';
    profileForm.elements.clientId.value = existing.clientId || '';
    profileForm.elements.clientCertPfxPath.value = existing.clientCertPfxPath || '';
  } else {
    profileForm.elements.name.readOnly = false;
    profileForm.elements.authType.value = 'Bearer';
  }

  showMainSection('profileSection');
}

document.getElementById('newProfileBtn').addEventListener('click', () => openProfileSection(null));

document.getElementById('editProfileBtn').addEventListener('click', () => {
  const current = state.profiles.find((p) => p.name === document.getElementById('profileSelect').value);
  if (current) openProfileSection(current);
});

document.getElementById('cancelProfileBtn').addEventListener('click', () => showMainSection('flowDetail'));
document.getElementById('closeProfileSectionBtn').addEventListener('click', () => showMainSection('flowDetail'));

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

  showMainSection('flowDetail');
  await loadProfiles();
});

// --- Buscador de certificado (.pfx, TLS mutuo) -------------------------------
// Navega certsBaseDir en el servidor (ver /api/certs-browse) para no tener que
// tipear la ruta a mano en el diálogo de Perfil — el buscador nunca puede salir
// de esa carpeta, eso lo hace cumplir el servidor.

const certBrowserDialog = document.getElementById('certBrowserDialog');
let certBrowserCurrentRelPath = ''; // currentPath de la última respuesta, para "Subir un nivel" y para armar la ruta del próximo pedido
let certBrowserCurrentFullPath = ''; // currentFullPath de la última respuesta, para armar la ruta completa al elegir un archivo

function renderCertBrowser(data) {
  document.getElementById('certBrowserBasePath').textContent = data.basePath;
  document.getElementById('certBrowserCurrentPath').textContent = data.currentPath || '(raíz)';
  certBrowserCurrentRelPath = data.currentPath || '';
  certBrowserCurrentFullPath = data.currentFullPath;

  const list = document.getElementById('certBrowserList');
  list.innerHTML = '';
  for (const entry of data.entries) {
    const li = document.createElement('li');
    li.textContent = (entry.isDirectory ? '📁 ' : '📄 ') + entry.name;
    li.addEventListener('click', () => {
      if (entry.isDirectory) {
        const nextPath = certBrowserCurrentRelPath ? `${certBrowserCurrentRelPath}/${entry.name}` : entry.name;
        loadCertBrowserPath(nextPath);
      } else {
        const sep = certBrowserCurrentFullPath.includes('\\') ? '\\' : '/';
        profileForm.elements.clientCertPfxPath.value = certBrowserCurrentFullPath.replace(/[/\\]+$/, '') + sep + entry.name;
        certBrowserDialog.close();
      }
    });
    list.appendChild(li);
  }
  document.getElementById('certBrowserEmptyHint').style.display = data.entries.length === 0 ? '' : 'none';

  document.getElementById('certBrowserUpBtn').disabled = !certBrowserCurrentRelPath;
}

async function loadCertBrowserPath(relPath) {
  const res = await apiFetch('/api/certs-browse?path=' + encodeURIComponent(relPath));
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'No se pudo explorar esa carpeta.');
    return;
  }
  renderCertBrowser(data);
}

function openCertBrowser() {
  loadCertBrowserPath('');
  certBrowserDialog.showModal();
}

document.getElementById('browseCertPathBtn').addEventListener('click', openCertBrowser);
document.getElementById('cancelCertBrowserBtn').addEventListener('click', () => certBrowserDialog.close());
document.getElementById('certBrowserUpBtn').addEventListener('click', () => {
  const parentPath = certBrowserCurrentRelPath.split('/').slice(0, -1).join('/');
  loadCertBrowserPath(parentPath);
});

document.getElementById('runBtn').addEventListener('click', runFlow);
document.getElementById('saveLogBtn').addEventListener('click', saveLog);
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

const parametriaForm = document.getElementById('parametriaForm');

// El botón "Probar token" prueba el perfil elegido en el <select> del header
// (profileSelect sigue visible con Parametría abierta, ya que el header queda
// afuera de <main>), por eso su estado depende de ese perfil y no de nada
// propio de este panel.
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

async function openParametriaSection() {
  parametriaForm.reset();

  const res = await apiFetch('/api/parametria');
  const data = await res.json();

  for (const [category, fields] of Object.entries(data || {})) {
    for (const [field, value] of Object.entries(fields || {})) {
      const el = parametriaForm.elements[`${category}.${field}`];
      if (el) el.value = value || '';
    }
  }

  updateTestTokenButtonState();
  showMainSection('parametriaSection');
}

document.getElementById('parametriaBtn').addEventListener('click', openParametriaSection);
document.getElementById('cancelParametriaBtn').addEventListener('click', () => showMainSection('flowDetail'));
document.getElementById('closeParametriaSectionBtn').addEventListener('click', () => showMainSection('flowDetail'));
document.getElementById('testTokenBtn').addEventListener('click', testToken);
document.getElementById('profileSelect').addEventListener('change', updateTestTokenButtonState);

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

  showMainSection('flowDetail');
});

// --- Administración de usuarios y configuración de Active Directory --------
// Panel solo visible para rol 'admin' (usersBtn queda oculto para los demás en
// loadMe()); el servidor igual vuelve a chequear el rol en cada request de
// /api/users y /api/security-config, así que ocultar el botón acá es solo UX.

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

async function openUsersSection() {
  resetUserForm();
  document.getElementById('adConfigSaveResult').textContent = '';
  await loadAdConfig();
  await loadUsersList();
  showMainSection('usersSection');
}

document.getElementById('usersBtn').addEventListener('click', openUsersSection);
document.getElementById('closeUsersSectionBtn').addEventListener('click', () => showMainSection('flowDetail'));
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

// --- Archivos de salida (pfout-/pfouterror-/dbnout-/dbnouterror-... guardados en files/) -----
// Además de la descarga automática al terminar un CSV (ver saveOutputFile),
// este panel deja ver y volver a descargar cualquier archivo ya guardado en
// el servidor — útil si se cerró el navegador antes de que la descarga
// terminara, o si hace falta recuperar el de una corrida anterior.

const outputFilesSection = document.getElementById('outputFilesSection');
const outputFilesFromDate = document.getElementById('outputFilesFromDate');
const outputFilesToDate = document.getElementById('outputFilesToDate');
let allOutputFiles = []; // última lista traída del servidor, sin filtrar — el filtro de fecha se aplica en el cliente

// Requiere Desde Y Hasta completos para buscar — sin rango de fechas no se
// lista nada (ni se llama a la API), a propósito: son carpetas que pueden
// acumular muchas corridas con el tiempo.
function outputFilesDateRangeComplete() {
  return !!(outputFilesFromDate.value && outputFilesToDate.value);
}

// Una fila por CORRIDA (no por archivo suelto, ver handleOutputFilesGet en
// server.js): hora, flow, usuario y pasos ok/error (si el resumen de esa
// corrida llegó a guardarse), más los 3 botones de descarga — ok/error solo
// si ese archivo existe, el log siempre (mientras la corrida haya llegado a
// generarlo).
function renderOutputFilesTable(runs, emptyMessage) {
  const tbody = document.getElementById('outputFilesTableBody');
  tbody.innerHTML = '';
  for (const run of runs) {
    const tr = document.createElement('tr');
    const pasos =
      run.pasosOk != null || run.pasosError != null
        ? `${run.pasosOk != null ? run.pasosOk : '?'} ok / ${run.pasosError != null ? run.pasosError : '?'} error`
        : '—';
    tr.innerHTML = `
      <td>${new Date(run.mtime).toLocaleString()}</td>
      <td>${escapeHtml(run.flowName || '—')}</td>
      <td>${escapeHtml(run.username || '—')}</td>
      <td>${escapeHtml(pasos)}</td>
      <td>
        <button type="button" class="downloadRunOkBtn" ${run.okFileName ? '' : 'disabled'}>Descargar OK</button>
        <button type="button" class="downloadRunErrorBtn" ${run.errorFileName ? '' : 'disabled'}>Descargar error</button>
        <button type="button" class="downloadRunLogBtn">Descargar log</button>
      </td>
    `;
    if (run.okFileName) {
      tr.querySelector('.downloadRunOkBtn').addEventListener('click', () => downloadOutputFile(run.okFileName));
    }
    if (run.errorFileName) {
      tr.querySelector('.downloadRunErrorBtn').addEventListener('click', () => downloadOutputFile(run.errorFileName));
    }
    tr.querySelector('.downloadRunLogBtn').addEventListener('click', () => downloadHttpLog(run.logFileName));
    tbody.appendChild(tr);
  }
  const hint = document.getElementById('outputFilesEmptyHint');
  if (runs.length === 0) {
    hint.textContent = emptyMessage;
    hint.style.display = '';
  } else {
    hint.style.display = 'none';
  }
}

// Compara solo la parte de fecha (yyyy-mm-dd, hora local) de run.mtime contra
// los <input type="date"> Desde/Hasta — ambos límites inclusive.
function applyOutputFilesFilter() {
  if (!outputFilesDateRangeComplete()) {
    renderOutputFilesTable([], 'Elegí un rango de fechas (Desde y Hasta) para buscar.');
    return;
  }
  const from = outputFilesFromDate.value;
  const to = outputFilesToDate.value;
  const filtered = allOutputFiles.filter((run) => {
    const runDate = formatDateOnlyLocal(new Date(run.mtime));
    return runDate >= from && runDate <= to;
  });
  renderOutputFilesTable(filtered, 'No hay ninguna corrida para el rango de fechas elegido.');
}

function formatDateOnlyLocal(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function loadOutputFilesList() {
  if (!outputFilesDateRangeComplete()) {
    applyOutputFilesFilter();
    return;
  }
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

async function openOutputFilesSection() {
  // Por default Desde/Hasta quedan en el día de hoy (rango de un solo día) —
  // así se puede ver algo apenas se abre el panel, sin tener que elegir
  // fecha a mano cada vez. Sigue siendo editable: "Limpiar filtro" los deja
  // vacíos si hace falta buscar en otro rango.
  const today = formatDateOnlyLocal(new Date());
  outputFilesFromDate.value = today;
  outputFilesToDate.value = today;
  allOutputFiles = [];
  showMainSection('outputFilesSection');
  await loadOutputFilesList();
}

document.getElementById('outputFilesBtn').addEventListener('click', openOutputFilesSection);
document.getElementById('closeOutputFilesBtn').addEventListener('click', () => showMainSection('flowDetail'));
document.getElementById('refreshOutputFilesBtn').addEventListener('click', loadOutputFilesList);
document.getElementById('clearOutputFilesFilterBtn').addEventListener('click', () => {
  outputFilesFromDate.value = '';
  outputFilesToDate.value = '';
  allOutputFiles = [];
  applyOutputFilesFilter();
});
outputFilesFromDate.addEventListener('change', loadOutputFilesList);
outputFilesToDate.addEventListener('change', loadOutputFilesList);

// Descarga de un log de corrida (logs/http/) — usado por el botón
// "Descargar log" de "Archivos de salida" arriba. Ya no hay una pantalla
// propia de "Logs de ejecución": quedó unificada ahí (una fila por corrida,
// con este mismo botón).
async function fetchHttpLogContent(name) {
  const res = await apiFetch('/api/http-logs/content?name=' + encodeURIComponent(name));
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'No se pudo obtener el log.');
    return null;
  }
  return data;
}

async function downloadHttpLog(name) {
  const data = await fetchHttpLogContent(name);
  if (!data) return;
  downloadTextFile(data.name, data.content, 'text/plain');
}

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

// --- Menú desplegable del header --------------------------------------------
// Se abre con un click en "Menú ▾" y se cierra con un click afuera o con
// Escape. No se cierra solo al hacer click en un item: algunos (ej. "Probar
// token") necesitan que el usuario siga viendo el resultado al lado del botón.
const mainMenuBtn = document.getElementById('mainMenuBtn');
const mainMenuList = document.getElementById('mainMenuList');

function closeMainMenu() {
  mainMenuList.style.display = 'none';
  mainMenuBtn.setAttribute('aria-expanded', 'false');
}

function toggleMainMenu() {
  const isOpen = mainMenuList.style.display !== 'none';
  mainMenuList.style.display = isOpen ? 'none' : '';
  mainMenuBtn.setAttribute('aria-expanded', String(!isOpen));
}

mainMenuBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleMainMenu();
});

document.addEventListener('click', (event) => {
  if (!document.getElementById('mainMenu').contains(event.target)) closeMainMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMainMenu();
});

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
