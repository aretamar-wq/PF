'use strict';

// Generador mínimo de PDF (sin dependencias): páginas A4, Helvetica y
// Helvetica-Bold con WinAnsiEncoding (acentos y ñ), texto, líneas, rectángulos y
// círculos. Coordenadas con origen arriba a la izquierda, en puntos (1/72").

// Anchos AFM (milésimas de em) de los caracteres 32..126.
const ANCHOS = {
  regular: [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584],
  bold: [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584],
};
// Caracteres fuera de ASCII: código WinAnsi y letra base para el ancho.
const ESPECIALES = { '—': [0x97, 1000], '–': [0x96, 556], '·': [0xb7, 278], '°': [0xb0, 400], 'º': [0xba, 365], 'ª': [0xaa, 370], '¿': [0xbf, 611], '¡': [0xa1, 333], '“': [0x93, 333], '”': [0x94, 333], '‘': [0x91, 222], '’': [0x92, 222], '€': [0x80, 556], '…': [0x85, 1000] };
const REEMPLAZOS = { '→': '->', '≠': '<>', '≤': '<=', '≥': '>=', '▲': '^', '▼': 'v', ' ': ' ', ' ': ' ' };

function base(ch) {
  return ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizar(texto) {
  let s = '';
  for (const ch of String(texto == null ? '' : texto)) s += REEMPLAZOS[ch] || ch;
  return s;
}

function anchoCaracter(ch, negrita) {
  const tabla = negrita ? ANCHOS.bold : ANCHOS.regular;
  if (ESPECIALES[ch]) return ESPECIALES[ch][1];
  let c = ch.charCodeAt(0);
  if (c >= 32 && c <= 126) return tabla[c - 32];
  const b = base(ch);
  c = b.charCodeAt(0);
  if (b.length === 1 && c >= 32 && c <= 126) return tabla[c - 32];
  return 556;
}

// Texto -> bytes WinAnsi escapados para un string PDF.
function codificar(texto) {
  let out = '';
  for (const ch of normalizar(texto)) {
    let code;
    if (ESPECIALES[ch]) code = ESPECIALES[ch][0];
    else {
      code = ch.charCodeAt(0);
      if (code > 255) code = 63; // '?'
    }
    if (code === 40 || code === 41 || code === 92) out += '\\' + String.fromCharCode(code);
    else if (code < 32) out += ' ';
    else out += String.fromCharCode(code);
  }
  return out;
}

const color = (hex) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '#000000');
  return [1, 2, 3].map((i) => (parseInt(m[i], 16) / 255).toFixed(3)).join(' ');
};
const n = (v) => (Math.round(v * 100) / 100).toString();

class Pdf {
  constructor({ ancho = 595.28, alto = 841.89 } = {}) {
    this.ancho = ancho;
    this.alto = alto;
    this.paginas = [];
    this.nuevaPagina();
  }

  nuevaPagina() {
    this.actual = [];
    this.paginas.push(this.actual);
    return this.paginas.length;
  }

  medir(texto, tam = 9, negrita = false) {
    let w = 0;
    for (const ch of normalizar(texto)) w += anchoCaracter(ch, negrita);
    return (w * tam) / 1000;
  }

  // Corta el texto en líneas que entren en `ancho`.
  partir(texto, ancho, tam = 9, negrita = false) {
    const lineas = [];
    for (const parrafo of String(texto == null ? '' : texto).split('\n')) {
      let linea = '';
      for (let palabra of parrafo.split(/\s+/).filter(Boolean)) {
        // Una palabra más ancha que la columna se corta por caracteres.
        while (this.medir(palabra, tam, negrita) > ancho && palabra.length > 1) {
          let corte = palabra.length - 1;
          while (corte > 1 && this.medir(palabra.slice(0, corte), tam, negrita) > ancho) corte--;
          if (linea) lineas.push(linea);
          lineas.push(palabra.slice(0, corte));
          linea = '';
          palabra = palabra.slice(corte);
        }
        const prueba = linea ? `${linea} ${palabra}` : palabra;
        if (this.medir(prueba, tam, negrita) <= ancho || !linea) linea = prueba;
        else {
          lineas.push(linea);
          linea = palabra;
        }
      }
      lineas.push(linea);
    }
    return lineas;
  }

  texto(x, y, texto, { tam = 9, negrita = false, colorHex = '#1d2433', alinear = 'izq', pagina } = {}) {
    let px = x;
    if (alinear === 'der') px = x - this.medir(texto, tam, negrita);
    else if (alinear === 'centro') px = x - this.medir(texto, tam, negrita) / 2;
    (pagina || this.actual).push(`BT ${color(colorHex)} rg /${negrita ? 'F2' : 'F1'} ${n(tam)} Tf ${n(px)} ${n(this.alto - y)} Td (${codificar(texto)}) Tj ET`);
  }

  linea(x1, y1, x2, y2, { colorHex = '#d9dde3', grosor = 0.5 } = {}) {
    this.actual.push(`${color(colorHex)} RG ${n(grosor)} w ${n(x1)} ${n(this.alto - y1)} m ${n(x2)} ${n(this.alto - y2)} l S`);
  }

  rect(x, y, w, h, { relleno = '#f7f8fa', borde } = {}) {
    const op = borde ? `${color(borde)} RG 0.5 w ${color(relleno)} rg ${n(x)} ${n(this.alto - y - h)} ${n(w)} ${n(h)} re B` : `${color(relleno)} rg ${n(x)} ${n(this.alto - y - h)} ${n(w)} ${n(h)} re f`;
    this.actual.push(op);
  }

  circulo(cx, cy, r, { relleno = '#2e9d6b' } = {}) {
    const k = 0.5523 * r;
    const y = this.alto - cy;
    this.actual.push(`${color(relleno)} rg ${n(cx + r)} ${n(y)} m ${n(cx + r)} ${n(y + k)} ${n(cx + k)} ${n(y + r)} ${n(cx)} ${n(y + r)} c ` +
      `${n(cx - k)} ${n(y + r)} ${n(cx - r)} ${n(y + k)} ${n(cx - r)} ${n(y)} c ${n(cx - r)} ${n(y - k)} ${n(cx - k)} ${n(y - r)} ${n(cx)} ${n(y - r)} c ` +
      `${n(cx + k)} ${n(y - r)} ${n(cx + r)} ${n(y - k)} ${n(cx + r)} ${n(y)} c f`);
  }

  // -> Buffer con el PDF completo. info: { titulo, autor, asunto, fecha (Date) }.
  aBuffer(info = {}) {
    const objetos = [];
    const agregar = (contenido) => {
      objetos.push(contenido);
      return objetos.length;
    };
    const catalogo = agregar(null);
    const paginasId = agregar(null);
    const f1 = agregar('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = agregar('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = [];
    for (const ops of this.paginas) {
      const stream = ops.join('\n');
      const contenido = agregar(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
      kids.push(agregar(`<< /Type /Page /Parent ${paginasId} 0 R /MediaBox [0 0 ${n(this.ancho)} ${n(this.alto)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${contenido} 0 R >>`));
    }
    objetos[catalogo - 1] = `<< /Type /Catalog /Pages ${paginasId} 0 R >>`;
    objetos[paginasId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    const f = info.fecha || new Date();
    const p2 = (v) => String(v).padStart(2, '0');
    const fechaPdf = `D:${f.getFullYear()}${p2(f.getMonth() + 1)}${p2(f.getDate())}${p2(f.getHours())}${p2(f.getMinutes())}${p2(f.getSeconds())}`;
    const infoId = agregar(`<< /Title (${codificar(info.titulo || '')}) /Author (${codificar(info.autor || '')}) /Subject (${codificar(info.asunto || '')}) /Producer (ApiCore) /CreationDate (${fechaPdf}) >>`);

    let salida = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets = [];
    objetos.forEach((o, i) => {
      offsets.push(Buffer.byteLength(salida, 'latin1'));
      salida += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = Buffer.byteLength(salida, 'latin1');
    salida += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) salida += `${String(off).padStart(10, '0')} 00000 n \n`;
    salida += `trailer\n<< /Size ${objetos.length + 1} /Root ${catalogo} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(salida, 'latin1');
  }
}

module.exports = { Pdf, codificar };
