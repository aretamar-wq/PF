'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { construirDashboardHtml } = require('../../lib/qnet/reportes/dashboard');

const datos = (extra = {}) => ({
  id: 'abc123def456', exitCode: 0, archivos: [], avisos: [{ nivel: 'advertencia', mensaje: 'un aviso con </script><b>html</b>' }],
  periodo: { primerDia: '2026-10-01', ultimoDia: '2026-11-12' }, corte: { ejecutada: '2026-11-12 23:58:41', dia: '2026-11-12' },
  partidasTotal: 4, comprobantesTotal: 2, comprobantesConMarca: 1,
  cruce: { total: 1, approved: 1, failed: 0, pending: 0, encontradas: 1, sinDiferencias: 1, approvedSinRegistro: 0, pendientesDeContabilizar: 0, fueraDelPeriodo: 0 },
  totales: { ARS: { neto: 5000, pendientes: 5000, sinCubrir: 0, comprobantes: 2 } },
  antiguedad: { filas: [], tramos: [] }, resumenPorTipo: [], pendientesPosteriores: [],
  excepciones: [{ tipo: 'Una partida', comprobante: '10', cuenta: '5001', moneda: 'ARS', fecha: '2026-11-02', importe: 5000, estadoTransfer: '', debitoPendiente: null, detalle: 'Solo el débito de 50.00.' }],
  ...extra,
});

test('Dashboard: HTML autocontenido con los datos embebidos', () => {
  const html = construirDashboardHtml(datos());
  assert.match(html, /^<!doctype html>/);
  assert.ok(!/<script[^>]+src=|<link[^>]+href=|https?:\/\//.test(html), 'sin pedidos a recursos externos');
  const json = /<script id="datos" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1];
  const d = JSON.parse(json);
  assert.strictEqual(d.id, 'abc123def456');
  assert.strictEqual(d.excepciones.length, 1);
});

test('Dashboard: un texto con </script> no rompe el HTML (se escapa el "<")', () => {
  const html = construirDashboardHtml(datos());
  assert.strictEqual((html.match(/<\/script>/g) || []).length, 2, 'solo los dos cierres propios (datos y código)');
  const d = JSON.parse(/<script id="datos" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.match(d.avisos[0].mensaje, /<\/script><b>html<\/b>/);
});

test('Dashboard: el código del navegador es sintácticamente válido y usa formato es-AR con $ y US$', () => {
  const html = construirDashboardHtml(datos());
  const codigo = /<script>(\(function cliente[\s\S]*)<\/script>\s*<\/body>/.exec(html)[1];
  assert.doesNotThrow(() => new Function(codigo));
  assert.match(codigo, /'es-AR'/);
  assert.match(codigo, /US\$/);
});
