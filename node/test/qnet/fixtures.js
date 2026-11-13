'use strict';
// Filas sintéticas para las pruebas (sin datos reales).
const LOOP_H = 'sistcod,moncod,cuecod,Fecha_Mov,comnro,movcod,signo,accimp,Importe';
const PEND_H = 'fecreal,tercod,succod,sistcod,moncod,cuecod,movcod,descdet,fecproceso,comnro,nromen,mentexto,importedeb,fecenlace,fecorigen';
const BS_H = 'Comprobante,Creada,Ejecutada,Estado,Titular,CUIT titular,CBU origen,CBU destino,Destinatario,CUIT destinatario,Monto,Moneda,Código QNET,Error';

const dmy = (iso) => iso.split('-').reverse().join('/');
const partida = (sist, mon, cue, fecha, com, mov, signo, imp) => ({
  sistcod: String(sist), moncod: String(mon), cuecod: String(cue), fecha, comnro: String(com), movcod: String(mov),
  signo, accimp: Math.round(imp * 100), importe: Math.round(signo * imp * 100),
});
// Par débito (cliente, sistcod 5) + crédito (puente, sistcod 3).
const par = (com, cuenta, fechaD, fechaC, impD, impC = impD, mon = 0) => [
  partida(5, mon, cuenta, fechaD, com, 25030, -1, impD),
  partida(3, mon, mon === 0 ? 11000492 : 11000493, fechaC, com, 25031, 1, impC),
];
const soloCredito = (com, fecha, imp, mon = 0) => [partida(3, mon, mon === 0 ? 11000492 : 11000493, fecha, com, 25031, 1, imp)];

const pendiente = (com, cuenta, imp, fechaOrigen, mon = 0) => ({
  moncod: String(mon), comnro: String(com), cuecod: String(cuenta), importedeb: Math.round(imp * 100), fechaOrigen, fechaHoraOrigen: `${fechaOrigen} 10:00:00`, fechaProceso: fechaOrigen, motivo: 'sin saldo',
});

const transfer = (com, estado, ejecutada, monto, cuenta, extra = {}) => ({
  comprobante: String(com), clave: `${extra.moncod || '0'}|${com}`, moncod: '0', moneda: 'ARS', estado,
  creada: ejecutada || '2026-11-02 10:00:00', ejecutada: ejecutada || '', monto: Math.round(monto * 100), cuenta: String(cuenta),
  cbuMonedaOk: true, codigoQnet: '', error: '', archivo: 'bs.csv', ...extra,
});

// CBU de 22 dígitos: banco(3) suc(4) dv(1) tipo(2) cuenta(11) dv(1)
const cbu = (cuenta, tipo = '02') => `31200019${tipo}${String(cuenta).padStart(11, '0')}0`;
const filaLoop = (sist, mon, cue, fecha, com, mov, signo, imp) =>
  [sist, mon, cue, dmy(fecha), com, mov, signo, imp.toFixed(3), (signo * imp).toFixed(3)].join(',');
const filaBs = (com, creada, ejecutada, estado, cuenta, monto, moneda = 'ARS', extra = {}) =>
  [com, creada, ejecutada, estado, '"APELLIDO, NOMBRE"', '20111222333', extra.cbu || cbu(cuenta, moneda === 'ARS' ? '02' : '06'), '0070000000000000000000', 'DEST', '30999888777', monto, moneda, '—', '—'].join(',');

module.exports = { LOOP_H, PEND_H, BS_H, dmy, partida, par, soloCredito, pendiente, transfer, cbu, filaLoop, filaBs };
