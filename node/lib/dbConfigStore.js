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

function getDbConfig(rootDir) {
  const filePath = getDbConfigFilePath(rootDir);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `No se encontró ${filePath}. Copiá db.sample.json a db.local.json y completá los datos de conexión a MariaDB.`
    );
  }

  const json = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(json);
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

module.exports = { getDbConfigFilePath, getDbConfig };
