'use strict';

// Agrupa las partidas de Loop por comprobante (clave: moncod + comnro): cantidad
// de partidas, neto (suma de Importe), débito y crédito (suma de accimp según el
// código de movimiento), fecha de cada uno y la cuenta del cliente.

const claveDe = (moncod, comnro) => `${moncod}|${comnro}`;

function agruparComprobantes(partidas, config) {
  const puente = new Set(Object.values(config.cuentasPuente).map(String));
  const mapa = new Map();
  for (const p of partidas) {
    const clave = claveDe(p.moncod, p.comnro);
    let c = mapa.get(clave);
    if (!c) {
      c = { clave, moncod: p.moncod, comnro: p.comnro, partidas: 0, neto: 0, debito: 0, credito: 0, fechaDebito: '', fechaCredito: '', cuenta: '' };
      mapa.set(clave, c);
    }
    c.partidas++;
    c.neto += p.importe;
    if (p.movcod === config.movDebito) {
      c.debito += p.accimp;
      if (!c.fechaDebito || p.fecha < c.fechaDebito) c.fechaDebito = p.fecha;
    } else if (p.movcod === config.movCredito) {
      c.credito += p.accimp;
      if (!c.fechaCredito || p.fecha < c.fechaCredito) c.fechaCredito = p.fecha;
    }
    // La cuenta es la de la partida del cliente (sistcod 5), nunca la cuenta puente.
    if (!c.cuenta && p.sistcod === config.sistCliente && !puente.has(String(p.cuecod))) c.cuenta = String(parseInt(p.cuecod, 10));
  }
  return mapa;
}

module.exports = { claveDe, agruparComprobantes };
