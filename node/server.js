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
// runId (ver generateRunId en flowEngine.js), así que alcanza con mirar si
// existen files/<runId>.csv y files/<runId>-error.csv — sin necesitar
// parsear nada. El resumen que /api/run-summary anexa al log (ver
// appendRunSummary/parseRunSummary) solo se usa para enriquecer la fila con
// quién la corrió, qué flow fue y los pasos ok/error — si un log no tiene
// resumen (corrida de antes de este feature, o un CSV que se cortó antes de
// terminar), la fila sale igual, con esos campos en null pero los archivos
// (si existen) siguen siendo descargables.
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

      const okFileName = `${runId}.csv`;
      const errorFileName = `${runId}-error.csv`;

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
  }));
  if (operations.length > 0) {
    await processedOperationsStore.addProcessedOperations(rootDir, operations, session.username);
    securityStore.writeSecurityLog(logsDir, `OPERACIONES REGISTRADAS: ${operations.length} por '${session.username}' (antiduplicado)`);
  }
  writeJsonResponse(res, 200, { ok: true, registered: operations.length });
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
    if (method === 'GET' && pathname === '/api/output-files/content') return void handleOutputFileContentGet(parsedUrl, res, session);
    if (method === 'GET' && pathname === '/api/http-logs/content') return void handleHttpLogContentGet(parsedUrl, res, session);
    if (method === 'GET' && pathname === '/api/certs-browse') return void handleCertsBrowseGet(parsedUrl, res, session);
    if (method === 'POST' && pathname === '/api/check-operations') return void (await handleCheckOperations(req, res, session));
    if (method === 'POST' && pathname === '/api/register-operations') return void (await handleRegisterOperations(req, res, session));
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
