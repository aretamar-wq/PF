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
        { cod: '25001', moneda: 'ARS', titular: 'cocos', nombre: 'Cuenta Corriente 11000524 · pesos', cuentaFija: '11000524' },
        { cod: '25002', moneda: 'ARS', titular: 'cliente', nombre: 'Caja de Ahorro del cliente · pesos' },
        { cod: '25003', moneda: 'ARS', titular: 'cliente', nombre: 'Caja de Ahorro del cliente · pesos' },
        { cod: '25004', moneda: 'USD', titular: 'cliente', nombre: 'Caja de Ahorro del cliente · USD' },
        { cod: '25005', moneda: 'USD', titular: 'cliente', nombre: 'Caja de Ahorro del cliente · USD' },
        { cod: '25006', moneda: 'USD', titular: 'cocos', nombre: 'Cuenta Corriente 11000525 · USD', cuentaFija: '11000525' },
      ],
    },
    {
      lado: 'SELL',
      clave: 'venta',
      titulo: 'IBS - FX Venta de USD (25007 - 25012)',
      movs: [
        { cod: '25007', moneda: 'USD', titular: 'cocos', nombre: 'Cuenta Corriente 11000525 · USD', cuentaFija: '11000525' },
        { cod: '25008', moneda: 'USD', titular: 'cliente', nombre: 'Caja de Ahorro del cliente · USD' },
        { cod: '25009', moneda: 'USD', titular: 'cliente', nombre: 'Caja de Ahorro del cliente · USD' },
        { cod: '25010', moneda: 'ARS', titular: 'cliente', nombre: 'Caja de Ahorro del cliente · pesos' },
        { cod: '25011', moneda: 'ARS', titular: 'cliente', nombre: 'Caja de Ahorro del cliente · pesos' },
        { cod: '25012', moneda: 'ARS', titular: 'cocos', nombre: 'Cuenta Corriente 11000524 · pesos', cuentaFija: '11000524' },
      ],
    },
  ],
  // Según IBS: 25001/25012 van en la Cuenta Corriente 11000524 (pesos) y 25006/25007
  // en la 11000525 (dólares), siempre las mismas (cuentaFija); 25002 a 25005 y 25008 a
  // 25011 van en las Cajas de Ahorro del cliente, en pesos y en dólares (el crédito y
  // el débito de cada moneda en la misma cuenta).
  // Titular de la cuenta de cada movimiento: el cliente de la orden (en las
  // excepciones va su nombre, customerFullName) o Cocos Capital S.A. (las Cuentas
  // Corrientes fijas).
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
