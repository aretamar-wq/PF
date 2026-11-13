'use strict';

// Fuente "Sybase": Loop (un día por consulta) y los débitos pendientes salen
// directo de IBS con las consultas del área. Devuelve el mismo CSV que los
// archivos, para que se validen y se guarden igual en el histórico.

const { csvTexto, sumarDias } = require('../util');
const { ENCABEZADO_LOOP } = require('../lectura/loop');
const { ENCABEZADO_PENDIENTES } = require('../lectura/pendientes');

// Las fechas van como 'aaaammdd': Sybase las interpreta igual sea cual sea el
// dateformat de la sesión (el '11/12/2026' de una consulta manual depende de él).
function consultaLoop(fechaISO, config) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaISO)) throw new Error(`Fecha inválida: '${fechaISO}'.`);
  const desde = fechaISO.replace(/-/g, '');
  const hasta = sumarDias(fechaISO, 1).replace(/-/g, '');
  return `select a.sistcod, a.moncod, a.cuecod, convert(varchar, a.fecmov, 103) 'Fecha_Mov', a.comnro, a.movcod, b.signo, b.accimp, b.signo * b.accimp 'Importe'
from tgl_movimientos a, tgl_movimientos_aper b
where a.fecmov >= '${desde}'
  and a.fecmov < '${hasta}'
  and a.concod = ' '
  and a.fecreal = b.fecreal
  and a.tercod = b.tercod
  and b.funcod = 1
  and a.movcod in (${config.movDebito}, ${config.movCredito})
order by a.comnro`;
}

// Tal cual la consulta del área; el filtro por tipo (sistcod 5 / movcod 25030)
// lo valida leerPendientes y rechaza el archivo si llega otra cosa.
function consultaPendientes(config) {
  return `select b.fecreal, b.tercod, b.succod, b.sistcod, b.moncod, b.cuecod, movcod, descdet, b.fecproceso, b.comnro, b.nromen, m.mentexto, b.importedeb, fecenlace, fecorigen
From Banksys..tgl_deb_pendientes b
inner join Banksys..tgt_transaccion a on b.paiscod = a.paiscod and
b.bcocod = a.bcocod and
b.sistcod = a.sistcod and
b.trancod = a.trancod
left outer join Banksys..tdoc_mensages m on b.nromen = m.nromen
Where
b.paiscod = 54 and
b.bcocod = 312 and
b.succod = 1 and
a.tipofunc in (0,1)
and a.movcod in (${config.movDebito}, ${config.movCredito})

order by b.fecorigen, b.fecreal, b.fecenlace, b.cuecod`;
}

const aTexto = (encabezado, filas) =>
  csvTexto([encabezado, ...filas.map((f) => encabezado.map((c) => (f[c] == null ? '' : String(f[c]).trim())))]);

const esFinDeSemana = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
};

// querySybase(parametriaSybase, sql) -> filas como objetos (ver sybaseClient.js).
function crearFuenteSybase(parametriaSybase, querySybase, config, opciones = {}) {
  const avisar = opciones.progreso || (() => {});
  return {
    nombre: 'sybase',
    async loopDias(desde, hasta) {
      const archivos = [];
      for (let dia = desde; dia <= hasta; dia = sumarDias(dia, 1)) {
        if (esFinDeSemana(dia)) continue; // los fines de semana no generan movimientos
        const filas = await querySybase(parametriaSybase, consultaLoop(dia, config));
        avisar(`Loop ${dia}: ${filas.length} fila(s)`);
        if (filas.length === 0) continue; // feriado: no genera archivo
        archivos.push({ nombre: `Movimientos_Loop_${dia.replace(/-/g, '')}.csv`, fecha: dia, contenido: aTexto(ENCABEZADO_LOOP, filas) });
      }
      return archivos;
    },
    async pendientes() {
      const filas = await querySybase(parametriaSybase, consultaPendientes(config));
      avisar(`Débitos pendientes: ${filas.length} fila(s)`);
      return { nombre: 'Debitos_Pendientes.csv', contenido: aTexto(ENCABEZADO_PENDIENTES, filas) };
    },
  };
}

module.exports = { consultaLoop, consultaPendientes, crearFuenteSybase };
