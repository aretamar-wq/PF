'use strict';

// Reglas de la conciliación "Transferencias CA -> CC" (QNET entre IBS/Loop, débitos
// pendientes y BankService). Importes en centavos enteros.
module.exports = {
  movDebito: '25030',
  movCredito: '25031',
  sistCliente: '5',
  // Partida de 1 centavo: accimp <= 0,011 (en centavos, <= 1).
  maxCentavo: 1,
  // Usuarios que cargan movimientos por proceso (cualquier otro = carga manual):
  // 123123123 los débitos del mismo día, 36077255 los que salen de pendientes.
  usuariosProceso: ['123123123', '36077255'],
  monedas: { ARS: '0', USD: '2' },
  etiquetaMoneda: { 0: 'ARS', 2: 'USD' },
  // Dígitos 9 y 10 del CBU origen según la moneda.
  digitosCbuMoneda: { ARS: '02', USD: '06' },
  estados: ['APPROVED', 'FAILED', 'PENDING_EXECUTION'],
};
