'use strict';

// Avisos de validación de una corrida. Un error corta la corrida (código de
// salida 1); una advertencia deja seguir (código 2); info es solo para el log.
function crearAvisos() {
  const lista = [];
  const agregar = (nivel) => (mensaje) => lista.push({ nivel, mensaje });
  return {
    lista,
    error: agregar('error'),
    advertencia: agregar('advertencia'),
    info: agregar('info'),
    errores: () => lista.filter((a) => a.nivel === 'error'),
    advertencias: () => lista.filter((a) => a.nivel === 'advertencia'),
    codigoSalida() {
      if (lista.some((a) => a.nivel === 'error')) return 1;
      if (lista.some((a) => a.nivel === 'advertencia')) return 2;
      return 0;
    },
  };
}

module.exports = { crearAvisos };
