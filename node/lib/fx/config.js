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
        { cod: '25001', moneda: 'ARS', titular: 'cliente', nombre: 'Cliente · pesos', cuentaFija: '11000524' },
        { cod: '25002', moneda: 'ARS', titular: 'cocos', nombre: 'Cocos Capital S.A. · pesos' },
        { cod: '25003', moneda: 'ARS', titular: 'cliente', nombre: 'Cliente · pesos' },
        { cod: '25004', moneda: 'USD', titular: 'cliente', nombre: 'Cliente · USD' },
        { cod: '25005', moneda: 'USD', titular: 'cocos', nombre: 'Cocos Capital S.A. · USD' },
        { cod: '25006', moneda: 'USD', titular: 'cliente', nombre: 'Cliente · USD', cuentaFija: '11000525' },
      ],
    },
    {
      lado: 'SELL',
      clave: 'venta',
      titulo: 'IBS - FX Venta de USD (25007 - 25012)',
      movs: [
        { cod: '25007', moneda: 'USD', titular: 'cliente', nombre: 'Cliente · USD', cuentaFija: '11000525' },
        { cod: '25008', moneda: 'USD', titular: 'cocos', nombre: 'Cocos Capital S.A. · USD' },
        { cod: '25009', moneda: 'USD', titular: 'cliente', nombre: 'Cliente · USD' },
        { cod: '25010', moneda: 'ARS', titular: 'cliente', nombre: 'Cliente · pesos' },
        { cod: '25011', moneda: 'ARS', titular: 'cocos', nombre: 'Cocos Capital S.A. · pesos' },
        { cod: '25012', moneda: 'ARS', titular: 'cliente', nombre: 'Cliente · pesos', cuentaFija: '11000524' },
      ],
    },
  ],
  // cuentaFija: la cuenta en la que siempre va ese movimiento (11000524 en pesos y
  // 11000525 en dólares para 25001, 25012, 25006 y 25007).
  // Titular de la cuenta de cada movimiento (titular de cada mov de lados): el cliente
  // de la orden (en las excepciones va su nombre, customerFullName) o Cocos Capital S.A.
  titulares: { cliente: 'Cliente', cocos: 'Cocos Capital S.A.' },
  // CUIT de los titulares fijos (el del cliente viene en cada orden de BankService).
  cuitTitulares: { cocos: '30708424478' },
  monedas: { ARS: '0', USD: '2' },
  usuariosProceso: ['123123123', '36077255'],
  estadosFinales: ['COMPLETED', 'FAILED'],
  // Órdenes que no se tienen en cuenta en la conciliación (ni en los indicadores ni
  // en excepciones), salvo que IBS tenga movimientos de su comprobante.
  estadosIgnorados: ['ABANDONED'],
};
