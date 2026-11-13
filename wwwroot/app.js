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
  pagoPlazoFijosRows: [],
  pagoPlazoFijosFechaProcesoISO: null,
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
const MAIN_SECTION_IDS = ['flowDetail', 'outputFilesSection', 'dashboardSection', 'conciliacionIbsSection', 'qnetSection', 'profileSection', 'parametriaSection', 'usersSection'];

function showMainSection(id) {
  for (const sectionId of MAIN_SECTION_IDS) {
    document.getElementById(sectionId).style.display = sectionId === id ? '' : 'none';
  }
  // El auto-refresh de 5 minutos del Dashboard solo tiene sentido mientras
  // ese panel está a la vista — si se navega a cualquier otra sección hay
  // que frenarlo (ver openDashboardSection más abajo), si no seguiría
  // pegándole a /api/dashboard de fondo para siempre.
  if (id !== 'dashboardSection' && typeof stopDashboardAutoRefresh === 'function') {
    stopDashboardAutoRefresh();
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
  const pagoPlazoFijosSection = document.getElementById('pagoPlazoFijosSection');

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
  state.pagoPlazoFijosRows = [];
  state.pagoPlazoFijosFechaProcesoISO = null;
  document.getElementById('pagoPlazoFijosProgress').textContent = '';
  document.getElementById('pagoPlazoFijosResult').style.display = 'none';
  document.getElementById('confirmarPagoPlazoFijosBtn').disabled = true;
  hideCsvSummary('pagoPlazoFijosSummary');

  if (isPagoPlazoFijosFlow(state.selectedFlow)) {
    form.style.display = 'none';
    csvSection.style.display = 'none';
    pagoPlazoFijosSection.style.display = '';
    // Esta corrida no se arma llenando un form ni subiendo un CSV: no tiene
    // sentido mostrar la tabla de log paso a paso genérica ni el botón
    // "Ejecutar flow" (ver runFlow/updateRunButtonState) — el disparo es
    // "Buscar..." + "Confirmar y pagar" dentro de #pagoPlazoFijosSection.
    document.getElementById('logTable').style.display = 'none';
    document.getElementById('runBtn').style.display = 'none';
  } else if (isCsvFlow(state.selectedFlow)) {
    form.style.display = 'none';
    csvSection.style.display = '';
    pagoPlazoFijosSection.style.display = 'none';
    document.getElementById('runBtn').style.display = '';
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
    pagoPlazoFijosSection.style.display = 'none';
    document.getElementById('runBtn').style.display = '';
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

function hideCsvSummary(targetId = 'csvSummary') {
  const summaryEl = document.getElementById(targetId);
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
function renderCsvSummary(flow, totalRows, stepCounts, contraasientoCounts, targetId = 'csvSummary') {
  const summaryEl = document.getElementById(targetId);
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

// No es un flow CSV ni manual: no tiene inputs para llenar a mano ni un
// archivo para subir. Las filas a procesar (una por plazo fijo a pagar)
// salen de una consulta al servidor (GET /api/plazos-fijos-a-pagar, ver
// buscarPlazosFijosAPagar) — ver #pagoPlazoFijosSection en index.html y
// runPagoPlazoFijos más abajo.
function isPagoPlazoFijosFlow(flow) {
  return !!flow && flow.name === 'Pago de Plazo Fijos';
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

// Mismo criterio para "Transferencia DEBIN - File": clave debitoCuit|idComprobante
// (columnas 4 y 7 del archivo), contra las transferencias ya realizadas en dbn_consulta.
async function checkDuplicateTransferencias(rows) {
  const transferencias = rows.map((row) => ({
    debitoCuit: (row[3] || '').trim(),
    idComprobante: (row[6] || '').trim(),
  }));

  const res = await apiFetch('/api/check-transferencias', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transferencias }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Error desconocido.');
  }

  return new Set((data.duplicates || []).map((d) => `${d.debitoCuit}|${d.idComprobante}`));
}

// Registra en dbn_consulta una transferencia apenas se hace o se rechaza, sin
// esperar al final del archivo: si el proceso se corta, igual queda para el
// antiduplicado, el límite diario y la conciliación. El guardado final de
// dbnconsulta-...csv actualiza la misma fila (por idMensaje). Una falla acá
// no corta el archivo: el guardado final la vuelve a registrar.
async function registrarDbnConsultaRow(consultaRow) {
  try {
    await apiFetch('/api/dbn-consulta-rows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: [consultaRow] }),
    });
  } catch (err) {
    // Ver comentario de la función.
  }
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

// Mismo criterio que normalizeMonedaCodigo en node/lib/debinOutputStore.js:
// la columna Moneda del CSV no trae "ARS"/"USD", trae el código numérico
// que espera Nova-Link (ISO 4217 — "032"/"32" = ARS, "840" = USD, ver
// defaultValue de "moneda" en Flows/transferencia-debin.json). Los límites
// de Parametría están en ARS/USD, así que hay que traducir el código antes
// de comparar — si no, "32" nunca matchea la clave "ARS" y el límite queda
// sin aplicarse.
function normalizeMonedaCodigoLocal(raw) {
  const value = String(raw || '').trim();
  const numeric = value.replace(/^0+(?=\d)/, '');
  if (numeric === '32') return 'ARS';
  if (numeric === '840') return 'USD';
  return value.toUpperCase();
}

// Mismo criterio que transferidoHoyKey en node/lib/debinOutputStore.js: un
// acumulado independiente por CUIT, moneda Y destinatario (ARS/USD y
// mismo-CUIT/terceros no se mezclan entre sí, ver Parametría > "Límite
// diario de transferencias"). moneda pasa por normalizeMonedaCodigoLocal
// (código numérico -> ARS/USD) antes de armar la clave. destinatario es
// literalmente 'mismo' o 'terceros'.
function transferidoHoyKeyLocal(cuit, moneda, destinatario) {
  return `${cuit}|${normalizeMonedaCodigoLocal(moneda)}|${destinatario}`;
}

// Junta los CUIT origen únicos de todas las filas (columna 4, debitoCuit) y
// hace UNA sola consulta al servidor (GET /api/transferencias-limite, ver
// handleTransferenciasLimiteGet en server.js) para traer, por moneda y
// destinatario (ARS/USD × mismo/terceros), el límite diario configurado en
// Parametría y cuánto transfirió cada CUIT hoy — en vez de una consulta por
// fila. limites.ARS.mismo/.terceros (e ídem USD) quedan en null si no hay
// límite configurado para esa combinación.
async function fetchTransferenciasLimite(rows) {
  const cuits = new Set();
  for (const row of rows) {
    const debitoCuit = (row[3] || '').trim();
    if (debitoCuit) cuits.add(debitoCuit);
  }
  const limitesVacios = { ARS: { mismo: null, terceros: null }, USD: { mismo: null, terceros: null } };
  if (cuits.size === 0) return { limites: limitesVacios, acumulado: new Map() };

  const res = await apiFetch('/api/transferencias-limite?cuits=' + encodeURIComponent(Array.from(cuits).join(',')));
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'No se pudo consultar el límite diario de transferencias.');
  }

  function limiteNum(v) {
    return v == null ? null : Number(v);
  }
  const limitesData = data.limites || {};
  const limites = {
    ARS: { mismo: limiteNum((limitesData.ARS || {}).mismo), terceros: limiteNum((limitesData.ARS || {}).terceros) },
    USD: { mismo: limiteNum((limitesData.USD || {}).mismo), terceros: limiteNum((limitesData.USD || {}).terceros) },
  };
  const acumulado = new Map();
  for (const cuit of cuits) {
    const porCuit = (data.acumulado || {})[cuit] || {};
    for (const moneda of ['ARS', 'USD']) {
      const porMoneda = porCuit[moneda] || {};
      for (const destinatario of ['mismo', 'terceros']) {
        acumulado.set(transferidoHoyKeyLocal(cuit, moneda, destinatario), Number(porMoneda[destinatario]) || 0);
      }
    }
  }
  return { limites, acumulado };
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

// "Consulta DEBIN" manual: si la operación es de una transferencia de ApiCore
// (dbn_consulta) que quedó sin estado de acreditación, guarda el estado que
// devolvió Nova-Link para que la conciliación lo vea. Si no hay transferencia
// con ese id, el servidor no hace nada. Una falla acá no corta la consulta.
async function guardarEstadoConsultaDebin(idOperacion, log) {
  const lastEntry = log[log.length - 1];
  if (!idOperacion || !lastEntry || lastEntry.status !== 'Success' || !lastEntry.responseSummary) return;
  try {
    const campos = extractDebinConsultaFields(JSON.parse(lastEntry.responseSummary));
    const res = await apiFetch('/api/dbn-consulta-estado', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idOperacion, campos }),
    });
    const data = await res.json();
    if (res.ok && data.actualizadas > 0) {
      alert(`Estado guardado en ApiCore: ${data.estadoCodigo || 'sin estado'}${data.estadoDescripcion ? ' — ' + data.estadoDescripcion : ''} (${data.actualizadas} transferencia).`);
    }
  } catch (err) {
    // No es parte de la consulta: se ignora.
  }
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
    if (state.selectedFlow.name === 'Consulta DEBIN') await guardarEstadoConsultaDebin(inputs.idOperacion, state.lastLog);
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
    if (isPlazoFijoCocosFilesSqlFlow(flow) || isTransferenciaDebinFilesFlow(flow)) {
      progressEl.textContent = 'Verificando operaciones ya procesadas...';
      try {
        duplicateOps = isPlazoFijoCocosFilesSqlFlow(flow)
          ? await checkDuplicateOperations(rows)
          : await checkDuplicateTransferencias(rows);
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

    // Para "Transferencia DEBIN - File": límite diario configurable por
    // CUIT origen, moneda Y destinatario (debitoCuit + moneda + mismo/
    // terceros, ver Parametría > "Límite diario de transferencias") — UNA
    // sola consulta al servidor con todos los CUIT origen del archivo
    // (cuánto ya transfirió cada uno hoy, por moneda y destinatario, ver
    // getTransferidoHoyPorCuit en debinOutputStore.js), antes de procesar
    // ninguna fila. limitesDiarioTransferencias.ARS.mismo/.terceros (e ídem
    // USD) quedan en null si no hay límite configurado para esa combinación
    // — en ese caso no se bloquea nada ahí, mismo comportamiento que antes
    // de este feature.
    let transferidoHoyPorCuit = null;
    let limitesDiarioTransferencias = null;
    if (isTransferenciaDebinFilesFlow(flow)) {
      progressEl.textContent = 'Consultando límite diario de transferencias...';
      try {
        const limiteInfo = await fetchTransferenciasLimite(rows);
        transferidoHoyPorCuit = limiteInfo.acumulado;
        limitesDiarioTransferencias = limiteInfo.limites;
      } catch (err) {
        alert('Error consultando el límite diario de transferencias: ' + err.message);
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

        // Límite diario de transferencias por CUIT origen, moneda Y
        // destinatario (Parametría > debin.limiteDiarioArs/UsdMismoCuit/
        // Terceros) — 4 acumulados y topes totalmente independientes entre
        // sí, no se mezclan ARS con USD ni mismo CUIT con terceros. Si no
        // hay límite configurado para la combinación de esta fila no se
        // bloquea nada. Solo se evalúa si el CBU ya es válido (de donde
        // sale inputs.mismoTitular): no tiene sentido sumar el importe de
        // una fila con CBU inválido (que ni va a intentar transferirse) al
        // acumulado del CUIT.
        let limiteDiarioError = null;
        if (!debinCbuError && isTransferenciaDebinFilesFlow(flow)) {
          const debitoCuit = (inputs.debitoCuit || '').trim();
          const moneda = normalizeMonedaCodigoLocal(inputs.moneda);
          const destinatario = inputs.mismoTitular === '1' ? 'mismo' : 'terceros';
          const limitesMoneda = limitesDiarioTransferencias ? limitesDiarioTransferencias[moneda] : null;
          const limiteValor = limitesMoneda ? limitesMoneda[destinatario] : null;
          if (limiteValor != null) {
            const importeFila = Number(inputs.importe) || 0;
            const yaTransferido = transferidoHoyPorCuit.get(transferidoHoyKeyLocal(debitoCuit, moneda, destinatario)) || 0;
            if (yaTransferido + importeFila > limiteValor) {
              const destinatarioLabel = destinatario === 'mismo' ? 'mismo CUIT' : 'terceros';
              limiteDiarioError =
                `Límite diario de transferencias en ${moneda} a ${destinatarioLabel} superado para el CUIT ` +
                `${debitoCuit}: ya transfirió ${yaTransferido.toFixed(2)} hoy, esta fila (${importeFila.toFixed(2)}) ` +
                `superaría el límite de ${limiteValor.toFixed(2)}.`;
            }
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
        } else if (isTransferenciaDebinFilesFlow(flow)) {
          const key = `${(row[3] || '').trim()}|${(row[6] || '').trim()}`;
          if (duplicateOps.has(key)) {
            duplicateError = `Esta transferencia (CUIT origen ${row[3]}, comprobante ${row[6]}) ya se realizó antes — se bloquea para evitar una transferencia duplicada.`;
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

        if (duplicateError || accountLookupError || circuitoError || debinCbuError || limiteDiarioError) {
          rowEntries = [
            {
              name: `Fila ${rowNumber}`,
              status: 'Error',
              requestSummary: null,
              responseSummary: null,
              httpStatusCode: null,
              durationMs: 0,
              errorMessage: duplicateError || accountLookupError || circuitoError || debinCbuError || limiteDiarioError,
              // Marca este motivo puntual (ver más abajo, bloque de
              // dbnconsulta-...csv): a diferencia de un CBU inválido o una
              // operación duplicada, el límite diario sí tiene que quedar
              // registrado en dbnconsulta, igual que un rechazo de negocio.
              isLimiteDiarioExceeded: !!limiteDiarioError && !duplicateError,
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
        // Para un rechazo de negocio (ver isBusinessRejection) se prefiere el
        // texto limpio de businessRejectionMessage (ej. "Cuenta No Existente")
        // en vez del errorMessage técnico/verboso — el mismo texto que ya se
        // usa en el semáforo (classifyStepErrorType) y en dbnconsulta-...csv.
        const rowErrorMessage = failedEntry
          ? failedEntry.isBusinessRejection && failedEntry.businessRejectionMessage
            ? failedEntry.businessRejectionMessage
            : failedEntry.errorMessage
          : '';
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
              // La respuesta de un alta OK trae en output[].codigoCuenta la
              // cuenta de Plazo Fijo (sist 4) recién creada por IBS. Si este
              // CUIT no tenía cuenta de PF al arrancar la corrida (quedó sin
              // cuecodSistema4 en el Map que arma fetchAccountsByCuit, UNA
              // sola vez para todo el archivo), hay que completarla ACÁ: si
              // no, una segunda fila del mismo CUIT en el mismo archivo
              // seguiría mandando "codigoCuenta" vacío (ver omitIfNull en el
              // step "3. Alta de Plazo Fijo") e IBS la rechaza con "la cuenta
              // ingresada no pertenece al cliente", porque ya le creó una
              // cuenta de PF con la fila anterior pero este alta no la
              // referencia.
              if (rowAccounts && first.codigoCuenta != null && String(first.codigoCuenta) !== '') {
                rowAccounts.cuecodSistema4 = String(first.codigoCuenta);
              }
              const operationRecord = {
                cuit: rowCuit,
                numeroComprobante: (row[4] || '').trim(),
                idMensaje: rowIdMensaje,
                cajaAhorro: (rowAccounts && rowAccounts.cuecodSistema5) || '',
                importeNeto: first.importeNeto,
                fechaVencimiento: first.vencimiento,
                tipoCircuito: (row[row.length - 1] || '').trim(),
                pfPagado: false,
                apellidoNombre: (row[1] || '').trim(),
                monto: (row[2] || '').trim(),
                plazo: (row[3] || '').trim(),
                operacion: first.operacion,
                tna: first.tna,
              };
              state.successfulOperations.push(operationRecord);
              // Registrar ACÁ, fila por fila, no solo en el bloque final de
              // más abajo (al terminar TODO el archivo): si el proceso se
              // corta a mitad de camino (pestaña cerrada, red caída, página
              // recargada) antes de llegar a ese bloque final, esta fila —
              // que YA se dio de alta en el banco — queda igual protegida
              // contra un reintento futuro del mismo archivo. Sin esto, un
              // alta real que sí se había hecho quedaba sin registrar, y
              // volver a subir el mismo CSV repetía débito/crédito/alta
              // (caso real: comprobante 4397, dado de alta dos veces el
              // 03/11 porque la primera corrida se cortó antes del registro
              // final). ON DUPLICATE KEY UPDATE en addProcessedOperations
              // (ver processedOperationsStore.js) hace que registrar la misma
              // fila acá Y en el bloque final (si ambos llegan a correr) no
              // sea un problema. Falla de red puntual acá no aborta el resto
              // del archivo — el bloque final sigue siendo el respaldo del
              // caso normal (corrida que termina sin cortarse).
              try {
                await apiFetch('/api/register-operations', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ operations: [operationRecord] }),
                });
              } catch (err) {
                // Sin acción: el bloque final al terminar el archivo reintenta
                // el registro de todas las operaciones exitosas igual.
              }
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
            // Se suma al acumulado EN MEMORIA del CUIT origen + moneda +
            // destinatario (no alcanza con lo que ya traía el servidor al
            // arrancar la corrida, ver fetchTransferenciasLimite): si el
            // mismo CUIT aparece en otra fila más abajo de este mismo
            // archivo CON LA MISMA MONEDA Y EL MISMO DESTINATARIO, tiene que
            // ver este importe ya sumado — mismo criterio que el Map de
            // cuentas de "Alta de Plazo Fijos - File" (ver
            // fetchAccountsByCuit).
            if (transferidoHoyPorCuit) {
              const creditoCuit = (row[0] || '').trim();
              const debitoCuit = (row[3] || '').trim();
              const importeFila = Number(row[8]) || 0;
              const destinatario = creditoCuit === debitoCuit ? 'mismo' : 'terceros';
              // row[7] (moneda) va tal cual: transferidoHoyKeyLocal ya
              // normaliza el código numérico (32/032 -> ARS, 840 -> USD).
              const key = transferidoHoyKeyLocal(debitoCuit, row[7], destinatario);
              transferidoHoyPorCuit.set(key, (transferidoHoyPorCuit.get(key) || 0) + importeFila);
            }
            // Mismas columnas que la fila de dbnconsulta que se arma al
            // final (ver el loop de consultas), con la consulta de estado
            // todavía sin hacer — si el proceso se corta, queda así en la base.
            const pendingConsultaRow = {
              idMensaje: rowIdMensaje,
              idComprobante: row[6] || '',
              idOperacion: respuesta.id != null ? respuesta.id : '',
              creditoCuit: row[0] || '',
              creditoCbu: row[1] || '',
              creditoTitular: row[2] || '',
              debitoCuit: row[3] || '',
              debitoCbu: row[4] || '',
              debitoTitular: row[5] || '',
              moneda: row[7] || '',
              importe: row[8] || '',
              codigoRespuestaTransferencia: respuesta.codigo != null ? respuesta.codigo : '',
              descripcionRespuestaTransferencia: respuesta.descripcion != null ? respuesta.descripcion : '',
              realizado: 's',
              errorConsulta: 'Consulta de estado pendiente',
            };
            for (const col of DEBIN_CONSULTA_COLUMNS) pendingConsultaRow[col] = '';
            await registrarDbnConsultaRow(pendingConsultaRow);
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
        // archivo, (b) Nova-Link rechazó la transferencia por un motivo de
        // negocio (HTTP 200 con una descripcionRespuesta puntual — ver
        // failIfEquals en el step "2. Transferencia DEBIN": hoy cubre
        // "ERROR GENERAL GARANTIAS" y "No existe saldo para efectuar el
        // debito", agregar otro motivo es solo otra tupla ahí), o (c) se
        // bloqueó por superar el límite diario (ver limiteDiarioError más
        // arriba) — también se agrega una fila a dbnconsulta-...csv (además
        // de dbnouterror-...csv) con el mismo formato fijo para todos los
        // casos (compradorCuentaCbu/estadoCodigo/estadoDescripcion, no
        // errorConsulta) — solo cambia el texto de estadoDescripcion. A
        // diferencia de un CBU inválido o una operación duplicada (que NO
        // generan fila en dbnconsulta, solo en dbnouterror), el límite
        // diario sí queda acá: es un rechazo que vale la pena ver en el
        // mismo lugar que el resto de los rechazos de negocio.
        const mismatchEntry = rowEntries.find((entry) => entry.isVariableMismatch);
        const businessRejectionEntry = rowEntries.find((entry) => entry.isBusinessRejection);
        const limiteDiarioEntry = rowEntries.find((entry) => entry.isLimiteDiarioExceeded);
        if (mismatchEntry || businessRejectionEntry || limiteDiarioEntry) {
          // Si fue un rechazo de negocio, el step "2. Transferencia DEBIN" sí
          // llegó a correr y responseSummary ya tiene el body completo (se
          // guarda ANTES de evaluar failIfEquals, ver invokeHttpStep en
          // flowEngine.js) — se puede sacar codigo/descripcion de la
          // transferencia en sí de ahí, igual que el bloque de éxito más
          // arriba. Si fue un mismatch de CUIT/CBU o se bloqueó por el
          // límite diario, el step 2 nunca corrió: no hay respuesta de
          // transferencia que parsear, quedan en blanco.
          let codigoRespuestaTransferencia = '';
          let descripcionRespuestaTransferencia = '';
          if (businessRejectionEntry && businessRejectionEntry.responseSummary) {
            try {
              const parsed = JSON.parse(businessRejectionEntry.responseSummary);
              const respuesta = (parsed.params && parsed.params.response && parsed.params.response.respuesta) || {};
              codigoRespuestaTransferencia = respuesta.codigo != null ? respuesta.codigo : '';
              descripcionRespuestaTransferencia = respuesta.descripcion != null ? respuesta.descripcion : '';
            } catch (err) {
              // Respuesta no vino en el formato esperado; quedan en blanco.
            }
          }

          const consultaRow = {
            idMensaje: rowIdMensaje,
            idComprobante: row[6] || '',
            idOperacion: '',
            // Datos del archivo de entrada (mismo orden de columnas que el
            // resto del código usa para esta fila, ver debinDetailRows más
            // arriba) — se guardan además de compradorCuentaCbu/etc. de
            // abajo, no en su reemplazo.
            creditoCuit: row[0] || '',
            creditoCbu: row[1] || '',
            creditoTitular: row[2] || '',
            debitoCuit: row[3] || '',
            debitoCbu: row[4] || '',
            debitoTitular: row[5] || '',
            moneda: row[7] || '',
            importe: row[8] || '',
            // Resultado de la transferencia original (no el de la consulta
            // de estado, que son los campos sueltos más abajo) — la fila
            // nunca llegó a transferirse con éxito, así que realizado = 'n'.
            codigoRespuestaTransferencia,
            descripcionRespuestaTransferencia,
            realizado: 'n',
            errorConsulta: '',
          };
          for (const col of DEBIN_CONSULTA_COLUMNS) consultaRow[col] = '';
          consultaRow.compradorCuentaCbu = row[4] || ''; // CBU origen (debitoCbu)
          consultaRow.estadoCodigo = 'Error';
          consultaRow.estadoDescripcion = mismatchEntry
            ? 'El CUIT no coincide con el CBU Destino'
            : limiteDiarioEntry
              ? 'Transferencia no realizada, supera el limite diario'
              : businessRejectionEntry.businessRejectionMessage;
          state.debinConsultaRows.push(consultaRow);
          await registrarDbnConsultaRow(consultaRow);
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
          // Datos del archivo de entrada: detailRow ya los tiene (ver
          // debinDetailRows más arriba), se copian tal cual.
          creditoCuit: detailRow.creditoCuit || '',
          creditoCbu: detailRow.creditoCbu || '',
          creditoTitular: detailRow.creditoTitular || '',
          debitoCuit: detailRow.debitoCuit || '',
          debitoCbu: detailRow.debitoCbu || '',
          debitoTitular: detailRow.debitoTitular || '',
          moneda: detailRow.moneda || '',
          importe: detailRow.importe || '',
          // Resultado de la transferencia original (detailRow ya lo tiene,
          // viene de la respuesta del POST credin) — esta fila solo llega
          // acá si realizado ya era 's' (ver el filtro de toQuery).
          codigoRespuestaTransferencia: detailRow.codigoRespuesta || '',
          descripcionRespuestaTransferencia: detailRow.descripcionRespuesta || '',
          realizado: 's',
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
    // "Transferencia DEBIN - File" no guarda su propio archivo "ok" bajo el
    // runId de la corrida (batchOkFileName siempre queda null para ese
    // flow, ver saveOutputFiles): el archivo con el detalle completo
    // (dbnconsulta-..., incluidos los rechazos de negocio) se guarda con un
    // runId PROPIO (consultaOkFileName). Como cada corrida es de un solo
    // flow CSV, nunca se llenan los dos a la vez — hay que reportar el que
    // haya, para que "Archivos de salida" (y el botón "Descargar OK") sepan
    // de qué archivo se trata.
    const reportedOkFileName = saved.consultaOkFileName || saved.batchOkFileName;
    if (batchLogFileName) {
      await postRunSummary(batchLogFileName, flow.name, reportedOkFileName, saved.batchErrorFileName, pasosOk, pasosError);
    }
    progressEl.textContent = doneText;
  } catch (err) {
    alert('Error leyendo el CSV: ' + err.message);
  } finally {
    runBtn.disabled = false;
  }
}

// "Buscar plazos fijos a pagar" (flow "Pago de Plazo Fijos"): trae del
// servidor los plazos fijos con fecha_vencimiento = hoy, tipo_circuito = 0
// y pf_pagado = 0 (ver findOperationsToPay en processedOperationsStore.js)
// y los muestra en una tabla para revisar antes de tocar ningún endpoint
// del banco — correrPagoPlazoFijos recién se puede apretar después de esto.
async function buscarPlazosFijosAPagar() {
  const buscarBtn = document.getElementById('buscarPagoPlazoFijosBtn');
  const confirmBtn = document.getElementById('confirmarPagoPlazoFijosBtn');
  const progressEl = document.getElementById('pagoPlazoFijosProgress');
  const resultDiv = document.getElementById('pagoPlazoFijosResult');
  const tbody = document.getElementById('pagoPlazoFijosBody');

  buscarBtn.disabled = true;
  confirmBtn.disabled = true;
  resultDiv.style.display = 'none';
  hideCsvSummary('pagoPlazoFijosSummary');
  progressEl.textContent = 'Buscando plazos fijos a pagar...';
  state.pagoPlazoFijosRows = [];

  try {
    const res = await apiFetch('/api/plazos-fijos-a-pagar');
    const data = await res.json();
    if (!res.ok) throw new Error((data && data.error) || 'Error buscando plazos fijos a pagar.');

    const rows = data.operaciones || [];
    // fechaProcesoISO (yyyy-MM-dd) es la fecha de PROCESO bancaria que ya usó
    // el servidor para esta misma búsqueda (ver handlePlazosFijosAPagarGet) —
    // se guarda acá para mandarla de vuelta como input "fechaProceso" al
    // correr cada fila (FechaMovimiento/FechaNegocio del débito y el crédito
    // tienen que ser esta fecha, no la del reloj del navegador ni la del
    // servidor al momento de "Confirmar y pagar", que puede ser más tarde).
    state.pagoPlazoFijosFechaProcesoISO = data.fechaProcesoISO;
    state.pagoPlazoFijosRows = rows;
    tbody.innerHTML = '';
    for (const row of rows) {
      const tr = document.createElement('tr');
      // Circuito '1' (solo alta) no recibe débito/crédito real al confirmar
      // — se lista igual, a título informativo, para que quede en el mismo
      // archivo de salida del día (ver confirmarPagoPlazoFijos más abajo).
      const circuitoLabel = String(row.tipoCircuito) === '1' ? '1 (solo constancia, sin movimiento)' : '0';
      tr.innerHTML = `
        <td>${escapeHtml(row.cuit)}</td>
        <td>${escapeHtml(row.apellidoNombre)}</td>
        <td>${escapeHtml(row.numeroComprobante)}</td>
        <td>${escapeHtml(row.importeNeto)}</td>
        <td>${escapeHtml(row.cajaAhorro)}</td>
        <td>${escapeHtml(row.fechaVencimiento)}</td>
        <td>${escapeHtml(circuitoLabel)}</td>
      `;
      tbody.appendChild(tr);
    }
    progressEl.textContent = `${rows.length} plazo(s) fijo(s) a pagar (fecha de proceso: ${data.fechaProceso}).`;
    resultDiv.style.display = '';
    confirmBtn.disabled = rows.length === 0;
  } catch (err) {
    progressEl.textContent = '';
    alert('Error buscando plazos fijos a pagar: ' + err.message);
  } finally {
    buscarBtn.disabled = false;
  }
}

// "Confirmar y pagar": corre el flow "Pago de Plazo Fijos" (Débito en Caja
// de Ahorro + Crédito en Cuenta Corriente, en ese orden — si el débito
// falla, flowEngine.js corta la cadena y no llega a correr el crédito, ver
// invokeFlow) una vez por cada fila que trajo buscarPlazosFijosAPagar. Todas
// las filas comparten un solo log (mismo criterio que batchLogFileName en
// runFlowFromCsv) y, al terminar, se marca pf_pagado = 1 en
// operaciones_procesadas solo para las filas donde los 2 pasos salieron
// bien — una fila con el débito en error nunca llega a marcarse (ni se
// intenta el crédito), así puede reintentarse en una corrida posterior sin
// haber tocado ninguna cuenta.
async function confirmarPagoPlazoFijos() {
  const flow = state.selectedFlow;
  const rows = state.pagoPlazoFijosRows || [];
  if (rows.length === 0) return;

  const buscarBtn = document.getElementById('buscarPagoPlazoFijosBtn');
  const confirmBtn = document.getElementById('confirmarPagoPlazoFijosBtn');
  const progressEl = document.getElementById('pagoPlazoFijosProgress');

  buscarBtn.disabled = true;
  confirmBtn.disabled = true;
  document.getElementById('logBody').innerHTML = '';
  state.lastLog = [];

  const stepCounts = flow.steps.map(() => ({ ok: 0, error: 0, skipped: 0, errorTypes: {} }));
  let batchLogFileName = `http/${generateFallbackStamp()}-${flowLogNameFallback(flow)}.log`;
  const paidOperations = [];
  // Filas circuito=1 listadas a título informativo (ver más abajo): cuentan
  // como "ok" para el resumen de la corrida (no son un error), aunque no
  // se les haya hecho ningún movimiento bancario ni se sumen a
  // paidOperations (pf_pagado sigue en 0 para ellas).
  let circuitoUnoCount = 0;
  // Filas para los 2 archivos de salida (ver más abajo, después del loop):
  // <runId>.csv (pago OK) y <runId>-error.csv (motivo del fallo) — mismo
  // criterio de "2 archivos, mismo runId" que pfout/pfouterror para "Alta
  // de Plazo Fijos - File".
  const okRows = [];
  const errorRows = [];
  const startedAt = Date.now();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNumber = i + 1;
    // Circuito '1' (solo alta, ver findOperationsToPay) nunca recibe débito
    // en Caja de Ahorro ni crédito en Cuenta Corriente acá — se lista en el
    // mismo archivo de salida del día solo a título informativo, sin llamar
    // a ningún endpoint del banco ni marcarse pf_pagado (no hubo pago real
    // que marcar). Solo circuito '0' corre el flow de verdad.
    const esCircuitoUno = String(row.tipoCircuito) === '1';
    progressEl.textContent = esCircuitoUno
      ? `Fila ${rowNumber} de ${rows.length} (CUIT ${row.cuit}, comprobante ${row.numeroComprobante}): circuito 1, sin movimiento bancario, solo constancia...`
      : `Pagando ${rowNumber} de ${rows.length} (CUIT ${row.cuit}, comprobante ${row.numeroComprobante})...`;

    // Un IdMensaje propio por fila (mismo criterio que runFlowFromCsv para
    // "Alta de Plazo Fijos - File"): generado acá para que quede disponible
    // en los 2 archivos de salida aunque la fila ni siquiera haya llegado a
    // llamar a ningún endpoint del banco (fila sin Caja de Ahorro, ver
    // abajo) — el server también lo genera si no se lo mandamos
    // (idMensajeGenerado), pero entonces el cliente nunca se entera de cuál
    // usó.
    const rowIdMensaje = generateIdMensaje();

    if (esCircuitoUno) {
      const pagoRow = {
        idMensaje: rowIdMensaje,
        cuit: row.cuit,
        apellidoNombre: row.apellidoNombre || '',
        numeroComprobante: row.numeroComprobante,
        importe: row.importeNeto || '',
        cajaAhorro: row.cajaAhorro || '',
        fechaVencimiento: row.fechaVencimiento || '',
        circuito: '1',
      };
      okRows.push(pagoRow);
      circuitoUnoCount++;
      const infoEntry = {
        name: `Fila ${rowNumber} — Circuito 1 (solo constancia, sin movimiento bancario)`,
        status: 'Success',
        requestSummary: null,
        responseSummary: null,
        httpStatusCode: null,
        durationMs: 0,
        errorMessage: null,
      };
      state.lastLog = state.lastLog.concat([infoEntry]);
      document.getElementById('saveLogBtn').disabled = state.lastLog.length === 0;
      renderCsvSummary(flow, rows.length, stepCounts, null, 'pagoPlazoFijosSummary');
      continue;
    }

    let rowEntries;
    if (!row.cajaAhorro) {
      // Sin cuenta de Caja de Ahorro guardada (dato faltante de una
      // instalación anterior a esta columna, o de un alta hecha antes de
      // que se empezara a guardar) no se llama a ningún endpoint del
      // banco — mismo criterio de seguridad que accountLookupError en
      // runFlowFromCsv para "Alta de Plazo Fijos - File".
      rowEntries = [
        {
          name: '1. Débito en Caja de Ahorro',
          status: 'Error',
          requestSummary: null,
          responseSummary: null,
          httpStatusCode: null,
          durationMs: 0,
          errorMessage: `No hay cuenta de Caja de Ahorro guardada para el CUIT ${row.cuit} (comprobante ${row.numeroComprobante}).`,
        },
      ];
    } else {
      const inputs = {
        cuit: row.cuit,
        apellidoNombre: row.apellidoNombre || '',
        numeroComprobante: row.numeroComprobante,
        importe: row.importeNeto || '',
        cajaAhorro: row.cajaAhorro,
        idMensajeGenerado: rowIdMensaje,
        // FechaMovimiento/FechaNegocio/FechayHoraMensaje del débito y el
        // crédito tienen que ser la fecha de PROCESO bancaria (la misma que
        // ya se usó para buscar esta fila, ver buscarPlazosFijosAPagar), no
        // la del reloj al momento de "Confirmar y pagar" — por eso viaja
        // como input en vez de dejar que el flow use {{nowDate}}.
        fechaProceso: state.pagoPlazoFijosFechaProcesoISO,
      };
      try {
        rowEntries = await runFlowByName(flow.name, inputs, batchLogFileName);
        batchLogFileName = rowEntries.runLogFileName || batchLogFileName;
      } catch (err) {
        rowEntries = [
          {
            name: '1. Débito en Caja de Ahorro',
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
      const entry = rowEntries[s];
      if (entry && entry.status === 'Success') {
        stepCounts[s].ok++;
      } else {
        stepCounts[s].error++;
        const errorType = classifyStepErrorType(entry);
        stepCounts[s].errorTypes[errorType] = (stepCounts[s].errorTypes[errorType] || 0) + 1;
      }
    }

    const allOk = rowEntries.length === flow.steps.length && rowEntries.every((entry) => entry.status === 'Success');
    // "Datos del pago del PF": los mismos datos con los que se corrió la
    // fila (numeroComprobante/cuit/apellidoNombre/importe/cajaAhorro/
    // fechaVencimiento) más el IdMensaje que se le generó — iguales en el
    // archivo OK y en el de error, este último con "motivo" al final.
    const pagoRow = {
      idMensaje: rowIdMensaje,
      cuit: row.cuit,
      apellidoNombre: row.apellidoNombre || '',
      numeroComprobante: row.numeroComprobante,
      importe: row.importeNeto || '',
      cajaAhorro: row.cajaAhorro || '',
      fechaVencimiento: row.fechaVencimiento || '',
      circuito: '0',
    };
    if (allOk) {
      const paidOperation = { cuit: row.cuit, numeroComprobante: row.numeroComprobante, idMensaje: rowIdMensaje };
      paidOperations.push(paidOperation);
      okRows.push(pagoRow);
      // Marcar pf_pagado ACÁ, fila por fila, no solo en el bloque final de
      // más abajo — mismo motivo que el registro incremental en
      // runFlowFromCsv (ver comentario ahí): si el proceso se corta a mitad
      // de camino, este pago YA hecho en el banco (débito en Caja de Ahorro)
      // queda igual marcado, y un reintento del mismo archivo no lo vuelve a
      // pagar. markOperationsPaid (ver processedOperationsStore.js) es un
      // UPDATE por cuit+numeroComprobante: llamarlo de nuevo en el bloque
      // final no tiene efecto extra.
      try {
        await apiFetch('/api/plazos-fijos-pagados', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operations: [paidOperation] }),
        });
      } catch (err) {
        // Sin acción: el bloque final al terminar el archivo reintenta
        // marcar como pagadas todas las operaciones exitosas igual.
      }
    } else {
      const failedEntry = rowEntries.find((entry) => entry.status !== 'Success' && entry.errorMessage);
      errorRows.push({ ...pagoRow, motivo: failedEntry ? failedEntry.errorMessage : '' });
    }

    renderCsvSummary(flow, rows.length, stepCounts, null, 'pagoPlazoFijosSummary');

    const prefixed = rowEntries.map((entry) => ({ ...entry, name: `Fila ${rowNumber} — ${entry.name}` }));
    state.lastLog = state.lastLog.concat(prefixed);
    document.getElementById('saveLogBtn').disabled = state.lastLog.length === 0;
  }

  let doneText = `Listo: ${rows.length} plazo(s) fijo(s) procesado(s) en ${formatDurationShort(Date.now() - startedAt)}` +
    (circuitoUnoCount > 0 ? ` (${circuitoUnoCount} de circuito 1, sin movimiento bancario, solo constancia).` : '.');

  // 2 archivos de salida, mismo runId (atado al log de esta corrida, igual
  // que pfout/pfouterror): <runId>.csv (pagos OK) y <runId>-error.csv
  // (fallidos, con el motivo).
  const runId = deriveRunId(batchLogFileName, flow);
  let okFileName = null;
  let errorFileName = null;
  if (okRows.length > 0) {
    const headers = ['idMensaje', 'cuit', 'apellidoNombre', 'numeroComprobante', 'importe', 'cajaAhorro', 'fechaVencimiento', 'circuito'];
    const lines = [headers.join(',')];
    for (const r of okRows) lines.push(headers.map((h) => csvEscape(r[h])).join(','));
    okFileName = await saveOutputFile(runId, 'ok', null, lines.join('\r\n'));
  }
  if (errorRows.length > 0) {
    const headers = ['idMensaje', 'cuit', 'apellidoNombre', 'numeroComprobante', 'importe', 'cajaAhorro', 'fechaVencimiento', 'circuito', 'motivo'];
    const lines = [headers.join(',')];
    for (const r of errorRows) lines.push(headers.map((h) => csvEscape(r[h])).join(','));
    errorFileName = await saveOutputFile(runId, 'error', null, lines.join('\r\n'));
  }
  const savedFiles = [okFileName, errorFileName].filter(Boolean);
  if (savedFiles.length > 0) {
    doneText += ` Guardado en files/: ${savedFiles.join(', ')}.`;
  }

  if (paidOperations.length > 0) {
    try {
      const res = await apiFetch('/api/plazos-fijos-pagados', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations: paidOperations }),
      });
      if (!res.ok) {
        let data = null;
        try {
          data = await res.json();
        } catch (err) {
          // Respuesta de error sin body JSON — se avisa igual, solo que sin
          // el detalle de data.error.
        }
        throw new Error((data && data.error) || `HTTP ${res.status}`);
      }
      doneText += ` ${paidOperations.length} marcado(s) como pagado(s).`;
    } catch (err) {
      // Los pagos que sí se hicieron en el banco no quedan marcados como
      // pagados en operaciones_procesadas — hay que avisar, no fallar en
      // silencio (mismo criterio que el aviso post register-operations en
      // runFlowFromCsv).
      alert('Atención: los pagos se hicieron pero no se pudieron marcar como pagados en la base: ' + err.message);
    }
  }

  if (batchLogFileName) {
    // pasosOk incluye las filas circuito=1 (listadas sin movimiento
    // bancario, pero no son un error) además de las realmente pagadas —
    // ver circuitoUnoCount más arriba.
    const pasosOk = paidOperations.length + circuitoUnoCount;
    await postRunSummary(batchLogFileName, flow.name, okFileName, errorFileName, pasosOk, rows.length - pasosOk);
  }

  progressEl.textContent = doneText;
  buscarBtn.disabled = false;
  confirmBtn.disabled = false;
}

document.getElementById('buscarPagoPlazoFijosBtn').addEventListener('click', buscarPlazosFijosAPagar);
document.getElementById('confirmarPagoPlazoFijosBtn').addEventListener('click', confirmarPagoPlazoFijos);

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
    const headers = [
      'idMensaje', 'idComprobante', 'idOperacion',
      'creditoCuit', 'creditoCbu', 'creditoTitular',
      'debitoCuit', 'debitoCbu', 'debitoTitular',
      'moneda', 'importe',
      'codigoRespuestaTransferencia', 'descripcionRespuestaTransferencia', 'realizado',
      ...DEBIN_CONSULTA_COLUMNS, 'errorConsulta',
    ];
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
const outputFilesFlowFilter = document.getElementById('outputFilesFlowFilter');
let allOutputFiles = []; // última lista traída del servidor, sin filtrar — los filtros de fecha/flow se aplican en el cliente

// Las opciones del <select> salen de los flowName que trajo la última
// consulta (no una lista fija): "Archivos de salida" no se limita a los 3
// flows del Dashboard, puede haber corridas de cualquier flow con resumen
// guardado. Se preserva la selección actual si ese flow sigue entre las
// opciones nuevas (ej. al apretar "Actualizar"), para no resetear el
// filtro elegido en cada refresco.
function populateOutputFilesFlowFilter() {
  const previousValue = outputFilesFlowFilter.value;
  const flowNames = [...new Set(allOutputFiles.map((run) => run.flowName).filter(Boolean))].sort();
  outputFilesFlowFilter.innerHTML = '<option value="">Todos</option>';
  for (const flowName of flowNames) {
    const option = document.createElement('option');
    option.value = flowName;
    option.textContent = flowName;
    outputFilesFlowFilter.appendChild(option);
  }
  outputFilesFlowFilter.value = flowNames.includes(previousValue) ? previousValue : '';
}

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
// los <input type="date"> Desde/Hasta (ambos límites inclusive) y, si hay
// uno elegido, el flow exacto del <select> — los dos filtros se aplican en
// el cliente sobre allOutputFiles, sin volver a pedirle nada al servidor.
function applyOutputFilesFilter() {
  if (!outputFilesDateRangeComplete()) {
    renderOutputFilesTable([], 'Elegí un rango de fechas (Desde y Hasta) para buscar.');
    return;
  }
  const from = outputFilesFromDate.value;
  const to = outputFilesToDate.value;
  const flowFilter = outputFilesFlowFilter.value;
  const filtered = allOutputFiles.filter((run) => {
    const runDate = formatDateOnlyLocal(new Date(run.mtime));
    if (runDate < from || runDate > to) return false;
    if (flowFilter && run.flowName !== flowFilter) return false;
    return true;
  });
  renderOutputFilesTable(filtered, 'No hay ninguna corrida para el rango de fechas y flow elegidos.');
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
  populateOutputFilesFlowFilter();
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

const conciliacionFecha = document.getElementById('conciliacionFecha');

async function downloadConciliacion(tipo) {
  if (!conciliacionFecha.value) {
    alert('Elegí una fecha.');
    return;
  }
  const res = await apiFetch(
    `/api/conciliacion?tipo=${encodeURIComponent(tipo)}&fecha=${encodeURIComponent(conciliacionFecha.value)}`
  );
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'No se pudo generar el archivo de conciliación.');
    return;
  }
  if (data.filas === 0 && !confirm(`No hay operaciones para el ${conciliacionFecha.value}. ¿Descargar el archivo vacío igual?`)) {
    return;
  }
  downloadTextFile(data.name, data.content, 'text/csv');
}

document.getElementById('conciliacionTransferenciasBtn').addEventListener('click', () => downloadConciliacion('transferencias'));
document.getElementById('conciliacionPlazosFijosBtn').addEventListener('click', () => downloadConciliacion('plazos-fijos'));
document.getElementById('conciliacionPagosPlazosFijosBtn').addEventListener('click', () => downloadConciliacion('pagos-plazos-fijos'));

async function openOutputFilesSection() {
  // Por default Desde/Hasta quedan en el día de hoy (rango de un solo día) —
  // así se puede ver algo apenas se abre el panel, sin tener que elegir
  // fecha a mano cada vez. Sigue siendo editable: "Limpiar filtro" los deja
  // vacíos si hace falta buscar en otro rango.
  const today = formatDateOnlyLocal(new Date());
  conciliacionFecha.value = today;
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
  outputFilesFlowFilter.value = '';
  allOutputFiles = [];
  applyOutputFilesFilter();
});
outputFilesFromDate.addEventListener('change', loadOutputFilesList);
outputFilesToDate.addEventListener('change', loadOutputFilesList);
outputFilesFlowFilter.addEventListener('change', applyOutputFilesFilter);

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

// --- Dashboard ---------------------------------------------------------
// Resumen del día (o del rango elegido) de los 3 flows que mueven plata —
// ver handleDashboardGet en server.js. Mismo criterio de filtro de fechas
// que "Archivos de salida" (requiere Desde y Hasta completos), más un
// auto-refresh cada 5 minutos mientras este panel esté a la vista (ver
// showMainSection, que lo frena al navegar a cualquier otro lado).

const DASHBOARD_AUTO_REFRESH_MS = 5 * 60 * 1000;
const dashboardFromDate = document.getElementById('dashboardFromDate');
const dashboardToDate = document.getElementById('dashboardToDate');
const dashboardErrorFlowFilter = document.getElementById('dashboardErrorFlowFilter');
let dashboardAutoRefreshTimer = null;
let lastDashboardData = { porFlow: [], errores: [] };

function dashboardDateRangeComplete() {
  return !!(dashboardFromDate.value && dashboardToDate.value);
}

function renderDashboardTiles(porFlow) {
  const corridas = porFlow.reduce((sum, f) => sum + f.corridas, 0);
  const ok = porFlow.reduce((sum, f) => sum + f.ok, 0);
  const error = porFlow.reduce((sum, f) => sum + f.error, 0);
  const el = document.getElementById('dashboardSummaryTiles');
  el.innerHTML = `
    <div class="dashboard-tile">
      <div class="dashboard-tile-label">Corridas</div>
      <div class="dashboard-tile-value">${corridas}</div>
    </div>
    <div class="dashboard-tile ok">
      <div class="dashboard-tile-label">Operaciones OK</div>
      <div class="dashboard-tile-value">${ok}</div>
    </div>
    <div class="dashboard-tile error">
      <div class="dashboard-tile-label">Operaciones con error</div>
      <div class="dashboard-tile-value">${error}</div>
    </div>
  `;
}

// Un "motivo" por fila de error (ver parseErrorFileRows en server.js) —
// se agrupan y cuentan acá, por flow, para las pastillas de cada card.
function countMotivos(errores, flowName) {
  const counts = new Map();
  for (const e of errores) {
    if (e.flowName !== flowName) continue;
    const motivo = e.motivo || '(sin motivo)';
    counts.set(motivo, (counts.get(motivo) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
}

function renderDashboardPorFlow(porFlow, errores) {
  const el = document.getElementById('dashboardPorFlow');
  el.innerHTML = '';
  for (const flow of porFlow) {
    const total = flow.ok + flow.error;
    const okPct = total > 0 ? Math.round((flow.ok / total) * 100) : 100;
    const motivos = countMotivos(errores, flow.flowName);
    const pills = motivos.length
      ? motivos.map(([motivo, count]) => `<span class="dashboard-motivo-pill">${escapeHtml(motivo)} (${count})</span>`).join('')
      : '<span class="muted">Sin errores</span>';
    const card = document.createElement('div');
    card.className = 'dashboard-flow-card';
    card.innerHTML = `
      <div class="dashboard-flow-card-head">
        <strong>${escapeHtml(flow.flowName)}</strong>
        <span class="muted">${flow.corridas} corrida(s) · ${flow.ok} ok / ${flow.error} error</span>
      </div>
      <div class="dashboard-flow-bar"><span style="width: ${okPct}%"></span></div>
      <div class="dashboard-motivo-pills">${pills}</div>
    `;
    el.appendChild(card);
  }
}

function applyDashboardErrorFilter() {
  const flowFilter = dashboardErrorFlowFilter.value;
  const filtered = flowFilter ? lastDashboardData.errores.filter((e) => e.flowName === flowFilter) : lastDashboardData.errores;
  const tbody = document.getElementById('dashboardErroresBody');
  tbody.innerHTML = '';
  for (const e of filtered) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(e.hora).toLocaleString()}</td>
      <td>${escapeHtml(e.flowName)}</td>
      <td style="font-family: monospace;">${escapeHtml(e.numeroComprobante || '—')}</td>
      <td style="font-family: monospace;">${escapeHtml(e.cuit || '—')}</td>
      <td><span class="dashboard-motivo-pill">${escapeHtml(e.motivo || '—')}</span></td>
      <td><button type="button" class="dashboardVerLogBtn">Descargar log</button></td>
    `;
    tr.querySelector('.dashboardVerLogBtn').addEventListener('click', () => downloadHttpLog(e.logFileName));
    tbody.appendChild(tr);
  }
  const hint = document.getElementById('dashboardErroresEmptyHint');
  hint.style.display = filtered.length === 0 ? '' : 'none';
}

function renderDashboard(data) {
  lastDashboardData = data;
  renderDashboardTiles(data.porFlow);
  renderDashboardPorFlow(data.porFlow, data.errores);
  applyDashboardErrorFilter();
}

async function loadDashboard() {
  if (!dashboardDateRangeComplete()) {
    renderDashboard({ porFlow: [], errores: [] });
    return;
  }
  const params = new URLSearchParams({ from: dashboardFromDate.value, to: dashboardToDate.value });
  const res = await apiFetch('/api/dashboard?' + params.toString());
  if (!res.ok) return;
  const data = await res.json();
  renderDashboard(data);
  document.getElementById('dashboardLastUpdated').textContent = 'Última actualización: ' + new Date().toLocaleTimeString();
}

function stopDashboardAutoRefresh() {
  if (dashboardAutoRefreshTimer) {
    clearInterval(dashboardAutoRefreshTimer);
    dashboardAutoRefreshTimer = null;
  }
}

function startDashboardAutoRefresh() {
  stopDashboardAutoRefresh();
  dashboardAutoRefreshTimer = setInterval(loadDashboard, DASHBOARD_AUTO_REFRESH_MS);
}

async function openDashboardSection() {
  const today = formatDateOnlyLocal(new Date());
  dashboardFromDate.value = today;
  dashboardToDate.value = today;
  dashboardErrorFlowFilter.value = '';
  showMainSection('dashboardSection');
  await loadDashboard();
  startDashboardAutoRefresh();
}

document.getElementById('dashboardBtn').addEventListener('click', openDashboardSection);
document.getElementById('closeDashboardBtn').addEventListener('click', () => showMainSection('flowDetail'));
document.getElementById('refreshDashboardBtn').addEventListener('click', loadDashboard);
document.getElementById('dashboardTodayBtn').addEventListener('click', () => {
  const today = formatDateOnlyLocal(new Date());
  dashboardFromDate.value = today;
  dashboardToDate.value = today;
  loadDashboard();
});
document.getElementById('clearDashboardFilterBtn').addEventListener('click', () => {
  dashboardFromDate.value = '';
  dashboardToDate.value = '';
  renderDashboard({ porFlow: [], errores: [] });
});
dashboardFromDate.addEventListener('change', loadDashboard);
dashboardToDate.addEventListener('change', loadDashboard);
dashboardErrorFlowFilter.addEventListener('change', applyDashboardErrorFilter);

// --- Conciliación con IBS (altas de Plazo Fijo) ------------------------------
// El cruce lo hace el servidor (POST /api/conciliacion/ibs, ver
// node/lib/conciliacionIbs.js); acá solo se lee el archivo y se muestra el
// resultado.

const conciliacionIbsFecha = document.getElementById('conciliacionIbsFecha');
const conciliacionIbsFile = document.getElementById('conciliacionIbsFile');
const conciliacionIbsTipoFilter = document.getElementById('conciliacionIbsTipoFilter');
const conciliacionIbsTipo = document.getElementById('conciliacionIbsTipo');
const conciliacionIbsHasta = document.getElementById('conciliacionIbsHasta');
let lastConciliacionIbs = null;

function formatImporte(value) {
  return Number(value || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderConciliacionIbsTiles(tipo, resumen) {
  const tile = (label, value, cls) => `
    <div class="dashboard-tile ${cls || ''}">
      <div class="dashboard-tile-label">${escapeHtml(label)}</div>
      <div class="dashboard-tile-value">${escapeHtml(String(value))}</div>
    </div>`;
  const malo = (n) => (n > 0 ? 'error' : 'ok');
  document.getElementById('conciliacionIbsTiles').innerHTML = tipo === 'transferencias'
    ? tile('Transferencias realizadas', resumen.realizadasApicore) +
      tile('Conciliadas OK', resumen.transferenciasOk, 'ok') +
      tile('Con diferencias', resumen.transferenciasConDiferencias, malo(resumen.transferenciasConDiferencias)) +
      tile('Pendientes de débito (día hábil)', resumen.pendientes) +
      tile('Con débito pendiente en IBS', resumen.debitosPendientesIbs, malo(resumen.debitosPendientesIbs)) +
      tile('Débitos solo en IBS', resumen.soloEnIbs, malo(resumen.soloEnIbs)) +
      tile('Rechazadas en ApiCore', resumen.rechazadosApicore) +
      tile('Rechazadas que figuran en IBS', resumen.rechazadosEnIbs, malo(resumen.rechazadosEnIbs))
    : tipo === 'pagos'
    ? tile('PF que vencían (circuito 0)', resumen.vencenCircuito0) +
      tile('Pagados en ApiCore', resumen.pagadosApicore) +
      tile('Pagos conciliados OK', resumen.pagosOk, 'ok') +
      tile('Pagos con diferencias', resumen.pagosConDiferencias, malo(resumen.pagosConDiferencias)) +
      tile('Pagados en IBS sin marcar en ApiCore', resumen.pagadosEnIbsNoApicore, malo(resumen.pagadosEnIbsNoApicore)) +
      tile('Movimientos solo en IBS', resumen.soloEnIbs, malo(resumen.soloEnIbs)) +
      tile('Sin pagar (pendientes)', resumen.pendientes) +
      tile('Rechazados en ApiCore', resumen.rechazadosApicore) +
      tile('Rechazados que figuran en IBS', resumen.rechazadosEnIbs, malo(resumen.rechazadosEnIbs))
    : tile('Altas en ApiCore', resumen.altasApicore) +
      tile('Movimientos en IBS', resumen.movimientosIbs) +
      tile('Altas conciliadas OK', resumen.altasOk, 'ok') +
      tile('Altas con diferencias', resumen.altasConDiferencias, malo(resumen.altasConDiferencias)) +
      tile('Movimientos solo en IBS', resumen.soloEnIbs, malo(resumen.soloEnIbs)) +
      tile('Rechazadas en ApiCore', resumen.rechazadosApicore) +
      tile('Rechazadas que figuran en IBS', resumen.rechazadosEnIbs, malo(resumen.rechazadosEnIbs));
}

function renderConciliacionIbsTotales(totales) {
  const tbody = document.querySelector('#conciliacionIbsTotales tbody');
  tbody.innerHTML = '';
  for (const t of totales) {
    const difImporte = Math.round((t.ibs.importe - t.apicore.importe) * 100) / 100;
    const difCantidad = t.ibs.cantidad - t.apicore.cantidad;
    const cuadra = difImporte === 0 && difCantidad === 0;
    const simbolo = /^Dólares/.test(t.concepto) ? 'USD' : '$';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(t.concepto)}</td>
      <td class="num">${t.apicore.cantidad} · ${simbolo} ${formatImporte(t.apicore.importe)}</td>
      <td class="num">${t.ibs.cantidad} · ${simbolo} ${formatImporte(t.ibs.importe)}</td>
      <td class="num">${cuadra ? '—' : `${difCantidad > 0 ? '+' : ''}${difCantidad} · ${simbolo} ${formatImporte(difImporte)}`}</td>
      <td class="${cuadra ? 'conciliacion-check-ok' : 'conciliacion-check-error'}">${cuadra ? '✓' : '✗'}</td>
    `;
    tbody.appendChild(tr);
  }
}

function applyConciliacionIbsFilter() {
  if (!lastConciliacionIbs) return;
  const tipo = conciliacionIbsTipoFilter.value;
  const filas = tipo ? lastConciliacionIbs.diferencias.filter((d) => d.tipo === tipo) : lastConciliacionIbs.diferencias;
  const tbody = document.querySelector('#conciliacionIbsDiferencias tbody');
  tbody.innerHTML = '';
  for (const d of filas) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="dashboard-motivo-pill">${escapeHtml(d.tipo)}</span></td>
      <td class="mono">${escapeHtml(d.numeroComprobante || '—')}</td>
      <td class="mono operacion">${escapeHtml(d.operacion || '—')}</td>
      <td>${escapeHtml(d.circuito || '—')}</td>
      <td class="mono">${escapeHtml(d.cuit || '—')}</td>
      <td class="titular">${escapeHtml(d.apellidoNombre || '—')}</td>
      <td class="mono">${escapeHtml(d.cajaAhorro || '—')}</td>
      <td class="num">${d.moneda === 'USD' ? 'USD' : '$'} ${formatImporte(d.importe)}</td>
      <td class="detalle">${escapeHtml(d.detalle)}</td>
    `;
    tbody.appendChild(tr);
  }
  const sinDiferencias = lastConciliacionIbs.diferencias.length === 0;
  document.getElementById('conciliacionIbsSinDiferencias').style.display = sinDiferencias ? '' : 'none';
  document.getElementById('conciliacionIbsDiferencias').style.display = sinDiferencias ? 'none' : '';
}

const CONCILIACION_RECHAZADO_ESTADOS = {
  'no-figura': { texto: 'No figura ✓', clase: 'conciliacion-check-ok' },
  figura: { texto: 'Figura en IBS ✗', clase: 'conciliacion-check-error' },
  revertida: { texto: 'Debitada y revertida', clase: '' },
  reintentada: { texto: 'Reintentada y realizada', clase: '' },
};

// Lo que ApiCore rechazó y que, si está todo bien, no figura en IBS.
function renderConciliacionIbsRechazados(data) {
  const box = document.getElementById('conciliacionIbsRechazadosBox');
  const rechazados = data.rechazados || [];
  if (rechazados.length === 0) {
    box.style.display = 'none';
    return;
  }
  const r = data.resumen;
  const esTransferencias = data.tipo === 'transferencias';
  const cosa = data.tipo === 'altas' ? 'alta(s)' : data.tipo === 'pagos' ? 'pago(s)' : 'transferencia(s)';
  document.getElementById('conciliacionIbsRechazadosTitulo').textContent = 'Rechazados en ApiCore';
  const partes = [`${rechazados.length} ${cosa} rechazada(s) por ApiCore`];
  if (r.rechazadosEnIbs > 0) partes.push(`${r.rechazadosEnIbs} figuran en IBS (diferencia)`);
  if (r.rechazadosRevertidos > 0) partes.push(`${r.rechazadosRevertidos} IBS las debitó y las revirtió`);
  if (r.rechazadosReintentados > 0) partes.push(`${r.rechazadosReintentados} se reintentaron y quedaron realizadas`);
  document.getElementById('conciliacionIbsRechazadosTexto').textContent =
    partes.join(' · ') + (r.rechazadosEnIbs === 0 ? '. Ninguna tiene movimientos pendientes en IBS.' : '.') +
    (esTransferencias ? ' Incluye las que nunca llegaron a la base (CBU inválido, error de comunicación).' : '');
  const orden = { figura: 0, revertida: 1, reintentada: 2, 'no-figura': 3 };
  const filas = [...rechazados].sort((a, b) => (orden[a.estado] - orden[b.estado]) || String(a.fecha).localeCompare(String(b.fecha)));
  const tbody = document.querySelector('#conciliacionIbsRechazados tbody');
  tbody.innerHTML = '';
  // Los que figuran en IBS van primero; con muchos rechazados se muestran los primeros.
  const LIMITE_FILAS = 200;
  if (filas.length > LIMITE_FILAS) {
    document.getElementById('conciliacionIbsRechazadosTexto').textContent += ` Se muestran los primeros ${LIMITE_FILAS} (primero los que figuran en IBS).`;
  }
  for (const f of filas.slice(0, LIMITE_FILAS)) {
    const estado = CONCILIACION_RECHAZADO_ESTADOS[f.estado] || { texto: f.estado, clase: '' };
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="${estado.clase}" title="${escapeHtml(f.detalle || '')}">${escapeHtml(estado.texto)}</td>
      <td class="mono">${escapeHtml(String(f.fecha || '—').slice(0, 19))}</td>
      <td class="mono">${escapeHtml(f.numeroComprobante || '—')}</td>
      <td class="mono">${escapeHtml(f.cuit || '—')}</td>
      <td class="titular">${escapeHtml(f.apellidoNombre || '—')}</td>
      <td class="num">${f.moneda === 'USD' ? 'USD' : '$'} ${formatImporte(f.importe)}</td>
      <td class="detalle">${escapeHtml(f.motivo || '—')}${f.intentos > 1 ? ` (${f.intentos} intentos)` : ''}</td>
    `;
    tbody.appendChild(tr);
  }
  box.style.display = '';
}

function renderConciliacionIbs(data) {
  lastConciliacionIbs = data;
  const esPagos = data.tipo === 'pagos';
  const esTransferencias = data.tipo === 'transferencias';
  const r = data.resumen;
  const conDiferencias = data.diferencias.length > 0;

  const estado = document.getElementById('conciliacionIbsEstado');
  estado.className = 'conciliacion-estado ' + (conDiferencias ? 'error' : 'ok');
  let texto;
  if (esTransferencias) {
    texto = conDiferencias
      ? `Hay diferencias: ${r.transferenciasConDiferencias} transferencia(s) con diferencias entre ApiCore e IBS (de ${r.realizadasApicore} realizadas).`
      : `Concilia: las ${r.realizadasApicore} transferencias realizadas del ${data.fecha} al ${data.hasta} están debitadas en IBS (o pendientes de su día hábil) y no hay débitos de más.`;
  } else if (esPagos) {
    texto = conDiferencias
      ? `Hay diferencias: ${r.pagosConDiferencias} pago(s) de ApiCore con diferencias, ${r.pagadosEnIbsNoApicore} pago(s) que IBS tiene y ApiCore no marcó como pagados, y ${r.soloEnIbs} movimiento(s) de IBS sin su plazo fijo en ApiCore.`
      : `Concilia: los ${r.pagadosApicore} plazos fijos pagados por ApiCore están en IBS con la misma cuenta e importe, y IBS no tiene ningún otro pago.`;
  } else {
    texto = conDiferencias
      ? `Hay diferencias: ${r.altasConDiferencias} alta(s) de ApiCore con diferencias y ${r.soloEnIbs} movimiento(s) de IBS sin su alta en ApiCore.`
      : `Concilia: las ${r.altasApicore} altas de ApiCore (${r.altasCircuito0} de circuito 0, ${r.altasCircuito1} de circuito 1) están en IBS con la misma cuenta e importe.`;
  }
  estado.textContent = texto + (data.origen ? ` (IBS: ${data.origen})` : '');

  const aviso = document.getElementById('conciliacionIbsAviso');
  const avisos = [];
  if (esTransferencias && r.realizadasApicore + r.rechazadasApicore === 0) {
    avisos.push('ApiCore no tiene transferencias ejecutadas en ese rango de fechas.');
  }
  for (const a of data.avisos || []) avisos.push(a);
  if (esPagos && r.vencenCircuito0 + r.vencenCircuito1 === 0) {
    avisos.push('ApiCore no tiene plazos fijos que venzan en esa fecha: para pagos la fecha es la de proceso bancaria (la del vencimiento).');
  }
  if (!esPagos && !esTransferencias && r.altasApicore === 0) avisos.push('ApiCore no tiene altas registradas en esa fecha: revisá que la fecha elegida sea la del extracto.');
  if (r.filasOtraFecha > 0) avisos.push(`Se ignoraron ${r.filasOtraFecha} movimiento(s) del extracto con una fecha distinta a la elegida.`);
  aviso.textContent = avisos.join(' ');
  aviso.style.display = avisos.length ? '' : 'none';

  renderConciliacionIbsTiles(data.tipo, r);
  renderConciliacionIbsTotales(data.totales);

  const tipos = [...new Set(data.diferencias.map((d) => d.tipo))].sort();
  conciliacionIbsTipoFilter.innerHTML = '<option value="">Todas</option>';
  for (const tipo of tipos) {
    const count = data.diferencias.filter((d) => d.tipo === tipo).length;
    const option = document.createElement('option');
    option.value = tipo;
    option.textContent = `${tipo} (${count})`;
    conciliacionIbsTipoFilter.appendChild(option);
  }
  applyConciliacionIbsFilter();

  const pendientes = data.pendientes || [];
  const pendientesBox = document.getElementById('conciliacionIbsPendientesBox');
  if ((esPagos || esTransferencias) && pendientes.length > 0) {
    document.getElementById('conciliacionIbsPendientesTitulo').textContent = esTransferencias
      ? 'Transferencias realizadas que todavía no vencen para su débito (informativo)'
      : 'Plazos fijos que vencían ese día y no se pagaron (informativo)';
    document.getElementById('conciliacionIbsPendientesTexto').textContent = esTransferencias
      ? `${pendientes.length} transferencia(s) realizada(s) todavía sin débito en IBS, pero su día hábil de débito no pasó: no es una diferencia. Si mañana siguen sin débito, van a figurar como diferencia.`
      : `${pendientes.length} plazo(s) fijo(s) de circuito 0 por $ ${formatImporte(r.pendientesImporte)} vencían ese día y no figuran como pagados en ApiCore ` +
        '(y IBS tampoco tiene su pago): no es una diferencia, pero siguen sin pagarse.';
    const tbody = document.querySelector('#conciliacionIbsPendientes tbody');
    tbody.innerHTML = '';
    for (const p of pendientes) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="mono">${escapeHtml(p.numeroComprobante || '—')}</td>
        <td class="mono operacion">${escapeHtml(p.operacion || '—')}</td>
        <td class="mono">${escapeHtml(p.cuit || '—')}</td>
        <td class="titular">${escapeHtml(p.apellidoNombre || '—')}</td>
        <td class="mono">${escapeHtml(p.cajaAhorro || '—')}</td>
        <td class="num">${p.moneda === 'USD' ? 'USD' : '$'} ${formatImporte(p.importe)}</td>
      `;
      tbody.appendChild(tr);
    }
    pendientesBox.style.display = '';
  } else {
    pendientesBox.style.display = 'none';
  }

  renderConciliacionIbsRechazados(data);

  const otrosBox = document.getElementById('conciliacionIbsOtrosCanalesBox');
  if (esTransferencias && r.debitosOtrasFechas > 0) {
    document.getElementById('conciliacionIbsOtrosCanalesTitulo').textContent = 'Débitos de transferencias de otras fechas (informativo)';
    document.getElementById('conciliacionIbsOtrosCanalesTexto').textContent =
      `${r.debitosOtrasFechas} débito(s) de IBS en este período corresponden a transferencias hechas fuera del rango elegido ` +
      `(ya figuran realizadas en ApiCore, por ejemplo las de un fin de semana o feriado anterior): no son diferencias.`;
    otrosBox.style.display = '';
  } else if (esPagos && r.otrosCanales > 0) {
    document.getElementById('conciliacionIbsOtrosCanalesTitulo').textContent = 'Vencimientos de plazos fijos de otros canales (informativo)';
    document.getElementById('conciliacionIbsOtrosCanalesTexto').textContent =
      `${r.otrosCanales} vencimiento(s) de plazos fijos por $ ${formatImporte(r.otrosCanalesImporte)} acreditados en IBS ese día que no son de ApiCore: ` +
      'no se concilian acá.';
    otrosBox.style.display = '';
  } else if (r.otrosCanales > 0) {
    document.getElementById('conciliacionIbsOtrosCanalesTitulo').textContent = 'Altas de PF de otros canales (informativo)';
    const cuentas = [...new Set(data.otrosCanales.map((o) => o.cuecod))].join(', ');
    document.getElementById('conciliacionIbsOtrosCanalesTexto').textContent =
      `${r.otrosCanales} alta(s) de PF por $ ${formatImporte(r.otrosCanalesImporte)} debitadas de Cuenta Corriente (${cuentas}): ` +
      'ApiCore no da de alta PF desde una Cuenta Corriente, así que no se concilian acá.';
    otrosBox.style.display = '';
  } else {
    otrosBox.style.display = 'none';
  }

  document.getElementById('conciliacionIbsResultado').style.display = '';
  document.getElementById('conciliacionIbsDownloadBtn').disabled = !conDiferencias;
}

// conArchivo = false: el servidor consulta los movimientos directo en IBS
// (Sybase); true: usa el extracto CSV elegido en el input.
async function runConciliacionIbs(conArchivo) {
  if (!conciliacionIbsFecha.value) {
    alert('Elegí la fecha a conciliar.');
    return;
  }
  const file = conciliacionIbsFile.files[0];
  if (conArchivo && !file) {
    alert('Elegí el archivo del extracto de IBS.');
    return;
  }
  const buttons = [document.getElementById('conciliacionIbsRunBtn'), document.getElementById('conciliacionIbsFileBtn')];
  for (const b of buttons) b.disabled = true;
  try {
    const body = { fecha: conciliacionIbsFecha.value, tipo: conciliacionIbsTipo.value };
    if (conciliacionIbsTipo.value === 'transferencias') body.hasta = conciliacionIbsHasta.value || conciliacionIbsFecha.value;
    if (conArchivo) body.contenido = await file.text();
    const res = await apiFetch('/api/conciliacion/ibs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'No se pudo conciliar.');
      return;
    }
    renderConciliacionIbs(data);
  } finally {
    for (const b of buttons) b.disabled = false;
  }
}

function downloadConciliacionIbsDiferencias() {
  if (!lastConciliacionIbs) return;
  const headers = ['tipo', 'numeroComprobante', 'operacion', 'circuito', 'cuit', 'apellidoNombre', 'cajaAhorro', 'importe', 'moneda', 'fecha', 'detalle'];
  const lines = [headers.join(',')];
  for (const d of lastConciliacionIbs.diferencias) lines.push(headers.map((h) => csvEscape(d[h])).join(','));
  downloadTextFile(`conciliacion-ibs-${lastConciliacionIbs.tipo === 'pagos' ? 'pagos-pf' : lastConciliacionIbs.tipo === 'transferencias' ? 'transferencias' : 'altas-pf'}-${lastConciliacionIbs.fecha}${lastConciliacionIbs.hasta && lastConciliacionIbs.hasta !== lastConciliacionIbs.fecha ? '-a-' + lastConciliacionIbs.hasta : ''}-diferencias.csv`, lines.join('\r\n'), 'text/csv');
}

const CONCILIACION_IBS_DESCRIPCIONES = {
  altas:
    'Cruza las altas de Plazo Fijo registradas en ApiCore ese día contra los movimientos de IBS. Circuito 0: débito en ' +
    'Cuenta Corriente (25020) y crédito en Caja de Ahorro (25021) por número de comprobante, y alta del PF (152) por ' +
    'número de operación. Circuito 1: solo el 152.',
  pagos:
    'Cruza los plazos fijos que vencían en la fecha de proceso elegida contra los pagos en IBS: débito en la Caja de ' +
    'Ahorro y crédito en la Cuenta Corriente (transacciones y cuenta de Parametría), por número de comprobante. Detecta ' +
    'pagos que IBS tiene y ApiCore no marcó como pagados (por ejemplo, una corrida cortada) y pagos a medias. Si el ' +
    'extracto trae los créditos de vencimiento (código 1200), también verifica que IBS haya acreditado cada plazo fijo ' +
    'por su importe neto.',
  transferencias:
    'Cruza las transferencias DEBIN realizadas en ApiCore entre las fechas elegidas contra los débitos de IBS en la Caja de ' +
    'Ahorro del cliente (28600 si es a su propia cuenta, 28601 si es a terceros), por comprobante, importe, moneda y cuenta. ' +
    'IBS pasa los fines de semana y feriados al próximo día hábil (calendario en Parametría). Detecta transferencias sin ' +
    'débito, enviadas más de una vez, con acreditación fallida sin reversa y débitos sin transferencia.',
};

function updateConciliacionIbsTipo() {
  const tipo = conciliacionIbsTipo.value;
  document.getElementById('conciliacionIbsDescripcion').textContent =
    CONCILIACION_IBS_DESCRIPCIONES[tipo] +
    ' "Conciliar contra IBS" consulta los movimientos directo en Sybase (sin contra-asientos); también se puede subir un ' +
    'extracto con las columnas sistcod, moncod, cuecod, Fecha_Mov, comnro, movcod, signo, accimp, Importe.';
  document.getElementById('conciliacionIbsFechaLabel').textContent =
    tipo === 'pagos' ? 'Fecha de proceso (vencimiento)' : tipo === 'transferencias' ? 'Desde' : 'Fecha';
  document.getElementById('conciliacionIbsHastaLabel').style.display = tipo === 'transferencias' ? '' : 'none';
  if (tipo === 'transferencias' && !conciliacionIbsHasta.value) conciliacionIbsHasta.value = conciliacionIbsFecha.value;
  document.getElementById('conciliacionIbsColCirc').textContent = tipo === 'transferencias' ? 'Destinatario' : 'Circ.';
  // El resultado en pantalla es del otro tipo: se oculta para no mezclarlos.
  lastConciliacionIbs = null;
  document.getElementById('conciliacionIbsResultado').style.display = 'none';
  document.getElementById('conciliacionIbsDownloadBtn').disabled = true;
}

function openConciliacionIbsSection() {
  if (!conciliacionIbsFecha.value) conciliacionIbsFecha.value = formatDateOnlyLocal(new Date());
  updateConciliacionIbsTipo();
  showMainSection('conciliacionIbsSection');
}

conciliacionIbsTipo.addEventListener('change', updateConciliacionIbsTipo);
document.getElementById('conciliacionIbsBtn').addEventListener('click', openConciliacionIbsSection);
document.getElementById('closeConciliacionIbsBtn').addEventListener('click', () => showMainSection('flowDetail'));
document.getElementById('conciliacionIbsRunBtn').addEventListener('click', () => runConciliacionIbs(false));
document.getElementById('conciliacionIbsFileBtn').addEventListener('click', () => runConciliacionIbs(true));
document.getElementById('conciliacionIbsDownloadBtn').addEventListener('click', downloadConciliacionIbsDiferencias);
conciliacionIbsTipoFilter.addEventListener('change', applyConciliacionIbsFilter);

// --- Conciliación Loop ----------------------------------------------------------
// Loop y los débitos pendientes se consultan en Sybase desde el servidor; acá se
// suben los archivos de BankService, se sigue el avance y se muestra el dashboard
// (un HTML autocontenido generado por el servidor, ver node/lib/qnet/reportes/dashboard.js).

let qnetCorridaActual = '';

function setQnetProgreso(texto, esError) {
  const el = document.getElementById('qnetProgreso');
  el.textContent = texto;
  el.style.color = esError ? 'var(--error, #b42318)' : '';
}

async function loadQnetCorridas(seleccionar) {
  const select = document.getElementById('qnetCorridas');
  try {
    const res = await apiFetch('/api/qnet/corridas');
    const data = await res.json();
    select.innerHTML = '';
    for (const c of data.corridas || []) {
      const option = document.createElement('option');
      option.value = c.id;
      const estado = c.exitCode === 0 ? '' : c.exitCode === 2 ? ' · con advertencias' : c.exitCode === 1 ? ' · con errores' : '';
      const dia = c.fecha ? c.fecha.split('-').reverse().join('/') : 'sin fecha';
      option.textContent = `${dia}${estado} · hecha ${c.fechaGenerada || ''} · ${c.id}`;
      select.appendChild(option);
    }
    if (seleccionar) select.value = seleccionar;
    return (data.corridas || []).length > 0;
  } catch (err) {
    return false;
  }
}

async function loadQnetDashboard(id) {
  const frame = document.getElementById('qnetFrame');
  try {
    const res = await apiFetch(`/api/qnet/dashboard?id=${encodeURIComponent(id)}`);
    const data = await res.json();
    if (!res.ok) {
      frame.style.display = 'none';
      document.getElementById('qnetDescargas').style.display = '';
      setQnetProgreso(data.error || 'No se pudo abrir el dashboard.', true);
      qnetCorridaActual = id;
      return;
    }
    qnetCorridaActual = id;
    // La pantalla de la app es siempre clara: el dashboard no sigue el modo oscuro del sistema.
    frame.srcdoc = data.html.replace('<html lang="es">', '<html lang="es" data-theme="light">');
    frame.style.display = '';
    document.getElementById('qnetDescargas').style.display = '';
  } catch (err) {
    setQnetProgreso('Error de red abriendo el dashboard: ' + err.message, true);
  }
}

async function runQnet() {
  const files = document.getElementById('qnetFiles').files;
  if (!files || files.length === 0) {
    alert('Elegí al menos un archivo de BankService (Movimientos_BankService-mmaaaa.csv).');
    return;
  }
  const fecha = document.getElementById('qnetFecha').value;
  if (!fecha) {
    alert('Elegí la fecha (un día) a conciliar.');
    return;
  }
  const runBtn = document.getElementById('qnetRunBtn');
  runBtn.disabled = true;
  setQnetProgreso('Leyendo los archivos...');
  try {
    const archivos = [];
    for (const file of files) archivos.push({ nombre: file.name, contenido: await readFileAsText(file) });
    const res = await apiFetch('/api/qnet/ejecutar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archivos, fecha }),
    });
    const data = await res.json();
    if (!res.ok) {
      setQnetProgreso(data.error || 'No se pudo iniciar la conciliación.', true);
      return;
    }
    await pollQnet(data.jobId);
  } catch (err) {
    setQnetProgreso('Error: ' + err.message, true);
  } finally {
    runBtn.disabled = false;
  }
}

async function pollQnet(jobId) {
  for (;;) {
    const res = await apiFetch(`/api/qnet/estado?job=${encodeURIComponent(jobId)}`);
    const data = await res.json();
    if (!res.ok) {
      setQnetProgreso(data.error || 'Se perdió el seguimiento de la conciliación.', true);
      return;
    }
    if (data.estado === 'corriendo') {
      setQnetProgreso(`Conciliando... ${data.segundos}s · ${(data.progreso || []).slice(-1)[0] || 'iniciando'}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    if (data.estado === 'error') {
      setQnetProgreso('La conciliación falló: ' + data.error, true);
      return;
    }
    const r = data.resultado;
    const avisos = (r.avisos || []).filter((a) => a.nivel !== 'info');
    await loadQnetCorridas(r.id);
    if (r.exitCode === 1) {
      // Con errores no hay dashboard: solo el log.
      qnetCorridaActual = r.id;
      document.getElementById('qnetFrame').style.display = 'none';
      document.getElementById('qnetDescargas').style.display = '';
    } else {
      await loadQnetDashboard(r.id);
    }
    const texto = r.exitCode === 0 ? 'Conciliación terminada sin avisos.'
      : r.exitCode === 2 ? 'Conciliación terminada con advertencias: ' + avisos.map((a) => a.mensaje).join(' | ')
      : 'La conciliación no se pudo hacer: ' + avisos.map((a) => a.mensaje).join(' | ');
    setQnetProgreso(texto, r.exitCode === 1);
    return;
  }
}

async function downloadQnetArchivo(name) {
  if (!qnetCorridaActual) return;
  try {
    const res = await apiFetch(`/api/qnet/archivo?id=${encodeURIComponent(qnetCorridaActual)}&name=${encodeURIComponent(name)}`);
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'No se pudo descargar el archivo.');
      return;
    }
    downloadTextFile(data.name, data.content, name.endsWith('.csv') ? 'text/csv' : 'text/plain');
  } catch (err) {
    alert('Error de red descargando el archivo: ' + err.message);
  }
}

// Evolución día a día: una conciliación por fecha (la más nueva) con sus excepciones y su saldo pendiente.
const QNET_COLORES = ['#1f4e8c', '#d9822b', '#2e9d6b', '#b42318', '#7a5af8', '#0e9384', '#c4320a', '#667085', '#dd2590', '#4e9f3d', '#9e77ed', '#ca8504'];

function qnetBarras(dias, serie, titulo, formato, formatoDetalle) {
  // serie: dia -> { clave: valor }; barras apiladas por clave
  const claves = [...new Set(dias.flatMap((d) => Object.keys(serie(d))))].sort();
  const total = (d) => Object.values(serie(d)).reduce((s, v) => s + v, 0);
  const max = Math.max(1, ...dias.map(total));
  const W = 860, H = 230, L = 56, B = 44, T = 8, R = 6;
  const bw = (W - L - R) / dias.length;
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${escapeHtml(titulo)}" style="max-width: 100%;">`;
  for (let i = 0; i <= 4; i++) {
    const y = T + (H - T - B) * (1 - i / 4);
    svg += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="currentColor" opacity=".12"/><text x="${L - 4}" y="${y + 3}" text-anchor="end" font-size="10" fill="currentColor" opacity=".7">${escapeHtml(formato((max * i) / 4))}</text>`;
  }
  dias.forEach((d, i) => {
    let acum = 0;
    for (const k of claves) {
      const v = serie(d)[k] || 0;
      if (!v) continue;
      const h = ((H - T - B) * v) / max;
      const y = H - B - ((H - T - B) * (acum + v)) / max;
      svg += `<rect x="${L + i * bw + 1}" y="${y}" width="${Math.max(bw - 2, 1)}" height="${h}" fill="${QNET_COLORES[claves.indexOf(k) % QNET_COLORES.length]}"><title>${escapeHtml(d.fecha.split('-').reverse().join('/'))} · ${escapeHtml(k)}: ${escapeHtml((formatoDetalle || formato)(v))}</title></rect>`;
      acum += v;
    }
    if (dias.length <= 16 || i % Math.ceil(dias.length / 16) === 0) {
      svg += `<text transform="translate(${L + i * bw + bw / 2},${H - B + 12}) rotate(60)" font-size="10" fill="currentColor" opacity=".7">${escapeHtml(d.fecha.split('-').reverse().slice(0, 2).join('/'))}</text>`;
    }
  });
  const leyenda = claves.map((k) => `<span style="margin-right:12px;white-space:nowrap;"><i style="display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;background:${QNET_COLORES[claves.indexOf(k) % QNET_COLORES.length]}"></i>${escapeHtml(k)}</span>`).join('');
  return `<h3>${escapeHtml(titulo)}</h3>${svg}</svg><div class="muted" style="font-size:12px;">${leyenda}</div>`;
}

async function toggleQnetEvolucion() {
  const box = document.getElementById('qnetEvolucion');
  if (box.style.display !== 'none') {
    box.style.display = 'none';
    document.getElementById('qnetEvolucionBtn').textContent = 'Evolución día a día';
    return;
  }
  box.style.display = '';
  document.getElementById('qnetEvolucionBtn').textContent = 'Ocultar evolución';
  box.innerHTML = '<p class="muted">Cargando...</p>';
  try {
    const res = await apiFetch('/api/qnet/evolucion');
    const data = await res.json();
    const dias = data.dias || [];
    if (dias.length === 0) {
      box.innerHTML = '<p class="muted">Todavía no hay conciliaciones guardadas.</p>';
      return;
    }
    const moneda = (m, v) => (m === 'USD' ? 'US$ ' : '$ ') + formatImporte(v / 100);
    const fecha = (f) => f.split('-').reverse().join('/');
    const filas = dias.map((d) => {
      const ars = d.monedas.ARS || { sinCubrir: 0 };
      const usd = d.monedas.USD || { sinCubrir: 0 };
      const sA = d.saldoPendiente.ARS || { cantidad: 0, importe: 0 };
      const sU = d.saldoPendiente.USD || { cantidad: 0, importe: 0 };
      const estado = d.exitCode === 2 ? 'advertencias' : d.exitCode === 0 ? 'ok' : '';
      return `<tr>
        <td class="mono">${fecha(d.fecha)}${d.diaAbierto ? ' (abierto)' : ''}</td>
        <td>${estado}</td>
        <td class="num">${d.comprobantes.toLocaleString('es-AR')}</td>
        <td class="num">${d.conMarca.toLocaleString('es-AR')}</td>
        <td class="num">${d.excepciones.toLocaleString('es-AR')}</td>
        <td class="num">${sA.cantidad} · ${moneda('ARS', sA.importe)}</td>
        <td class="num">${sU.cantidad} · ${moneda('USD', sU.importe)}</td>
        <td class="num">${moneda('ARS', ars.sinCubrir)}</td>
        <td class="num">${moneda('USD', usd.sinCubrir)}</td>
        <td><button type="button" data-qnet-abrir="${d.id}">Abrir</button></td>
      </tr>`;
    }).join('');
    box.innerHTML =
      qnetBarras(dias, (d) => d.porTipo, 'Excepciones por fecha y tipo', (v) => String(Math.round(v))) +
      qnetBarras(dias, (d) => ({ 'Saldo pendiente ARS': (d.saldoPendiente.ARS || { importe: 0 }).importe }), 'Saldo de débitos pendientes por fecha (pesos, en millones)', (v) => '$ ' + (v / 100 / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + ' M', (v) => '$ ' + formatImporte(v / 100)) +
      `<h3>Día a día</h3><div class="conciliacion-table-wrap"><table>
        <thead><tr><th>Fecha</th><th>Estado</th><th>Comprobantes</th><th>Con marca</th><th>Excepciones</th><th>Saldo pendiente ARS</th><th>Saldo pendiente USD</th><th>Sin cubrir ARS</th><th>Sin cubrir USD</th><th></th></tr></thead>
        <tbody>${filas}</tbody></table></div>`;
    for (const b of box.querySelectorAll('[data-qnet-abrir]')) {
      b.addEventListener('click', () => {
        document.getElementById('qnetCorridas').value = b.dataset.qnetAbrir;
        loadQnetDashboard(b.dataset.qnetAbrir);
        document.getElementById('qnetFrame').scrollIntoView();
      });
    }
  } catch (err) {
    box.innerHTML = '<p class="muted">Error cargando la evolución: ' + escapeHtml(err.message) + '</p>';
  }
}

async function openQnetSection() {
  if (!document.getElementById('qnetFecha').value) document.getElementById('qnetFecha').value = formatDateOnlyLocal(new Date());
  showMainSection('qnetSection');
  const hay = await loadQnetCorridas();
  const select = document.getElementById('qnetCorridas');
  if (hay && !qnetCorridaActual) await loadQnetDashboard(select.value);
}

document.getElementById('qnetBtn').addEventListener('click', openQnetSection);
document.getElementById('closeQnetBtn').addEventListener('click', () => showMainSection('flowDetail'));
document.getElementById('qnetRunBtn').addEventListener('click', runQnet);
document.getElementById('qnetEvolucionBtn').addEventListener('click', toggleQnetEvolucion);
document.getElementById('qnetAbrirBtn').addEventListener('click', () => {
  const id = document.getElementById('qnetCorridas').value;
  if (id) loadQnetDashboard(id);
});
for (const button of document.querySelectorAll('[data-qnet-archivo]')) {
  button.addEventListener('click', () => downloadQnetArchivo(button.dataset.qnetArchivo));
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
