'use strict';

// Pool de conexiones a MariaDB (mysql2/promise) compartido por todos los
// stores (securityStore, profileStore, parametriaStore,
// processedOperationsStore) — ver "Base de datos (MariaDB)" en el README.
// Un solo pool por proceso: rootDir no cambia durante la vida del proceso
// (se resuelve una sola vez en server.js), así que alcanza con crearlo la
// primera vez que hace falta y reusarlo después.

const mysql = require('mysql2/promise');
const { getDbConfig } = require('./dbConfigStore');

let pool = null;

function getPool(rootDir) {
  if (!pool) {
    const config = getDbConfig(rootDir);
    pool = mysql.createPool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      waitForConnections: true,
      connectionLimit: 10,
      // dateStrings evita que mysql2 devuelva objetos Date (con conversión
      // de zona horaria incluida) para columnas DATE/DATETIME/TIMESTAMP —
      // el resto de la app maneja fechas como texto (ver dateUtil.js), así
      // se evita una conversión de zona horaria no deseada de ida y vuelta.
      dateStrings: true,
    });
  }
  return pool;
}

// Wrapper fino sobre pool.query — centraliza el getPool(rootDir) para que
// cada store no tenga que importar mysql2 directamente.
async function query(rootDir, sql, params) {
  const [rows] = await getPool(rootDir).query(sql, params);
  return rows;
}

module.exports = { getPool, query };
