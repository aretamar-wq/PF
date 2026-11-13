#!/usr/bin/env node
'use strict';

// Lista, para pedir la devolución al banco, las transferencias DEBIN que se
// realizaron más de una vez: mismo CUIT de débito y mismo comprobante, con
// realizado = 's' en más de un envío (distinto idMensaje). Lee los archivos
// files/*-consulta-debin-solo.csv (no necesita la base) y escribe un CSV con
// UNA FILA POR CADA ENVÍO DE MÁS (el DEBIN a devolver), con el del primer
// envío como referencia.
//
// Uso (desde la carpeta node/):
//   node scripts/duplicadas-debin.js                              (todos los archivos, escribe duplicadas-debin.csv)
//   node scripts/duplicadas-debin.js --desde 2026-10-01 --hasta 2026-11-02
//   node scripts/duplicadas-debin.js --out /ruta/salida.csv
//   node scripts/duplicadas-debin.js --dir /otra/carpeta/files

const fs = require('fs');
const path = require('path');

function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

const csvEscape = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

// PFC20261021123021406 -> 2026-10-21 12:30:21
function fechaDeIdMensaje(idMensaje) {
  const m = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(idMensaje || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : '';
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : '';
}

function main() {
  const args = process.argv.slice(2);
  const dir = argValue(args, '--dir') || path.join(__dirname, '..', '..', 'files');
  const out = argValue(args, '--out') || 'duplicadas-debin.csv';
  const desde = argValue(args, '--desde');
  const hasta = argValue(args, '--hasta');

  const envios = new Map(); // idMensaje -> registro (sin repetir entre archivos)
  for (const name of fs.readdirSync(dir).filter((n) => /-consulta-debin-solo\.csv$/.test(n)).sort()) {
    const lines = fs.readFileSync(path.join(dir, name), 'utf8').split(/\r\n|\r|\n/).filter(Boolean).map(parseCsvLine);
    const header = lines[0] || [];
    for (const row of lines.slice(1)) {
      const g = (k) => String(row[header.indexOf(k)] == null ? '' : row[header.indexOf(k)]).trim();
      if (g('realizado') !== 's' || !g('idComprobante') || !g('idMensaje')) continue;
      const fecha = fechaDeIdMensaje(g('idMensaje'));
      if ((desde && fecha.slice(0, 10) < desde) || (hasta && fecha.slice(0, 10) > hasta)) continue;
      envios.set(g('idMensaje'), {
        fecha,
        idMensaje: g('idMensaje'),
        idComprobante: g('idComprobante'),
        idOperacion: g('idOperacion'),
        debitoCuit: g('debitoCuit'),
        debitoCbu: g('debitoCbu'),
        debitoTitular: g('debitoTitular'),
        creditoCuit: g('creditoCuit'),
        creditoCbu: g('creditoCbu'),
        creditoTitular: g('creditoTitular'),
        moneda: g('moneda'),
        importe: g('importe'),
        estado: g('estadoCodigo'),
        estadoDescripcion: g('estadoDescripcion'),
      });
    }
  }

  const grupos = new Map();
  for (const e of envios.values()) {
    const clave = `${e.debitoCuit}|${e.idComprobante}`;
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(e);
  }

  const headers = [
    'debitoCuit', 'debitoTitular', 'debitoCbu', 'idComprobante', 'moneda', 'importe',
    'creditoCuit', 'creditoTitular', 'creditoCbu',
    'idOperacionADevolver', 'fechaADevolver', 'estadoADevolver',
    'idOperacionOriginal', 'fechaOriginal', 'estadoOriginal', 'mismoImporte',
  ];
  const filas = [];
  for (const lista of grupos.values()) {
    if (lista.length < 2) continue;
    lista.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.idMensaje.localeCompare(b.idMensaje));
    const [primero, ...demas] = lista;
    for (const e of demas) {
      filas.push({
        debitoCuit: e.debitoCuit, debitoTitular: e.debitoTitular, debitoCbu: e.debitoCbu,
        idComprobante: e.idComprobante, moneda: e.moneda, importe: e.importe,
        creditoCuit: e.creditoCuit, creditoTitular: e.creditoTitular, creditoCbu: e.creditoCbu,
        idOperacionADevolver: e.idOperacion, fechaADevolver: e.fecha, estadoADevolver: e.estado,
        idOperacionOriginal: primero.idOperacion, fechaOriginal: primero.fecha, estadoOriginal: primero.estado,
        mismoImporte: Number(e.importe) === Number(primero.importe) ? 'SI' : 'NO',
      });
    }
  }
  filas.sort((a, b) => a.fechaADevolver.localeCompare(b.fechaADevolver));

  fs.writeFileSync(out, [headers.join(','), ...filas.map((f) => headers.map((h) => csvEscape(f[h])).join(','))].join('\r\n') + '\r\n');

  const total = (list) => list.reduce((s, f) => s + Math.round(Number(f.importe) * 100), 0) / 100;
  const acreditadas = filas.filter((f) => f.estadoADevolver === 'ACREDITADO');
  const fmt = (n) => n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  console.log(`${envios.size} envío(s) realizados leídos; ${filas.length} DEBIN de más a devolver por $ ${fmt(total(filas))}.`);
  console.log(`De esos, ${acreditadas.length} figuran ACREDITADO por $ ${fmt(total(acreditadas))}.`);
  const mon = new Set(filas.map((f) => f.moneda));
  if (mon.size > 1) console.log(`Ojo: hay más de una moneda (${[...mon].join(', ')}); los totales las suman sin distinguir.`);
  console.log(`CSV escrito en ${path.resolve(out)}`);
}

main();
