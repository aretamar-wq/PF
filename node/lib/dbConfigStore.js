'use strict';

// Lee db.local.json: datos de conexión a la base MariaDB (host/port/database/
// user/password) que reemplaza el almacenamiento en archivos JSON de usuarios,
// perfiles, parametría y operaciones procesadas — ver "Base de datos (MariaDB)"
// en el README. Mismo patrón local/sample que profiles.local.json.

const fs = require('fs');
const path = require('path');

function getDbConfigFilePath(rootDir) {
  return path.join(rootDir, 'db.local.json');
}

function readDbConfigFile(rootDir) {
  const filePath = getDbConfigFilePath(rootDir);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `No se encontró ${filePath}. Copiá db.sample.json a db.local.json y completá los datos de conexión a MariaDB.`
    );
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getDbConfig(rootDir) {
  const parsed = readDbConfigFile(rootDir);
  if (!parsed || !parsed.host || !parsed.database || !parsed.user) {
    throw new Error('db.local.json está incompleto: hacen falta al menos host, database y user.');
  }

  return {
    host: String(parsed.host),
    port: parsed.port ? Number(parsed.port) : 3306,
    database: String(parsed.database),
    user: String(parsed.user),
    password: parsed.password ? String(parsed.password) : '',
  };
}

// Clave de cifrado (AES-256-GCM, ver cryptoUtil.js) para parametria.sybase_password
// — vive en el mismo db.local.json que el resto de la conexión a MariaDB, no
// en la base (cifrar con una clave guardada en la misma tabla que lo cifrado
// no protege nada). Se genera una sola vez con:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// y se completa a mano en db.local.json, campo "encryptionKey" — no hay
// forma de recuperar el valor cifrado si se pierde esta clave.
function getEncryptionKey(rootDir) {
  const parsed = readDbConfigFile(rootDir);
  if (!parsed || !parsed.encryptionKey) {
    throw new Error(
      'db.local.json no tiene configurado "encryptionKey" (hace falta para cifrar/descifrar la contraseña de Sybase en Parametría). ' +
        'Generá una con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" y agregala a db.local.json.'
    );
  }
  return String(parsed.encryptionKey);
}

module.exports = { getDbConfigFilePath, getDbConfig, getEncryptionKey };
