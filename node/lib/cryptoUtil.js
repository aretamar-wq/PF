'use strict';

// Cifrado simétrico (AES-256-GCM) para guardar secretos en MariaDB en vez de
// en texto plano — hoy, solo se usa para parametria.sybase_password (ver
// parametriaStore.js). AES-256-GCM es autenticado: además de que nadie pueda
// leer el valor sin la clave, si alguien lo edita a mano en la base (o se
// corrompe), decrypt() lo detecta y tira un error en vez de devolver basura
// silenciosamente.
//
// La clave vive en db.local.json (mismo archivo, nunca versionado, que ya
// tiene el resto de los datos de conexión a MariaDB) — ver
// dbConfigStore.getEncryptionKey y "Base de datos (MariaDB)" en el README
// para cómo generarla. Si se pierde esa clave, los valores ya cifrados en la
// base quedan irrecuperables (no hay "clave maestra" de respaldo) — hay que
// tratarla con el mismo cuidado que una contraseña de producción.

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recomendado para GCM (no 16, a diferencia de CBC)

function getKeyBuffer(hexKey) {
  const buffer = Buffer.from(String(hexKey || ''), 'hex');
  if (buffer.length !== 32) {
    throw new Error(
      "La clave de cifrado (encryptionKey en db.local.json) tiene que ser exactamente 32 bytes en hexadecimal (64 caracteres) — generá una con: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return buffer;
}

// Formato guardado: "<iv hex>:<authTag hex>:<ciphertext hex>" — todo en un
// solo string de texto para que entre en una columna VARCHAR normal, sin
// necesitar una columna binaria aparte.
function encrypt(plaintext, hexKey) {
  if (!plaintext) return '';

  const key = getKeyBuffer(hexKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(stored, hexKey) {
  if (!stored) return '';

  const parts = String(stored).split(':');
  if (parts.length !== 3) {
    throw new Error('El valor cifrado en la base tiene un formato inválido (se esperaba "iv:authTag:ciphertext").');
  }
  const [ivHex, authTagHex, ciphertextHex] = parts;

  const key = getKeyBuffer(hexKey);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

  const decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
