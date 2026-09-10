'use strict';

// Valores fijos reutilizables por categoría de cuenta (Cuenta Corriente, Caja
// de Ahorro, Plazo Fijo) + conexión Sybase, en MariaDB (tabla "parametria",
// fila única id=1) — reemplaza parametria.local.json (ver
// deploy/mariadb-schema.sql y "Base de datos (MariaDB)" en el README). Misma
// API pública que antes (getParametria/saveParametria, ahora async).

const db = require('./mariadbClient');

function getDefaultParametria() {
  return {
    cuentaCorriente: { codigoCuenta: '', codigoSistema: '', transaccion: '' },
    cajaDeAhorro: { codigoSistema: '', transaccion: '' },
    plazoFijo: { codigoProducto: '', codigoMovimiento: '' },
    sybase: {
      connectionString:
        'Driver={Adaptive Server Enterprise};NetworkAddress=Aconquija4.bv.voii.com.ar,5000;Database=Banksys;Uid={{usuario}};Pwd={{password}}',
      usuario: '',
      password: '',
    },
  };
}

function mapParametriaRow(row) {
  return {
    cuentaCorriente: {
      codigoCuenta: row.cc_codigo_cuenta,
      codigoSistema: row.cc_codigo_sistema,
      transaccion: row.cc_transaccion,
    },
    cajaDeAhorro: {
      codigoSistema: row.ca_codigo_sistema,
      transaccion: row.ca_transaccion,
    },
    plazoFijo: {
      codigoProducto: row.pf_codigo_producto,
      codigoMovimiento: row.pf_codigo_movimiento,
    },
    sybase: {
      connectionString: row.sybase_connection_string,
      usuario: row.sybase_usuario,
      password: row.sybase_password,
    },
  };
}

async function getParametria(rootDir) {
  const rows = await db.query(rootDir, 'SELECT * FROM parametria WHERE id = 1');
  if (rows.length === 0) return getDefaultParametria();
  return mapParametriaRow(rows[0]);
}

async function saveParametria(rootDir, parametria) {
  const p = parametria || {};
  const cc = p.cuentaCorriente || {};
  const ca = p.cajaDeAhorro || {};
  const pf = p.plazoFijo || {};
  const sybase = p.sybase || {};

  await db.query(
    rootDir,
    `INSERT INTO parametria (
       id, cc_codigo_cuenta, cc_codigo_sistema, cc_transaccion,
       ca_codigo_sistema, ca_transaccion,
       pf_codigo_producto, pf_codigo_movimiento,
       sybase_connection_string, sybase_usuario, sybase_password
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       cc_codigo_cuenta = VALUES(cc_codigo_cuenta),
       cc_codigo_sistema = VALUES(cc_codigo_sistema),
       cc_transaccion = VALUES(cc_transaccion),
       ca_codigo_sistema = VALUES(ca_codigo_sistema),
       ca_transaccion = VALUES(ca_transaccion),
       pf_codigo_producto = VALUES(pf_codigo_producto),
       pf_codigo_movimiento = VALUES(pf_codigo_movimiento),
       sybase_connection_string = VALUES(sybase_connection_string),
       sybase_usuario = VALUES(sybase_usuario),
       sybase_password = VALUES(sybase_password)`,
    [
      cc.codigoCuenta || '',
      cc.codigoSistema || '',
      cc.transaccion || '',
      ca.codigoSistema || '',
      ca.transaccion || '',
      pf.codigoProducto || '',
      pf.codigoMovimiento || '',
      sybase.connectionString || '',
      sybase.usuario || '',
      sybase.password || '',
    ]
  );
}

module.exports = { getDefaultParametria, getParametria, saveParametria };
