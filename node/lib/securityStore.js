'use strict';

// Login contra Active Directory (la contraseña nunca se guarda, solo se usa un
// instante para el bind LDAP), administración de usuarios habilitados + su rol
// y auditoría en logs/security.log. A diferencia del resto de este archivo,
// las sesiones (tokens Bearer) siguen en memoria (nunca se persisten, ni en
// disco ni en la base — se pierden al reiniciar el proceso, a propósito).
//
// Usuarios/roles y la configuración de AD viven en MariaDB (tablas usuarios,
// rol, rol_usuarios, configuracion_ad — ver deploy/mariadb-schema.sql y "Base
// de datos (MariaDB)" en el README), no en security.local.json — ese archivo
// se dejó de usar (ver node/scripts/migrate-json-to-mariadb.js para migrar
// los datos que hubiera).
//
// rol_usuarios es una relación usuarios<->rol modelada con tabla intermedia,
// pero usuario_id es su PRIMARY KEY: fuerza como máximo una fila por usuario,
// o sea un solo rol por usuario — mismo comportamiento que antes (un rol
// plano por usuario), solo que mejor normalizado en la base.
//
// El bind LDAP usa el paquete "ldapts" (LDAP puro, sin dependencias nativas) —
// mismo enfoque conceptual que System.DirectoryServices.Protocols del lado
// PowerShell: autentica directo contra el Domain Controller sin pasar por ADSI.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client: LdapClient } = require('ldapts');
const { formatLocal } = require('./dateUtil');
const db = require('./mariadbClient');

const VALID_ROLES = ['admin', 'operador', 'lectura'];

// --- Configuración de Active Directory ----------------------------------------

async function getAdConfig(rootDir) {
  const rows = await db.query(rootDir, 'SELECT server, port, use_ssl, domain FROM configuracion_ad WHERE id = 1');
  if (rows.length === 0) return { server: '', port: 389, useSsl: false, domain: '' };
  const row = rows[0];
  return { server: row.server, port: row.port, useSsl: !!row.use_ssl, domain: row.domain };
}

async function saveAdConfig(rootDir, adConfig) {
  await db.query(
    rootDir,
    `INSERT INTO configuracion_ad (id, server, port, use_ssl, domain) VALUES (1, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE server = VALUES(server), port = VALUES(port), use_ssl = VALUES(use_ssl), domain = VALUES(domain)`,
    [String(adConfig.server || ''), adConfig.port ? Number(adConfig.port) : 389, adConfig.useSsl ? 1 : 0, String(adConfig.domain || '')]
  );
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

// --- Roles ---------------------------------------------------------------------
// Estas 3 son funciones puras sobre un role string ya conocido (no tocan la
// base) — siguen siendo síncronas a propósito, para no tener que acordarse de
// poner "await" en cada chequeo de permisos (un "await" salteado en un chequeo
// de rol sería un agujero de seguridad silencioso).

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

// --- Usuarios --------------------------------------------------------------

function mapUserRow(row) {
  return {
    username: row.username,
    role: row.role,
    enabled: !!row.enabled,
    displayName: row.display_name || '',
  };
}

const USER_SELECT_SQL = `
  SELECT u.username, u.display_name, u.enabled, r.nombre AS role
  FROM usuarios u
  LEFT JOIN rol_usuarios ru ON ru.usuario_id = u.id
  LEFT JOIN rol r ON r.id = ru.rol_id
`;

async function getSecurityUsers(rootDir) {
  const rows = await db.query(rootDir, `${USER_SELECT_SQL} ORDER BY u.username`);
  return rows.map(mapUserRow);
}

async function findSecurityUser(rootDir, username) {
  const rows = await db.query(rootDir, `${USER_SELECT_SQL} WHERE LOWER(u.username) = LOWER(?)`, [username]);
  return rows.length > 0 ? mapUserRow(rows[0]) : null;
}

async function testIsLastEnabledAdmin(rootDir, username) {
  const targetUser = await findSecurityUser(rootDir, username);
  if (!targetUser || targetUser.role !== 'admin' || !targetUser.enabled) return false;

  const rows = await db.query(
    rootDir,
    `SELECT COUNT(*) AS total
     FROM usuarios u
     JOIN rol_usuarios ru ON ru.usuario_id = u.id
     JOIN rol r ON r.id = ru.rol_id
     WHERE r.nombre = 'admin' AND u.enabled = 1 AND LOWER(u.username) <> LOWER(?)`,
    [username]
  );
  return Number(rows[0].total) === 0;
}

async function addOrUpdateSecurityUser(rootDir, username, role, enabled, displayName) {
  if (!VALID_ROLES.includes(role)) {
    throw new Error(`Rol inválido: '${role}'. Roles válidos: ${VALID_ROLES.join(', ')}.`);
  }

  const pool = db.getPool(rootDir);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    await connection.query(
      `INSERT INTO usuarios (username, display_name, enabled) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), enabled = VALUES(enabled)`,
      [username, displayName || '', enabled ? 1 : 0]
    );
    const [userRows] = await connection.query('SELECT id FROM usuarios WHERE LOWER(username) = LOWER(?)', [username]);
    const userId = userRows[0].id;

    const [roleRows] = await connection.query('SELECT id FROM rol WHERE nombre = ?', [role]);
    const roleId = roleRows[0].id;

    // usuario_id es la PRIMARY KEY de rol_usuarios: este INSERT ... ON
    // DUPLICATE KEY pisa el rol existente en vez de agregar una segunda fila
    // — así se mantiene "un solo rol por usuario" aunque la relación esté
    // modelada como tabla intermedia.
    await connection.query(
      'INSERT INTO rol_usuarios (usuario_id, rol_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE rol_id = VALUES(rol_id)',
      [userId, roleId]
    );

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

async function removeSecurityUser(rootDir, username) {
  // ON DELETE CASCADE en rol_usuarios.usuario_id se encarga de borrar también
  // la fila de rol_usuarios de este usuario.
  await db.query(rootDir, 'DELETE FROM usuarios WHERE LOWER(username) = LOWER(?)', [username]);
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
  getAdConfig,
  saveAdConfig,
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
