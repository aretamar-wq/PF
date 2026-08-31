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

module.exports = { formatLocal, formatDateOnly, formatTimeOnly, formatCompact, formatCompactMillis };
