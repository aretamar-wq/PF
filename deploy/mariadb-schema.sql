-- Esquema MariaDB 10 para ApiCore (backend Node.js) — reemplaza el
-- almacenamiento en archivos JSON locales (security.local.json,
-- profiles.local.json, parametria.local.json, logs/processed-operations.json)
-- por estas tablas. Ver "Base de datos (MariaDB)" en README.md.
--
-- Correr una sola vez contra la base configurada en db.local.json
-- (ver db.sample.json), ya creada de antemano:
--   mysql -u root -p apicore < deploy/mariadb-schema.sql
--
-- node/scripts/migrate-json-to-mariadb.js importa, después de esto, los
-- datos que ya hubiera en los archivos JSON.

CREATE TABLE IF NOT EXISTS rol (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  nombre VARCHAR(50) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_rol_nombre (nombre)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Los 3 roles válidos de la app (ver VALID_ROLES en securityStore.js) — fila
-- fija, no se administran desde la UI.
INSERT INTO rol (nombre) VALUES ('admin'), ('operador'), ('lectura')
  ON DUPLICATE KEY UPDATE nombre = VALUES(nombre);

CREATE TABLE IF NOT EXISTS usuarios (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(255) NOT NULL,
  display_name VARCHAR(255) NOT NULL DEFAULT '',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_usuarios_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Nunca guarda contraseña: la app autentica contra Active Directory (bind
-- LDAP puntual) — esta tabla es un allowlist de qué cuentas de AD pueden
-- entrar y con qué rol, no un almacén de credenciales.

-- usuario_id como PK (no una PK propia + UNIQUE aparte): fuerza como máximo
-- una fila por usuario aunque la tabla esté modelada como relación
-- usuarios<->rol — un usuario, un rol, igual que hoy (ver README, "Modelo
-- de roles").
CREATE TABLE IF NOT EXISTS rol_usuarios (
  usuario_id INT UNSIGNED NOT NULL,
  rol_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (usuario_id),
  KEY idx_rol_usuarios_rol (rol_id),
  CONSTRAINT fk_rol_usuarios_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE CASCADE,
  CONSTRAINT fk_rol_usuarios_rol FOREIGN KEY (rol_id) REFERENCES rol (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Configuración de Active Directory (server/port/useSsl/domain) contra el
-- que se valida el login — antes vivía junto a los usuarios en
-- security.local.json, ahora en su propia tabla singleton (siempre 1 fila,
-- id = 1) para no mezclar configuración con datos de usuarios.
CREATE TABLE IF NOT EXISTS configuracion_ad (
  id TINYINT UNSIGNED NOT NULL,
  server VARCHAR(255) NOT NULL DEFAULT '',
  port INT UNSIGNED NOT NULL DEFAULT 389,
  use_ssl TINYINT(1) NOT NULL DEFAULT 0,
  domain VARCHAR(255) NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  CONSTRAINT chk_configuracion_ad_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO configuracion_ad (id, server, port, use_ssl, domain)
  VALUES (1, '', 389, 0, '')
  ON DUPLICATE KEY UPDATE id = id;

-- Parametría: valores fijos por categoría de cuenta + conexión Sybase.
-- Singleton (siempre 1 fila, id = 1) — mismo criterio que configuracion_ad.
CREATE TABLE IF NOT EXISTS parametria (
  id TINYINT UNSIGNED NOT NULL,
  cc_codigo_cuenta VARCHAR(100) NOT NULL DEFAULT '',
  cc_codigo_sistema VARCHAR(100) NOT NULL DEFAULT '',
  cc_transaccion VARCHAR(100) NOT NULL DEFAULT '',
  ca_codigo_sistema VARCHAR(100) NOT NULL DEFAULT '',
  ca_transaccion VARCHAR(100) NOT NULL DEFAULT '',
  pf_codigo_producto VARCHAR(100) NOT NULL DEFAULT '',
  pf_codigo_movimiento VARCHAR(100) NOT NULL DEFAULT '',
  sybase_connection_string VARCHAR(1000) NOT NULL DEFAULT '',
  sybase_usuario VARCHAR(255) NOT NULL DEFAULT '',
  -- Cifrada (AES-256-GCM, ver node/lib/cryptoUtil.js) — más ancha que un
  -- VARCHAR(255) de contraseña en texto plano porque el formato guardado es
  -- "iv:authTag:ciphertext" en hexadecimal (~56 bytes de overhead antes de
  -- contar la contraseña en sí).
  sybase_password VARCHAR(500) NOT NULL DEFAULT '',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT chk_parametria_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO parametria (
    id, cc_codigo_cuenta, cc_codigo_sistema, cc_transaccion,
    ca_codigo_sistema, ca_transaccion,
    pf_codigo_producto, pf_codigo_movimiento,
    sybase_connection_string, sybase_usuario, sybase_password
  ) VALUES (
    1, '', '', '',
    '', '',
    '', '',
    'Driver={Adaptive Server Enterprise};NetworkAddress=Aconquija4.bv.voii.com.ar,5000;Database=Banksys;Uid={{usuario}};Pwd={{password}}', '', ''
  )
  ON DUPLICATE KEY UPDATE id = id;

-- Perfiles de conexión (baseUrl/novaBaseUrl, auth, certificado cliente) —
-- mismos campos que profiles.local.json, "name" es la clave única que ya
-- usaba el archivo.
CREATE TABLE IF NOT EXISTS perfiles (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  base_url VARCHAR(500) NOT NULL DEFAULT '',
  nova_base_url VARCHAR(500) NOT NULL DEFAULT '',
  auth_type VARCHAR(50) NOT NULL DEFAULT '',
  api_key_or_token VARCHAR(1000) NOT NULL DEFAULT '',
  api_key_header_name VARCHAR(255) NOT NULL DEFAULT '',
  token_url VARCHAR(500) NOT NULL DEFAULT '',
  -- client_id/client_secret/client_cert_passphrase cifrados (AES-256-GCM,
  -- ver node/lib/cryptoUtil.js) — más anchos que el dato en texto plano
  -- porque el formato guardado es "iv:authTag:ciphertext" en hexadecimal
  -- (~56 bytes de overhead antes de contar el valor real). apiKeyOrToken
  -- queda sin cifrar por ahora.
  client_id VARCHAR(500) NOT NULL DEFAULT '',
  client_secret VARCHAR(500) NOT NULL DEFAULT '',
  client_cert_pfx_path VARCHAR(500) NOT NULL DEFAULT '',
  client_cert_passphrase VARCHAR(500) NOT NULL DEFAULT '',
  -- Campos OAuth2 avanzados que la UI no expone (tokenParams, tokenHeaders,
  -- tokenAccessTokenPath, tokenAuthHeaderFormat, tokenAuthHeaderName,
  -- tokenBodyContentType, tokenExpiresInPath, tokenMethod — ver
  -- "Limitaciones conocidas" en README) — un solo JSON en vez de 8 columnas
  -- sparse casi siempre NULL; profileStore.js los aplana de vuelta al nivel
  -- superior del objeto perfil al leer, para que flowEngine.js no note la
  -- diferencia.
  token_extra_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_perfiles_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Registro de operaciones (cuit + numeroComprobante) ya ejecutadas, para
-- bloquear un reintento antes de llamar a ningún endpoint del banco. La
-- UNIQUE KEY (cuit, numero_comprobante) hace de índice de deduplicación
-- (mismo criterio que la Map en findDuplicateOperations) y de defensa
-- contra un INSERT duplicado por una carrera entre dos corridas.
CREATE TABLE IF NOT EXISTS operaciones_procesadas (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cuit VARCHAR(50) NOT NULL,
  numero_comprobante VARCHAR(100) NOT NULL,
  id_mensaje VARCHAR(100) NOT NULL DEFAULT '',
  processed_at DATETIME NOT NULL,
  processed_by VARCHAR(255) NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  UNIQUE KEY uk_operaciones_cuit_comprobante (cuit, numero_comprobante)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Registro en base del contenido de dbnout-...csv (detalle de cada
-- Transferencia DEBIN de un archivo procesado) y dbnconsulta-...csv
-- (resultado de consultar el estado de cada una) — además del .csv que ya
-- se guarda en files/ (ver "Archivos de salida (files/)" en el README),
-- estas tablas quedan como registro consultable de quién ejecutó la carga
-- y cuándo. Una fila de la tabla por cada fila del .csv correspondiente;
-- nunca se leen para deduplicar (eso lo sigue haciendo
-- operaciones_procesadas), son puramente de registro/auditoría.
CREATE TABLE IF NOT EXISTS dbn_out (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  credito_cuit VARCHAR(50) NOT NULL DEFAULT '',
  credito_cbu VARCHAR(50) NOT NULL DEFAULT '',
  credito_titular VARCHAR(255) NOT NULL DEFAULT '',
  debito_cuit VARCHAR(50) NOT NULL DEFAULT '',
  debito_cbu VARCHAR(50) NOT NULL DEFAULT '',
  debito_titular VARCHAR(255) NOT NULL DEFAULT '',
  id_comprobante VARCHAR(100) NOT NULL DEFAULT '',
  moneda VARCHAR(20) NOT NULL DEFAULT '',
  importe VARCHAR(50) NOT NULL DEFAULT '',
  codigo_respuesta VARCHAR(100) NOT NULL DEFAULT '',
  descripcion_respuesta VARCHAR(500) NOT NULL DEFAULT '',
  id_respuesta VARCHAR(100) NOT NULL DEFAULT '',
  id_mensaje VARCHAR(100) NOT NULL DEFAULT '',
  realizado VARCHAR(1) NOT NULL DEFAULT '',
  ejecutado_por VARCHAR(255) NOT NULL DEFAULT '',
  ejecutado_en DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_dbn_out_id_mensaje (id_mensaje)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- id_mensaje/id_comprobante/id_operacion quedan como columnas propias (se
-- usan para buscar); el resto de las ~58 columnas que trae la respuesta de
-- "Consulta DEBIN (solo)" (ver DEBIN_CONSULTA_COLUMNS en wwwroot/app.js) se
-- guardan enteras en respuesta_json — mismo criterio que token_extra_json
-- en "perfiles", para no tener que mantener sincronizada una columna por
-- campo si Nova-Link agrega uno nuevo.
CREATE TABLE IF NOT EXISTS dbn_consulta (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_mensaje VARCHAR(100) NOT NULL DEFAULT '',
  id_comprobante VARCHAR(100) NOT NULL DEFAULT '',
  id_operacion VARCHAR(100) NOT NULL DEFAULT '',
  error_consulta VARCHAR(500) NOT NULL DEFAULT '',
  respuesta_json JSON NULL,
  ejecutado_por VARCHAR(255) NOT NULL DEFAULT '',
  ejecutado_en DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_dbn_consulta_id_mensaje (id_mensaje)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
