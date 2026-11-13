'use strict';

// Loop (contabilidad): un archivo (o una consulta) por día con los movimientos
// 25030/25031. Valida encabezado, que cada día tenga solo filas de su fecha, que
// no haya filas repetidas entre días ni archivos idénticos, y que un reexport
// REEMPLACE completo al archivo de ese día (no se suma).

const { sha256, parseCsv, centavos, parseFechaHora } = require('../util');

const ENCABEZADO_LOOP = ['sistcod', 'moncod', 'cuecod', 'Fecha_Mov', 'comnro', 'movcod', 'signo', 'accimp', 'Importe'];

// Movimientos_Loop_20261104.csv (original) o Movimientos_Loop_20261104_xxxx.csv (reexport).
function infoNombreLoop(nombre) {
  const m = /Movimientos_Loop_(\d{4})(\d{2})(\d{2})(?:_([^.]+))?\.csv$/i.exec(String(nombre));
  return m ? { fecha: `${m[1]}-${m[2]}-${m[3]}`, sufijo: m[4] || '' } : null;
}

// archivos: [{ nombre, fecha?, contenido }]. Devuelve { partidas, archivos } y
// carga los avisos en "avisos".
function leerLoop(archivos, avisos) {
  const infoArchivos = [];
  const vistos = new Map(); // hash -> nombre
  const candidatos = []; // sin repetidos por hash

  for (const a of archivos) {
    const hash = sha256(a.contenido);
    const nombre = a.nombre;
    const info = a.fecha ? { fecha: a.fecha, sufijo: a.sufijo || '' } : infoNombreLoop(nombre);
    if (!info) {
      avisos.error(`${nombre}: el nombre no tiene la forma Movimientos_Loop_aaaammdd[_xxxx].csv.`);
      continue;
    }
    if (vistos.has(hash)) {
      avisos.advertencia(`${nombre}: es idéntico a ${vistos.get(hash)} (mismo hash): no se procesa de nuevo.`);
      infoArchivos.push({ nombre, tipo: 'loop-dia', hash, filas: '', estado: 'repetido-idéntico' });
      continue;
    }
    vistos.set(hash, nombre);
    candidatos.push({ nombre, hash, fecha: info.fecha, sufijo: info.sufijo, contenido: a.contenido });
  }

  // Un reexport reemplaza al archivo del día; entre varios reexports, el último por sufijo.
  const porFecha = new Map();
  for (const c of candidatos) {
    if (!porFecha.has(c.fecha)) porFecha.set(c.fecha, []);
    porFecha.get(c.fecha).push(c);
  }
  const elegidos = [];
  for (const [fecha, lista] of [...porFecha].sort(([a], [b]) => a.localeCompare(b))) {
    lista.sort((x, y) => (x.sufijo === '' ? -1 : y.sufijo === '' ? 1 : x.sufijo.localeCompare(y.sufijo)));
    const ganador = lista[lista.length - 1];
    for (const c of lista.slice(0, -1)) {
      avisos.info(`${c.nombre}: reemplazado por ${ganador.nombre} (reexport del ${fecha}).`);
      infoArchivos.push({ nombre: c.nombre, tipo: 'loop-dia', hash: c.hash, filas: '', estado: 'reemplazado' });
    }
    elegidos.push(ganador);
  }

  const partidas = [];
  const firmas = new Map(); // fila -> archivo, para detectar repetidas entre archivos
  for (const c of elegidos) {
    const filas = parseCsv(c.contenido);
    const encabezado = (filas[0] || []).map((h) => h.trim());
    if (encabezado.join(',') !== ENCABEZADO_LOOP.join(',')) {
      avisos.error(`${c.nombre}: encabezado inesperado (${encabezado.join(',')}); se esperaba ${ENCABEZADO_LOOP.join(',')}.`);
      continue;
    }
    let fuera = 0;
    let invalidas = 0;
    let n = 0;
    for (const f of filas.slice(1)) {
      const reg = Object.fromEntries(ENCABEZADO_LOOP.map((h, i) => [h, (f[i] == null ? '' : f[i]).trim()]));
      const fechaFila = parseFechaHora(reg.Fecha_Mov);
      const accimp = centavos(reg.accimp);
      const importe = centavos(reg.Importe);
      const signo = Number(reg.signo);
      if (!fechaFila || accimp == null || importe == null || ![-1, 1].includes(signo)) {
        invalidas++;
        continue;
      }
      if (fechaFila.fecha !== c.fecha) {
        fuera++;
        continue;
      }
      const firma = f.map((x) => x.trim()).join('|');
      if (firmas.has(firma) && firmas.get(firma) !== c.nombre) {
        avisos.error(`${c.nombre}: fila repetida entre archivos (también en ${firmas.get(firma)}).`);
        continue;
      }
      firmas.set(firma, c.nombre);
      n++;
      partidas.push({
        sistcod: reg.sistcod,
        moncod: reg.moncod,
        cuecod: reg.cuecod,
        fecha: c.fecha,
        comnro: reg.comnro,
        movcod: reg.movcod,
        signo,
        accimp,
        importe,
        archivo: c.nombre,
      });
    }
    if (fuera > 0) avisos.error(`${c.nombre}: ${fuera} fila(s) con fecha distinta a ${c.fecha}.`);
    if (invalidas > 0) avisos.error(`${c.nombre}: ${invalidas} fila(s) con valores inválidos.`);
    infoArchivos.push({ nombre: c.nombre, tipo: 'loop-dia', hash: c.hash, filas: n, estado: 'usado' });
  }
  return { partidas, archivos: infoArchivos };
}

module.exports = { ENCABEZADO_LOOP, infoNombreLoop, leerLoop };
