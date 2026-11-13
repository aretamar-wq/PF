'use strict';

const crypto = require('crypto');

function sha256(contenido) {
  return crypto.createHash('sha256').update(contenido).digest('hex');
}

// CSV (RFC 4180): comillas dobles con "" para escapar, comas y saltos de línea
// dentro de comillas, CRLF o LF, BOM al principio.
function parseCsv(texto) {
  const rows = [];
  let row = [];
  let cell = '';
  let enComillas = false;
  const s = String(texto).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (enComillas) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          enComillas = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      enComillas = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

const csvCelda = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLinea = (valores) => valores.map(csvCelda).join(',');
// CRLF y punto decimal, como los archivos de Loop.
const csvTexto = (filas) => filas.map(csvLinea).join('\r\n') + '\r\n';

// "15600.000" / "1.234,56" -> centavos enteros. Vacío o inválido -> null.
function centavos(valor) {
  let s = String(valor == null ? '' : valor).trim();
  if (s === '' || s === '—' || s === '-') return null;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const fmtCentavos = (c) => (c == null ? '' : (c / 100).toFixed(2));

const pad2 = (n) => String(n).padStart(2, '0');
const MESES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// Acepta "dd/mm/aaaa", "d/M/aaaa HH:mm:ss.fff", "aaaa-mm-dd HH:mm:ss(.fff)" y el
// formato de isql "Nov 12 2026 10:11AM". Devuelve { fecha: 'aaaa-mm-dd', hora: 'HH:mm:ss' } o null.
function parseFechaHora(valor) {
  const s = String(valor == null ? '' : valor).trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) return { fecha: `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`, hora: `${pad2(m[4] || 0)}:${m[5] || '00'}:${m[6] || '00'}` };
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) return { fecha: `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`, hora: `${pad2(m[4] || 0)}:${m[5] || '00'}:${m[6] || '00'}` };
  m = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?)?/i.exec(s);
  if (m && MESES[m[1].toLowerCase()]) {
    let h = Number(m[4] || 0);
    if (m[7] && /pm/i.test(m[7]) && h < 12) h += 12;
    if (m[7] && /am/i.test(m[7]) && h === 12) h = 0;
    return { fecha: `${m[3]}-${pad2(MESES[m[1].toLowerCase()])}-${pad2(m[2])}`, hora: `${pad2(h)}:${m[5] || '00'}:${m[6] || '00'}` };
  }
  return null;
}

function sumarDias(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// 'aaaa-mm-dd' -> 'dd/mm/aaaa'
const fechaDMY = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

module.exports = { sha256, parseCsv, csvCelda, csvLinea, csvTexto, centavos, fmtCentavos, parseFechaHora, sumarDias, fechaDMY };
