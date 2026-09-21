'use strict';

// Valores fijos reutilizables por categoría de cuenta (Cuenta Corriente, Caja
// de Ahorro, Plazo Fijo) + conexión Sybase, en MariaDB (tabla "parametria",
// fila única id=1) — reemplaza parametria.local.json (ver
// deploy/mariadb-schema.sql y "Base de datos (MariaDB)" en el README). Misma
// API pública que antes (getParametria/saveParametria, ahora async).
//
// sybase_password se guarda cifrada (AES-256-GCM, ver cryptoUtil.js) — es la
// contraseña real de la base bancaria, no algo que deba quedar legible con
// un SELECT directo a la tabla. El resto de los campos de Parametría no son
// secretos (códigos de cuenta/producto/movimiento, o el connection string
// sin la contraseña) y se guardan tal cual.

const db = require('./mariadbClient');
const { encrypt, decrypt } = require('./cryptoUtil');
const { getEncryptionKey } = require('./dbConfigStore');

// URL fija que tenía hardcodeada "Consultar CBU destino" antes de que fuera
// configurable por Parametría — se usa como default tanto para una
// instalación nueva (getDefaultParametria) como para una ya existente cuyo
// campo consulta_cbu_base_url quedó vacío después de agregar la columna
// (ver mapParametriaRow), para que ninguna de las dos deje de funcionar.
const DEFAULT_CONSULTA_CBU_BASE_URL = 'http://api-billetera.voii.com.ar:54000/QNet24/Services/rest/Nova';

function getDefaultParametria() {
  return {
    cuentaCorriente: { codigoCuenta: '', codigoSistema: '', transaccionDebito: '', transaccionCredito: '' },
    cajaDeAhorro: { codigoSistema: '', transaccionCredito: '', transaccionDebito: '' },
    plazoFijo: { codigoProducto: '', codigoMovimiento: '' },
    sybase: {
      connectionString:
        'Driver={Adaptive Server Enterprise};NetworkAddress=Aconquija4.bv.voii.com.ar,5000;Database=Banksys;Uid={{usuario}};Pwd={{password}}',
      usuario: '',
      password: '',
    },
    consultaCbu: { baseUrl: DEFAULT_CONSULTA_CBU_BASE_URL },
  };
}

function mapParametriaRow(row) {
  return {
    cuentaCorriente: {
      codigoCuenta: row.cc_codigo_cuenta,
      codigoSistema: row.cc_codigo_sistema,
      transaccionDebito: row.cc_transaccion_debito,
      transaccionCredito: row.cc_transaccion_credito,
    },
    cajaDeAhorro: {
      codigoSistema: row.ca_codigo_sistema,
      transaccionCredito: row.ca_transaccion_credito,
      transaccionDebito: row.ca_transaccion_debito,
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
    consultaCbu: {
      baseUrl: row.consulta_cbu_base_url || DEFAULT_CONSULTA_CBU_BASE_URL,
    },
  };
}

async function getParametria(rootDir) {
  const rows = await db.query(rootDir, 'SELECT * FROM parametria WHERE id = 1');
  if (rows.length === 0) return getDefaultParametria();

  const parametria = mapParametriaRow(rows[0]);
  if (parametria.sybase.password) {
    parametria.sybase.password = decrypt(parametria.sybase.password, getEncryptionKey(rootDir));
  }
  return parametria;
}

async function saveParametria(rootDir, parametria) {
  const p = parametria || {};
  const cc = p.cuentaCorriente || {};
  const ca = p.cajaDeAhorro || {};
  const pf = p.plazoFijo || {};
  const sybase = p.sybase || {};
  const consultaCbu = p.consultaCbu || {};

  const encryptedPassword = sybase.password ? encrypt(sybase.password, getEncryptionKey(rootDir)) : '';

  await db.query(
    rootDir,
    `INSERT INTO parametria (
       id, cc_codigo_cuenta, cc_codigo_sistema, cc_transaccion_debito, cc_transaccion_credito,
       ca_codigo_sistema, ca_transaccion_credito, ca_transaccion_debito,
       pf_codigo_producto, pf_codigo_movimiento,
       sybase_connection_string, sybase_usuario, sybase_password,
       consulta_cbu_base_url
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       cc_codigo_cuenta = VALUES(cc_codigo_cuenta),
       cc_codigo_sistema = VALUES(cc_codigo_sistema),
       cc_transaccion_debito = VALUES(cc_transaccion_debito),
       cc_transaccion_credito = VALUES(cc_transaccion_credito),
       ca_codigo_sistema = VALUES(ca_codigo_sistema),
       ca_transaccion_credito = VALUES(ca_transaccion_credito),
       ca_transaccion_debito = VALUES(ca_transaccion_debito),
       pf_codigo_producto = VALUES(pf_codigo_producto),
       pf_codigo_movimiento = VALUES(pf_codigo_movimiento),
       sybase_connection_string = VALUES(sybase_connection_string),
       sybase_usuario = VALUES(sybase_usuario),
       sybase_password = VALUES(sybase_password),
       consulta_cbu_base_url = VALUES(consulta_cbu_base_url)`,
    [
      cc.codigoCuenta || '',
      cc.codigoSistema || '',
      cc.transaccionDebito || '',
      cc.transaccionCredito || '',
      ca.codigoSistema || '',
      ca.transaccionCredito || '',
      ca.transaccionDebito || '',
      pf.codigoProducto || '',
      pf.codigoMovimiento || '',
      sybase.connectionString || '',
      sybase.usuario || '',
      encryptedPassword,
      consultaCbu.baseUrl || '',
    ]
  );
}

module.exports = { getDefaultParametria, getParametria, saveParametria };
