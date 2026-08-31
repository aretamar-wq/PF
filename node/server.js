#!/usr/bin/env node
'use strict';

// BankCoreFlowRunner — backend Node.js (alternativa a server.ps1/PowerShell,
// pensada para deployments Linux que prefieren no instalar pwsh). Sirve la
// MISMA wwwroot/ y expone exactamente las mismas rutas /api/* con el mismo
// contrato JSON que server.ps1 — el frontend (wwwroot/app.js) no sabe ni le
// importa cuál de los dos backends tiene enfrente. Comparte también Flows/ y
// los *.local.json de la raíz del repo: es un runtime alternativo, no una
// copia con datos propios.
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
    authType: profileObj.authType,
    apiKeyHeaderName: profileObj.apiKeyHeaderName,
    hasApiKeyOrToken: !!profileObj.apiKeyOrToken,
    tokenUrl: profileObj.tokenUrl,
    clientId: profileObj.clientId,
    hasClientSecret: !!profileObj.clientSecret,
  };
}

// A diferencia de solo mirar el token, esto vuelve a chequear contra
// security.local.json en cada request (no confía en el rol cacheado al hacer
// login): si un admin deshabilita o elimina a un usuario, o le cambia el rol,
// eso tiene efecto inmediato en la próxima request de esa sesión.
function getAuthenticatedSession(req) {
  const token = getBearerToken(req);
  const session = securityStore.getSessionUser(token);
  if (!session) return null;

  const currentUser = securityStore.findSecurityUser(rootDir, session.username);
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

  const security = securityStore.getSecurity(rootDir);
  const users = security.users || [];
  const localUser = users.find((u) => String(u.username).toLowerCase() === username.toLowerCase()) || null;

  // Bootstrap: si todavía no hay ningún usuario configurado localmente, el
  // primer login exitoso contra AD se auto-promueve a admin.
  const isBootstrap = users.length === 0;

  if (!isBootstrap && (!localUser || !localUser.enabled)) {
    securityStore.writeSecurityLog(logsDir, `LOGIN DENEGADO usuario='${username}' (no habilitado en la app) desde ${clientAddress}`);
    writeJsonResponse(res, 401, { error: 'Usuario no habilitado en esta aplicación. Pedile a un administrador que te dé de alta.' });
    return;
  }

  const adResult = await securityStore.testAdCredentials(security.ad, username, password);
  if (!adResult.ok) {
    securityStore.writeSecurityLog(logsDir, `LOGIN FALLIDO usuario='${username}' desde ${clientAddress} (${adResult.message})`);
    writeJsonResponse(res, 401, { error: adResult.message });
    return;
  }

  let effectiveUser = localUser;
  if (isBootstrap) {
    securityStore.addOrUpdateSecurityUser(rootDir, username, 'admin', true, '');
    effectiveUser = securityStore.findSecurityUser(rootDir, username);
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
  if (!targetEnabled && securityStore.testIsLastEnabledAdmin(rootDir, targetUsername)) {
    writeJsonResponse(res, 400, { error: 'No se puede deshabilitar al último administrador habilitado.' });
    return;
  }
  if (targetRole !== 'admin' && securityStore.testIsLastEnabledAdmin(rootDir, targetUsername)) {
    writeJsonResponse(res, 400, { error: 'No se puede sacarle el rol de administrador al último administrador habilitado.' });
    return;
  }

  securityStore.addOrUpdateSecurityUser(rootDir, targetUsername, targetRole, targetEnabled, String(incoming.displayName || ''));
  securityStore.writeSecurityLog(
    logsDir,
    `USUARIO '${targetUsername}' (rol='${targetRole}', habilitado=${targetEnabled}) dado de alta/editado por '${session.username}'`
  );
  writeJsonResponse(res, 200, { ok: true });
}

function handleUsersDelete(parsedUrl, res, session) {
  if (!securityStore.testRoleCanManageUsers(session.role)) {
    writeJsonResponse(res, 403, { error: 'No tenés permiso para administrar usuarios.' });
    return;
  }
  const targetUsername = parsedUrl.searchParams.get('username') || '';
  if (securityStore.testIsLastEnabledAdmin(rootDir, targetUsername)) {
    writeJsonResponse(res, 400, { error: 'No se puede eliminar al último administrador habilitado.' });
    return;
  }
  securityStore.removeSecurityUser(rootDir, targetUsername);
  securityStore.writeSecurityLog(logsDir, `USUARIO '${targetUsername}' eliminado por '${session.username}'`);
  writeJsonResponse(res, 200, { ok: true });
}

async function handleSecurityConfigPost(req, res, session) {
  if (!securityStore.testRoleCanManageUsers(session.role)) {
    writeJsonResponse(res, 403, { error: 'No tenés permiso para administrar usuarios.' });
    return;
  }
  const incoming = await readJsonBody(req);
  const security = securityStore.getSecurity(rootDir);
  security.ad = {
    server: String(incoming.server || ''),
    port: parseInt(incoming.port, 10) || 0,
    useSsl: !!incoming.useSsl,
    domain: String(incoming.domain || ''),
  };
  securityStore.saveSecurity(rootDir, security);
  securityStore.writeSecurityLog(
    logsDir,
    `CONFIG AD actualizada por '${session.username}' (server='${security.ad.server}', domain='${security.ad.domain}')`
  );
  writeJsonResponse(res, 200, { ok: true });
}

async function handleProfilesPost(req, res) {
  const incoming = await readJsonBody(req);
  const profiles = profileStore.getProfiles(rootDir);
  const existingIndex = profiles.findIndex((p) => p.name === incoming.name);

  const updated = {
    name: incoming.name,
    baseUrl: incoming.baseUrl,
    authType: incoming.authType,
    apiKeyHeaderName: incoming.apiKeyHeaderName,
    apiKeyOrToken: incoming.apiKeyOrToken,
    tokenUrl: incoming.tokenUrl,
    clientId: incoming.clientId,
    clientSecret: incoming.clientSecret,
  };

  if (existingIndex >= 0) {
    // Si el form no mandó un secreto nuevo, conservar el que ya había guardado.
    if (!updated.apiKeyOrToken) updated.apiKeyOrToken = profiles[existingIndex].apiKeyOrToken;
    if (!updated.clientSecret) updated.clientSecret = profiles[existingIndex].clientSecret;
    profiles[existingIndex] = updated;
  } else {
    profiles.push(updated);
  }

  profileStore.saveProfiles(rootDir, profiles);
  writeJsonResponse(res, 200, { ok: true });
}

function handleProfilesDelete(parsedUrl, res) {
  const name = parsedUrl.searchParams.get('name') || '';
  const profiles = profileStore.getProfiles(rootDir).filter((p) => p.name !== name);
  profileStore.saveProfiles(rootDir, profiles);
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
    steps: (f.steps || []).map((s) => ({ name: s.name, type: s.type || null })),
  }));
  writeJsonResponse(res, 200, summary);
}

async function handleRun(req, res, session) {
  const payload = await readJsonBody(req);

  const profiles = profileStore.getProfiles(rootDir);
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

  const parametria = parametriaStore.getParametria(rootDir);
  const log = await flowEngine.invokeFlow(selectedProfile, selectedFlow, inputValues, logsDir, parametria);

  // Una entrada por cada corrida de /api/run (para un flow CSV, una por fila del
  // archivo) — nunca incluye inputs ni la respuesta (pueden traer datos
  // bancarios reales). El detalle completo sigue en logs/http.log.
  const okSteps = log.filter((e) => e.status === 'Success').length;
  const errorSteps = log.filter((e) => e.status !== 'Success').length;
  securityStore.writeSecurityLog(
    logsDir,
    `EJECUCIÓN flow='${selectedFlow.name}' perfil='${selectedProfile.name}' usuario='${session.username}' rol='${session.role}' pasos_ok=${okSteps} pasos_error=${errorSteps}`
  );

  writeJsonResponse(res, 200, log);
}

async function handleSaveOutput(req, res, session) {
  // $prefix/$timestamp los arma el cliente, pero se validan acá con formato
  // estricto: es la única defensa contra path traversal en un endpoint que
  // escribe archivos a partir de input del cliente.
  const payload = await readJsonBody(req);
  const prefix = String(payload.prefix || '');
  const timestamp = String(payload.timestamp || '');
  const content = String(payload.content || '');

  if (!/^[a-zA-Z0-9-]{1,40}$/.test(prefix)) {
    writeJsonResponse(res, 400, { error: 'Prefijo de archivo inválido.' });
    return;
  }
  if (!/^\d{14}$/.test(timestamp)) {
    writeJsonResponse(res, 400, { error: 'Timestamp inválido (se espera yyyyMMddHHmmss).' });
    return;
  }

  if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
  const fileName = `${prefix}${timestamp}.csv`;
  const filePath = path.join(filesDir, fileName);
  fs.writeFileSync(filePath, content, 'utf8');
  securityStore.writeSecurityLog(logsDir, `ARCHIVO DE SALIDA '${fileName}' guardado por '${session.username}'`);
  writeJsonResponse(res, 200, { ok: true, fileName });
}

async function handleCheckOperations(req, res, session) {
  const payload = await readJsonBody(req);
  const operations = (payload.operations || []).map((op) => ({
    cuit: String(op.cuit),
    numeroComprobante: String(op.numeroComprobante),
  }));
  const duplicates = processedOperationsStore.findDuplicateOperations(rootDir, operations);
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
    processedOperationsStore.addProcessedOperations(rootDir, operations, session.username);
    securityStore.writeSecurityLog(logsDir, `OPERACIONES REGISTRADAS: ${operations.length} por '${session.username}' (antiduplicado)`);
  }
  writeJsonResponse(res, 200, { ok: true, registered: operations.length });
}

function handleParametriaGet(res) {
  const parametria = parametriaStore.getParametria(rootDir);
  // La contraseña de Sybase nunca sale del servidor en texto plano, ni siquiera
  // hacia la propia UI: el formulario la deja en blanco y el POST conserva la
  // guardada si no se manda una nueva.
  if (parametria.sybase) parametria.sybase.password = '';
  writeJsonResponse(res, 200, parametria);
}

async function handleParametriaPost(req, res) {
  const incoming = await readJsonBody(req);
  if (incoming.sybase && !incoming.sybase.password) {
    const existing = parametriaStore.getParametria(rootDir);
    if (existing.sybase) {
      incoming.sybase.password = existing.sybase.password;
    }
  }
  parametriaStore.saveParametria(rootDir, incoming);
  writeJsonResponse(res, 200, { ok: true });
}

async function handleTestSybase(req, res) {
  const payload = await readJsonBody(req);
  let password = String(payload.password || '');
  if (!password) {
    const existing = parametriaStore.getParametria(rootDir);
    if (existing.sybase) password = String(existing.sybase.password || '');
  }
  const result = await flowEngine.testSybaseConnection(String(payload.connectionString || ''), String(payload.usuario || ''), password);
  writeJsonResponse(res, 200, result);
}

async function handleTestToken(req, res) {
  const payload = await readJsonBody(req);
  const profiles = profileStore.getProfiles(rootDir);
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
      session = getAuthenticatedSession(req);
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
      });
      return;
    }
    if (method === 'GET' && pathname === '/api/users') {
      if (!securityStore.testRoleCanManageUsers(session.role)) {
        writeJsonResponse(res, 403, { error: 'No tenés permiso para administrar usuarios.' });
      } else {
        writeJsonResponse(res, 200, securityStore.getSecurityUsers(rootDir));
      }
      return;
    }
    if (method === 'POST' && pathname === '/api/users') return void (await handleUsersPost(req, res, session));
    if (method === 'DELETE' && pathname === '/api/users') return void handleUsersDelete(parsedUrl, res, session);
    if (method === 'GET' && pathname === '/api/security-config') {
      if (!securityStore.testRoleCanManageUsers(session.role)) {
        writeJsonResponse(res, 403, { error: 'No tenés permiso para administrar usuarios.' });
      } else {
        writeJsonResponse(res, 200, { ad: securityStore.getSecurity(rootDir).ad });
      }
      return;
    }
    if (method === 'POST' && pathname === '/api/security-config') return void (await handleSecurityConfigPost(req, res, session));
    if (method === 'GET' && pathname === '/api/profiles') {
      writeJsonResponse(res, 200, profileStore.getProfiles(rootDir).map(getMaskedProfile));
      return;
    }
    if (method === 'POST' && pathname === '/api/profiles') return void (await handleProfilesPost(req, res));
    if (method === 'DELETE' && pathname === '/api/profiles') return void handleProfilesDelete(parsedUrl, res);
    if (method === 'GET' && pathname === '/api/flows') return void handleFlowsGet(res);
    if (method === 'POST' && pathname === '/api/run') return void (await handleRun(req, res, session));
    if (method === 'POST' && pathname === '/api/save-output') return void (await handleSaveOutput(req, res, session));
    if (method === 'POST' && pathname === '/api/check-operations') return void (await handleCheckOperations(req, res, session));
    if (method === 'POST' && pathname === '/api/register-operations') return void (await handleRegisterOperations(req, res, session));
    if (method === 'GET' && pathname === '/api/parametria') return void handleParametriaGet(res);
    if (method === 'POST' && pathname === '/api/parametria') return void (await handleParametriaPost(req, res));
    if (method === 'POST' && pathname === '/api/test-sybase') return void (await handleTestSybase(req, res));
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
  console.log(`BankCoreFlowRunner (Node.js) corriendo en http://localhost:${port}/ (Ctrl+C para detener)`);
});
