'use strict';

// Fuente "archivos": los CSV de Loop (uno por día, con reexports) y el de
// pendientes ya exportados. Sirve para volver a correr con lo que se guardó en
// el histórico o cuando no hay conexión a Sybase.

const fs = require('fs');
const path = require('path');

function crearFuenteArchivos({ loopDir, pendientesFile }) {
  return {
    nombre: 'archivos',
    async loopDias(desde, hasta) {
      // Solo los archivos de las fechas pedidas (el reexport de un día lleva el mismo aaaammdd).
      const dentro = (n) => {
        const f = /^Movimientos_Loop_(\d{4})(\d{2})(\d{2})/i.exec(n);
        const iso = f ? `${f[1]}-${f[2]}-${f[3]}` : '';
        return iso && (!desde || iso >= desde) && (!hasta || iso <= hasta);
      };
      return fs
        .readdirSync(loopDir)
        .filter((n) => /^Movimientos_Loop_\d{8}.*\.csv$/i.test(n) && dentro(n))
        .sort()
        .map((n) => ({ nombre: n, contenido: fs.readFileSync(path.join(loopDir, n), 'utf8') }));
    },
    async pendientes() {
      return { nombre: path.basename(pendientesFile), contenido: fs.readFileSync(pendientesFile, 'utf8') };
    },
  };
}

module.exports = { crearFuenteArchivos };
