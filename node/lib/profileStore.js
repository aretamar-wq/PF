'use strict';

// Perfiles de conexión (con sus credenciales) en MariaDB, tabla "perfiles" —
// reemplaza profiles.local.json (ver deploy/mariadb-schema.sql y "Base de
// datos (MariaDB)" en el README). Misma API pública que antes
// (getProfiles/saveProfiles, ahora async) para no tener que tocar la lógica
// de node/server.js más allá de agregar "await": saveProfiles sigue
// recibiendo el array completo y reemplaza el contenido entero de la tabla
// en una transacción, igual que antes sobrescribía el archivo entero.
//
// client_id/client_secret/client_cert_passphrase se guardan cifrados
// (AES-256-GCM, ver cryptoUtil.js) — no algo que deba quedar legible con un
// SELECT directo a la tabla. apiKeyOrToken queda sin cifrar por ahora (no
// se pidió); el resto de los campos (baseUrl/novaBaseUrl/authType/tokenUrl/
// clientCertPfxPath) no son secretos.

const db = require('./mariadbClient');
const { encrypt, decrypt } = require('./cryptoUtil');
const { getEncryptionKey } = require('./dbConfigStore');

// Campos de un perfil que se guardan cifrados en la base — un solo lugar
// donde agregar/sacar uno si hace falta cambiar el alcance más adelante.
const ENCRYPTED_FIELDS = ['clientId', 'clientSecret', 'clientCertPassphrase'];

// Campos OAuth2 avanzados que no tienen columna propia (ver
// deploy/mariadb-schema.sql, token_extra_json) — se guardan tal cual en un
// solo JSON y se aplanan de vuelta al nivel superior del objeto perfil al
// leer, para que flowEngine.js siga viendo profileObj.tokenParams, etc.,
// sin enterarse de que están en una columna aparte.
const TOKEN_EXTRA_FIELDS = [
  'tokenParams',
  'tokenHeaders',
  'tokenAccessTokenPath',
  'tokenAuthHeaderFormat',
  'tokenAuthHeaderName',
  'tokenBodyContentType',
  'tokenExpiresInPath',
  'tokenMethod',
];

function mapProfileRow(row, rootDir) {
  const profile = {
    name: row.name,
    baseUrl: row.base_url,
    novaBaseUrl: row.nova_base_url,
    authType: row.auth_type,
    apiKeyHeaderName: row.api_key_header_name,
    apiKeyOrToken: row.api_key_or_token,
    tokenUrl: row.token_url,
    clientId: row.client_id,
    clientSecret: row.client_secret,
    clientCertPfxPath: row.client_cert_pfx_path,
    clientCertPassphrase: row.client_cert_passphrase,
  };
  if (row.token_extra_json) {
    const extra = typeof row.token_extra_json === 'string' ? JSON.parse(row.token_extra_json) : row.token_extra_json;
    Object.assign(profile, extra);
  }

  if (ENCRYPTED_FIELDS.some((field) => profile[field])) {
    const key = getEncryptionKey(rootDir);
    for (const field of ENCRYPTED_FIELDS) {
      if (profile[field]) profile[field] = decrypt(profile[field], key);
    }
  }

  return profile;
}

async function getProfiles(rootDir) {
  const rows = await db.query(rootDir, 'SELECT * FROM perfiles ORDER BY name');
  return rows.map((row) => mapProfileRow(row, rootDir));
}

async function saveProfiles(rootDir, profiles) {
  const array = Array.isArray(profiles) ? profiles : [profiles];
  const pool = db.getPool(rootDir);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    // Reemplazo total, igual que la escritura completa del archivo JSON de
    // antes: se borra todo y se vuelve a insertar la lista entera, en vez de
    // hacer un diff fila por fila.
    await connection.query('DELETE FROM perfiles');

    let key = null;
    for (const profile of array) {
      if (ENCRYPTED_FIELDS.some((field) => profile[field])) {
        if (!key) key = getEncryptionKey(rootDir);
      }
    }

    for (const profile of array) {
      const tokenExtra = {};
      for (const field of TOKEN_EXTRA_FIELDS) {
        if (profile[field] !== undefined) tokenExtra[field] = profile[field];
      }

      await connection.query(
        `INSERT INTO perfiles (
           name, base_url, nova_base_url, auth_type, api_key_header_name, api_key_or_token,
           token_url, client_id, client_secret, client_cert_pfx_path, client_cert_passphrase,
           token_extra_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          profile.name,
          profile.baseUrl || '',
          profile.novaBaseUrl || '',
          profile.authType || '',
          profile.apiKeyHeaderName || '',
          profile.apiKeyOrToken || '',
          profile.tokenUrl || '',
          profile.clientId ? encrypt(profile.clientId, key) : '',
          profile.clientSecret ? encrypt(profile.clientSecret, key) : '',
          profile.clientCertPfxPath || '',
          profile.clientCertPassphrase ? encrypt(profile.clientCertPassphrase, key) : '',
          Object.keys(tokenExtra).length > 0 ? JSON.stringify(tokenExtra) : null,
        ]
      );
    }

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = { getProfiles, saveProfiles };
