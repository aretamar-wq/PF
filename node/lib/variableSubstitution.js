'use strict';

// Reemplaza placeholders {{variable}} dentro de un template usando un objeto de
// variables. Port de modules/VariableSubstitution.psm1 (Expand-Template) — una
// clave sin match en Variables deja el placeholder tal cual, sin tocar.

const PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

function expandTemplate(template, variables) {
  if (template === null || template === undefined || template === '') {
    return template;
  }
  return template.replace(PATTERN, (match, key) => {
    if (variables && Object.prototype.hasOwnProperty.call(variables, key)) {
      return String(variables[key]);
    }
    return match;
  });
}

module.exports = { expandTemplate };
