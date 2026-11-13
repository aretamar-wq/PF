'use strict';

// Salidas en CSV (punto decimal, CRLF, UTF-8, fechas dd/mm/aaaa): conciliación por
// comprobante, excepciones, resumen, pendientes por día y fuentes. No llevan
// nombres, CUIT ni CBU: solo comprobante, cuenta, moneda e importes.

const fs = require('fs');
const path = require('path');
const { csvTexto, fmtCentavos, fechaDMY } = require('../util');

const importe = (c) => (c == null ? '' : fmtCentavos(c));

function tablaComprobantes(resultado, config) {
  const filas = [['Clave', 'Moneda', 'Comprobante', 'Partidas', 'Débito', 'Crédito', 'Neto', 'Fecha débito', 'Fecha crédito', 'Cuenta', 'Marca', 'Estado BankService', 'Débito pendiente', 'Fecha pendiente']];
  const ordenados = [...resultado.comprobantes].sort((a, b) => a.moncod.localeCompare(b.moncod) || Number(a.comnro) - Number(b.comnro));
  for (const c of ordenados) {
    filas.push([
      c.clave, config.etiquetasMoneda[c.moncod] || c.moncod, c.comnro, c.partidas, importe(c.debito), importe(c.credito), importe(c.neto),
      fechaDMY(c.fechaDebito), fechaDMY(c.fechaCredito), c.cuenta, c.marca, c.estadoBankService,
      c.pendiente ? importe(c.pendiente.importedeb) : '', c.pendiente ? fechaDMY(c.pendiente.fechaOrigen) : '',
    ]);
  }
  return filas;
}

function tablaExcepciones(resultado) {
  const filas = [['Tipo', 'Comprobante', 'Cuenta', 'Moneda', 'Fecha', 'Importe', 'Estado transfer', 'Débito pendiente', 'Detalle']];
  const ordenadas = [...resultado.excepciones].sort(
    (a, b) => a.tipo.localeCompare(b.tipo) || String(a.fecha).localeCompare(String(b.fecha)) || Number(a.comprobante) - Number(b.comprobante)
  );
  for (const e of ordenadas) {
    filas.push([e.tipo, e.comprobante, e.cuenta, e.moneda, fechaDMY(e.fecha), importe(e.importe), e.estadoTransfer, importe(e.debitoPendiente), e.detalle]);
  }
  return filas;
}

function tablaResumen(resultado) {
  const filas = [['Bloque', 'Concepto', 'Moneda', 'Cantidad', 'Importe']];
  for (const r of resultado.resumenPorTipo) filas.push(['Por tipo', r.tipo, r.moneda, r.cantidad, importe(r.importe)]);
  for (const [moneda, t] of Object.entries(resultado.totales).sort()) {
    filas.push(['Desbalance', 'Neto en Loop', moneda, t.comprobantes, importe(t.neto)]);
    filas.push(['Desbalance', 'Débitos pendientes', moneda, '', importe(t.pendientes)]);
    filas.push(['Desbalance', 'Sin cubrir (neto - pendientes)', moneda, '', importe(t.sinCubrir)]);
  }
  const c = resultado.cruce;
  const cruce = [
    ['Operaciones en los archivos de BankService', c.totalEnArchivos], ['Operaciones del día (fecha contable)', c.delDia], ['  APPROVED', c.approved], ['  FAILED', c.failed],
    ['PENDING_EXECUTION sin ejecutar (hasta el día)', c.pending], ['APPROVED encontradas en Loop', c.encontradas], ['  sin diferencias', c.sinDiferencias],
    ['APPROVED sin registro', c.approvedSinRegistro], ['APPROVED pendientes de contabilizar (el día sigue abierto)', c.pendientesDeContabilizar], ['Operaciones de otros días', c.otrosDias],
  ];
  for (const [concepto, n] of cruce) filas.push(['Cruce con transfers', concepto, '', n, '']);
  for (const p of resultado.pendientesPosteriores) filas.push(['Pendiente posterior al día', `Comprobante ${p.comprobante} del ${fechaDMY(p.fecha)}`, p.moneda, 1, importe(p.importe)]);
  const anteriores = {};
  for (const p of resultado.pendientesAnteriores) {
    anteriores[p.moneda] = anteriores[p.moneda] || { n: 0, c: 0 };
    anteriores[p.moneda].n++;
    anteriores[p.moneda].c += p.importe;
  }
  for (const [moneda, a] of Object.entries(anteriores).sort()) filas.push(['Pendientes de días anteriores', 'Sin partida en Loop del día (entran en la antigüedad)', moneda, a.n, importe(a.c)]);
  return filas;
}

function tablaPendientesPorDia(resultado) {
  const filas = [['Tramo', 'Fecha crédito', 'Moneda', 'Cantidad', 'Importe', 'Acumulado']];
  for (const f of resultado.antiguedad.filas) filas.push([f.tramo, fechaDMY(f.fecha), f.moneda, f.cantidad, importe(f.importe), importe(f.acumulado)]);
  for (const t of resultado.antiguedad.tramos) filas.push([`Total ${t.tramo}`, '', t.moneda, t.cantidad, importe(t.importe), '']);
  return filas;
}

function tablaFuentes(resultado, archivos, origenes) {
  const filas = [['Bloque', 'Concepto', 'Valor', 'Hash', 'Filas', 'Estado']];
  for (const a of archivos) filas.push(['Archivo', a.tipo, a.nombre, a.hash, a.filas, a.estado]);
  filas.push(['Fecha conciliada', 'Día de Loop', fechaDMY(resultado.fecha), '', '', '']);
  filas.push(['Corte de transfers', 'Última Ejecutada', resultado.corte.ejecutada, '', '', '']);
  for (const [k, v] of Object.entries(origenes || {})) filas.push(['Origen', k, v, '', '', '']);
  return filas;
}

function escribirReportes(dir, resultado, archivos, config, origenes) {
  fs.mkdirSync(dir, { recursive: true });
  const salidas = {
    'conciliacion-comprobantes.csv': tablaComprobantes(resultado, config),
    'excepciones.csv': tablaExcepciones(resultado),
    'resumen.csv': tablaResumen(resultado),
    'pendientes-por-dia.csv': tablaPendientesPorDia(resultado),
    'fuentes.csv': tablaFuentes(resultado, archivos, origenes),
  };
  for (const [nombre, filas] of Object.entries(salidas)) fs.writeFileSync(path.join(dir, nombre), csvTexto(filas));
  return Object.keys(salidas);
}

module.exports = { tablaComprobantes, tablaExcepciones, tablaResumen, tablaPendientesPorDia, tablaFuentes, escribirReportes };
