'use strict';

// Navegación simple de JSON por notación de puntos con índices de array opcionales,
// ej: "data.accounts[0].balance". Port 1:1 de modules/JsonPath.psm1 (Get-JsonPathValue).

const SEGMENT_RE = /^([^[\]]+)(\[(\d+)\])?$/;

function getJsonPathValue(data, jsonPath) {
  let current = data;

  for (const rawSegment of jsonPath.split('.')) {
    if (current === null || current === undefined) return null;

    const match = SEGMENT_RE.exec(rawSegment);
    if (!match) return null;

    const propertyName = match[1];
    const hasIndex = match[2];
    const index = match[3];

    if (typeof current !== 'object') return null;
    if (!(propertyName in current)) return null;
    current = current[propertyName];

    if (hasIndex) {
      if (current === null || current === undefined) return null;
      const i = parseInt(index, 10);
      const items = Array.isArray(current) ? current : [current];
      if (i >= items.length) return null;
      current = items[i];
    }
  }

  return current === undefined ? null : current;
}

module.exports = { getJsonPathValue };
