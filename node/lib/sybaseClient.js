'use strict';

// Cliente Sybase para el backend Node.js — vía isql (SAP Open Client/Server,
// "OCS"), corriendo como subproceso por cada query.
//
// Por qué isql y no ODBC: en el servidor de referencia de este deployment
// (RHEL, SAP OCS 16.0 en /opt/sap) no hay unixODBC instalado ni ningún driver
// ODBC de Sybase — solo el Open Client nativo (ct-lib/db-lib) y sus
// herramientas de línea de comandos (isql, bcp). SAP tampoco provee ningún
// binding de Node.js para ese OCS (sí para Python/Perl/PHP), así que la
// opción realista sin agregar otro runtime al deployment es invocar isql
// como subproceso y parsear su salida.
//
// Trade-offs conocidos de este enfoque (aceptados explícitamente, no bugs):
//   - La contraseña de Sybase viaja como argumento de línea de comandos
//     (-P) del proceso isql mientras corre esa query puntual — visible vía
//     `ps aux`/`/proc/<pid>/cmdline` para cualquier usuario con acceso al
//     mismo servidor durante esa ventana (a diferencia de una conexión ODBC
//     en proceso, que nunca expone la contraseña como argumento de otro
//     proceso). Si esto es inaceptable, la alternativa es restringir
//     `hidepid=2` en /proc a nivel de SO, o migrar a un binding más robusto
//     (ver el aviso "Opción B" que se descartó en README > Sybase).
//   - El parseo de la tabla de resultados de isql es por posición de
//     columna (usa la línea de guiones "---- ----" para ubicar cada
//     columna) — funciona bien con los datos típicos de esta app (códigos
//     de cuenta, DNI, montos), pero un valor con salto de línea embebido
//     rompería el parseo. No es un problema para las queries que usan hoy
//     los flows de este repo.
//   - Solo se parsea el PRIMER result set de la query (los flows de este
//     repo hacen un único SELECT por step SQL).

const { spawn } = require('child_process');

// Configuración del entorno SAP OCS — todo sobreescribible por variable de
// entorno del proceso, por si en otro servidor cambia la ruta de
// instalación, la versión del OCS, o el locale que hace falta forzar (ver
// el error típico "context allocation routine failed... localization
// files" cuando LANG del sistema no está en locales.dat del OCS).
const SYBASE_HOME = process.env.SYBASE_HOME || '/opt/sap';
const SYBASE_OCS_DIR = process.env.SYBASE_OCS_DIR || 'OCS-16_0';
const SYBASE_LANG = process.env.SYBASE_LANG || 'en_US.UTF-8';
const ISQL_PATH = process.env.SYBASE_ISQL_PATH || `${SYBASE_HOME}/${SYBASE_OCS_DIR}/bin/isql`;
const ISQL_TIMEOUT_MS = Number(process.env.SYBASE_ISQL_TIMEOUT_MS) || 30000;
const ISQL_DISPLAY_WIDTH = process.env.SYBASE_ISQL_WIDTH || '8000';
// SYBASE.sh es el script que trae el propio OCS para armar su entorno
// (SYBASE/SYBASE_OCS/PATH/LD_LIBRARY_PATH) — entre otras cosas agrega
// lib3p64/ (donde vive la librería de cifrado que usa el handshake de
// login) además de lib/. En vez de reconstruir esas variables a mano acá
// (fácil de dejar una carpeta afuera, como pasó con lib3p64 en una
// versión anterior de este archivo — isql fallaba con "CS-LIBRARY
// error: comn_cryptolib_load()... Failed to load library"), se invoca
// isql DENTRO de un bash que sourcea este mismo script primero: así se
// usa exactamente el mismo mecanismo de entorno que ya probamos a mano
// y funciona.
const SYBASE_ENV_SCRIPT = process.env.SYBASE_ENV_SCRIPT || `${SYBASE_HOME}/SYBASE.sh`;

// Escapa un valor para insertarlo entre comillas simples en un comando de
// bash sin riesgo de que se interprete como parte del shell (crítico para
// la contraseña, que puede traer $, `, ", espacios, etc.) — el truco
// estándar de POSIX para "comilla simple dentro de comilla simple".
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// parametria.sybase.connectionString sigue el mismo template que usa el
// backend PowerShell (Driver={Adaptive Server Enterprise};NetworkAddress=
// host,puerto;Database=nombre;Uid={{usuario}};Pwd={{password}}) — no hace
// falta reinventar un formato de configuración aparte para Node: se
// reutiliza el mismo campo, extrayendo host/puerto/base de ahí (Driver=/
// Uid=/Pwd= se ignoran, usuario/password llegan aparte, ya resueltos).
function parseConnectionString(connectionString) {
  const networkMatch = /NetworkAddress\s*=\s*([^,;]+)\s*,\s*(\d+)/i.exec(connectionString || '');
  if (!networkMatch) {
    throw new Error("No se pudo interpretar 'NetworkAddress=host,puerto' en el connection string de Sybase (Parametría > Conexión Sybase).");
  }
  const databaseMatch = /Database\s*=\s*([^;]+)/i.exec(connectionString || '');
  return {
    host: networkMatch[1].trim(),
    port: networkMatch[2].trim(),
    database: databaseMatch ? databaseMatch[1].trim() : null,
  };
}

function runIsql(host, port, usuario, password, sqlBatch) {
  return new Promise((resolve, reject) => {
    // "-S<host>:<puerto>" tiene que llegar como un único argumento (sin
    // espacio entre -S y el valor) — concatenar comilla simple pegada al
    // flag y bash arma un solo token igual, sin romper el quoting.
    const isqlCommand = [
      `source ${shellQuote(SYBASE_ENV_SCRIPT)} > /dev/null`,
      [
        'exec',
        shellQuote(ISQL_PATH),
        `-S${shellQuote(`${host}:${port}`)}`,
        `-U${shellQuote(usuario)}`,
        `-P${shellQuote(password)}`,
        '-w',
        shellQuote(ISQL_DISPLAY_WIDTH),
      ].join(' '),
    ].join(' && ');

    let child;
    try {
      child = spawn('/bin/bash', ['-c', isqlCommand], {
        env: { ...process.env, LANG: SYBASE_LANG, LC_ALL: SYBASE_LANG },
      });
    } catch (err) {
      reject(new Error(`No se pudo ejecutar isql (${ISQL_PATH}): ${err.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      // Por si isql (o algo que haya heredado sus file descriptors) sigue
      // sosteniendo el pipe abierto tras el kill, hay que soltar la
      // referencia a mano — si no, el proceso Node puede quedar colgado
      // esperando un 'close' que nunca llega.
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new Error(`isql no respondió dentro de ${ISQL_TIMEOUT_MS} ms (${host}:${port}).`));
    }, ISQL_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`No se pudo ejecutar isql (${ISQL_PATH}): ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    // Si isql ya murió (bash no lo encontró, un flag inválido, se cayó al
    // arrancar) antes de que termine de escribirle, escribir a su stdin ya
    // cerrado tira EPIPE como evento 'error' del stream — sin este handler
    // eso es una excepción no manejada que tumba TODO el proceso Node, no
    // solo esta query. El 'error' del proceso en sí (unos handlers más
    // arriba) ya se encarga de rechazar la promesa con un mensaje útil.
    child.stdin.on('error', () => {});

    child.stdin.write(sqlBatch);
    child.stdin.end();
  });
}

// Ubica la tabla de resultados en la salida de isql usando la línea de
// guiones (una corrida de "-" por columna) para determinar el ancho exacto
// de cada columna, y corta el header y cada fila de datos en esas mismas
// posiciones. Es el mismo truco que usan la mayoría de los scripts viejos
// que scrapean isql — no depende de que isql imprima o no los prompts
// "1>"/"2>" (esas líneas nunca matchean el patrón "solo guiones y
// espacios", así que se saltean solas).
function parseIsqlTable(output) {
  const lines = output.split(/\r?\n/);

  const sepIndex = lines.findIndex((line) => line.includes('-') && /^[-\s]+$/.test(line));
  if (sepIndex <= 0) {
    return [];
  }

  const sepLine = lines[sepIndex];
  const headerLine = lines[sepIndex - 1];

  const bounds = [];
  const runRe = /-+/g;
  let match;
  while ((match = runRe.exec(sepLine)) !== null) {
    bounds.push([match.index, match.index + match[0].length]);
  }
  if (bounds.length === 0) return [];

  const columns = bounds.map(([start, end]) => headerLine.slice(start, end).trim());

  const rows = [];
  for (let i = sepIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') break;
    if (/^Msg \d+, Level \d+, State \d+:/.test(line)) break;

    const row = {};
    bounds.forEach(([start, end], idx) => {
      const isLast = idx === bounds.length - 1;
      const raw = line.slice(start, isLast ? line.length : end);
      const value = raw.trim();
      row[columns[idx]] = value === 'NULL' ? null : value;
    });
    rows.push(row);
  }

  return rows;
}

// Busca un bloque de error en la salida combinada de isql. Hay dos formatos
// posibles y bien distintos:
//   - Errores del SERVIDOR Sybase: "Msg NNNN, Level N, State N:" (SQL
//     inválido, tabla inexistente, y también login rechazado por usuario/
//     contraseña incorrectos — Sybase reporta eso como un Msg numerado más).
//   - Errores del CLIENTE (las librerías ct-lib/cs-lib/db-lib del OCS, antes
//     incluso de llegar al servidor) — formato "XX-LIBRARY error: ...", por
//     ejemplo "CS-LIBRARY error: comn_cryptolib_load(): ... Failed to load
//     library" cuando falta algo del entorno del OCS (LD_LIBRARY_PATH,
//     locale, etc.). Sin reconocer también este segundo formato, isql podía
//     fallar en el connect/login y el resto del código lo interpretaba como
//     una query que simplemente no encontró filas, en vez de un error real.
function findSybaseErrorMessage(combinedOutput) {
  const msgMatch = /Msg \d+, Level \d+, State \d+:[\s\S]*?(?=\n\s*\n|\n\S*\d>|$)/.exec(combinedOutput);
  if (msgMatch) return msgMatch[0].replace(/\s+/g, ' ').trim();

  const libMatch = /(CS-LIBRARY|CT-LIBRARY|DB-LIBRARY|BLK-LIBRARY) error:[\s\S]*?(?=\n\s*\n|$)/.exec(combinedOutput);
  if (libMatch) return libMatch[0].replace(/\s+/g, ' ').trim();

  return null;
}

async function runQuery(parametriaSybase, sqlBatch) {
  if (!parametriaSybase || !parametriaSybase.usuario) {
    throw new Error('Falta el usuario de Sybase en la Parametría (botón "Parametría..." > Conexión Sybase).');
  }

  const { host, port, database } = parseConnectionString(parametriaSybase.connectionString);

  const batchLines = ['SET NOCOUNT ON', 'GO'];
  if (database) {
    batchLines.push(`USE ${database}`, 'GO');
  }
  batchLines.push(sqlBatch, 'GO');

  const { code, stdout, stderr } = await runIsql(host, port, parametriaSybase.usuario, parametriaSybase.password, `${batchLines.join('\n')}\n`);

  const combined = `${stdout}\n${stderr}`;
  const sybaseError = findSybaseErrorMessage(combined);
  if (sybaseError) {
    throw new Error(`Error de Sybase: ${sybaseError}`);
  }
  // Cualquier código de salida distinto de cero es una condición anormal —
  // tratarlo como error SIEMPRE, tenga o no algo en stdout (antes esto solo
  // se chequeaba cuando stdout estaba vacío, y por eso un error de conexión
  // que sí escribe texto en stdout, como el de CS-LIBRARY de más arriba,
  // podía colarse como si fuera "0 filas" en vez de una falla real).
  if (code !== 0) {
    const detail = combined.trim().slice(0, 1000) || '(sin salida)';
    throw new Error(`isql (${host}:${port}) terminó con código ${code}. ${detail}`);
  }

  return parseIsqlTable(stdout);
}

async function testSybaseConnection(parametriaSybase) {
  try {
    const rows = await runQuery(parametriaSybase, 'SELECT getdate() AS ahora');
    const ahora = rows[0] ? rows[0].ahora : null;
    return { ok: true, message: `Conexión exitosa (hora del servidor Sybase: ${ahora}).` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// queryText ya viene con las variables del flow ya interpoladas (mismo
// Expand-Template que arma el resto de bodies/paths — ver flowEngine.js).
// Devuelve un array de objetos plain (una fila = un objeto columna -> valor),
// igual que hace el backend PowerShell leyendo el OdbcDataReader.
async function querySybase(parametriaSybase, queryText) {
  return runQuery(parametriaSybase, queryText);
}

module.exports = {
  testSybaseConnection,
  querySybase,
  // Exportadas aparte para poder testear el parseo sin una conexión real.
  parseConnectionString,
  parseIsqlTable,
};
