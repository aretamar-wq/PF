'use strict';

// Reglas configurables de la conciliación Loop (se pueden pisar con un JSON,
// ver cargarConfig en corrida.js). Todos los importes en centavos enteros.
module.exports = {
  movDebito: '25030', // débito de la transferencia
  movCredito: '25031', // crédito
  sistCliente: '5', // sistcod de la partida en la cuenta del cliente
  cuentasPuente: { 0: '11000492', 2: '11000493' }, // por moncod (0 = pesos, 2 = USD)
  umbralCentavo: 1, // débito de hasta 0,01 sin crédito = "débito de centavo"
  tolerancia: 0, // en centavos (0,005 sobre importes de 2 decimales = igualdad exacta)
  pendientes: { sistcod: '5', movcod: '25030' }, // únicas filas válidas del archivo de pendientes
  monedas: { ARS: '0', USD: '2' }, // Moneda de BankService -> moncod
  digitosCbuMoneda: { ARS: '02', USD: '06' }, // dígitos 9 y 10 del CBU origen
  etiquetasMoneda: { 0: 'ARS', 2: 'USD' },
  // Lo ejecutado un fin de semana o feriado se contabiliza el próximo día hábil
  // (calendario de feriados de Parametría). Si Loop contabiliza por la fecha de la
  // operación, ponerlo en false.
  postergarNoHabiles: true,
};
