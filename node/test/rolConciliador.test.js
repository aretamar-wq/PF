'use strict';
const test = require('node:test');
const assert = require('node:assert');
// securityStore carga ldapts y mysql2 (instalados en el servidor): acá se simulan.
const Module = require('module');
const cargar = Module._load;
Module._load = function (pedido, ...resto) {
  if (pedido === 'ldapts') return { Client: class {} };
  if (pedido === 'mysql2/promise') return { createPool: () => ({}) };
  return cargar.call(this, pedido, ...resto);
};
const sec = require('../lib/securityStore');
Module._load = cargar;

test("rol 'conciliador': solo las rutas de las conciliaciones", () => {
  assert.ok(sec.getValidRoles().includes('conciliador'));
  const puede = (m, p) => sec.testRoleCanAccessApi('conciliador', m, p);
  for (const [m, p] of [['GET', '/api/me'], ['POST', '/api/logout'], ['POST', '/api/conciliacion/ibs'], ['GET', '/api/dbn-consulta-dia'],
    ['POST', '/api/transf-ca-cc/bankservice'], ['GET', '/api/transf-ca-cc/datos'], ['GET', '/api/transf-ca-cc/reporte'],
    ['POST', '/api/fx/bankservice'], ['GET', '/api/fx/datos'], ['GET', '/api/fx/historia'], ['GET', '/api/fx/reporte'], ['GET', '/api/fx/cargas']]) {
    assert.ok(puede(m, p), `${m} ${p}`);
  }
  for (const [m, p] of [['POST', '/api/run'], ['GET', '/api/flows'], ['GET', '/api/profiles'], ['POST', '/api/profiles'], ['GET', '/api/parametria'],
    ['GET', '/api/users'], ['GET', '/api/output-files'], ['GET', '/api/dashboard'], ['POST', '/api/dbn-consulta-estado'], ['GET', '/api/fx/bankservice']]) {
    assert.ok(!puede(m, p), `${m} ${p}`);
  }
  assert.ok(!sec.testRoleCanRunFlow('conciliador'));
  assert.ok(!sec.testRoleCanManageParametria('conciliador'));
  assert.ok(!sec.testRoleCanManageUsers('conciliador'));
  // Los demás roles no cambian.
  for (const r of ['admin', 'operador', 'lectura']) assert.ok(sec.testRoleCanAccessApi(r, 'GET', '/api/flows'));
});
