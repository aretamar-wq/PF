'use strict';

// Reporte PDF de un día de la "Conciliación FX", como evidencia de auditoría: quién,
// cuándo y con qué datos se concilió (SHA-256 de los datos), semáforo de compra y de
// venta con sus motivos, los indicadores por movimiento y todas las excepciones del día.
// Se arma con los mismos cálculos que el dashboard (wwwroot/fx-calculo.js).

const crypto = require('crypto');
const { Pdf } = require('../transfCaCc/pdf');
const calculo = require('../../../wwwroot/fx-calculo');

const M = 40;
const COLORES = { verde: '#2e9d6b', amarillo: '#f0b429', rojo: '#d92d20' };
const ETIQUETA = { verde: 'Verde: todo OK', amarillo: 'Amarillo: débitos pendientes o a revisar', rojo: 'Rojo: hay diferencias' };
const NOMBRE_LADO = { BUY: 'Compra de USD', SELL: 'Venta de USD' };

const fmtNum = (v) => Number(v || 0).toLocaleString('es-AR');
const fmtImp = (c) => (Number(c || 0) / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dinero = (moneda, c) => `${moneda === 'USD' ? 'US$' : '$'} ${fmtImp(c)}`;
const dmy = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
};
const hora = (s) => String(s || '').slice(11, 19);

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
  const parrafo = (texto, tam = 8, color = '#5b6576') => {
    for (const l of pdf.partir(texto, W, tam)) {
      espacio(tam + 3);
      pdf.texto(M, y, l, { tam, colorHex: color });
      y += tam + 3;
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
      parrafo(`${ETIQUETA[sem.color]}. ${sem.motivos.join(' · ')}`);
      y += 2;
    }
  };
  // Grilla de indicadores: [titulo, valor, detalle, estado].
  const grilla = (items, columnas = 4) => {
    const ancho = (W - (columnas - 1) * 6) / columnas;
    for (let i = 0; i < items.length; i += columnas) {
      const fila = items.slice(i, i + columnas);
      const titulos = fila.map(([tt]) => pdf.partir(tt, ancho - 12, 7).slice(0, 2));
      const detalles = fila.map(([, , d]) => (d ? pdf.partir(d, ancho - 12, 7).slice(0, 2) : []));
      const lt = Math.max(...titulos.map((x) => x.length));
      const ld = Math.max(...detalles.map((x) => x.length));
      const alto = 22 + lt * 9 + ld * 9;
      espacio(alto + 6);
      fila.forEach(([, v, , est], j) => {
        const x = M + j * (ancho + 6);
        const borde = est === 'ok' ? '#2e9d6b' : est === 'err' ? '#d92d20' : est === 'warn' ? '#f0b429' : '#d9dde3';
        const fondo = est === 'ok' ? '#e6f4ec' : est === 'err' ? '#fdecea' : est === 'warn' ? '#fff4e5' : '#f7f8fa';
        pdf.rect(x, y, ancho, alto, { relleno: fondo, borde });
        titulos[j].forEach((l, k) => pdf.texto(x + 6, y + 10 + k * 9, l, { tam: 7, colorHex: '#5b6576' }));
        pdf.texto(x + 6, y + 14 + lt * 9 + 3, v, { tam: 11, negrita: true, colorHex: est === 'err' ? '#b42318' : est === 'ok' ? '#1e7b4f' : est === 'warn' ? '#b54708' : '#1d2433' });
        detalles[j].forEach((l, k) => pdf.texto(x + 6, y + 22 + lt * 9 + 6 + k * 9, l, { tam: 7, colorHex: '#5b6576' }));
      });
      y += alto + 6;
    }
  };
  const tabla = (cols, filas, tam = 7) => {
    const total = cols.reduce((s, c) => s + c.w, 0);
    const k = W / total;
    const encabezado = () => {
      pdf.rect(M, y, W, 14, { relleno: '#eef0f3' });
      let x = M;
      for (const c of cols) {
        const w = c.w * k;
        pdf.texto(c.der ? x + w - 3 : x + 3, y + 10, c.t, { tam, negrita: true, colorHex: '#5b6576', alinear: c.der ? 'der' : 'izq' });
        x += w;
      }
      y += 14;
    };
    espacio(30);
    encabezado();
    for (const fila of filas) {
      const celdas = fila.map((v, i) => pdf.partir(v, cols[i].w * k - 6, tam));
      const alto = Math.max(...celdas.map((c) => c.length)) * (tam + 2) + 4;
      if (y + alto > pdf.alto - M - 20) {
        pdf.nuevaPagina();
        y = M;
        encabezado();
      }
      let x = M;
      celdas.forEach((lineas, i) => {
        const w = cols[i].w * k;
        lineas.forEach((l, j) => pdf.texto(cols[i].der ? x + w - 3 : x + 3, y + 9 + j * (tam + 2), l, { tam, alinear: cols[i].der ? 'der' : 'izq' }));
        x += w;
      });
      y += alto;
      pdf.linea(M, y, M + W, y, { grosor: 0.3 });
    }
  };

  const huella = crypto.createHash('sha256').update(JSON.stringify({ rango: datos.rango, generado: datos.generado, movimientos: datos.movimientos, pendientes: datos.pendientes, ordenes: datos.ordenes })).digest('hex');
  const lados = datos.lados.map((l) => {
    const ind = calculo.indicadores(datos, dia, l);
    return { l, ind, sem: calculo.semaforo(ind, l) };
  });

  pdf.texto(M, y + 14, 'Conciliación FX', { tam: 16, negrita: true });
  y += 30;
  pdf.texto(M, y, `Reporte del ${dmy(dia)}`, { tam: 11, negrita: true, colorHex: '#1f4e8c' });
  y += 16;
  const u = datos.ultimaCarga;
  parrafo(`Conciliación: datos de IBS al ${dmy(datos.generado)} ${hora(datos.generado)}. Reporte generado el ${dmy(ahora.toISOString())} ${ahora.toTimeString().slice(0, 8)} por ${usuario}.`);
  parrafo(`Corte: último día de IBS ${dmy(datos.corte.ultimoDiaIbs)}; mayor comprobante de IBS ${fmtNum(datos.corte.mayorComprobante)}.`);
  parrafo(`Última carga de BankService FX: ${u ? `${u.nombre} · ${dmy(u.cargado_en)} ${hora(u.cargado_en)} · órdenes hasta el ${u.corte ? dmy(u.corte) : '—'}` : 'sin cargas'}.`);
  parrafo(`SHA-256 de los datos conciliados: ${huella}`);
  y += 4;
  for (const a of datos.avisos || []) parrafo(`Aviso: ${a}`, 8, '#b54708');

  for (const { l, ind, sem } of lados) {
    const { bs, ibs } = ind;
    const est = calculo.estados(ind, l);
    const dif = bs.incompletas + bs.sinRegistro;
    titulo(l.titulo, sem);
    grilla([
      ['Órdenes COMPLETED en BankService', fmtNum(bs.completadas), `FAILED ${fmtNum(bs.failed)}${bs.revision ? ` · en revisión ${fmtNum(bs.revision)}` : ''}`],
      ['Importe en pesos', dinero('ARS', bs.ars), ''],
      ['Importe en USD', dinero('USD', bs.usd), ''],
      ['Tipo de cambio promedio', bs.usd ? dinero('ARS', Math.round((bs.ars / bs.usd) * 100)) : '—', 'pesos / USD'],
    ]);
    grilla(l.movs.map((m) => [`${m.cod} ${m.nombre}`, fmtNum(ibs[m.cod].n), dinero(m.moneda, ibs[m.cod].importe), est.movs[m.cod]]), 6);
    grilla([
      ['Órdenes completas en IBS', fmtNum(bs.completas), `de ${fmtNum(bs.completadas)} COMPLETED`, est.completas],
      ['Órdenes con débito pendiente', fmtNum(bs.pendientes), `${dinero('ARS', bs.pendArs)} · ${dinero('USD', bs.pendUsd)}`, est.conPendiente],
      ['Órdenes con movimientos faltantes', fmtNum(dif), `${fmtNum(bs.incompletas)} incompletas · ${fmtNum(bs.sinRegistro)} sin registro${bs.porContabilizar ? ` · ${fmtNum(bs.porContabilizar)} por contabilizar` : ''}`, est.faltantes],
      ['FAILED o en revisión con movimientos en IBS', fmtNum(bs.noCompletadasEnIbs), `de ${fmtNum(bs.failed + bs.revision)} no COMPLETED`, est.noCompletadas],
      ['Movimientos de IBS sin orden en BankService', fmtNum(ind.sinOrden.comprobantes), `${fmtNum(ind.sinOrden.n)} movimiento(s) · ${dinero('ARS', ind.sinOrden.ARS)} · ${dinero('USD', ind.sinOrden.USD)}`, est.sinOrden],
    ], 5);
    const pd = ind.pendDia;
    grilla([
      ['Débitos pendientes del día en pesos', fmtNum(pd.ARS.n), dinero('ARS', pd.ARS.importe), est.pendArs],
      ['Débitos pendientes del día en USD', fmtNum(pd.USD.n), dinero('USD', pd.USD.importe), est.pendUsd],
      ['Débitos pendientes del día', fmtNum(pd.ARS.n + pd.USD.n), `${dinero('ARS', pd.ARS.importe)} · ${dinero('USD', pd.USD.importe)}`, est.pendDia],
      ['Movimientos manuales', fmtNum(ind.manuales), 'usuarios que no son de proceso'],
    ]);
  }

  const excepciones = lados.flatMap(({ ind }) => ind.excepciones);
  titulo(`Excepciones a revisar (${fmtNum(excepciones.length)})`);
  if (excepciones.length === 0) {
    parrafo('Sin excepciones.', 8.5);
  } else {
    const filas = excepciones.slice().sort((a, b) => a.tipo.localeCompare(b.tipo, 'es') || (Number(a.comprobante) || 0) - (Number(b.comprobante) || 0));
    tabla([{ t: 'Tipo', w: 12 }, { t: 'Oper.', w: 7 }, { t: 'Comprob.', w: 7, der: true }, { t: 'Cuenta', w: 7, der: true }, { t: 'CUIT', w: 11 }, { t: 'Mon.', w: 5 }, { t: 'Fecha', w: 9 }, { t: 'Importe', w: 13, der: true }, { t: 'Usuario', w: 9 }, { t: 'Estado BS', w: 11 }, { t: 'Detalle', w: 21 }],
      filas.map((e) => [e.tipo, NOMBRE_LADO[e.lado] || e.lado || '—', e.comprobante, e.cuenta || '—', e.cuit || '—', e.moneda, dmy(e.fecha), e.importe == null ? '—' : dinero(e.moneda, e.importe), e.usuario || '—', (e.estadoBs || '—').replace(/_/g, '_ '), e.detalle]), 6.5);
  }

  const totalPaginas = pdf.paginas.length;
  pdf.paginas.forEach((pagina, i) => {
    pdf.texto(M, pdf.alto - 22, `Conciliación FX · Reporte del ${dmy(dia)} · SHA-256 datos ${huella.slice(0, 16)}…`, { tam: 7, colorHex: '#5b6576', pagina });
    pdf.texto(M + W, pdf.alto - 22, `Página ${i + 1} de ${totalPaginas}`, { tam: 7, colorHex: '#5b6576', alinear: 'der', pagina });
  });

  const buffer = pdf.aBuffer({ titulo: `Conciliación FX - Reporte del ${dmy(dia)}`, autor: usuario, asunto: `SHA-256 de los datos: ${huella}`, fecha: ahora });
  const nombre = `conciliacion-fx-${dia}-${ahora.toISOString().slice(0, 19).replace(/[-:T]/g, '')}.pdf`;
  return { buffer, nombre, huellaDatos: huella, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

module.exports = { generarReporte };
