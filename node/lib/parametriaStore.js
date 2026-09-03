'use strict';

// Lee/escribe parametria.local.json: valores fijos reutilizables por categoría de
// cuenta (Cuenta Corriente, Caja de Ahorro, Plazo Fijo) que los flows usan en vez
// de pedirlos a mano en cada ejecución. Port de modules/ParametriaStore.psm1.

const fs = require('fs');
const path = require('path');

function getDefaultParametria() {
  return {
    cuentaCorriente: { codigoCuenta: '', codigoSistema: '', transaccion: '' },
    cajaDeAhorro: { codigoSistema: '', transaccion: '' },
    plazoFijo: { codigoProducto: '', codigoMovimiento: '' },
    debin: {
      debitoCuit: '',
      debitoCbu: '',
      debitoBanco: '',
      debitoSucursal: '',
      debitoTitular: '',
      idUsuario: '',
      concepto: 'HAB',
      moneda: '032',
    },
    sybase: {
      connectionString:
        'Driver={Adaptive Server Enterprise};NetworkAddress=Aconquija4.bv.voii.com.ar,5000;Database=Banksys;Uid={{usuario}};Pwd={{password}}',
      usuario: '',
      password: '',
    },
  };
}

function getParametriaFilePath(rootDir) {
  return path.join(rootDir, 'parametria.local.json');
}

function getParametria(rootDir) {
  const filePath = getParametriaFilePath(rootDir);
  if (!fs.existsSync(filePath)) return getDefaultParametria();

  const json = fs.readFileSync(filePath, 'utf8');
  if (!json.trim()) return getDefaultParametria();

  const parsed = JSON.parse(json);
  return parsed === null || parsed === undefined ? getDefaultParametria() : parsed;
}

function saveParametria(rootDir, parametria) {
  const filePath = getParametriaFilePath(rootDir);
  fs.writeFileSync(filePath, JSON.stringify(parametria, null, 2), 'utf8');
}

module.exports = { getDefaultParametria, getParametriaFilePath, getParametria, saveParametria };
