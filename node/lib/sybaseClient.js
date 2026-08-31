'use strict';

// Cliente Sybase para el backend Node.js.
//
// A diferencia del backend PowerShell (que se conecta directo a Sybase por ODBC
// vía System.Data.Odbc — ver Invoke-SqlStep/Test-SybaseConnection en
// modules/FlowEngine.psm1), acá la conexión pasa por un servicio/API intermedio
// que ya existe en la organización, en vez de ODBC directo desde Node.
//
// TODO: cablear acá la llamada real a esa API una vez que se tengan los
// detalles (URL, método, formato de request/response, autenticación). Hasta
// entonces, tanto testSybaseConnection como querySybase devuelven un error
// explícito en vez de fallar en silencio o simular una respuesta exitosa —
// así un step "type": "sql" o el botón "Probar conexión" de Parametría avisan
// claro que falta esta parte, en vez de comportarse de forma inconsistente.
//
// Cuando se cablee la API real, estas son las dos únicas funciones que hace
// falta tocar; el resto del flow engine (flowEngine.js) ya está preparado
// para llamarlas tal cual están.

const NOT_WIRED_MESSAGE =
  'La conexión a Sybase todavía no está conectada a la API intermedia en el backend Node.js (ver TODO en node/lib/sybaseClient.js).';

// parametria.sybase trae { connectionString, usuario, password } — mismo shape
// que usa el backend PowerShell (parametriaStore.js). Reemplazar el cuerpo de
// esta función por la llamada real (ej. fetch a la API intermedia) cuando esté
// disponible; connectionString hoy no se usa acá, queda disponible por si la
// API intermedia necesita algún dato de ahí (host, base, etc.).
async function testSybaseConnection(_parametriaSybase) {
  const start = Date.now();
  return {
    ok: false,
    message: NOT_WIRED_MESSAGE,
    durationMs: Date.now() - start,
  };
}

// queryText ya viene con las variables del flow ya interpoladas (mismo
// Expand-Template que arma el resto de bodies/paths — ver flowEngine.js). Debe
// devolver un array de objetos plain (una fila = un objeto columna -> valor),
// igual que hace PowerShell leyendo el OdbcDataReader.
async function querySybase(_parametriaSybase, _queryText) {
  throw new Error(NOT_WIRED_MESSAGE);
}

module.exports = { testSybaseConnection, querySybase };
