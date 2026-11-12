#!/usr/bin/env node
'use strict';

// ApiCore — backend Node.js (alternativa a server.ps1/PowerShell,
// pensada para deployments Linux que prefieren no instalar pwsh). Sirve la
// MISMA wwwroot/ y expone exactamente las mismas rutas /api/* con el mismo
// contrato JSON que server.ps1 — el frontend (wwwroot/app.js) no sabe ni le
// importa cuál de los dos backends tiene enfrente. Comparte Flows/ con
// server.ps1, pero usuarios/roles, perfiles, parametría y el registro
// antiduplicado viven en MariaDB (ver "Base de datos (MariaDB)" en el
// README) — ya NO son los mismos *.local.json que lee/escribe server.ps1.
//
// Requiere Node.js 18+ (usa fetch global). Ver README.md > "Instalación en
// Linux" para el paso a paso de deployment.

const http = require('http');
const fs = require('fs');
const path = require('path');

const profileStore = require('./lib/profileStore');
const parametriaStore = require('./lib/parametriaStore');
const flowStore = require('./lib/flowStore');
const flowEngine = require('./lib/flowEngine');
const securityStore = require('./lib/securityStore');
const processedOperationsStore = require('./lib/processedOperationsStore');
const debinOutputStore = require('./lib/debinOutputStore');
const conciliacionIbs = require('./lib/conciliacionIbs');
const sybaseClient = require('./lib/sybaseClient');
const { convertDMYToISO, formatLocal } = require('./lib/dateUtil');

function parsePort() {
  const args = process.argv.slice(2);
  const flagIndex = args.findIndex((a) => a === '--port' || a === '-p');
  if (flagIndex >= 0 && args[flagIndex + 1]) {
    const parsed = parseInt(args[flagIndex + 1], 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (process.env.PORT) {
    const parsed = parseInt(process.env.PORT, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 8787;
}

const port = parsePort();
const rootDir = path.join(__dirname, '..');
const flowsDir = path.join(rootDir, 'Flows');
const wwwRoot = path.join(rootDir, 'wwwroot');
const logsDir = path.join(rootDir, 'logs');
const filesDir = path.join(rootDir, 'files');
// Carpeta que navega el buscador de "Certificado cliente (TLS mutuo)" en el
// diálogo de Perfil (ver /api/certs-browse) — ahí es donde hay que dejar los
// .crt/.key reales para poder encontrarlos con el buscador en vez de tipear
// la ruta a mano. Configurable con CERTS_BASE_DIR si no conviene que viva
// adentro de la carpeta de la app.
const certsBaseDir = process.env.CERTS_BASE_DIR ? path.resolve(process.env.CERTS_BASE_DIR) : path.join(rootDir, 'certs');

// --- Helpers de request/response --------------------------------------------

function getContentType(extension) {
  switch (extension.toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function writeJsonResponse(res, statusCode, body) {
  const json = JSON.stringify(body === undefined ? null : body);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(json);
}

function writeFileResponse(res, filePath, contentType) {
  const data = fs.readFileSync(filePath);
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.end(data);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const text = await readRequestBody(req);
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function getBearerToken(req) {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? match[1].trim() : null;
}

function getClientAddress(req) {
  return (req.socket && req.socket.remoteAddress) || '?';
}

function getMaskedProfile(profileObj) {
  return {
    name: profileObj.name,
    baseUrl: profileObj.baseUrl,
    // URL base alternativa, para flows con "baseUrlField" propio (ver
    // "Transferencia DEBIN" / Nova-Link en el README) — un perfil puede
    // pegarle a más de un servidor sin necesitar un perfil por servidor.
    novaBaseUrl: profileObj.novaBaseUrl,
    authType: profileObj.authType,
    apiKeyHeaderName: profileObj.apiKeyHeaderName,
    hasApiKeyOrToken: !!profileObj.apiKeyOrToken,
    tokenUrl: profileObj.tokenUrl,
    clientId: profileObj.clientId,
    hasClientSecret: !!profileObj.clientSecret,
    // TLS mutuo (ver "Transferencia DEBIN" / Nova-Link en el README): ruta al
    // .pfx en el disco del servidor, no un secreto en sí — se muestra
    // completa. La contraseña del .pfx sí se enmascara, mismo criterio que
    // apiKeyOrToken/clientSecret.
    clientCertPfxPath: profileObj.clientCertPfxPath,
    hasClientCertPassphrase: !!profileObj.clientCertPassphrase,
  };
}

// A diferencia de solo mirar el token, esto vuelve a chequear contra la
// tabla usuarios en MariaDB en cada request (no confía en el rol cacheado al
// hacer login): si un admin deshabilita o elimina a un usuario, o le cambia
// el rol, eso tiene efecto inmediato en la próxima request de esa sesión.
async function getAuthenticatedSession(req) {
  const token = getBearerToken(req);
  const session = securityStore.getSessionUser(token);
  if (!session) return null;

  const currentUser = await securityStore.findSecurityUser(rootDir, session.username);
  if (!currentUser || !currentUser.enabled) {
    securityStore.removeSession(token);
    return null;
  }

  session.role = currentUser.role;
  session.displayName = currentUser.displayName;
  return session;
}

// --- Handlers de rutas -------------------------------------------------------

async function handleLogin(req, res) {
  const payload = await readJsonBody(req);
  const username = String(payload.username || '');
  const password = String(payload.password || '');
  const clientAddress = getClientAddress(req);

  if (!username.trim() || !password.trim()) {
    writeJsonResponse(res, 400, { error: 'Usuario y contraseña son obligatorios.' });
    return;
  }

  const adConfig = await securityStore.getAdConfig(rootDir);
  const users = await securityStore.getSecurityUsers(rootDir);
  const localUser = users.find((u) => String(u.username).toLowerCase() === username.toLowerCase()) || null;

  // Bootstrap: si todavía no hay ningún usuario configurado localmente, el
  // primer login exitoso contra AD se auto-promueve a admin.
  const isBootstrap = users.length === 0;

  if (!isBootstrap && (!localUser || !localUser.enabled)) {
    securityStore.writeSecurityLog(logsDir, `LOGIN DENEGADO usuario='${username}' (no habilitado en la app) desde ${clientAddress}`);
    writeJsonResponse(res, 401, { error: 'Usuario no habilitado en esta aplicación. Pedile a un administrador que te dé de alta.' });
    return;
  }

  const adResult = await securityStore.testAdCredentials(adConfig, username, password);
  if (!adResult.ok) {
    securityStore.writeSecurityLog(logsDir, `LOGIN FALLIDO usuario='${username}' desde ${clientAddress} (${adResult.message})`);
    writeJsonResponse(res, 401, { error: adResult.message });
    return;
  }

  let effectiveUser = localUser;
  if (isBootstrap) {
    await securityStore.addOrUpdateSecurityUser(rootDir, username, 'admin', true, '');
    effectiveUser = await securityStore.findSecurityUser(rootDir, username);
    securityStore.writeSecurityLog(
      logsDir,
      `BOOTSTRAP: '${username}' se dio de alta como el primer administrador (login exitoso, sin usuarios configurados todavía)`
    );
  }

  const token = securityStore.newSession(effectiveUser.username, effectiveUser.role, effectiveUser.displayName);
  securityStore.writeSecurityLog(logsDir, `LOGIN OK usuario='${effectiveUser.username}' rol='${effectiveUser.role}' desde ${clientAddress}`);
  writeJsonResponse(res, 200, {
    token,
    username: effectiveUser.username,
    role: effectiveUser.role,
    displayName: effectiveUser.displayName,
  });
}

async function handleUsersPost(req, res, session) {
  if (!securityStore.testRoleCanManageUsers(session.role)) {
    writeJsonResponse(res, 403, { error: 'No tenés permiso para administrar usuarios.' });
    return;
  }
  const incoming = await readJsonBody(req);
  const targetUsername = String(incoming.username || '');
  const targetRole = String(incoming.role || '');
  const targetEnabled = !!incoming.enabled;

  if (!targetUsername.trim()) {
    writeJsonResponse(res, 400, { error: 'Falta el nombre de usuario.' });
    return;
  }
  if (!securityStore.getValidRoles().includes(targetRole)) {
    writeJsonResponse(res, 400, { error: `Rol inválido. Roles válidos: ${securityStore.getValidRoles().join(', ')}.` });
    return;
  }
  if (!targetEnabled && (await securityStore.testIsLastEnabledAdmin(rootDir, targetUsername))) {
    writeJsonResponse(res, 400, { error: 'No se puede deshabilitar al último administrador habilitado.' });
    return;
  }
  if (targetRole !== 'admin' && (await securityStore.testIsLastEnabledAdmin(rootDir, targetUsername))) {
    writeJsonResponse(res, 400, { error: 'No se puede sacarle el rol de administrador al último administrador habilitado.' });
    return;
  }

  await securityStore.addOrUpdateSecurityUser(rootDir, targetUsername, targetRole, targetEnabled, String(incoming.displayName || ''));
  securityStore.writeSecurityLog(
    logsDir,
    `USUARIO '${targetUsername}' (rol='${targetRole}', habilitado=${targetEnabled}) dado de alta/editado por '${session.username}'`
  );
  writeJsonResponse(res, 200, { ok: true });
}

async function handleUsersDelete(parsedUrl, res, session) {
  if (!securityStore.testRoleCanManageUsers(session.role)) {
    writeJsonResponse(res, 403, { error: 'No tenés permiso para administrar usuarios.' });
    return;
  }
  const targetUsername = parsedUrl.searchParams.get('username') || '';
  if (await securityStore.testIsLastEnabledAdmin(rootDir, targetUsername)) {
    writeJsonResponse(res, 400, { error: 'No se puede eliminar al último administrador habilitado.' });
    return;
  }
  await securityStore.removeSecurityUser(rootDir, targetUsername);
  securityStore.writeSecurityLog(logsDir, `USUARIO '${targetUsername}' eliminado por '${session.username}'`);
  writeJsonResponse(res, 200, { ok: true });
}

async function handleSecurityConfigPost(req, res, session) {
  if (!securityStore.testRoleCanManageUsers(session.role)) {
    writeJsonResponse(res, 403, { error: 'No tenés permiso para administrar usuarios.' });
    return;
  }
  const incoming = await readJsonBody(req);
  const adConfig = {
    server: String(incoming.server || ''),
    port: parseInt(incoming.port, 10) || 0,
    useSsl: !!incoming.useSsl,
    domain: String(incoming.domain || ''),
  };
  await securityStore.saveAdConfig(rootDir, adConfig);
  securityStore.writeSecurityLog(
    logsDir,
    `CONFIG AD actualizada por '${session.username}' (server='${adConfig.server}', domain='${adConfig.domain}')`
  );
  writeJsonResponse(res, 200, { ok: true });
}

async function handleProfilesPost(req, res) {
  const incoming = await readJsonBody(req);
  const profiles = await profileStore.getProfiles(rootDir);
  const existingIndex = profiles.findIndex((p) => p.name === incoming.name);

  const updated = {
    name: incoming.name,
    baseUrl: incoming.baseUrl,
    novaBaseUrl: incoming.novaBaseUrl,
    authType: incoming.authType,
    apiKeyHeaderName: incoming.apiKeyHeaderName,
    apiKeyOrToken: incoming.apiKeyOrToken,
    tokenUrl: incoming.tokenUrl,
    clientId: incoming.clientId,
    clientSecret: incoming.clientSecret,
    clientCertPfxPath: incoming.clientCertPfxPath,
    clientCertPassphrase: incoming.clientCertPassphrase,
  };

  if (existingIndex >= 0) {
    // Si el form no mandó un secreto nuevo, conservar el que ya había guardado.
    if (!updated.apiKeyOrToken) updated.apiKeyOrToken = profiles[existingIndex].apiKeyOrToken;
    if (!updated.clientSecret) updated.clientSecret = profiles[existingIndex].clientSecret;
    if (!updated.clientCertPassphrase) updated.clientCertPassphrase = profiles[existingIndex].clientCertPassphrase;
    profiles[existingIndex] = updated;
  } else {
    profiles.push(updated);
  }

  await profileStore.saveProfiles(rootDir, profiles);
  writeJsonResponse(res, 200, { ok: true });
}

async function handleProfilesDelete(parsedUrl, res) {
  const name = parsedUrl.searchParams.get('name') || '';
  const profiles = (await profileStore.getProfiles(rootDir)).filter((p) => p.name !== name);
  await profileStore.saveProfiles(rootDir, profiles);
  writeJsonResponse(res, 200, { ok: true });
}

function handleFlowsGet(res) {
  // "hidden": true saca un flow de esta lista sin sacarle la posibilidad de
  // ejecutarlo por nombre vía /api/run — ver Flows/recupera-cuentas-sql.json.
  const flows = flowStore.getFlows(flowsDir).filter((f) => !f.hidden);
  const summary = flows.map((f) => ({
    name: f.name,
    description: f.description,
    inputMode: f.inputMode,
    inputs: f.inputs,
    // Nombre corto opcional para el log/archivos de salida de esta corrida
    // (ver flowLogName en flowEngine.js) — el frontend lo necesita para
    // generar el mismo nombre de log ANTES de la primera llamada a
    // /api/run (ver batchLogFileName en runFlowFromCsv, wwwroot/app.js).
    logAlias: f.logAlias || null,
    steps: (f.steps || []).map((s) => ({ name: s.name, type: s.type || null })),
  }));
  writeJsonResponse(res, 200, summary);
}

async function handleRun(req, res, session) {
  const payload = await readJsonBody(req);

  const profiles = await profileStore.getProfiles(rootDir);
  const selectedProfile = profiles.find((p) => p.name === payload.profileName) || null;

  const flows = flowStore.getFlows(flowsDir);
  const selectedFlow = flows.find((f) => f.name === payload.flowName) || null;

  if (!selectedProfile) {
    writeJsonResponse(res, 400, { error: `Perfil '${payload.profileName}' no encontrado.` });
    return;
  }
  if (!selectedFlow) {
    writeJsonResponse(res, 400, { error: `Flow '${payload.flowName}' no encontrado.` });
    return;
  }
  if (!securityStore.testRoleCanRunFlow(session.role)) {
    securityStore.writeSecurityLog(
      logsDir,
      `EJECUCIÓN DENEGADA usuario='${session.username}' rol='${session.role}' flow='${selectedFlow.name}' (rol sin permiso para ejecutar)`
    );
    writeJsonResponse(res, 403, { error: `Tu rol ('${session.role}') no tiene permiso para ejecutar flows.` });
    return;
  }
  const inputValues = {};
  if (payload.inputs) {
    for (const [key, value] of Object.entries(payload.inputs)) {
      inputValues[key] = String(value);
    }
  }

  const parametria = await parametriaStore.getParametria(rootDir);
  // payload.runLogFileName (opcional): el cliente lo manda para que varias
  // filas de un mismo archivo CSV terminen todas en el mismo log de
  // logs/http/ en vez de uno por fila (ver invokeFlow, que valida el
  // formato antes de confiarlo). Se devuelve el nombre realmente usado en
  // el header X-Run-Log-File para que el cliente lo reuse en la próxima
  // fila del mismo archivo.
  const { log, runLogFileName } = await flowEngine.invokeFlow(
    selectedProfile,
    selectedFlow,
    inputValues,
    logsDir,
    parametria,
    payload.runLogFileName ? String(payload.runLogFileName) : null,
    session.username
  );

  // Una entrada por cada corrida de /api/run (para un flow CSV, una por fila del
  // archivo) — nunca incluye inputs ni la respuesta (pueden traer datos
  // bancarios reales). El detalle completo de request/response de esta corrida
  // queda en su propio archivo bajo logs/http/ (ver flowEngine.js, invokeFlow).
  const okSteps = log.filter((e) => e.status === 'Success').length;
  const errorSteps = log.filter((e) => e.status !== 'Success').length;
  securityStore.writeSecurityLog(
    logsDir,
    `EJECUCIÓN flow='${selectedFlow.name}' perfil='${selectedProfile.name}' usuario='${session.username}' rol='${session.role}' pasos_ok=${okSteps} pasos_error=${errorSteps}`
  );

  res.setHeader('X-Run-Log-File', runLogFileName);
  writeJsonResponse(res, 200, log);
}

// runId es el MISMO identificador que ya generó el log de esta corrida (ver
// flowEngine.js, generateRunId — el cliente lo saca del nombre de log que le
// devolvió /api/run) — se valida acá con el mismo patrón (RUN_ID_PATTERN),
// única defensa contra path traversal en un endpoint que escribe archivos a
// partir de input del cliente. Compartir el runId entre log y archivo de
// salida es a propósito: "Archivos de salida" los encuentra por nombre, sin
// tener que parsear contenido de ningún archivo (ver handleOutputFilesGet).
// "kind" (pfout/dbnout/dbnconsulta) es solo para decidir si hay que además
// registrar el contenido en MariaDB (dbn_out/dbn_consulta) — no forma parte
// del nombre del archivo.
async function handleSaveOutput(req, res, session) {
  const payload = await readJsonBody(req);
  const runId = String(payload.runId || '');
  const variant = payload.variant === 'error' ? 'error' : 'ok';
  const kind = String(payload.kind || '');
  const content = String(payload.content || '');

  if (!flowEngine.RUN_ID_PATTERN.test(runId)) {
    writeJsonResponse(res, 400, { error: 'Identificador de corrida inválido.' });
    return;
  }

  if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
  const fileName = variant === 'error' ? `${runId}-error.csv` : `${runId}.csv`;
  const filePath = path.join(filesDir, fileName);
  fs.writeFileSync(filePath, content, 'utf8');
  securityStore.writeSecurityLog(logsDir, `ARCHIVO DE SALIDA '${fileName}' guardado por '${session.username}'`);

  // Además del .csv en files/ (arriba), el contenido de dbnout-/dbnconsulta-
  // queda registrado en MariaDB con quién lo generó y cuándo (ver
  // debinOutputStore.js) — un registro que se puede consultar sin tener que
  // ir a buscar el archivo. Si esto falla (ej. MariaDB no disponible en ese
  // momento) no aborta la respuesta: el .csv ya se guardó bien, que es lo
  // principal de este endpoint; solo queda constancia del error en el log
  // de seguridad.
  if (kind === 'dbnout' || kind === 'dbnconsulta') {
    try {
      if (kind === 'dbnout') {
        await debinOutputStore.addDbnOutRows(rootDir, content, session.username);
      } else {
        await debinOutputStore.addDbnConsultaRows(rootDir, content, session.username);
      }
    } catch (err) {
      securityStore.writeSecurityLog(
        logsDir,
        `ERROR registrando '${fileName}' en MariaDB (dbn_out/dbn_consulta): ${err.message}`
      );
    }
  }

  writeJsonResponse(res, 200, { ok: true, fileName });
}

// El cliente llama a esto una sola vez, al terminar de procesar un CSV
// completo (después de guardar los archivos ok/error con /api/save-output),
// para anexarle al log de esa corrida (logs/http/) un resumen: qué flow fue,
// quién lo corrió, y los nombres de los archivos que quedaron guardados —
// así "Archivos de salida" puede armar una fila por corrida sin necesitar
// una tabla nueva en la base (ver appendRunSummary en flowEngine.js). El
// usuario SIEMPRE es el de la sesión (session.username), nunca el que
// mande el cliente en el body — evita que alguien falsifique quién corrió qué.
async function handleRunSummaryPost(req, res, session) {
  const payload = await readJsonBody(req);
  const logFileName = String(payload.logFileName || '');

  try {
    flowEngine.appendRunSummary(logsDir, logFileName, {
      flowName: payload.flowName ? String(payload.flowName) : null,
      username: session.username,
      okFileName: payload.okFileName ? String(payload.okFileName) : null,
      errorFileName: payload.errorFileName ? String(payload.errorFileName) : null,
      pasosOk: payload.pasosOk != null ? Number(payload.pasosOk) : null,
      pasosError: payload.pasosError != null ? Number(payload.pasosError) : null,
    });
  } catch (err) {
    writeJsonResponse(res, 400, { error: err.message });
    return;
  }
  writeJsonResponse(res, 200, { ok: true });
}

// El archivo ok comparte el runId tal cual (mismo nombre que el log, sin
// "http/" ni ".log"); el de error es el mismo runId + "-error" al final —
// ver handleSaveOutput. Única defensa anti path-traversal al leer un nombre
// de archivo que llega por querystring.
const OUTPUT_FILE_NAME_PATTERN = new RegExp(`^${flowEngine.RUN_ID_PATTERN.source.slice(1, -1)}(-error)?\\.csv$`);

// Una fila por CORRIDA (no por archivo suelto): el nombre del log YA ES el
// runId (ver generateRunId en flowEngine.js). Casi siempre el archivo ok/
// error comparte ese runId (files/<runId>.csv / <runId>-error.csv, ver
// handleSaveOutput), así que de entrada se asume ese patrón — pero
// "Transferencia DEBIN - File" guarda su archivo "ok" (dbnconsulta-..., el
// detalle completo) con un runId PROPIO, no el de la corrida (ver
// saveOutputFiles/consultaOkFileName en wwwroot/app.js): para esos casos
// hay que confiar en summary.okFileName/errorFileName (lo que la corrida
// reportó de verdad que guardó, ver postRunSummary) en vez del patrón fijo.
// El resumen que /api/run-summary anexa al log (ver appendRunSummary/
// parseRunSummary) también enriquece la fila con quién la corrió, qué flow
// fue y los pasos ok/error — si un log no tiene resumen (corrida de antes
// de este feature, o un CSV que se cortó antes de terminar), la fila sale
// igual, con esos campos en null pero el archivo por patrón (si existe)
// sigue siendo descargable.
function handleOutputFilesGet(res) {
  const httpLogsDir = path.join(logsDir, HTTP_LOG_SUBDIR);
  if (!fs.existsSync(httpLogsDir)) {
    writeJsonResponse(res, 200, []);
    return;
  }
  const runs = fs
    .readdirSync(httpLogsDir)
    .filter((name) => HTTP_LOG_FILE_NAME_PATTERN.test(name))
    .map((name) => {
      const filePath = path.join(httpLogsDir, name);
      const stat = fs.statSync(filePath);
      const runId = name.replace(/\.log$/, '');

      let summary = null;
      try {
        summary = flowEngine.parseRunSummary(fs.readFileSync(filePath, 'utf8'));
      } catch (err) {
        // Log corrupto o ilegible: la corrida sale igual en la lista, solo sin resumen.
      }

      // OUTPUT_FILE_NAME_PATTERN valida summary.okFileName/errorFileName
      // antes de confiar en ellos (mismo chequeo anti path-traversal que ya
      // hace handleOutputFileContentGet): un valor fuera de ese formato
      // (log corrupto, instalación vieja) cae al patrón fijo de siempre.
      const okFileName =
        summary && summary.okFileName && OUTPUT_FILE_NAME_PATTERN.test(summary.okFileName)
          ? summary.okFileName
          : `${runId}.csv`;
      const errorFileName =
        summary && summary.errorFileName && OUTPUT_FILE_NAME_PATTERN.test(summary.errorFileName)
          ? summary.errorFileName
          : `${runId}-error.csv`;

      return {
        logFileName: name,
        mtime: stat.mtime.toISOString(),
        flowName: summary ? summary.flowName : null,
        username: summary ? summary.username : null,
        okFileName: fs.existsSync(path.join(filesDir, okFileName)) ? okFileName : null,
        errorFileName: fs.existsSync(path.join(filesDir, errorFileName)) ? errorFileName : null,
        pasosOk: summary ? summary.pasosOk : null,
        pasosError: summary ? summary.pasosError : null,
      };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
  writeJsonResponse(res, 200, runs);
}

// Nombres de flow que puede mostrar el Dashboard (los 3 que mueven plata) —
// los mismos 3 nombres exactos que usan los .json de Flows/ (ver
// parseRunSummary/summary.flowName), para filtrar las corridas de
// handleOutputFilesGet que no son de ninguno de estos 3 (ej. "Consultar
// CBU" u otros flows auxiliares).
const DASHBOARD_FLOW_NAMES = ['Alta de Plazo Fijos - File', 'Pago de Plazo Fijos', 'Transferencia DEBIN - File'];

// Copia local de parseCsvLine/parseCsvText — mismo caso que
// node/lib/debinOutputStore.js y wwwroot/app.js (ver comentario ahí): no
// vale la pena un módulo compartido para un parser de 2 funciones.
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
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

function parseCsvText(text) {
  return text
    .split(/\r\n|\r|\n/)
    .filter((line) => line.length > 0)
    .map(parseCsvLine);
}

// De cada archivo de error (files/<runId>-error.csv) solo nos interesan 3
// datos por fila: con qué comprobante buscar en el log, el CUIT para
// identificar al cliente, y el motivo del rechazo. El layout de columnas
// difiere por flow (ver comentario en wwwroot/app.js sobre
// state.errorRows.push, y el armado de errorRows de "Pago de Plazo
// Fijos"): "Alta de Plazo Fijos - File" y "Transferencia DEBIN - File" no
// llevan encabezado (son la fila de entrada tal cual + idMensaje + motivo),
// "Pago de Plazo Fijos" sí.
function parseErrorFileRows(flowName, csvContent) {
  const lines = parseCsvText(csvContent);
  if (lines.length === 0) return [];

  if (flowName === 'Alta de Plazo Fijos - File') {
    // cuit, apellidoNombre, importe, plazo, numeroComprobante, circuito, idMensaje, motivo
    return lines.map((cols) => ({
      numeroComprobante: cols[4] || '',
      cuit: cols[0] || '',
      motivo: cols[cols.length - 1] || '',
    }));
  }

  if (flowName === 'Transferencia DEBIN - File') {
    // creditoCuit, creditoCbu, creditoTitular, debitoCuit, debitoCbu, debitoTitular, idComprobante, moneda, importe, idMensaje, motivo
    return lines.map((cols) => ({
      numeroComprobante: cols[6] || '',
      cuit: cols[0] || '',
      motivo: cols[cols.length - 1] || '',
    }));
  }

  if (flowName === 'Pago de Plazo Fijos') {
    // Con encabezado: idMensaje,cuit,apellidoNombre,numeroComprobante,importe,cajaAhorro,fechaVencimiento,motivo
    const header = lines[0];
    const idx = (col) => header.indexOf(col);
    return lines.slice(1).map((cols) => ({
      numeroComprobante: cols[idx('numeroComprobante')] || '',
      cuit: cols[idx('cuit')] || '',
      motivo: cols[idx('motivo')] || '',
    }));
  }

  return [];
}

// Agrupa por día local (no UTC) el mismo criterio que usa "Archivos de
// salida" para su filtro de fechas en wwwroot/app.js
// (formatDateOnlyLocal): año-mes-día de la hora local del servidor, no de
// toISOString() (que es UTC y puede correr la fecha de corridas hechas
// cerca de medianoche).
function formatDateOnlyLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// GET /api/dashboard?from=yyyy-MM-dd&to=yyyy-MM-dd — resumen del día (o del
// rango pedido) de los 3 flows que mueven plata, para el panel de
// Dashboard. Reusa el mismo escaneo de logs/http/ que handleOutputFilesGet
// (mismo resumen por corrida, ver appendRunSummary/parseRunSummary), pero
// además abre cada errorFileName para sacar comprobante+motivo por fila:
// el resumen de la corrida (pasosOk/pasosError) no alcanza para eso, hay
// que leer el CSV de error ya guardado en files/.
function handleDashboardGet(parsedUrl, res) {
  const from = parsedUrl.searchParams.get('from') || '';
  const to = parsedUrl.searchParams.get('to') || '';

  const httpLogsDir = path.join(logsDir, HTTP_LOG_SUBDIR);
  if (!fs.existsSync(httpLogsDir)) {
    writeJsonResponse(res, 200, { porFlow: [], errores: [] });
    return;
  }

  const runs = fs
    .readdirSync(httpLogsDir)
    .filter((name) => HTTP_LOG_FILE_NAME_PATTERN.test(name))
    .map((name) => {
      const filePath = path.join(httpLogsDir, name);
      const stat = fs.statSync(filePath);
      const runId = name.replace(/\.log$/, '');

      let summary = null;
      try {
        summary = flowEngine.parseRunSummary(fs.readFileSync(filePath, 'utf8'));
      } catch (err) {
        // Log corrupto o ilegible: se descarta para el Dashboard (igual que
        // una corrida sin resumen no aporta flowName/pasosOk/pasosError).
      }
      if (!summary || !summary.flowName) return null;

      const errorFileName = `${runId}-error.csv`;
      return {
        logFileName: name,
        mtime: stat.mtime,
        flowName: summary.flowName,
        pasosOk: summary.pasosOk || 0,
        pasosError: summary.pasosError || 0,
        errorFileName: fs.existsSync(path.join(filesDir, errorFileName)) ? errorFileName : null,
      };
    })
    .filter((run) => run && DASHBOARD_FLOW_NAMES.includes(run.flowName))
    .filter((run) => {
      const day = formatDateOnlyLocal(run.mtime);
      if (from && day < from) return false;
      if (to && day > to) return false;
      return true;
    });

  const porFlowMap = new Map();
  for (const flowName of DASHBOARD_FLOW_NAMES) {
    porFlowMap.set(flowName, { flowName, corridas: 0, ok: 0, error: 0 });
  }
  for (const run of runs) {
    const entry = porFlowMap.get(run.flowName);
    entry.corridas++;
    entry.ok += run.pasosOk;
    entry.error += run.pasosError;
  }

  const errores = [];
  for (const run of runs) {
    if (!run.errorFileName) continue;
    let csvContent = '';
    try {
      csvContent = fs.readFileSync(path.join(filesDir, run.errorFileName), 'utf8');
    } catch (err) {
      continue; // Archivo listado pero ya no accesible (borrado a mano, etc.): se omite.
    }
    for (const row of parseErrorFileRows(run.flowName, csvContent)) {
      errores.push({
        hora: run.mtime.toISOString(),
        flowName: run.flowName,
        logFileName: run.logFileName,
        numeroComprobante: row.numeroComprobante,
        cuit: row.cuit,
        motivo: row.motivo,
      });
    }
  }
  errores.sort((a, b) => b.hora.localeCompare(a.hora));

  writeJsonResponse(res, 200, { porFlow: Array.from(porFlowMap.values()), errores });
}

// Una corrida cortada antes de guardar su resumen no tiene flowName, pero sí
// puede tener su archivo de error: se reconoce por el sufijo del runId
// (logAlias del flow, o el slug del name si no tiene — ver flowLogName en
// flowEngine.js).
const CONCILIACION_RUN_ID_SUFFIXES = {
  'Alta de Plazo Fijos - File': 'Alta-PF',
  'Transferencia DEBIN - File': 'transferencia-debin-file',
  'Pago de Plazo Fijos': 'Pago-PF',
};

function csvEscape(value) {
  const str = value == null ? '' : String(value);
  return /[",\r\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

// files/<runId><fileSuffix>.csv ('-error' o '' para el OK) de cada corrida
// de flowName terminada ese día (mtime del log, mismo criterio que el
// Dashboard), ya parseado en filas.
function readRunFilesDelDia(flowName, fecha, fileSuffix) {
  const httpLogsDir = path.join(logsDir, HTTP_LOG_SUBDIR);
  if (!fs.existsSync(httpLogsDir)) return [];
  const runIdPattern = new RegExp(`^\\d{18}-${CONCILIACION_RUN_ID_SUFFIXES[flowName]}$`);
  const result = [];
  for (const name of fs.readdirSync(httpLogsDir)) {
    if (!HTTP_LOG_FILE_NAME_PATTERN.test(name)) continue;
    const logPath = path.join(httpLogsDir, name);
    const mtime = fs.statSync(logPath).mtime;
    if (formatDateOnlyLocal(mtime) !== fecha) continue;

    const runId = name.replace(/\.log$/, '');
    const errorPath = path.join(filesDir, `${runId}${fileSuffix}.csv`);
    if (!fs.existsSync(errorPath)) continue;

    let summary = null;
    try {
      summary = flowEngine.parseRunSummary(fs.readFileSync(logPath, 'utf8'));
    } catch (err) {
      // Sin resumen: se decide por el sufijo del runId.
    }
    const esDelFlow = summary && summary.flowName ? summary.flowName === flowName : runIdPattern.test(runId);
    if (!esDelFlow) continue;

    let content;
    try {
      content = fs.readFileSync(errorPath, 'utf8');
    } catch (err) {
      continue;
    }
    result.push({ fecha: formatLocal(mtime), usuario: summary ? summary.username : '', lines: parseCsvText(content) });
  }
  return result;
}

// Archivo de error sin encabezado ("Alta de Plazo Fijos - File" y
// "Transferencia DEBIN - File"): la fila de entrada tal cual + idMensaje + motivo.
function readErrorRowsDelDia(flowName, fecha) {
  return readRunFilesDelDia(flowName, fecha, '-error').flatMap(({ fecha: fechaCorrida, usuario, lines }) =>
    lines.map((cols) => ({ fecha: fechaCorrida, usuario, cols }))
  );
}

// Archivo con encabezado ("Pago de Plazo Fijos", OK y error): cada fila como
// objeto por nombre de columna (archivos viejos pueden no tener "circuito").
function readRunRecordsDelDia(flowName, fecha, fileSuffix) {
  return readRunFilesDelDia(flowName, fecha, fileSuffix).flatMap(({ fecha: fechaCorrida, usuario, lines }) => {
    const [header, ...data] = lines;
    if (!header) return [];
    return data.map((cols) => {
      const record = {};
      header.forEach((col, i) => (record[col] = cols[i] != null ? cols[i] : ''));
      return { fecha: fechaCorrida, usuario, record };
    });
  });
}

const CONCILIACION_TRANSFERENCIAS_HEADERS = [
  'fecha', 'idMensaje', 'idComprobante', 'idOperacion',
  'debitoCuit', 'debitoCbu', 'debitoTitular',
  'creditoCuit', 'creditoCbu', 'creditoTitular',
  'moneda', 'importe', 'realizado',
  'codigoRespuesta', 'descripcionRespuesta', 'estadoCodigo', 'estadoDescripcion',
  'errorConsulta', 'motivo', 'usuario',
];

// Todas las transferencias del día: las de dbn_consulta (realizadas, y las
// rechazadas que ya quedan ahí — rechazo de negocio, límite diario, CUIT que
// no coincide) más las del archivo de error que nunca llegaron a dbn_consulta
// (CBU inválido, error de comunicación), sin repetir por idMensaje.
async function buildConciliacionTransferencias(fecha) {
  const dbRows = await debinOutputStore.getConsultaRowsDelDia(rootDir, fecha);
  const rows = dbRows.map((r) => ({
    fecha: r.ejecutado_en,
    idMensaje: r.id_mensaje,
    idComprobante: r.id_comprobante,
    idOperacion: r.id_operacion,
    debitoCuit: r.debito_cuit,
    debitoCbu: r.debito_cbu,
    debitoTitular: r.debito_titular,
    creditoCuit: r.credito_cuit,
    creditoCbu: r.credito_cbu,
    creditoTitular: r.credito_titular,
    moneda: r.moneda,
    importe: r.importe,
    realizado: r.realizado === 's' ? 'SI' : 'NO',
    codigoRespuesta: r.codigo_respuesta,
    descripcionRespuesta: r.descripcion_respuesta,
    estadoCodigo: r.estado_codigo || '',
    estadoDescripcion: r.estado_descripcion || '',
    errorConsulta: r.error_consulta,
    motivo: r.realizado === 's' ? '' : r.estado_descripcion || r.descripcion_respuesta || '',
    usuario: r.ejecutado_por,
  }));

  const idMensajesEnBase = new Set(rows.map((r) => r.idMensaje).filter(Boolean));
  for (const { fecha: fechaCorrida, usuario, cols } of readErrorRowsDelDia('Transferencia DEBIN - File', fecha)) {
    // creditoCuit, creditoCbu, creditoTitular, debitoCuit, debitoCbu, debitoTitular, idComprobante, moneda, importe, idMensaje, motivo
    const idMensaje = cols[cols.length - 2] || '';
    if (idMensaje && idMensajesEnBase.has(idMensaje)) continue;
    rows.push({
      fecha: fechaCorrida,
      idMensaje,
      idComprobante: cols[6] || '',
      idOperacion: '',
      debitoCuit: cols[3] || '',
      debitoCbu: cols[4] || '',
      debitoTitular: cols[5] || '',
      creditoCuit: cols[0] || '',
      creditoCbu: cols[1] || '',
      creditoTitular: cols[2] || '',
      moneda: cols[7] || '',
      importe: cols[8] || '',
      realizado: 'NO',
      codigoRespuesta: '',
      descripcionRespuesta: '',
      estadoCodigo: '',
      estadoDescripcion: '',
      errorConsulta: '',
      motivo: cols[cols.length - 1] || '',
      usuario,
    });
  }
  return rows;
}

const CONCILIACION_PLAZOS_FIJOS_HEADERS = [
  'fecha', 'idMensaje', 'cuit', 'apellidoNombre', 'numeroComprobante', 'circuito',
  'monto', 'plazo', 'cajaAhorro', 'operacion', 'importeNeto', 'tna', 'fechaVencimiento',
  'realizado', 'motivo', 'usuario',
];

// Altas del día: las exitosas de operaciones_procesadas más las fallidas de
// los archivos de error de "Alta de Plazo Fijos - File".
async function buildConciliacionPlazosFijos(fecha) {
  const dbRows = await processedOperationsStore.getAltasDelDia(rootDir, fecha);
  const rows = dbRows.map((r) => ({
    fecha: r.processed_at,
    idMensaje: r.id_mensaje,
    cuit: r.cuit,
    apellidoNombre: r.apellido_nombre,
    numeroComprobante: r.numero_comprobante,
    circuito: r.tipo_circuito,
    monto: r.monto,
    plazo: r.plazo,
    cajaAhorro: r.caja_ahorro,
    operacion: r.operacion,
    importeNeto: r.importe_neto,
    tna: r.tna,
    fechaVencimiento: r.fecha_vencimiento,
    realizado: 'SI',
    motivo: '',
    usuario: r.processed_by,
  }));

  const idMensajesEnBase = new Set(rows.map((r) => r.idMensaje).filter(Boolean));
  for (const { fecha: fechaCorrida, usuario, cols } of readErrorRowsDelDia('Alta de Plazo Fijos - File', fecha)) {
    // cuit, apellidoNombre, monto, plazo, numeroComprobante, circuito, idMensaje, motivo
    const idMensaje = cols[cols.length - 2] || '';
    if (idMensaje && idMensajesEnBase.has(idMensaje)) continue;
    rows.push({
      fecha: fechaCorrida,
      idMensaje,
      cuit: cols[0] || '',
      apellidoNombre: cols[1] || '',
      numeroComprobante: cols[4] || '',
      circuito: cols[5] || '',
      monto: cols[2] || '',
      plazo: cols[3] || '',
      cajaAhorro: '',
      operacion: '',
      importeNeto: '',
      tna: '',
      fechaVencimiento: '',
      realizado: 'NO',
      motivo: cols[cols.length - 1] || '',
      usuario,
    });
  }
  return rows;
}

const CONCILIACION_PAGOS_PLAZOS_FIJOS_HEADERS = [
  'fecha', 'idMensaje', 'cuit', 'apellidoNombre', 'numeroComprobante', 'operacion', 'circuito',
  'importe', 'cajaAhorro', 'fechaVencimiento', 'realizado', 'motivo', 'usuario',
];

// Pagos del día de "Pago de Plazo Fijos":
// - realizados (SI): los marcados como pagados ese día en
//   operaciones_procesadas (pf_pagado_en) — se marcan fila por fila, así que
//   están aunque la corrida se haya cortado;
// - del archivo OK de cada corrida: los de circuito 1 (NO: listados sin
//   movimiento bancario) y los pagados que no estén en la base (pagos de
//   antes de existir pf_pagado_en);
// - del archivo de error de cada corrida: los fallidos (NO, con motivo).
// Sin repetir por idMensaje.
async function buildConciliacionPagosPlazosFijos(fecha) {
  const dbRows = await processedOperationsStore.getPagosDelDia(rootDir, fecha);
  const rows = dbRows.map((r) => ({
    fecha: r.pf_pagado_en,
    idMensaje: r.pf_pago_id_mensaje,
    cuit: r.cuit,
    apellidoNombre: r.apellido_nombre,
    numeroComprobante: r.numero_comprobante,
    operacion: r.operacion,
    circuito: r.tipo_circuito,
    importe: r.importe_neto,
    cajaAhorro: r.caja_ahorro,
    fechaVencimiento: r.fecha_vencimiento,
    realizado: 'SI',
    motivo: '',
    usuario: r.pf_pagado_por,
  }));

  const idMensajesVistos = new Set(rows.map((r) => r.idMensaje).filter(Boolean));
  const fromFile = (fechaCorrida, usuario, record, realizado, motivo) => ({
    fecha: fechaCorrida,
    idMensaje: record.idMensaje || '',
    cuit: record.cuit || '',
    apellidoNombre: record.apellidoNombre || '',
    numeroComprobante: record.numeroComprobante || '',
    operacion: '',
    circuito: record.circuito || '',
    importe: record.importe || '',
    cajaAhorro: record.cajaAhorro || '',
    fechaVencimiento: record.fechaVencimiento || '',
    realizado,
    motivo,
    usuario,
  });

  for (const { fecha: fechaCorrida, usuario, record } of readRunRecordsDelDia('Pago de Plazo Fijos', fecha, '')) {
    if (record.idMensaje && idMensajesVistos.has(record.idMensaje)) continue;
    idMensajesVistos.add(record.idMensaje);
    rows.push(
      record.circuito === '1'
        ? fromFile(fechaCorrida, usuario, record, 'NO', 'Circuito 1: sin movimiento bancario (solo constancia)')
        : fromFile(fechaCorrida, usuario, record, 'SI', '')
    );
  }
  for (const { fecha: fechaCorrida, usuario, record } of readRunRecordsDelDia('Pago de Plazo Fijos', fecha, '-error')) {
    if (record.idMensaje && idMensajesVistos.has(record.idMensaje)) continue;
    rows.push(fromFile(fechaCorrida, usuario, record, 'NO', record.motivo || ''));
  }
  return rows;
}

// GET /api/conciliacion?tipo=transferencias|plazos-fijos|pagos-plazos-fijos&fecha=yyyy-MM-dd —
// archivo diario para conciliar contra el core, con realizado SI/NO por fila.
async function handleConciliacionGet(parsedUrl, res, session) {
  const tipo = parsedUrl.searchParams.get('tipo') || '';
  const fecha = parsedUrl.searchParams.get('fecha') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    writeJsonResponse(res, 400, { error: 'Fecha inválida (formato yyyy-MM-dd).' });
    return;
  }
  let headers;
  let rows;
  if (tipo === 'transferencias') {
    headers = CONCILIACION_TRANSFERENCIAS_HEADERS;
    rows = await buildConciliacionTransferencias(fecha);
  } else if (tipo === 'plazos-fijos') {
    headers = CONCILIACION_PLAZOS_FIJOS_HEADERS;
    rows = await buildConciliacionPlazosFijos(fecha);
  } else if (tipo === 'pagos-plazos-fijos') {
    headers = CONCILIACION_PAGOS_PLAZOS_FIJOS_HEADERS;
    rows = await buildConciliacionPagosPlazosFijos(fecha);
  } else {
    writeJsonResponse(res, 400, { error: 'Tipo inválido (transferencias, plazos-fijos o pagos-plazos-fijos).' });
    return;
  }

  rows.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(','));

  const name = `conciliacion-${tipo}-${fecha}.csv`;
  securityStore.writeSecurityLog(logsDir, `CONCILIACION '${name}' descargada por '${session.username}' (${rows.length} fila(s))`);
  writeJsonResponse(res, 200, { name, content: lines.join('\r\n'), filas: rows.length });
}

// POST /api/conciliacion/ibs { fecha: yyyy-MM-dd, contenido: <CSV del
// extracto de IBS> } — cruza las altas de Plazo Fijo de ese día contra el
// extracto (ver conciliacionIbs.js) y devuelve resumen, totales y
// diferencias para el panel "Conciliación con IBS".
async function handleConciliacionIbsPost(req, res, session) {
  const payload = await readJsonBody(req);
  const fecha = String(payload.fecha || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    writeJsonResponse(res, 400, { error: 'Fecha inválida (formato yyyy-MM-dd).' });
    return;
  }
  const contenido = String(payload.contenido || '');
  if (!contenido.trim()) {
    writeJsonResponse(res, 400, { error: 'El archivo de IBS está vacío.' });
    return;
  }

  const altas = await processedOperationsStore.getAltasDelDia(rootDir, fecha);
  let resultado;
  try {
    resultado = conciliacionIbs.conciliarAltasPf(altas, parseCsvText(contenido.replace(/^﻿/, '')), fecha);
  } catch (err) {
    if (err.statusCode === 400) {
      writeJsonResponse(res, 400, { error: err.message });
      return;
    }
    throw err;
  }
  const r = resultado.resumen;
  securityStore.writeSecurityLog(
    logsDir,
    `CONCILIACION IBS altas PF ${fecha} por '${session.username}': ${r.altasOk}/${r.altasApicore} OK, ${r.altasConDiferencias} con diferencias, ${r.soloEnIbs} solo en IBS`
  );
  writeJsonResponse(res, 200, resultado);
}

function handleOutputFileContentGet(parsedUrl, res, session) {
  const name = parsedUrl.searchParams.get('name') || '';
  if (!OUTPUT_FILE_NAME_PATTERN.test(name)) {
    writeJsonResponse(res, 400, { error: 'Nombre de archivo inválido.' });
    return;
  }
  const filePath = path.join(filesDir, name);
  if (!fs.existsSync(filePath)) {
    writeJsonResponse(res, 404, { error: 'No se encontró el archivo.' });
    return;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  securityStore.writeSecurityLog(logsDir, `ARCHIVO DE SALIDA '${name}' descargado por '${session.username}'`);
  writeJsonResponse(res, 200, { name, content });
}

// Logs de ejecución (logs/http/, un archivo por corrida — ver
// generateRunLogFileName/writeHttpLog en flowEngine.js): detalle de
// request/response de cada step de cada flow corrido. No hay un listado
// propio de esto (ver handleOutputFilesGet más abajo, que ya arma una fila
// por corrida leyendo esta misma carpeta) — solo queda el endpoint de
// contenido, para el botón "Descargar log" de "Archivos de salida".
const HTTP_LOG_SUBDIR = 'http';
const HTTP_LOG_FILE_NAME_PATTERN = new RegExp(`^${flowEngine.RUN_ID_PATTERN.source.slice(1, -1)}\\.log$`);

function handleHttpLogContentGet(parsedUrl, res, session) {
  const name = parsedUrl.searchParams.get('name') || '';
  if (!HTTP_LOG_FILE_NAME_PATTERN.test(name)) {
    writeJsonResponse(res, 400, { error: 'Nombre de archivo inválido.' });
    return;
  }
  const filePath = path.join(logsDir, HTTP_LOG_SUBDIR, name);
  if (!fs.existsSync(filePath)) {
    writeJsonResponse(res, 404, { error: 'No se encontró el archivo.' });
    return;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  securityStore.writeSecurityLog(logsDir, `LOG DE EJECUCIÓN '${name}' visto por '${session.username}'`);
  writeJsonResponse(res, 200, { name, content });
}

// Buscador de "Certificado cliente (TLS mutuo)" en el diálogo de Perfil: solo
// lista lo que hay adentro de certsBaseDir (nunca fuera de ahí, ni aunque el
// query param intente escapar con ../ o una ruta absoluta — se valida
// comparando la ruta ya resuelta, no el texto que llega). Mismo permiso que
// Parametría: no es algo que un rol "operador" deba poder usar.
function handleCertsBrowseGet(parsedUrl, res, session) {
  if (!securityStore.testRoleCanManageParametria(session.role)) {
    writeJsonResponse(res, 403, { error: 'No tenés permiso para explorar archivos del servidor.' });
    return;
  }

  const relPath = parsedUrl.searchParams.get('path') || '';
  const baseResolved = path.resolve(certsBaseDir);
  const targetResolved = path.resolve(certsBaseDir, relPath);
  if (targetResolved !== baseResolved && !targetResolved.startsWith(baseResolved + path.sep)) {
    writeJsonResponse(res, 400, { error: 'Ruta inválida.' });
    return;
  }

  if (!fs.existsSync(targetResolved)) {
    writeJsonResponse(res, 200, { basePath: baseResolved, currentPath: relPath, currentFullPath: targetResolved, entries: [] });
    return;
  }
  if (!fs.statSync(targetResolved).isDirectory()) {
    writeJsonResponse(res, 400, { error: 'La ruta no es una carpeta.' });
    return;
  }

  const entries = fs
    .readdirSync(targetResolved, { withFileTypes: true })
    .map((dirent) => ({ name: dirent.name, isDirectory: dirent.isDirectory() }))
    .sort((a, b) => (a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name)));

  writeJsonResponse(res, 200, { basePath: baseResolved, currentPath: relPath, currentFullPath: targetResolved, entries });
}

async function handleCheckOperations(req, res, session) {
  const payload = await readJsonBody(req);
  const operations = (payload.operations || []).map((op) => ({
    cuit: String(op.cuit),
    numeroComprobante: String(op.numeroComprobante),
  }));
  const duplicates = await processedOperationsStore.findDuplicateOperations(rootDir, operations);
  if (duplicates.length > 0) {
    const detalle = duplicates.map((d) => `cuit='${d.cuit}' comprobante='${d.numeroComprobante}'`).join('; ');
    securityStore.writeSecurityLog(
      logsDir,
      `OPERACIONES DUPLICADAS DETECTADAS: ${duplicates.length} por '${session.username}' (bloqueadas, no se ejecutan) -> ${detalle}`
    );
  }
  writeJsonResponse(res, 200, { duplicates });
}

async function handleRegisterOperations(req, res, session) {
  const payload = await readJsonBody(req);
  const operations = (payload.operations || []).map((op) => ({
    cuit: String(op.cuit),
    numeroComprobante: String(op.numeroComprobante),
    idMensaje: String(op.idMensaje),
    cajaAhorro: op.cajaAhorro != null ? String(op.cajaAhorro) : '',
    importeNeto: op.importeNeto != null ? String(op.importeNeto) : '',
    fechaVencimiento: op.fechaVencimiento != null ? String(op.fechaVencimiento) : '',
    tipoCircuito: op.tipoCircuito != null ? String(op.tipoCircuito) : '',
    pfPagado: !!op.pfPagado,
    apellidoNombre: op.apellidoNombre != null ? String(op.apellidoNombre) : '',
    monto: op.monto != null ? String(op.monto) : '',
    plazo: op.plazo != null ? String(op.plazo) : '',
    operacion: op.operacion != null ? String(op.operacion) : '',
    tna: op.tna != null ? String(op.tna) : '',
  }));
  if (operations.length > 0) {
    await processedOperationsStore.addProcessedOperations(rootDir, operations, session.username);
    securityStore.writeSecurityLog(logsDir, `OPERACIONES REGISTRADAS: ${operations.length} por '${session.username}' (antiduplicado)`);
  }
  writeJsonResponse(res, 200, { ok: true, registered: operations.length });
}

// Antiduplicado de "Transferencia DEBIN - File" (mismo criterio que
// /api/check-operations para Plazo Fijo): pares (debitoCuit, idComprobante)
// que ya tienen una transferencia realizada en dbn_consulta.
async function handleCheckTransferencias(req, res, session) {
  const payload = await readJsonBody(req);
  const transferencias = (payload.transferencias || []).map((t) => ({
    debitoCuit: String(t.debitoCuit || '').trim(),
    idComprobante: String(t.idComprobante || '').trim(),
  }));
  const duplicates = await debinOutputStore.findTransferenciasRealizadas(rootDir, transferencias);
  if (duplicates.length > 0) {
    const detalle = duplicates.map((d) => `cuit='${d.debitoCuit}' comprobante='${d.idComprobante}'`).join('; ');
    securityStore.writeSecurityLog(
      logsDir,
      `TRANSFERENCIAS DUPLICADAS DETECTADAS: ${duplicates.length} por '${session.username}' (bloqueadas, no se ejecutan) -> ${detalle}`
    );
  }
  writeJsonResponse(res, 200, { duplicates });
}

// Registro en dbn_consulta de cada transferencia apenas se hace (o se
// rechaza), sin esperar al final del archivo — ver upsertDbnConsultaRecords.
async function handleDbnConsultaRowsPost(req, res, session) {
  const payload = await readJsonBody(req);
  const rows = Array.isArray(payload.rows) ? payload.rows.filter((r) => r && typeof r === 'object') : [];
  await debinOutputStore.upsertDbnConsultaRecords(rootDir, rows, session.username);
  writeJsonResponse(res, 200, { ok: true, registered: rows.length });
}

// La "fecha de hoy" para "Pago de Plazo Fijos" no es la fecha del sistema
// operativo del servidor: tiene que ser la fecha de PROCESO del banco
// (tabla tgl_fechaproceso en Sybase), que puede no coincidir con el
// calendario (ej. mientras no cerró el batch de fin de día). Se pide a los
// 3 sistemas relacionados (3 = Cuenta Corriente, 4 = Plazo Fijo, 5 = Caja
// de Ahorro) en la sucursal 1, estado 10 — si no están los 3 en ese estado,
// o sus fechas no coinciden entre sí, no hay una única fecha de proceso
// confiable todavía: se corta acá (mejor no mostrar nada que mostrar una
// lista de plazos fijos con la fecha equivocada). CONVERT(..., 103) fuerza
// dd/mm/yyyy sin hora, sea cual sea el dateformat/idioma de la sesión de
// Sybase — mismo formato en el que queda guardado fecha_vencimiento en
// operaciones_procesadas (ver formatDateOnlyDMY en dateUtil.js, que ya no
// se usa para esto: antes se tomaba la fecha del sistema operativo).
const FECHA_PROCESO_QUERY =
  'SELECT sistcod, CONVERT(CHAR(10), fecproceso, 103) AS fecproceso FROM tgl_fechaproceso WHERE sistcod IN (3, 4, 5) AND succod = 1 AND estado = 10';

async function getFechaProcesoBancaria(parametria) {
  const rows = await sybaseClient.querySybase(parametria.sybase, FECHA_PROCESO_QUERY);
  if (rows.length !== 3) {
    throw new Error(
      `tgl_fechaproceso no tiene los 3 sistemas (3, 4 y 5) en succod=1 y estado=10 en este momento (hay ${rows.length}).`
    );
  }
  const fechas = rows.map((row) => String(row.fecproceso || '').trim());
  const distintas = [...new Set(fechas)];
  if (distintas.length !== 1) {
    throw new Error(`Las fechas de proceso de los sistemas 3/4/5 no coinciden entre sí (${fechas.join(', ')}).`);
  }
  return distintas[0];
}

// Flow "Pago de Plazo Fijos": lista de candidatos a pagar hoy (fecha_vencimiento
// = fecha de proceso bancaria, tipo_circuito = '0', pf_pagado = 0 — ver
// findOperationsToPay). Mismo requisito que /api/run: un rol sin permiso para
// ejecutar flows tampoco puede ver ni disparar esta lista (aunque en sí misma
// es de solo lectura, es el primer paso de una corrida que va a mover dinero
// real).
async function handlePlazosFijosAPagarGet(res, session) {
  if (!securityStore.testRoleCanRunFlow(session.role)) {
    writeJsonResponse(res, 403, { error: `Tu rol ('${session.role}') no tiene permiso para ejecutar flows.` });
    return;
  }

  const parametria = await parametriaStore.getParametria(rootDir);
  let fechaProceso;
  try {
    fechaProceso = await getFechaProcesoBancaria(parametria);
  } catch (err) {
    writeJsonResponse(res, 400, { error: `No se pudo obtener la fecha de proceso de Sybase: ${err.message}` });
    return;
  }

  const operations = await processedOperationsStore.findOperationsToPay(rootDir, fechaProceso);
  // fechaProcesoISO (yyyy-MM-dd, igual formato que {{nowDate}}) es la que el
  // cliente manda de vuelta como input "fechaProceso" al correr cada fila del
  // flow — FechaMovimiento/FechaNegocio del débito y el crédito tienen que
  // ser la fecha de PROCESO bancaria, no la del reloj del servidor (ver
  // Flows/pago-plazo-fijos.json).
  writeJsonResponse(res, 200, { fechaProceso, fechaProcesoISO: convertDMYToISO(fechaProceso), operaciones: operations });
}

// Límite diario de transferencias por CUIT origen, moneda y destinatario
// (Parametría > debin.limiteDiarioArs/UsdMismoCuit/Terceros, ver
// fetchTransferenciasLimite en wwwroot/app.js): UNA sola consulta con
// todos los CUIT origen del archivo antes de procesar ninguna fila.
// "limites.ARS.mismo/terceros" (e ídem USD) salen null si el campo de
// Parametría de esa combinación está vacío o no es un número positivo —
// en ese caso el cliente no bloquea nada ahí, mismo comportamiento que
// antes de este feature. Mismo requisito de rol que
// /api/plazos-fijos-a-pagar: es de solo lectura, pero es el primer paso de
// una corrida que va a mover dinero real.
async function handleTransferenciasLimiteGet(parsedUrl, res, session) {
  if (!securityStore.testRoleCanRunFlow(session.role)) {
    writeJsonResponse(res, 403, { error: `Tu rol ('${session.role}') no tiene permiso para ejecutar flows.` });
    return;
  }

  const cuits = (parsedUrl.searchParams.get('cuits') || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  // 4 límites totalmente independientes (moneda × destinatario, ver
  // Parametría > "Límite diario de transferencias"): vacío/0/no numérico =
  // sin límite para esa combinación, no bloquea nada ahí.
  function limiteDe(raw) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const debin = (await parametriaStore.getParametria(rootDir)).debin || {};
  const limites = {
    ARS: { mismo: limiteDe(debin.limiteDiarioArsMismoCuit), terceros: limiteDe(debin.limiteDiarioArsTerceros) },
    USD: { mismo: limiteDe(debin.limiteDiarioUsdMismoCuit), terceros: limiteDe(debin.limiteDiarioUsdTerceros) },
  };

  const acumuladoMap = await debinOutputStore.getTransferidoHoyPorCuit(rootDir, cuits);
  const acumulado = {};
  for (const cuit of cuits) {
    acumulado[cuit] = {
      ARS: {
        mismo: acumuladoMap.get(debinOutputStore.transferidoHoyKey(cuit, 'ARS', 'mismo')) || 0,
        terceros: acumuladoMap.get(debinOutputStore.transferidoHoyKey(cuit, 'ARS', 'terceros')) || 0,
      },
      USD: {
        mismo: acumuladoMap.get(debinOutputStore.transferidoHoyKey(cuit, 'USD', 'mismo')) || 0,
        terceros: acumuladoMap.get(debinOutputStore.transferidoHoyKey(cuit, 'USD', 'terceros')) || 0,
      },
    };
  }

  writeJsonResponse(res, 200, { limites, acumulado });
}

// Se llama al final de una corrida de "Pago de Plazo Fijos", solo con las
// operaciones cuyo débito en Caja de Ahorro Y crédito en Cuenta Corriente
// salieron bien (ver runPagoPlazoFijos en wwwroot/app.js) — acá no se vuelve
// a validar eso, se confía en lo que mandó el cliente (los movimientos
// bancarios en sí ya se hicieron vía /api/run, que sí valida el rol).
async function handlePlazosFijosPagadosPost(req, res, session) {
  const payload = await readJsonBody(req);
  const operations = (payload.operations || []).map((op) => ({
    cuit: String(op.cuit),
    numeroComprobante: String(op.numeroComprobante),
    idMensaje: op.idMensaje != null ? String(op.idMensaje) : '',
  }));
  if (operations.length > 0) {
    await processedOperationsStore.markOperationsPaid(rootDir, operations, session.username);
    securityStore.writeSecurityLog(logsDir, `PLAZOS FIJOS MARCADOS COMO PAGADOS: ${operations.length} por '${session.username}'`);
  }
  writeJsonResponse(res, 200, { ok: true, marked: operations.length });
}

async function handleParametriaGet(res, session) {
  if (!securityStore.testRoleCanManageParametria(session.role)) {
    writeJsonResponse(res, 403, { error: 'No tenés permiso para ver la parametría.' });
    return;
  }
  const parametria = await parametriaStore.getParametria(rootDir);
  // La contraseña de Sybase nunca sale del servidor en texto plano, ni siquiera
  // hacia la propia UI: el formulario la deja en blanco y el POST conserva la
  // guardada si no se manda una nueva.
  if (parametria.sybase) parametria.sybase.password = '';
  writeJsonResponse(res, 200, parametria);
}

async function handleParametriaPost(req, res, session) {
  if (!securityStore.testRoleCanManageParametria(session.role)) {
    writeJsonResponse(res, 403, { error: 'No tenés permiso para editar la parametría.' });
    return;
  }
  const incoming = await readJsonBody(req);
  if (incoming.sybase && !incoming.sybase.password) {
    const existing = await parametriaStore.getParametria(rootDir);
    if (existing.sybase) {
      incoming.sybase.password = existing.sybase.password;
    }
  }
  await parametriaStore.saveParametria(rootDir, incoming);
  writeJsonResponse(res, 200, { ok: true });
}

async function handleTestSybase(req, res, session) {
  if (!securityStore.testRoleCanManageParametria(session.role)) {
    writeJsonResponse(res, 403, { error: 'No tenés permiso para probar la conexión de Sybase.' });
    return;
  }
  const payload = await readJsonBody(req);
  let password = String(payload.password || '');
  if (!password) {
    const existing = await parametriaStore.getParametria(rootDir);
    if (existing.sybase) password = String(existing.sybase.password || '');
  }
  const result = await flowEngine.testSybaseConnection(String(payload.connectionString || ''), String(payload.usuario || ''), password);
  writeJsonResponse(res, 200, result);
}

async function handleTestToken(req, res) {
  const payload = await readJsonBody(req);
  const profiles = await profileStore.getProfiles(rootDir);
  const selectedProfile = profiles.find((p) => p.name === payload.profileName) || null;

  if (!selectedProfile) {
    writeJsonResponse(res, 400, { ok: false, message: `Perfil '${payload.profileName}' no encontrado.` });
    return;
  }

  const result = await flowEngine.testTokenAcquisition(selectedProfile);
  writeJsonResponse(res, 200, result);
}

function serveStatic(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const fullWwwRoot = path.resolve(wwwRoot);
  const fullFilePath = path.resolve(path.join(wwwRoot, relative));
  const wwwRootPrefix = fullWwwRoot.endsWith(path.sep) ? fullWwwRoot : fullWwwRoot + path.sep;

  if (
    fullFilePath.toLowerCase().startsWith(wwwRootPrefix.toLowerCase()) &&
    fs.existsSync(fullFilePath) &&
    fs.statSync(fullFilePath).isFile()
  ) {
    writeFileResponse(res, fullFilePath, getContentType(path.extname(fullFilePath)));
  } else {
    res.statusCode = 404;
    res.end();
  }
}

// --- Dispatcher ---------------------------------------------------------------

async function handleRequest(req, res) {
  try {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const pathname = parsedUrl.pathname;
    const method = req.method;

    // Todo /api/* (salvo /api/login) requiere una sesión válida. Los archivos
    // estáticos siguen sin auth a propósito: si no, la pantalla de login no
    // tendría cómo cargar.
    const authRequired = pathname.startsWith('/api/') && pathname !== '/api/login';
    let session = null;
    if (authRequired) {
      session = await getAuthenticatedSession(req);
    }

    if (authRequired && !session) {
      writeJsonResponse(res, 401, { error: 'Sesión inválida o expirada. Iniciá sesión de nuevo.' });
      return;
    }

    if (method === 'POST' && pathname === '/api/login') return void (await handleLogin(req, res));
    if (method === 'POST' && pathname === '/api/logout') {
      securityStore.removeSession(getBearerToken(req));
      writeJsonResponse(res, 200, { ok: true });
      return;
    }
    if (method === 'GET' && pathname === '/api/me') {
      writeJsonResponse(res, 200, {
        username: session.username,
        role: session.role,
        displayName: session.displayName,
        canManageUsers: securityStore.testRoleCanManageUsers(session.role),
        canManageParametria: securityStore.testRoleCanManageParametria(session.role),
      });
      return;
    }
    if (method === 'GET' && pathname === '/api/users') {
      if (!securityStore.testRoleCanManageUsers(session.role)) {
        writeJsonResponse(res, 403, { error: 'No tenés permiso para administrar usuarios.' });
      } else {
        writeJsonResponse(res, 200, await securityStore.getSecurityUsers(rootDir));
      }
      return;
    }
    if (method === 'POST' && pathname === '/api/users') return void (await handleUsersPost(req, res, session));
    if (method === 'DELETE' && pathname === '/api/users') return void (await handleUsersDelete(parsedUrl, res, session));
    if (method === 'GET' && pathname === '/api/security-config') {
      if (!securityStore.testRoleCanManageUsers(session.role)) {
        writeJsonResponse(res, 403, { error: 'No tenés permiso para administrar usuarios.' });
      } else {
        writeJsonResponse(res, 200, { ad: await securityStore.getAdConfig(rootDir) });
      }
      return;
    }
    if (method === 'POST' && pathname === '/api/security-config') return void (await handleSecurityConfigPost(req, res, session));
    if (method === 'GET' && pathname === '/api/profiles') {
      writeJsonResponse(res, 200, (await profileStore.getProfiles(rootDir)).map(getMaskedProfile));
      return;
    }
    if (method === 'POST' && pathname === '/api/profiles') return void (await handleProfilesPost(req, res));
    if (method === 'DELETE' && pathname === '/api/profiles') return void (await handleProfilesDelete(parsedUrl, res));
    if (method === 'GET' && pathname === '/api/flows') return void handleFlowsGet(res);
    if (method === 'POST' && pathname === '/api/run') return void (await handleRun(req, res, session));
    if (method === 'POST' && pathname === '/api/save-output') return void (await handleSaveOutput(req, res, session));
    if (method === 'POST' && pathname === '/api/run-summary') return void (await handleRunSummaryPost(req, res, session));
    if (method === 'GET' && pathname === '/api/output-files') return void handleOutputFilesGet(res);
    if (method === 'GET' && pathname === '/api/dashboard') return void handleDashboardGet(parsedUrl, res);
    if (method === 'GET' && pathname === '/api/output-files/content') return void handleOutputFileContentGet(parsedUrl, res, session);
    if (method === 'GET' && pathname === '/api/conciliacion') return void (await handleConciliacionGet(parsedUrl, res, session));
    if (method === 'POST' && pathname === '/api/conciliacion/ibs') return void (await handleConciliacionIbsPost(req, res, session));
    if (method === 'GET' && pathname === '/api/http-logs/content') return void handleHttpLogContentGet(parsedUrl, res, session);
    if (method === 'GET' && pathname === '/api/certs-browse') return void handleCertsBrowseGet(parsedUrl, res, session);
    if (method === 'POST' && pathname === '/api/check-operations') return void (await handleCheckOperations(req, res, session));
    if (method === 'POST' && pathname === '/api/register-operations') return void (await handleRegisterOperations(req, res, session));
    if (method === 'POST' && pathname === '/api/check-transferencias') return void (await handleCheckTransferencias(req, res, session));
    if (method === 'POST' && pathname === '/api/dbn-consulta-rows') return void (await handleDbnConsultaRowsPost(req, res, session));
    if (method === 'GET' && pathname === '/api/plazos-fijos-a-pagar') return void (await handlePlazosFijosAPagarGet(res, session));
    if (method === 'GET' && pathname === '/api/transferencias-limite') return void (await handleTransferenciasLimiteGet(parsedUrl, res, session));
    if (method === 'POST' && pathname === '/api/plazos-fijos-pagados') return void (await handlePlazosFijosPagadosPost(req, res, session));
    if (method === 'GET' && pathname === '/api/parametria') return void (await handleParametriaGet(res, session));
    if (method === 'POST' && pathname === '/api/parametria') return void (await handleParametriaPost(req, res, session));
    if (method === 'POST' && pathname === '/api/test-sybase') return void (await handleTestSybase(req, res, session));
    if (method === 'POST' && pathname === '/api/test-token') return void (await handleTestToken(req, res));

    if (method === 'GET') {
      serveStatic(pathname, res);
      return;
    }

    res.statusCode = 404;
    res.end();
  } catch (err) {
    try {
      writeJsonResponse(res, 500, { error: err.message });
    } catch (innerErr) {
      // El cliente ya se había desconectado o la respuesta se cerró; no hay nada más para hacer.
    }
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`ApiCore (Node.js) corriendo en http://localhost:${port}/ (Ctrl+C para detener)`);
});
