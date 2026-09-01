'use strict';

// Login contra Active Directory (la contraseña nunca se guarda, solo se usa un
// instante para el bind LDAP), administración local de usuarios habilitados + su
// rol, sesiones en memoria (tokens Bearer) y auditoría en logs/security.log. Port
// de modules/SecurityStore.psm1 — lee/escribe el mismo security.local.json que el
// backend PowerShell (nunca versionado, ver .gitignore).
//
// El bind LDAP usa el paquete "ldapjs" (LDAP puro, sin dependencias nativas) —
// mismo enfoque conceptual que System.DirectoryServices.Protocols del lado
// PowerShell: autentica directo contra el Domain Controller sin pasar por ADSI.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client: LdapClient } = require('ldapts');
const { formatLocal } = require('./dateUtil');

const VALID_ROLES = ['admin', 'operador', 'lectura'];

function getDefaultSecurity() {
  return { ad: { server: '', port: 389, useSsl: false, domain: '' }, users: [] };
}

function getSecurityFilePath(rootDir) {
  return path.join(rootDir, 'security.local.json');
}

function getSecurity(rootDir) {
  const filePath = getSecurityFilePath(rootDir);
  if (!fs.existsSync(filePath)) return getDefaultSecurity();

  const json = fs.readFileSync(filePath, 'utf8');
  if (!json.trim()) return getDefaultSecurity();

  const parsed = JSON.parse(json);
  if (parsed === null || parsed === undefined) return getDefaultSecurity();
  if (!parsed.ad) parsed.ad = getDefaultSecurity().ad;
  if (!Array.isArray(parsed.users)) parsed.users = parsed.users ? [parsed.users] : [];
  return parsed;
}

function saveSecurity(rootDir, security) {
  const filePath = getSecurityFilePath(rootDir);
  fs.writeFileSync(filePath, JSON.stringify(security, null, 2), 'utf8');
}

// --- Autenticación contra Active Directory ----------------------------------

async function testAdCredentials(adConfig, username, password) {
  const server = adConfig && adConfig.server ? String(adConfig.server) : '';
  if (!server.trim()) {
    return { ok: false, message: 'No hay un servidor de Active Directory configurado (ver Parametría de seguridad).' };
  }

  const port = adConfig.port ? Number(adConfig.port) : 389;
  const scheme = adConfig.useSsl ? 'ldaps' : 'ldap';
  const url = `${scheme}://${server}:${port}`;

  let upn = username;
  if (!username.includes('@') && !username.includes('\\') && adConfig.domain) {
    upn = `${username}@${adConfig.domain}`;
  }

  const client = new LdapClient({ url, timeout: 10000, connectTimeout: 10000 });

  try {
    // Bind "simple" (usuario/contraseña en texto plano dentro del request LDAP) —
    // por eso useSsl debería estar prendido en producción (LDAPS), igual que en
    // el backend PowerShell. La contraseña solo vive en esta función durante el
    // bind puntual y se descarta enseguida (nunca se persiste).
    await client.bind(upn, password);
    return { ok: true, message: 'OK' };
  } catch (err) {
    if (err.name === 'InvalidCredentialsError') {
      return { ok: false, message: 'Usuario o contraseña inválidos en Active Directory.' };
    }
    return { ok: false, message: `No se pudo validar contra Active Directory: ${err.message}` };
  } finally {
    try {
      await client.unbind();
    } catch (err) {
      // El cliente ya podía estar en un estado inválido tras el error de bind.
    }
  }
}

// --- Roles -------------------------------------------------------------------

function getValidRoles() {
  return [...VALID_ROLES];
}

function testRoleCanManageUsers(role) {
  return role === 'admin';
}

// Parametría trae valores de cuenta y, sobre todo, la contraseña de Sybase
// (aunque nunca se manda de vuelta al navegador, sí se puede pisar) — mismo
// criterio que testRoleCanManageUsers: solo admin. 'operador' puede correr
// flows y probar el token OAuth2 del perfil elegido, pero no ver ni tocar
// Parametría (ni siquiera "Probar conexión" de Sybase).
function testRoleCanManageParametria(role) {
  return role === 'admin';
}

function testRoleCanRunFlow(role) {
  // 'lectura' es solo consulta: puede ver flows/perfiles/logs pero no ejecutar
  // nada. admin/operador pueden correr cualquier flow.
  return role === 'admin' || role === 'operador';
}

// --- Usuarios locales ----------------------------------------------------------

function getSecurityUsers(rootDir) {
  return getSecurity(rootDir).users || [];
}

function findSecurityUser(rootDir, username) {
  const target = username.toLowerCase();
  return getSecurityUsers(rootDir).find((u) => String(u.username).toLowerCase() === target) || null;
}

function testIsLastEnabledAdmin(rootDir, username) {
  const target = username.toLowerCase();
  const users = getSecurityUsers(rootDir);
  const otherEnabledAdmins = users.filter(
    (u) => String(u.username).toLowerCase() !== target && u.role === 'admin' && u.enabled
  );
  const targetUser = users.find((u) => String(u.username).toLowerCase() === target);
  return !!(targetUser && targetUser.role === 'admin' && targetUser.enabled && otherEnabledAdmins.length === 0);
}

function addOrUpdateSecurityUser(rootDir, username, role, enabled, displayName) {
  if (!VALID_ROLES.includes(role)) {
    throw new Error(`Rol inválido: '${role}'. Roles válidos: ${VALID_ROLES.join(', ')}.`);
  }

  const security = getSecurity(rootDir);
  const users = security.users || [];
  const target = username.toLowerCase();
  const existingIndex = users.findIndex((u) => String(u.username).toLowerCase() === target);

  const record = { username, role, enabled: !!enabled, displayName: displayName || '' };
  if (existingIndex >= 0) {
    users[existingIndex] = record;
  } else {
    users.push(record);
  }

  security.users = users;
  saveSecurity(rootDir, security);
}

function removeSecurityUser(rootDir, username) {
  const target = username.toLowerCase();
  const security = getSecurity(rootDir);
  security.users = (security.users || []).filter((u) => String(u.username).toLowerCase() !== target);
  saveSecurity(rootDir, security);
}

// --- Sesiones (tokens Bearer en memoria, se pierden al reiniciar el proceso,
// mismo criterio que el cache de token OAuth2 en flowEngine.js) ----------------

const sessions = new Map();

function newSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function newSession(username, role, displayName, lifetimeHours = 8) {
  const token = newSessionToken();
  sessions.set(token, {
    username,
    role,
    displayName: displayName || '',
    expiresAtUtc: Date.now() + lifetimeHours * 3600 * 1000,
  });
  return token;
}

function getSessionUser(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAtUtc) {
    sessions.delete(token);
    return null;
  }
  return { ...session };
}

function removeSession(token) {
  if (token) sessions.delete(token);
}

// --- Auditoría -----------------------------------------------------------------

function writeSecurityLog(logsDir, message) {
  try {
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const filePath = path.join(logsDir, 'security.log');
    fs.appendFileSync(filePath, `[${formatLocal()}] ${message}\n`, 'utf8');
  } catch (err) {
    // Igual que Write-HttpLog en flowEngine.js: un problema de logging nunca debe
    // romper el login ni la gestión de usuarios.
  }
}

module.exports = {
  getDefaultSecurity,
  getSecurityFilePath,
  getSecurity,
  saveSecurity,
  testAdCredentials,
  getValidRoles,
  testRoleCanManageUsers,
  testRoleCanManageParametria,
  testRoleCanRunFlow,
  getSecurityUsers,
  findSecurityUser,
  testIsLastEnabledAdmin,
  addOrUpdateSecurityUser,
  removeSecurityUser,
  newSession,
  getSessionUser,
  removeSession,
  writeSecurityLog,
};
