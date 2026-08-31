'use strict';

// Lee todos los flows (*.json) de la carpeta Flows/. Cada archivo se lee de forma
// independiente: si uno tiene un JSON inválido, se ignora y se avisa por consola en
// vez de tirar abajo el resto de los flows. Un flow con "enabled": false en su JSON
// se salta por completo (no aparece en la lista ni se puede ejecutar por nombre).
// Port de modules/FlowStore.psm1 — lee la misma carpeta Flows/ que el backend
// PowerShell (RootDir/../Flows es la raíz del repo, compartida por ambos).

const fs = require('fs');
const path = require('path');

function getFlows(flowsDir) {
  const flows = [];
  if (!fs.existsSync(flowsDir)) return flows;

  const files = fs
    .readdirSync(flowsDir)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .sort();

  for (const file of files) {
    try {
      const json = fs.readFileSync(path.join(flowsDir, file), 'utf8');
      const flow = JSON.parse(json);
      if (flow !== null && flow !== undefined && flow.enabled !== false) {
        flows.push(flow);
      }
    } catch (err) {
      console.warn(`No se pudo leer el flow '${file}': ${err.message}`);
    }
  }

  return flows;
}

module.exports = { getFlows };
