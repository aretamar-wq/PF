'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseCsv, centavos, parseFechaHora, csvTexto } = require('../../lib/qnet/util');

test('parseCsv: comillas con comas, "" escapada, CRLF y LF, BOM', () => {
  const filas = parseCsv('﻿a,b,c\r\n"x, y","di ""hola""",—\nz,,\n');
  assert.deepStrictEqual(filas, [['a', 'b', 'c'], ['x, y', 'di "hola"', '—'], ['z', '', '']]);
});

test('csvTexto: CRLF y escapa comillas y comas', () => {
  assert.strictEqual(csvTexto([['a', 'b,c'], ['"x"', 1]]), 'a,"b,c"\r\n"""x""",1\r\n');
});

test('centavos: punto decimal, 3 decimales, coma decimal y vacíos', () => {
  assert.strictEqual(centavos('15600.000'), 1560000);
  assert.strictEqual(centavos('5333430.56'), 533343056);
  assert.strictEqual(centavos('-0.01'), -1);
  assert.strictEqual(centavos('1.234,56'), 123456);
  assert.strictEqual(centavos('12,5'), 1250);
  assert.strictEqual(centavos('—'), null);
  assert.strictEqual(centavos(''), null);
});

test('parseFechaHora: los formatos de Loop, pendientes, BankService e isql', () => {
  assert.deepStrictEqual(parseFechaHora('04/11/2026'), { fecha: '2026-11-04', hora: '00:00:00' });
  assert.deepStrictEqual(parseFechaHora('2/5/2026 9:03:07.123'), { fecha: '2026-05-02', hora: '09:03:07' });
  assert.deepStrictEqual(parseFechaHora('2026-11-12 23:58:41'), { fecha: '2026-11-12', hora: '23:58:41' });
  assert.deepStrictEqual(parseFechaHora('Nov  3 2026  2:15PM'), { fecha: '2026-11-03', hora: '14:15:00' });
  assert.deepStrictEqual(parseFechaHora('Nov 12 2026 12:05AM'), { fecha: '2026-11-12', hora: '00:05:00' });
  assert.strictEqual(parseFechaHora(''), null);
  assert.strictEqual(parseFechaHora('basura'), null);
});
