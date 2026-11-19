'use strict';

// Reporte PDF de un día (o de todo el período) de la "Conciliación Transferencias
// CA -> CC", como evidencia de auditoría: encabezado con quién, cuándo y con qué
// datos se concilió (incluido el SHA-256 de los datos), semáforos con sus motivos,
// los indicadores de las secciones, el saldo de pendientes y todas
// las excepciones del día. Se arma con los mismos cálculos que el dashboard.

const crypto = require('crypto');
const { Pdf } = require('./pdf');
const calculo = require('../../../wwwroot/transf-ca-cc-calculo');

const M = 40; // margen
const COLORES = { verde: '#2e9d6b', amarillo: '#f0b429', rojo: '#d92d20' };
const ETIQUETA = { verde: 'Verde: todo OK', amarillo: 'Amarillo: débitos pendientes o a revisar', rojo: 'Rojo: hay diferencias' };

const fmtNum = (v) => Number(v || 0).toLocaleString('es-AR');
const fmtImp = (c) => (Number(c || 0) / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dinero = (moncod, c) => `${String(moncod) === '2' || moncod === 'USD' ? 'US$' : '$'} ${fmtImp(c)}`;
const dmy = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
};
const hora = (s) => String(s || '').slice(11, 19);
const sumarDias = (iso, d) => {
  const x = new Date(`${iso}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
};

function generarReporte({ datos, dia, usuario, ahora = new Date() }) {
  const pdf = new Pdf();
  const W = pdf.ancho - 2 * M;
  let y = M;
  const espacio = (alto) => {
    if (y + alto > pdf.alto - M - 20) {
      pdf.nuevaPagina();
      y = M;
    }
  };
  const titulo = (texto, sem) => {
    espacio(40);
    y += 14;
    let x = M;
    if (sem) {
      pdf.circulo(M + 5, y - 4, 5, { relleno: COLORES[sem.color] });
      x += 16;
    }
    pdf.texto(x, y, texto, { tam: 12, negrita: true });
    y += 5;
    pdf.linea(M, y, M + W, y);
    y += 12;
    if (sem) {
      for (const l of pdf.partir(`${ETIQUETA[sem.color]}. ${sem.motivos.join(' · ')}`, W, 8)) {
        espacio(11);
        pdf.texto(M, y, l, { tam: 8, colorHex: '#5b6576' });
        y += 11;
      }
      y += 2;
    }
  };
  // Grilla de indicadores: [titulo, valor, detalle].
  const grilla = (items, columnas = 4) => {
    const ancho = (W - (columnas - 1) * 6) / columnas;
    for (let i = 0; i < items.length; i += columnas) {
      const fila = items.slice(i, i + columnas);
      // Título de hasta 2 líneas y detalle de hasta 2 líneas: el alto se ajusta a la fila.
      const titulos = fila.map(([tt]) => pdf.partir(tt, ancho - 12, 7).slice(0, 2));
      const detalles = fila.map(([, , d]) => (d ? pdf.partir(d, ancho - 12, 7).slice(0, 2) : []));
      const lt = Math.max(...titulos.map((x) => x.length));
      const ld = Math.max(...detalles.map((x) => x.length));
      const alto = 22 + lt * 9 + ld * 9;
      espacio(alto + 6);
      fila.forEach(([, v, , estado], j) => {
        const x = M + j * (ancho + 6);
        const borde = estado === 'ok' ? '#2e9d6b' : estado === 'err' ? '#d92d20' : estado === 'warn' ? '#f0b429' : '#d9dde3';
        const fondo = estado === 'ok' ? '#e6f4ec' : estado === 'err' ? '#fdecea' : estado === 'warn' ? '#fff4e5' : '#f7f8fa';
        pdf.rect(x, y, ancho, alto, { relleno: fondo, borde });
        titulos[j].forEach((l, k) => pdf.texto(x + 6, y + 10 + k * 9, l, { tam: 7, colorHex: '#5b6576' }));
        pdf.texto(x + 6, y + 14 + lt * 9 + 3, v, { tam: 12, negrita: true, colorHex: estado === 'err' ? '#b42318' : estado === 'ok' ? '#1e7b4f' : estado === 'warn' ? '#b54708' : '#1d2433' });
        detalles[j].forEach((l, k) => pdf.texto(x + 6, y + 22 + lt * 9 + 6 + k * 9, l, { tam: 7, colorHex: '#5b6576' }));
      });
      y += alto + 6;
    }
  };
  // Tabla con encabezado repetido en cada página. cols: [{ t, w, der }].
  const tabla = (cols, filas, tam = 7.5) => {
    const total = cols.reduce((s, c) => s + c.w, 0);
    const esc = W / total;
    const encabezado = () => {
      pdf.rect(M, y, W, 14, { relleno: '#eef0f3' });
      let x = M;
      for (const c of cols) {
        const w = c.w * esc;
        pdf.texto(c.der ? x + w - 3 : x + 3, y + 10, c.t, { tam, negrita: true, colorHex: '#5b6576', alinear: c.der ? 'der' : 'izq' });
        x += w;
      }
      y += 14;
    };
    espacio(30);
    encabezado();
    for (const fila of filas) {
      const celdas = fila.map((v, i) => pdf.partir(v, cols[i].w * esc - 6, tam));
      const alto = Math.max(...celdas.map((c) => c.length)) * (tam + 2) + 4;
      if (y + alto > pdf.alto - M - 20) {
        pdf.nuevaPagina();
        y = M;
        encabezado();
      }
      let x = M;
      celdas.forEach((lineas, i) => {
        const w = cols[i].w * esc;
        lineas.forEach((l, k) => pdf.texto(cols[i].der ? x + w - 3 : x + 3, y + 9 + k * (tam + 2), l, { tam, alinear: cols[i].der ? 'der' : 'izq' }));
        x += w;
      });
      y += alto;
      pdf.linea(M, y, M + W, y, { grosor: 0.3 });
    }
  };

  const ind = calculo.indicadores(datos, dia || '');
  const sem = calculo.semaforos(ind);
  const { ibs, activar, bs, total } = ind;
  const porMoneda = (o) => `Pesos ${fmtNum(o[0])} · USD ${fmtNum(o[2])}`;
  const hastaIncl = sumarDias(datos.rango.hasta, -1);
  const alcance = dia ? `del ${dmy(dia)}` : `del ${dmy(datos.rango.desde)} al ${dmy(hastaIncl)}`;
  const huella = crypto.createHash('sha256').update(JSON.stringify({ rango: datos.rango, generado: datos.generado, movimientos: datos.movimientos, pendientes: datos.pendientes, operaciones: datos.operaciones })).digest('hex');

  // Encabezado
  pdf.texto(M, y + 14, 'Conciliación Transferencias CA -> CC', { tam: 16, negrita: true });
  y += 30;
  pdf.texto(M, y, `Reporte ${alcance}`, { tam: 11, negrita: true, colorHex: '#1f4e8c' });
  y += 16;
  const u = datos.ultimaCarga;
  const lineasEnc = [
    `Conciliación: datos de IBS al ${dmy(datos.generado)} ${hora(datos.generado)} (período de IBS ${dmy(datos.rango.desde)} al ${dmy(hastaIncl)}). Reporte generado el ${dmy(ahora.toISOString())} ${ahora.toTimeString().slice(0, 8)} por ${usuario}.`,
    `Corte: último día de IBS ${dmy(datos.corte.ultimoDiaIbs)}; mayor comprobante de IBS ${fmtNum(datos.corte.mayorComprobante)}.`,
    `Última carga de BankService: ${u ? `${u.nombre} · ${dmy(u.cargado_en)} ${hora(u.cargado_en)} · corte (mayor Ejecutada) ${u.corte ? `${dmy(u.corte)} ${hora(u.corte)}` : '—'}` : 'sin cargas'}.`,
    `SHA-256 de los datos conciliados: ${huella}`,
  ];
  for (const l of lineasEnc.flatMap((x) => pdf.partir(x, W, 8))) {
    pdf.texto(M, y, l, { tam: 8, colorHex: '#5b6576' });
    y += 11;
  }
  y += 4;
  const resumen = `${fmtNum(total(bs.pendientes))} operación(es) con débito pendiente (${fmtNum(total(bs.pendientesUltimoDia))} del último día y ${fmtNum(total(bs.pendientesAnteriores))} anteriores), ${fmtNum(total(bs.sinRegistro))} sin registro en IBS y ${fmtNum(total(bs.porContabilizar))} pendientes de contabilizar. Importe pendiente: ${dinero('0', bs.importePendiente[0])} y ${dinero('2', bs.importePendiente[2])}.`;
  for (const l of pdf.partir(resumen, W, 9.5)) {
    pdf.texto(M, y, l, { tam: 9.5 });
    y += 13;
  }
  for (const a of datos.avisos || []) {
    for (const l of pdf.partir(`Aviso: ${a}`, W, 8)) {
      espacio(11);
      pdf.texto(M, y, l, { tam: 8, colorHex: '#b54708' });
      y += 11;
    }
  }

  const sinReg = total(bs.sinRegistro);
  const col = calculo.coloresTransferencias(ind);
  titulo('IBS - Transferencias Loop (25030 - 25031)', sem.transferencias);
  grilla([
    ['Operaciones en BankService (APPROVED)', fmtNum(total(bs.aprobadas)), porMoneda(bs.aprobadas)],
    ['Débitos 25030', fmtNum(total(ibs.debitos)), porMoneda(ibs.debitos), col.debitos],
    ['Créditos 25031', fmtNum(total(ibs.creditos)), porMoneda(ibs.creditos), col.creditos],
    ['Débitos pendientes', fmtNum(total(ibs.pendientes)), porMoneda(ibs.pendientes), col.pendientes],
  ]);
  grilla([
    ['Transferencias BankService en pesos', dinero('0', bs.importeAprobadas[0]), `${fmtNum(bs.aprobadas[0])} APPROVED`],
    ['Débitos en pesos', dinero('0', ibs.saldoDebitos[0]), '', col.saldoDebitos[0]], ['Créditos 25031 en pesos', dinero('0', ibs.saldoCreditos[0]), '', col.saldoCreditos[0]], ['Débitos pendientes en pesos', dinero('0', ibs.saldoPendientes[0]), '', col.saldoPendientes[0]],
  ], 4);
  grilla([
    ['Transferencias BankService en USD', dinero('2', bs.importeAprobadas[2]), `${fmtNum(bs.aprobadas[2])} APPROVED`],
    ['Débitos en USD', dinero('2', ibs.saldoDebitos[2]), '', col.saldoDebitos[2]], ['Créditos 25031 en USD', dinero('2', ibs.saldoCreditos[2]), '', col.saldoCreditos[2]], ['Débitos pendientes en USD', dinero('2', ibs.saldoPendientes[2]), '', col.saldoPendientes[2]],
  ], 4);
  grilla([
    ['Débitos manuales en pesos', fmtNum(ibs.manuales[0]), dinero('0', ibs.importeManuales[0])], ['Débitos manuales en USD', fmtNum(ibs.manuales[2]), dinero('2', ibs.importeManuales[2])],
  ], 2);
  grilla([
    ['APPROVED que no figuran en IBS ni en pendientes', fmtNum(sinReg), `${porMoneda(bs.sinRegistro)}${total(bs.porContabilizar) ? ` · ${fmtNum(total(bs.porContabilizar))} pendientes de contabilizar` : ''}`, sinReg === 0 ? 'ok' : 'err'],
    ['Operaciones FAILED en BS que figuran en IBS', fmtNum(bs.failedEnIbs), `de ${fmtNum(bs.failed)} operaciones FAILED en BankService`, bs.failedEnIbs === 0 ? 'ok' : 'err'],
  ], 2);

  titulo('IBS - Activar Cuentas', sem.activar);
  grilla([
    ['Transacciones de 1 centavo (comprobantes)', fmtNum(total(activar.comprobantes)), porMoneda(activar.comprobantes)],
    ['Créditos de 1 centavo', fmtNum(total(activar.creditos)), porMoneda(activar.creditos)],
    ['Débitos de 1 centavo', fmtNum(total(activar.debitos)), porMoneda(activar.debitos)],
  ], 3);


  // Saldo de pendientes (de la fecha de la operación) dentro del alcance del reporte.
  titulo('Saldo de débitos pendientes por día');
  const { saldo } = calculo.porDia(datos, dia || datos.rango.desde, dia || hastaIncl);
  if (saldo.length === 0) {
    pdf.texto(M, y, 'No hay débitos pendientes.', { tam: 8.5, colorHex: '#5b6576' });
    y += 14;
  } else {
    tabla([{ t: 'Fecha', w: 10 }, { t: 'Operaciones en pesos', w: 12, der: true }, { t: 'Pesos', w: 16, der: true }, { t: 'Acumulado en pesos', w: 16, der: true }, { t: 'Operaciones en USD', w: 12, der: true }, { t: 'USD', w: 14, der: true }, { t: 'Acumulado en USD', w: 14, der: true }],
      saldo.map((s) => [dmy(s.fecha), fmtNum(s.nPend[0]), dinero('0', s.importePend[0]), dinero('0', s.acumulado[0]), fmtNum(s.nPend[2]), dinero('2', s.importePend[2]), dinero('2', s.acumulado[2])]));
  }

  titulo(`Excepciones a revisar (${fmtNum(ind.excepciones.length)})`);
  if (ind.excepciones.length === 0) {
    pdf.texto(M, y, 'Sin excepciones.', { tam: 8.5, colorHex: '#5b6576' });
    y += 14;
  } else {
    const filas = ind.excepciones.slice().sort((a, b) => a.tipo.localeCompare(b.tipo, 'es') || String(a.fecha).localeCompare(String(b.fecha)) || (Number(a.comprobante) || 0) - (Number(b.comprobante) || 0));
    tabla([{ t: 'Tipo', w: 16 }, { t: 'Comprobante', w: 9, der: true }, { t: 'Cuenta', w: 8, der: true }, { t: 'Moneda', w: 6 }, { t: 'Fecha', w: 9 }, { t: 'Importe', w: 12, der: true }, { t: 'Usuario', w: 8 }, { t: 'Estado BS', w: 12 }, { t: 'Detalle', w: 28 }],
      filas.map((e) => [e.tipo, e.comprobante, e.cuenta || '—', e.moneda, dmy(e.fecha), e.importe == null ? '—' : dinero(e.moneda === 'USD' ? '2' : '0', e.importe), e.usuario || '—', (e.estadoBs || '—').replace('_', '_ '), e.detalle]), 7);
  }

  // Pie: página y huella en todas las páginas.
  const totalPaginas = pdf.paginas.length;
  pdf.paginas.forEach((pagina, i) => {
    pdf.texto(M, pdf.alto - 22, `Conciliación Transferencias CA -> CC · Reporte ${alcance} · SHA-256 datos ${huella.slice(0, 16)}…`, { tam: 7, colorHex: '#5b6576', pagina });
    pdf.texto(M + W, pdf.alto - 22, `Página ${i + 1} de ${totalPaginas}`, { tam: 7, colorHex: '#5b6576', alinear: 'der', pagina });
  });

  const buffer = pdf.aBuffer({ titulo: `Conciliación Transferencias CA -> CC - Reporte ${alcance}`, autor: usuario, asunto: `SHA-256 de los datos: ${huella}`, fecha: ahora });
  const nombre = `conciliacion-ca-cc-${dia || `${datos.rango.desde}-a-${hastaIncl}`}-${ahora.toISOString().slice(0, 19).replace(/[-:T]/g, '')}.pdf`;
  return { buffer, nombre, huellaDatos: huella, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

module.exports = { generarReporte };
