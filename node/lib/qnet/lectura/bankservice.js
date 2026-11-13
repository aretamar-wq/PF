'use strict';

// BankService (transferencias QNET): un archivo por mes. Los de dos meses
// consecutivos se superponen unos días: se combinan por Comprobante y, si está
// repetido, gana el archivo más nuevo (un PENDING_EXECUTION puede pasar a
// APPROVED). Del archivo solo se conserva lo necesario (comprobante, fechas,
// estado, moneda, monto, cuenta del cliente, código y error): NO se guardan
// nombres, CUIT ni CBU.

const { sha256, parseCsv, centavos, parseFechaHora } = require('../util');

const ENCABEZADO_BANKSERVICE = [
  'Comprobante', 'Creada', 'Ejecutada', 'Estado', 'Titular', 'CUIT titular', 'CBU origen', 'CBU destino',
  'Destinatario', 'CUIT destinatario', 'Monto', 'Moneda', 'Código QNET', 'Error',
];
const ESTADOS = ['APPROVED', 'FAILED', 'PENDING_EXECUTION'];

// Movimientos_BankService-112026.csv -> { anio: 2026, mes: 11 } (acepta un prefijo antes del nombre).
function infoNombreBankService(nombre) {
  const m = /Movimientos_BankService-(\d{2})(\d{4})\.csv$/i.exec(String(nombre));
  return m ? { anio: Number(m[2]), mes: Number(m[1]) } : null;
}

const vacio = (v) => (String(v == null ? '' : v).trim() === '—' ? '' : String(v == null ? '' : v).trim());

function leerBankService(archivos, config, avisos) {
  const infoArchivos = [];
  const ordenados = [];
  const vistos = new Map();
  for (const a of archivos) {
    const hash = sha256(a.contenido);
    const periodo = infoNombreBankService(a.nombre);
    if (!periodo) {
      avisos.error(`${a.nombre}: el nombre no tiene la forma Movimientos_BankService-mmaaaa.csv.`);
      continue;
    }
    if (vistos.has(hash)) {
      avisos.advertencia(`${a.nombre}: es idéntico a ${vistos.get(hash)} (mismo hash): no se procesa de nuevo.`);
      infoArchivos.push({ nombre: a.nombre, tipo: 'bankservice-mes', hash, filas: '', estado: 'repetido-idéntico' });
      continue;
    }
    vistos.set(hash, a.nombre);
    ordenados.push({ ...a, hash, periodo });
  }
  // Más viejo primero: el más nuevo pisa a los anteriores.
  ordenados.sort((x, y) => x.periodo.anio - y.periodo.anio || x.periodo.mes - y.periodo.mes);

  const porComprobante = new Map();
  let superpuestos = 0;
  let cambiaron = 0;
  const inconsistentes = { moneda: 0, estado: 0, monto: 0 };
  for (const a of ordenados) {
    const filas = parseCsv(a.contenido);
    const encabezado = (filas[0] || []).map((h) => h.trim());
    if (encabezado.join(',') !== ENCABEZADO_BANKSERVICE.join(',')) {
      avisos.error(`${a.nombre}: encabezado de BankService inesperado.`);
      continue;
    }
    const col = Object.fromEntries(ENCABEZADO_BANKSERVICE.map((h, i) => [h, i]));
    let n = 0;
    const enEsteArchivo = new Set();
    for (const f of filas.slice(1)) {
      const g = (h) => (f[col[h]] == null ? '' : f[col[h]]).trim();
      const comprobante = g('Comprobante');
      const estado = g('Estado');
      const moneda = g('Moneda');
      const monto = centavos(g('Monto'));
      if (!comprobante || !ESTADOS.includes(estado) || !(moneda in config.monedas) || monto == null) {
        if (!ESTADOS.includes(estado)) inconsistentes.estado++;
        else if (!(moneda in config.monedas)) inconsistentes.moneda++;
        else inconsistentes.monto++;
        continue;
      }
      if (enEsteArchivo.has(comprobante)) avisos.advertencia(`${a.nombre}: el comprobante ${comprobante} está repetido dentro del archivo; se toma la última fila.`);
      enEsteArchivo.add(comprobante);
      const moncod = config.monedas[moneda];
      const cbu = g('CBU origen');
      const cbuValido = /^\d{22}$/.test(cbu);
      const creada = parseFechaHora(g('Creada'));
      const ejecutada = parseFechaHora(g('Ejecutada'));
      const registro = {
        comprobante,
        clave: `${moncod}|${comprobante}`,
        moncod,
        moneda,
        estado,
        creada: creada ? `${creada.fecha} ${creada.hora}` : '',
        ejecutada: ejecutada ? `${ejecutada.fecha} ${ejecutada.hora}` : '',
        monto,
        cuenta: cbuValido ? String(parseInt(cbu.slice(10, 21), 10)) : '',
        cbuMonedaOk: cbuValido && cbu.slice(8, 10) === config.digitosCbuMoneda[moneda],
        codigoQnet: vacio(g('Código QNET')),
        error: vacio(g('Error')),
        archivo: a.nombre,
      };
      if (porComprobante.has(registro.clave) && porComprobante.get(registro.clave).archivo !== a.nombre) {
        superpuestos++;
        if (porComprobante.get(registro.clave).estado !== registro.estado) cambiaron++;
      }
      porComprobante.set(registro.clave, registro);
      n++;
    }
    infoArchivos.push({ nombre: a.nombre, tipo: 'bankservice-mes', hash: a.hash, filas: n, estado: 'usado' });
  }
  if (inconsistentes.estado + inconsistentes.moneda + inconsistentes.monto > 0) {
    avisos.advertencia(
      `BankService: filas descartadas por datos inválidos (estado desconocido: ${inconsistentes.estado}, moneda desconocida: ${inconsistentes.moneda}, monto o comprobante inválido: ${inconsistentes.monto}).`
    );
  }
  if (superpuestos > 0) avisos.info(`BankService: ${superpuestos} comprobante(s) superpuestos entre archivos (${cambiaron} con estado distinto); gana el archivo más nuevo.`);
  return { transfers: [...porComprobante.values()], archivos: infoArchivos };
}

module.exports = { ENCABEZADO_BANKSERVICE, infoNombreBankService, leerBankService };
