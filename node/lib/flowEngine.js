'use strict';

// Ejecuta un flow: encadena requests HTTP sustituyendo variables ({{var}}) entre
// pasos. Port de modules/FlowEngine.psm1 — usa el fetch global de Node (18+) en
// vez de System.Net.Http.HttpClient. La conexión a Sybase para steps
// "type": "sql" vive en sybaseClient.js (ver el TODO ahí).

const fs = require('fs');
const path = require('path');
const { getJsonPathValue } = require('./jsonPath');
const { expandTemplate } = require('./variableSubstitution');
const { formatLocal, formatDateOnly, formatTimeOnly, formatCompact, formatCompactMillis } = require('./dateUtil');
const sybaseClient = require('./sybaseClient');

// Cache de tokens OAuth2 en memoria, vive mientras viva el proceso — mismo
// criterio que $Global:TokenCache del lado PowerShell.
const tokenCache = new Map();

function writeHttpLog(logsDir, fileName, content) {
  if (!logsDir) return;
  try {
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const filePath = path.join(logsDir, fileName);
    fs.appendFileSync(filePath, `${content}\n`, 'utf8');
  } catch (err) {
    // Un problema de logging (disco lleno, permisos) nunca debe romper la ejecución del flow.
  }
}

function getLoggableHeaderLines(headers, apiKeyHeaderName) {
  const lines = [];
  const apiKeyHeaderLower = apiKeyHeaderName ? String(apiKeyHeaderName).toLowerCase() : null;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'authorization' || (apiKeyHeaderLower && name.toLowerCase() === apiKeyHeaderLower)) {
      lines.push(`${name}: ***REDACTED***`);
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  return lines.join('\n');
}

function buildTokenRequestBody(contentType, params) {
  if (contentType.toLowerCase() === 'application/json') {
    return { body: JSON.stringify(params), contentType: 'application/json' };
  }
  if (contentType.toLowerCase() === 'application/x-www-form-urlencoded') {
    return { body: new URLSearchParams(params).toString(), contentType };
  }
  // Content-Type no reconocido: se manda como key=value&key2=value2 sin encodear, tal cual.
  const raw = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return { body: raw, contentType };
}

async function getOrRefreshAccessToken(profileObj) {
  const now = Date.now();
  const cached = tokenCache.get(profileObj.name);
  if (cached && cached.expiresAtMs > now) {
    return cached.accessToken;
  }

  const variables = {
    clientId: String(profileObj.clientId || ''),
    clientSecret: String(profileObj.clientSecret || ''),
  };

  const tokenMethod = profileObj.tokenMethod || 'POST';
  const tokenBodyContentType = profileObj.tokenBodyContentType || 'application/x-www-form-urlencoded';
  const accessTokenPath = profileObj.tokenAccessTokenPath || 'access_token';
  const expiresInPath = profileObj.tokenExpiresInPath || 'expires_in';

  // Parámetros del body del token request: por default, el client_credentials
  // clásico. Un perfil puede pisar "tokenParams" para agregar/renombrar campos,
  // con placeholders {{clientId}}/{{clientSecret}}.
  let tokenParams = {
    grant_type: 'client_credentials',
    client_id: '{{clientId}}',
    client_secret: '{{clientSecret}}',
  };
  if (profileObj.tokenParams && typeof profileObj.tokenParams === 'object') {
    tokenParams = {};
    for (const [key, value] of Object.entries(profileObj.tokenParams)) {
      tokenParams[key] = String(value);
    }
  }

  const resolvedParams = {};
  for (const [key, value] of Object.entries(tokenParams)) {
    resolvedParams[key] = expandTemplate(value, variables);
  }

  const { body, contentType } = buildTokenRequestBody(tokenBodyContentType, resolvedParams);
  const headers = { 'Content-Type': contentType };
  if (profileObj.tokenHeaders && typeof profileObj.tokenHeaders === 'object') {
    for (const [name, value] of Object.entries(profileObj.tokenHeaders)) {
      if (name.toLowerCase() === 'content-type') continue;
      headers[name] = expandTemplate(String(value), variables);
    }
  }

  const methodUpper = String(tokenMethod).toUpperCase();
  const bodyAllowed = methodUpper !== 'GET' && methodUpper !== 'HEAD';
  const fetchOptions = { method: tokenMethod, headers };
  if (bodyAllowed) fetchOptions.body = body;

  const response = await fetch(profileObj.tokenUrl, fetchOptions);
  const responseBody = await response.text();

  if (!response.ok) {
    throw new Error(`No se pudo obtener el token OAuth2 en '${profileObj.tokenUrl}' (HTTP ${response.status}): ${responseBody}`);
  }

  const tokenJson = JSON.parse(responseBody);
  const accessToken = getJsonPathValue(tokenJson, accessTokenPath);
  if (accessToken === null || accessToken === undefined || String(accessToken) === '') {
    throw new Error(`La respuesta del endpoint de token no contiene un valor en '${accessTokenPath}'.`);
  }

  const expiresInRaw = getJsonPathValue(tokenJson, expiresInPath);
  let expiresIn = 300;
  if (expiresInRaw !== null && expiresInRaw !== undefined && String(expiresInRaw) !== '') {
    const parsed = parseInt(String(expiresInRaw), 10);
    if (!Number.isNaN(parsed)) expiresIn = parsed;
  }

  tokenCache.set(profileObj.name, {
    accessToken: String(accessToken),
    expiresAtMs: now + Math.max(30, expiresIn - 30) * 1000,
  });

  return String(accessToken);
}

async function addAuthHeader(headers, profileObj) {
  const authType = String(profileObj.authType || '').trim();
  if (authType === 'ApiKey') {
    headers[String(profileObj.apiKeyHeaderName)] = String(profileObj.apiKeyOrToken);
  } else if (authType === 'Bearer') {
    headers.Authorization = `Bearer ${profileObj.apiKeyOrToken}`;
  } else if (authType === 'OAuth2ClientCredentials') {
    const token = await getOrRefreshAccessToken(profileObj);
    const headerName = profileObj.tokenAuthHeaderName || 'Authorization';
    const headerFormat = profileObj.tokenAuthHeaderFormat || 'Bearer {{token}}';
    headers[headerName] = expandTemplate(headerFormat, { token });
  }
  // default 'None': sin header de autenticación.
}

function getParametriaVariables(parametria) {
  const variables = {};
  if (!parametria) return variables;

  if (parametria.cuentaCorriente) {
    variables.ctaCteCodigoCuenta = String(parametria.cuentaCorriente.codigoCuenta || '');
    variables.ctaCteCodigoSistema = String(parametria.cuentaCorriente.codigoSistema || '');
    variables.ctaCteTransaccion = String(parametria.cuentaCorriente.transaccion || '');
  }
  if (parametria.cajaDeAhorro) {
    variables.cajaAhorroCodigoSistema = String(parametria.cajaDeAhorro.codigoSistema || '');
    variables.cajaAhorroTransaccion = String(parametria.cajaDeAhorro.transaccion || '');
  }
  if (parametria.plazoFijo) {
    variables.plazoFijoCodigoProducto = String(parametria.plazoFijo.codigoProducto || '');
    variables.plazoFijoCodigoMovimiento = String(parametria.plazoFijo.codigoMovimiento || '');
  }
  return variables;
}

// El usuario/contraseña de Sybase se resuelven acá, aparte de
// getParametriaVariables a propósito: si entraran al pool general de variables
// ({{sybaseUsuario}}/{{sybasePassword}}), un flow HTTP podría llegar a
// interpolarlos por error en un path/body/header y terminar logueando la
// contraseña en texto plano.
function getSybaseConnectionString(connectionStringTemplate, usuario, password) {
  if (!connectionStringTemplate || !connectionStringTemplate.trim()) {
    throw new Error('El connection string de Sybase está vacío en la Parametría.');
  }
  return expandTemplate(connectionStringTemplate, { usuario, password });
}

// Enmascara Pwd=.../Password=... para poder loguear el connection string sin
// exponer la contraseña real en logs/http.log.
function getRedactedSybaseConnectionString(connectionString) {
  if (!connectionString) return connectionString;
  return connectionString.replace(/(Pwd|Password)\s*=\s*[^;]*/gi, '$1=***REDACTED***');
}

async function testSybaseConnection(connectionStringTemplate, usuario, password) {
  const start = Date.now();
  try {
    getSybaseConnectionString(connectionStringTemplate, usuario, password);
  } catch (err) {
    return { ok: false, message: err.message, durationMs: Date.now() - start };
  }

  const result = await sybaseClient.testSybaseConnection({
    connectionString: connectionStringTemplate,
    usuario,
    password,
  });
  return { ok: result.ok, message: result.message, durationMs: Date.now() - start };
}

// Ejecuta un step de flow con "type": "sql". El resultado se envuelve como
// { "rows": [ {columna: valor, ...}, ... ] } y de ahí en más se trata
// exactamente igual que la respuesta JSON de un step HTTP: mismo mecanismo de
// extractVariables (getJsonPathValue, ej. "rows[0].saldo"), mismo límite de
// 200.000 caracteres para lo que se manda al navegador, mismo logs/http.log.
async function invokeSqlStep(step, flowObj, variables, parametria, logsDir, entry, stepStartedAt) {
  if (!parametria || !parametria.sybase) {
    throw new Error("No hay una conexión Sybase configurada en la Parametría (botón 'Parametría...' > Conexión Sybase).");
  }

  const queryText = expandTemplate(String(step.query || ''), variables);
  const connectionString = getSybaseConnectionString(
    String(parametria.sybase.connectionString || ''),
    String(parametria.sybase.usuario || ''),
    String(parametria.sybase.password || '')
  );
  const redactedConnectionString = getRedactedSybaseConnectionString(connectionString);

  entry.requestSummary = `SQL (Sybase): ${queryText}`;

  const requestLogText = [
    `>>> REQUEST [${formatLocal(new Date(), true)}] Flow=${flowObj.name} | Step=${step.name} (SQL)`,
    `ConnectionString: ${redactedConnectionString}`,
    'Query:',
    queryText,
    '---',
  ].join('\n');
  // Igual que en un step HTTP: se loguea antes de ejecutar la consulta, así queda
  // registrada aunque la conexión nunca llegue a abrirse.
  writeHttpLog(logsDir, 'http.log', requestLogText);

  const rows = await querySybaseRows(parametria.sybase, queryText);

  const responseBody = JSON.stringify({ rows }, null, 2);

  const responseLogText = [
    `<<< RESPONSE [${formatLocal(new Date(), true)}] Flow=${flowObj.name} | Step=${step.name} (SQL) | OK, ${rows.length} fila(s) (${Date.now() - stepStartedAt} ms)`,
    'Body:',
    responseBody,
    '---',
  ].join('\n');
  writeHttpLog(logsDir, 'http.log', responseLogText);

  entry.httpStatusCode = null;
  entry.responseSummary = responseBody.length > 200000 ? `${responseBody.slice(0, 200000)}...` : responseBody;

  if (step.extractVariables) {
    const responseJson = JSON.parse(responseBody);
    for (const [name, jsonPath] of Object.entries(step.extractVariables)) {
      const extracted = getJsonPathValue(responseJson, jsonPath);
      if (extracted !== null && extracted !== undefined) {
        variables[name] = String(extracted);
      }
    }
  }

  // requireVariables (opcional): nombres de variables que este step tiene que
  // haber dejado seteadas (vía extractVariables) para que el step cuente como
  // exitoso — ver el comentario largo en modules/FlowEngine.psm1 (misma lógica).
  if (step.requireVariables) {
    for (const requiredName of [].concat(step.requireVariables)) {
      const value = variables[requiredName];
      if (value === undefined || value === null || String(value) === '') {
        throw new Error(
          `El step SQL no encontró un valor para la variable requerida '${requiredName}' (columna vacía o ausente en el resultado de la consulta).`
        );
      }
    }
  }

  entry.status = 'Success';
}

async function querySybaseRows(parametriaSybase, queryText) {
  return sybaseClient.querySybase(parametriaSybase, queryText);
}

async function invokeHttpStep(step, flowObj, variables, profileObj, logsDir, entry, stepStartedAt) {
  const stepPath = expandTemplate(step.pathTemplate, variables);
  const baseUrl = String(profileObj.baseUrl || '').replace(/\/+$/, '');
  const relativePath = String(stepPath || '').replace(/^\/+/, '');
  const url = `${baseUrl}/${relativePath}`;

  const headers = {};
  await addAuthHeader(headers, profileObj);

  let contentTypeFromHeaders = null;
  if (step.headers && typeof step.headers === 'object') {
    for (const [name, value] of Object.entries(step.headers)) {
      if (name.toLowerCase() === 'content-type') {
        contentTypeFromHeaders = String(value);
        continue;
      }
      headers[name] = expandTemplate(String(value), variables);
    }
  }

  const method = String(step.method || 'GET').toUpperCase();
  // GET/HEAD nunca llevan body: fetch (Node) tira "Request with GET/HEAD method
  // cannot have body" si se le asigna body en esos métodos — mismo espíritu de
  // la restricción que tenía HttpClient en Windows PowerShell 5.1.
  const methodAllowsBody = method !== 'GET' && method !== 'HEAD';

  let bodyText = null;
  if (methodAllowsBody && step.bodyTemplate) {
    bodyText = expandTemplate(step.bodyTemplate, variables);
    let contentType = 'application/json';
    if (contentTypeFromHeaders) contentType = contentTypeFromHeaders;
    if (step.bodyContentType) contentType = String(step.bodyContentType);

    // omitIfNull (opcional, array de nombres de campo): ver el comentario largo
    // en modules/FlowEngine.psm1 (misma lógica) — borra del JSON ya armado
    // cualquier campo de la lista que haya quedado en null.
    if (step.omitIfNull && contentType.toLowerCase() === 'application/json') {
      try {
        const bodyJson = JSON.parse(bodyText);
        for (const propName of [].concat(step.omitIfNull)) {
          if (Object.prototype.hasOwnProperty.call(bodyJson, propName) && bodyJson[propName] === null) {
            delete bodyJson[propName];
          }
        }
        bodyText = JSON.stringify(bodyJson);
      } catch (err) {
        // El bodyTemplate no resultó en JSON parseable; se manda tal cual, sin
        // aplicar omitIfNull.
      }
    }

    headers['Content-Type'] = contentType;
  }

  entry.requestSummary = `${step.method} ${url}`;

  const requestHeaderLines = getLoggableHeaderLines(headers, profileObj.apiKeyHeaderName);
  const requestLogText = [
    `>>> REQUEST [${formatLocal(new Date(), true)}] Flow=${flowObj.name} | Step=${step.name}`,
    `${step.method} ${url}`,
    requestHeaderLines,
    'Body:',
    bodyText !== null ? bodyText : '(sin body)',
    '---',
  ].join('\n');
  // Se loguea antes de mandar el request: así queda un registro aunque la
  // respuesta nunca llegue (timeout, host inalcanzable, etc.).
  writeHttpLog(logsDir, 'http.log', requestLogText);

  const fetchOptions = { method, headers };
  if (bodyText !== null) fetchOptions.body = bodyText;

  const response = await fetch(url, fetchOptions);
  const responseBody = await response.text();

  const responseLogText = [
    `<<< RESPONSE [${formatLocal(new Date(), true)}] Flow=${flowObj.name} | Step=${step.name} | HTTP ${response.status} (${Date.now() - stepStartedAt} ms)`,
    'Body:',
    responseBody,
    '---',
  ].join('\n');
  writeHttpLog(logsDir, 'http.log', responseLogText);

  entry.httpStatusCode = response.status;
  // Se manda al navegador casi entera (hasta 200.000 caracteres) — ver
  // modules/FlowEngine.psm1 para el detalle de por qué. logs/http.log siempre
  // guarda el body entero.
  entry.responseSummary = responseBody.length > 200000 ? `${responseBody.slice(0, 200000)}...` : responseBody;

  const expectedStatus = step.expectedStatusCode ? Number(step.expectedStatusCode) : 200;

  if (response.status !== expectedStatus) {
    entry.status = 'Error';
    entry.errorMessage = `Se esperaba HTTP ${expectedStatus} y se recibió HTTP ${response.status}.`;
    return;
  }

  if (step.extractVariables && responseBody.trim()) {
    try {
      const responseJson = JSON.parse(responseBody);
      for (const [name, jsonPath] of Object.entries(step.extractVariables)) {
        const extracted = getJsonPathValue(responseJson, jsonPath);
        if (extracted !== null && extracted !== undefined) {
          variables[name] = String(extracted);
        }
      }
    } catch (err) {
      // La respuesta no era JSON parseable; se ignora la extracción de variables.
    }
  }

  entry.status = 'Success';
}

async function invokeFlow(profileObj, flowObj, inputValues, logsDir, parametria) {
  const now = new Date();
  // Variables de sistema disponibles en cualquier flow (ej. {{nowDate}} para una
  // FechaMovimiento/FechaNegocio que no debe pedirse al usuario), seguidas de los
  // valores de parametría. Un input del usuario con el mismo nombre pisa a ambos.
  const variables = {
    nowDate: formatDateOnly(now),
    nowDateTime: formatLocal(now),
    nowTime: formatTimeOnly(now),
    nowCompact: formatCompact(now),
    idMensajeGenerado: `PFC${formatCompactMillis(now)}`,
  };
  Object.assign(variables, getParametriaVariables(parametria));
  Object.assign(variables, inputValues);

  const log = [];

  for (const step of flowObj.steps || []) {
    const entry = {
      name: step.name,
      status: 'Running',
      requestSummary: null,
      responseSummary: null,
      httpStatusCode: null,
      durationMs: 0,
      errorMessage: null,
    };

    const stepStartedAt = Date.now();
    try {
      if (String(step.type || '').trim().toLowerCase() === 'sql') {
        await invokeSqlStep(step, flowObj, variables, parametria, logsDir, entry, stepStartedAt);
      } else {
        await invokeHttpStep(step, flowObj, variables, profileObj, logsDir, entry, stepStartedAt);
      }
    } catch (err) {
      entry.status = 'Error';
      entry.errorMessage = err.message;
    } finally {
      entry.durationMs = Date.now() - stepStartedAt;
    }

    log.push(entry);
    if (entry.status === 'Error') break;
  }

  return log;
}

async function testTokenAcquisition(profileObj) {
  if (String(profileObj.authType || '').trim() !== 'OAuth2ClientCredentials') {
    return {
      ok: false,
      message: `El perfil '${profileObj.name}' no usa OAuth2ClientCredentials (authType actual: '${profileObj.authType}').`,
    };
  }

  // Ignora cualquier token cacheado: esto siempre prueba la obtención real, no un valor viejo.
  tokenCache.delete(profileObj.name);

  const start = Date.now();
  try {
    const token = await getOrRefreshAccessToken(profileObj);
    const durationMs = Date.now() - start;
    const preview = token.length > 10 ? `${token.slice(0, 6)}...${token.slice(-4)}` : token;
    const cached = tokenCache.get(profileObj.name);
    const expiresAtUtc = cached ? new Date(cached.expiresAtMs).toISOString() : null;

    return {
      ok: true,
      message: `Token obtenido correctamente en ${durationMs} ms.`,
      tokenPreview: preview,
      expiresAtUtc,
      durationMs,
    };
  } catch (err) {
    return { ok: false, message: err.message, durationMs: Date.now() - start };
  }
}

module.exports = { invokeFlow, testTokenAcquisition, testSybaseConnection };
