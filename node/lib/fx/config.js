'use strict';

// Reglas de la "Conciliación FX": órdenes de compra / venta de dólares de BankService
// (fx-orders-settlement-*.csv) contra los movimientos de IBS 25001 a 25012 y los
// débitos pendientes. Importes en centavos.
//
// Cada orden COMPLETED genera 6 movimientos con su receiptNumber como comprobante:
//   Compra de USD (BUY, el cliente paga pesos):   25001 a 25006
//   Venta de USD (SELL, el cliente paga dólares): 25007 a 25012
// Los débitos al cliente que no se pueden hacer quedan en débitos pendientes.
module.exports = {
  movimientos: ['25001', '25002', '25003', '25004', '25005', '25006', '25007', '25008', '25009', '25010', '25011', '25012'],
  lados: [
    {
      lado: 'BUY',
      clave: 'compra',
      titulo: 'IBS - FX Compra de USD (25001 - 25006)',
      movs: [
        { cod: '25001', moneda: 'ARS', nombre: 'Puente pesos' },
        { cod: '25002', moneda: 'ARS', nombre: 'Crédito pesos cliente' },
        { cod: '25003', moneda: 'ARS', nombre: 'Débito pesos cliente' },
        { cod: '25004', moneda: 'USD', nombre: 'Crédito USD cliente' },
        { cod: '25005', moneda: 'USD', nombre: 'Débito USD cliente' },
        { cod: '25006', moneda: 'USD', nombre: 'Puente USD' },
      ],
    },
    {
      lado: 'SELL',
      clave: 'venta',
      titulo: 'IBS - FX Venta de USD (25007 - 25012)',
      movs: [
        { cod: '25007', moneda: 'USD', nombre: 'Puente USD' },
        { cod: '25008', moneda: 'USD', nombre: 'Crédito USD cliente' },
        { cod: '25009', moneda: 'USD', nombre: 'Débito USD cliente' },
        { cod: '25010', moneda: 'ARS', nombre: 'Crédito pesos cliente' },
        { cod: '25011', moneda: 'ARS', nombre: 'Débito pesos cliente' },
        { cod: '25012', moneda: 'ARS', nombre: 'Puente pesos' },
      ],
    },
  ],
  monedas: { ARS: '0', USD: '2' },
  usuariosProceso: ['123123123', '36077255'],
  estadosFinales: ['COMPLETED', 'FAILED'],
  // Órdenes que no se tienen en cuenta en la conciliación (ni en los indicadores ni
  // en excepciones), salvo que IBS tenga movimientos de su comprobante.
  estadosIgnorados: ['ABANDONED'],
};
