'use strict';

// Marca de cada comprobante, en este orden (primera que aplica):
//   1. Más de 2 partidas
//   2. Débito de centavo sin crédito
//   3. Con 1 partida (el crédito) y un débito pendiente con la misma clave:
//        Débito pendiente del último día / anterior / Pendiente con importe distinto
//   4. Una partida
//   5. Importes distintos (2 partidas, neto distinto de 0)
//   6. Correcto (2 partidas, neto 0, aunque débito y crédito tengan fechas distintas)

const MARCAS = {
  MAS_DE_DOS: 'Más de 2 partidas',
  CENTAVO: 'Débito de centavo sin crédito',
  PEND_ULTIMO: 'Débito pendiente del último día',
  PEND_ANTERIOR: 'Débito pendiente anterior',
  PEND_DISTINTO: 'Pendiente con importe distinto',
  UNA_PARTIDA: 'Una partida',
  IMPORTES_DISTINTOS: 'Importes distintos',
  CORRECTO: 'Correcto',
};
const MARCAS_PENDIENTE = [MARCAS.PEND_ULTIMO, MARCAS.PEND_ANTERIOR, MARCAS.PEND_DISTINTO];

const dinero = (c) => (c / 100).toFixed(2);

// ctx: { pendiente, ultimoDia, config, debitosPorCuentaImporte: Map('moncod|cuenta|importe' -> [comnro]) }
function marcar(c, ctx) {
  const { pendiente, ultimoDia, config } = ctx;
  const iguales = (a, b) => Math.abs(a - b) <= config.tolerancia;

  if (c.partidas > 2) return { marca: MARCAS.MAS_DE_DOS, detalle: `${c.partidas} partidas en Loop (neto ${dinero(c.neto)}).` };
  if (c.partidas === 1 && c.credito === 0 && c.debito <= config.umbralCentavo) {
    return { marca: MARCAS.CENTAVO, detalle: `Débito de ${dinero(c.debito)} sin crédito y sin operación en BankService.` };
  }
  if (c.partidas === 1 && c.credito > 0 && pendiente) {
    if (iguales(pendiente.importedeb, c.credito)) {
      return c.fechaCredito === ultimoDia
        ? { marca: MARCAS.PEND_ULTIMO, detalle: `Crédito del ${c.fechaCredito}; débito pendiente por ${dinero(pendiente.importedeb)}.` }
        : { marca: MARCAS.PEND_ANTERIOR, detalle: `Crédito del ${c.fechaCredito}; débito pendiente por ${dinero(pendiente.importedeb)} desde el ${pendiente.fechaOrigen}.` };
    }
    const cruzados = (ctx.debitosPorCuentaImporte.get(`${c.moncod}|${c.cuenta || pendiente.cuecod}|${pendiente.importedeb}`) || []).filter((n) => n !== c.comnro);
    return {
      marca: MARCAS.PEND_DISTINTO,
      detalle:
        `Crédito de ${dinero(c.credito)} y débito pendiente de ${dinero(pendiente.importedeb)}.` +
        (cruzados.length > 0 ? ` El comprobante ${cruzados.join(', ')} de la misma cuenta tiene un débito por exactamente ese importe: posible débito cruzado o duplicado.` : ''),
    };
  }
  if (c.partidas === 1) {
    return { marca: MARCAS.UNA_PARTIDA, detalle: c.credito > 0 ? `Solo el crédito de ${dinero(c.credito)}.` : `Solo el débito de ${dinero(c.debito)}.` };
  }
  if (Math.abs(c.neto) > config.tolerancia) return { marca: MARCAS.IMPORTES_DISTINTOS, detalle: `Débito ${dinero(c.debito)} y crédito ${dinero(c.credito)}: neto ${dinero(c.neto)}.` };
  return { marca: MARCAS.CORRECTO, detalle: '' };
}

module.exports = { MARCAS, MARCAS_PENDIENTE, marcar };
