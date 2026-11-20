'use strict';

// Reglas de la conciliación "Transferencias CA -> CC" (QNET entre IBS/Loop, débitos
// pendientes y BankService). Importes en centavos enteros.
module.exports = {
  movDebito: '25030',
  movCredito: '25031',
  // Pares de movimientos que se concilian contra BankService, cada uno en su sección.
  // Una operación de BankService va con el par de movimientos (o de débito pendiente)
  // que tiene su comprobante en IBS; si no tiene ninguno, con el primero.
  grupos: [
    { clave: 'loop', titulo: 'IBS - Transferencias CA -> CC (25030 - 25031)', etiqueta: '25030-25031', movDebito: '25030', movCredito: '25031' },
    { clave: 'g2', titulo: 'IBS - Pago de Servicios (25032 - 25033)', etiqueta: '25032-25033', movDebito: '25032', movCredito: '25033' },
  ],
  movimientos: ['25030', '25031', '25032', '25033'],
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
