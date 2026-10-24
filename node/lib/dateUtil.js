'use strict';

// Formatea en hora LOCAL (no UTC) para que coincida con lo que escribía la
// versión PowerShell (Get-Date sin -AsUTC usa la hora local del servidor).

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

function formatLocal(date = new Date(), withMillis = false) {
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return withMillis ? `${base}.${pad(date.getMilliseconds(), 3)}` : base;
}

// yyyy-MM-dd
function formatDateOnly(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// HH:mm:ss
function formatTimeOnly(date = new Date()) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// yyyyMMddHHmm
function formatCompact(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
}

// yyyyMMddHHmmssfff
function formatCompactMillis(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`;
}

// ddMMyyyyHHmmss — usado como identificador compartido entre el log de una
// corrida (logs/http/) y sus archivos de salida (files/), para que ambos
// lados se puedan encontrar por nombre sin necesitar parsear nada (ver
// generateRunLogFileName en flowEngine.js).
function formatCompactDMY(date = new Date()) {
  return `${pad(date.getDate())}${pad(date.getMonth() + 1)}${date.getFullYear()}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// dd/MM/yyyy — mismo formato en el que queda guardado fecha_vencimiento en
// operaciones_procesadas (lo que devuelve el banco al dar de alta el plazo
// fijo). Se usa para el "hoy" del flow "Pago de Plazo Fijos"
// (findOperationsToPay en processedOperationsStore.js), que compara por
// igualdad de texto contra esa columna.
function formatDateOnlyDMY(date = new Date()) {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

// dd/mm/yyyy -> yyyy-MM-dd — conversión de texto pura (sin pasar por un
// objeto Date, que podría reinterpretar la fecha en otra zona horaria): la
// fecha de proceso bancaria viene de Sybase en dd/mm/yyyy (ver
// FECHA_PROCESO_QUERY en server.js, CONVERT(..., 103)), pero el resto de
// los flows (FechaMovimiento/FechaNegocio del body hacia el banco) esperan
// el mismo formato yyyy-MM-dd que ya usa {{nowDate}} en todos lados.
function convertDMYToISO(dmy) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(dmy || '').trim());
  if (!match) {
    throw new Error(`Fecha '${dmy}' no tiene el formato esperado dd/mm/yyyy.`);
  }
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

module.exports = {
  formatLocal,
  formatDateOnly,
  formatTimeOnly,
  formatCompact,
  formatCompactMillis,
  formatCompactDMY,
  formatDateOnlyDMY,
  convertDMYToISO,
};
