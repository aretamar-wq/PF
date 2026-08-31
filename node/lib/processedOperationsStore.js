'use strict';

// Lleva el registro de operaciones (cuit + numeroComprobante) que ya se
// ejecutaron con éxito, para poder bloquear una fila que intente repetir la
// misma operación antes de llamar a ningún endpoint del banco. Port de
// modules/ProcessedOperationsStore.psm1 — lee/escribe el mismo
// logs/processed-operations.json que el backend PowerShell (no se versiona,
// logs/ está en .gitignore entero).

const fs = require('fs');
const path = require('path');
const { formatLocal } = require('./dateUtil');

function getProcessedOperationsFilePath(rootDir) {
  return path.join(rootDir, 'logs', 'processed-operations.json');
}

function getProcessedOperations(rootDir) {
  const filePath = getProcessedOperationsFilePath(rootDir);
  if (!fs.existsSync(filePath)) return [];

  const json = fs.readFileSync(filePath, 'utf8');
  if (!json.trim()) return [];

  const parsed = JSON.parse(json);
  if (parsed === null || parsed === undefined) return [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function saveProcessedOperations(rootDir, operations) {
  const logsDir = path.join(rootDir, 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const filePath = getProcessedOperationsFilePath(rootDir);
  fs.writeFileSync(filePath, JSON.stringify(operations, null, 2), 'utf8');
}

function findDuplicateOperations(rootDir, operations) {
  const existing = getProcessedOperations(rootDir);
  const index = new Map();
  for (const record of existing) {
    const key = `${record.cuit}|${record.numeroComprobante}`;
    if (!index.has(key)) index.set(key, record);
  }

  const duplicates = [];
  for (const op of operations) {
    const key = `${op.cuit}|${op.numeroComprobante}`;
    if (index.has(key)) {
      const match = index.get(key);
      duplicates.push({
        cuit: String(op.cuit),
        numeroComprobante: String(op.numeroComprobante),
        processedAt: match.processedAt,
        processedBy: match.processedBy,
      });
    }
  }
  return duplicates;
}

function addProcessedOperations(rootDir, operations, username) {
  const existing = getProcessedOperations(rootDir);
  const now = formatLocal();
  const added = operations.map((op) => ({
    cuit: String(op.cuit),
    numeroComprobante: String(op.numeroComprobante),
    idMensaje: String(op.idMensaje),
    processedAt: now,
    processedBy: username,
  }));
  saveProcessedOperations(rootDir, existing.concat(added));
}

module.exports = { getProcessedOperations, findDuplicateOperations, addProcessedOperations };
