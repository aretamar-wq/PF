'use strict';

// Lee/escribe profiles.local.json (perfiles de conexión con sus credenciales).
// Este archivo nunca se versiona: contiene client secrets / tokens en texto plano.
// Port de modules/ProfileStore.psm1 — mismo archivo en disco que usa el backend
// PowerShell (RootDir es la raíz del repo, no node/).

const fs = require('fs');
const path = require('path');

function getProfilesFilePath(rootDir) {
  return path.join(rootDir, 'profiles.local.json');
}

function getProfiles(rootDir) {
  const filePath = getProfilesFilePath(rootDir);
  if (!fs.existsSync(filePath)) return [];

  const json = fs.readFileSync(filePath, 'utf8');
  if (!json.trim()) return [];

  const parsed = JSON.parse(json);
  if (parsed === null || parsed === undefined) return [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function saveProfiles(rootDir, profiles) {
  const filePath = getProfilesFilePath(rootDir);
  const array = Array.isArray(profiles) ? profiles : [profiles];
  fs.writeFileSync(filePath, JSON.stringify(array, null, 2), 'utf8');
}

module.exports = { getProfilesFilePath, getProfiles, saveProfiles };
