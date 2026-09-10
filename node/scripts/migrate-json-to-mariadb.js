#!/usr/bin/env node
'use strict';

// Migra, una sola vez, los datos que hubiera en los archivos JSON locales
// (security.local.json, profiles.local.json, parametria.local.json,
// logs/processed-operations.json) a las tablas de MariaDB que los
// reemplazan — ver deploy/mariadb-schema.sql y "Base de datos (MariaDB)" en
// el README.
//
// Uso (desde la carpeta node/, con db.local.json ya configurado y el schema
// ya aplicado contra la base):
//   node scripts/migrate-json-to-mariadb.js
//
// No requiere las versiones viejas de los stores (ya no existen: fueron
// reemplazados) — lee los JSON directo del disco con el mismo formato que
// tenían antes, y usa la misma conexión (mariadbClient) que ahora usa la
// app. Es seguro correrlo más de una vez: usuarios/perfiles se upsertean
// por su clave (username/name), y las operaciones procesadas tienen
// UNIQUE KEY (cuit, numero_comprobante) — no duplica filas.

const fs = require('fs');
const path = require('path');
const rootDir = path.join(__dirname, '..', '..');

const db = require('../lib/mariadbClient');
const securityStore = require('../lib/securityStore');
const profileStore = require('../lib/profileStore');
const parametriaStore = require('../lib/parametriaStore');

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text.trim()) return null;
  return JSON.parse(text);
}

async function migrateSecurity() {
  const filePath = path.join(rootDir, 'security.local.json');
  const security = readJsonIfExists(filePath);
  if (!security) {
    console.log(`- security.local.json: no existe o está vacío, nada para migrar.`);
    return;
  }

  if (security.ad) {
    await securityStore.saveAdConfig(rootDir, security.ad);
    console.log(`- Configuración de AD migrada (server='${security.ad.server || ''}').`);
  }

  const users = Array.isArray(security.users) ? security.users : [];
  for (const user of users) {
    await securityStore.addOrUpdateSecurityUser(rootDir, user.username, user.role, !!user.enabled, user.displayName || '');
  }
  console.log(`- ${users.length} usuario(s) migrado(s) desde security.local.json.`);
}

async function migrateProfiles() {
  const filePath = path.join(rootDir, 'profiles.local.json');
  const profiles = readJsonIfExists(filePath);
  if (!profiles) {
    console.log(`- profiles.local.json: no existe o está vacío, nada para migrar.`);
    return;
  }

  const array = Array.isArray(profiles) ? profiles : [profiles];
  const existing = await profileStore.getProfiles(rootDir);
  const merged = existing.filter((p) => !array.some((incoming) => incoming.name === p.name)).concat(array);
  await profileStore.saveProfiles(rootDir, merged);
  console.log(`- ${array.length} perfil(es) migrado(s) desde profiles.local.json.`);
}

async function migrateParametria() {
  const filePath = path.join(rootDir, 'parametria.local.json');
  const parametria = readJsonIfExists(filePath);
  if (!parametria) {
    console.log(`- parametria.local.json: no existe o está vacío, nada para migrar.`);
    return;
  }

  await parametriaStore.saveParametria(rootDir, parametria);
  console.log('- Parametría migrada desde parametria.local.json.');
}

async function migrateProcessedOperations() {
  const filePath = path.join(rootDir, 'logs', 'processed-operations.json');
  const operations = readJsonIfExists(filePath);
  if (!operations) {
    console.log(`- logs/processed-operations.json: no existe o está vacío, nada para migrar.`);
    return;
  }

  const array = Array.isArray(operations) ? operations : [operations];
  let migrated = 0;
  for (const op of array) {
    // INSERT directo (no addProcessedOperations, que pisa processedAt/
    // processedBy con el momento de la migración) — se conserva la fecha y
    // el usuario originales tal cual estaban en el archivo.
    await db.query(
      rootDir,
      `INSERT INTO operaciones_procesadas (cuit, numero_comprobante, id_mensaje, processed_at, processed_by)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [String(op.cuit), String(op.numeroComprobante), String(op.idMensaje || ''), op.processedAt || null, op.processedBy || '']
    );
    migrated += 1;
  }
  console.log(`- ${migrated} operación(es) procesada(s) migrada(s) desde logs/processed-operations.json.`);
}

async function main() {
  console.log(`Migrando datos locales de ${rootDir} a MariaDB...\n`);
  await migrateSecurity();
  await migrateProfiles();
  await migrateParametria();
  await migrateProcessedOperations();
  console.log('\nListo. Los archivos *.local.json originales NO se borraron ni se modificaron —');
  console.log('podés revisarlos y borrarlos a mano una vez que confirmes que la app funciona bien contra MariaDB.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Error migrando a MariaDB:', err.message);
  process.exit(1);
});
