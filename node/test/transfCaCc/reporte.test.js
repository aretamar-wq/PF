'use strict';
const test = require('node:test');
const assert = require('node:assert');
const config = require('../../lib/transfCaCc/config');
const { conciliar } = require('../../lib/transfCaCc/conciliar');
const { generarReporte } = require('../../lib/transfCaCc/reporte');
const { Pdf } = require('../../lib/transfCaCc/pdf');

const op = (c, f, monto, estado = 'APPROVED') => ({ comprobante: String(c), moncod: '0', cuecod: '1', monto, estado, creada: `${f} 10:00:00`, ejecutada: `${f} 10:00:00`, fecha: f, error: '' });
const mov = (c, f, imp) => ({ usuario: '123123123', sistcod: '5', moncod: '0', cuecod: '1', fecha: f, comprobante: String(c), movcod: '25030', signo: -1, importe: imp });

test('PDF: estructura válida (xref con offsets correctos) y acentos en WinAnsi', () => {
  const pdf = new Pdf();
  pdf.texto(40, 40, 'Conciliación — año ñandú (paréntesis)');
  const b = pdf.aBuffer({ titulo: 'Prueba' });
  const s = b.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  const xref = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.strictEqual(s.slice(xref, xref + 4), 'xref');
  for (const m of s.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)) {
    assert.match(s.slice(Number(m[1]), Number(m[1]) + 10), /^\d+ 0 obj/);
  }
  assert.ok(s.includes('Conciliaci\xf3n \x97 a\xf1o \xf1and\xfa \\(par\xe9ntesis\\)'));
});

test('reporte del día: varias páginas con muchas excepciones, nombre y huellas', () => {
  const ops = [];
  const movs = [];
  for (let i = 0; i < 300; i++) {
    ops.push(op(1000 + i, '2026-11-16', 100));
    movs.push({ ...mov(1000 + i, '2026-11-16', 100), usuario: 'manual' }); // 300 débitos manuales
  }
  const r = conciliar({ movimientos: movs, pendientes: [], operaciones: ops, config });
  const datos = { ...r, rango: { desde: '2026-11-16', hasta: '2026-11-17' }, generado: '2026-11-16 18:00:00', config: { movDebito: '25030', movCredito: '25031' }, avisos: [], ultimaCarga: null };
  const rep = generarReporte({ datos, dia: '2026-11-16', usuario: 'auditor', ahora: new Date('2026-11-19T15:30:00') });
  const s = rep.buffer.toString('latin1');
  const paginas = Number(/\/Count (\d+)/.exec(s)[1]);
  assert.ok(paginas >= 5, `páginas: ${paginas}`);
  assert.match(rep.nombre, /^conciliacion-ca-cc-2026-11-16-\d{14}\.pdf$/);
  assert.match(rep.sha256, /^[0-9a-f]{64}$/);
  assert.ok(s.includes(`SHA-256 de los datos: ${rep.huellaDatos}`));
  assert.ok(s.includes(`P\xe1gina ${paginas} de ${paginas}`));
});
