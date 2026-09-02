# ApiCore

Aplicación web local, **portable** (nada para instalar), que ejecuta *flows* —
secuencias de llamadas a las APIs REST de un core bancario — definidos en
archivos JSON editables sin reiniciar nada.

El servidor es un script de **PowerShell** (el que ya viene instalado en
cualquier Windows 10/11), que expone una API local y sirve una página web
sencilla (HTML/CSS/JS, sin frameworks ni dependencias) para manejarla desde el
navegador. No hay que compilar nada ni instalar .NET, Node, Python ni ningún
runtime adicional.

> **Importante:** hoy la app está reducida a un único flow operativo,
> `Flows/plazo-fijo-cocos-files-sql.json` ("Alta de Plazo Fijos - File"),
> más una dependencia interna que no aparece en la lista
> (`Flows/recupera-cuentas-sql.json`, ver "Módulo de flows ocultos"). Los
> demás flows de versiones anteriores (ejemplos con endpoints ficticios,
> variantes manuales/CSV previas de Plazo Fijo Cocos, consultas sueltas)
> se borraron del repo — el historial de git los tiene si hace falta
> recuperar alguno como referencia.

## Cómo correrla (sin instalar nada)

1. Descargá o cloná el repo — es solo texto, no hay nada para compilar.
2. Copiá `profiles.sample.json` a `profiles.local.json` (este archivo **no se
   versiona**, ver `.gitignore`) y completá tus credenciales — ver
   "Configurar perfiles" más abajo. Copiá también `security.sample.json` a
   `security.local.json` y completá los datos de tu Active Directory — ver
   "Módulo de seguridad" más abajo (el primer login exitoso se da de alta
   solo como administrador, no hace falta crear usuarios a mano).
3. Hacé doble click en **`Iniciar.bat`**. Esto abre PowerShell, levanta el
   servidor local y abre tu navegador en `http://localhost:8787/`
   automáticamente.
   - Si preferís lanzarlo a mano: `powershell -ExecutionPolicy Bypass -File server.ps1`
     (el `-ExecutionPolicy Bypass` es solo para esa ejecución, no cambia
     ninguna configuración del sistema).
   - Si el puerto 8787 está ocupado: `powershell -ExecutionPolicy Bypass -File server.ps1 -Port 8899`
4. Para cerrarla, cerrá la ventana de PowerShell (o Ctrl+C).

## Instalación en Linux (nginx + systemd)

Ninguno de los dos backends usa PHP para nada. En un servidor Linux con
nginx + PHP ya instalados (por ejemplo, sirviendo otros sitios), esto se
agrega aparte sin tocar el PHP existente: nginx solo hace de reverse proxy
hacia el backend elegido, igual que podría hacerlo hacia un backend PHP-FPM
en otro `server {}`.

Hay **dos backends intercambiables**, que sirven exactamente la misma
`wwwroot/`, los mismos `Flows/*.json` y los mismos `*.local.json` — el
frontend no sabe ni le importa cuál de los dos tiene enfrente. Elegí uno,
**no hace falta correr los dos a la vez** en el mismo servidor:

- **PowerShell** (`server.ps1`, el mismo motor que Windows) — conviene si ya
  vas a instalar `pwsh` en el servidor de todos modos, o si preferís no
  agregar Node.js como dependencia nueva.
- **Node.js** (`node/server.js`) — conviene si el servidor ya tiene Node.js
  o si preferís no instalar PowerShell en Linux. Ver el aviso sobre Sybase
  más abajo antes de elegir esta opción si el flow de Alta de Plazo Fijos
  es imprescindible desde el día uno.

### Opción A: backend PowerShell

Requisitos en el servidor:

- **PowerShell 7+ para Linux** (`pwsh`) — no es Windows PowerShell 5.1, hay
  que instalar el paquete de Microsoft para tu distro
  ([instrucciones oficiales](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-linux)).
- **unixODBC** (`apt install unixodbc` / `yum install unixODBC`) si el flow
  de Alta de Plazo Fijos va a correr — necesita un driver ODBC para Sybase/SAP
  ASE instalado en la máquina (típicamente **FreeTDS** en Linux, con su
  propio `Driver=` distinto al de Windows). Ajustar el connection string en
  Parametría de acuerdo al driver instalado — ver "Módulo de parametría".
- Conectividad de red hacia el core bancario, el servidor Sybase y el
  Domain Controller de Active Directory (mismos hosts/puertos que en
  Windows).

Pasos:

1. Copiar el repo al servidor (por ejemplo `/opt/apicore`).
2. Completar `profiles.local.json`, `parametria.local.json` y
   `security.local.json` igual que en Windows (ver las secciones
   correspondientes más abajo) — estos archivos no viajan con el repo.
3. Instalar el servicio con **`deploy/apicore.service`** (unidad
   systemd — corre `server.ps1` como usuario sin privilegios, reinicia solo
   si se cae, y solo escucha en `127.0.0.1:8787`, nunca expuesto directo a
   la red). El archivo trae los pasos de instalación en su propio
   comentario.
4. Publicarlo con **`deploy/nginx-apicore.conf`** (reverse proxy
   nginx → `127.0.0.1:8787`, probado contra nginx 1.18). Incluye un bloque
   HTTPS comentado para producción — recomendado, porque el login manda la
   contraseña de AD en el body del POST.

#### Notas específicas de RHEL/CentOS/Rocky/Alma (backend PowerShell)

- **Paquetes**: `pwsh` viene del repo de Microsoft
  (`sudo dnf install -y https://packages.microsoft.com/config/rhel/<versión>/packages-microsoft-prod.rpm`
  y después `sudo dnf install -y powershell` — ver la
  [guía oficial](https://learn.microsoft.com/powershell/scripting/install/install-rhel)
  para el número de versión de RHEL exacto). `nginx` está en el repo
  AppStream (`sudo dnf install -y nginx`). Para el driver de Sybase:
  `sudo dnf install -y unixODBC freetds` (freetds puede requerir el repo
  EPEL: `sudo dnf install -y epel-release` antes).
- **Ubicación del config de nginx**: RHEL no trae `sites-available`/
  `sites-enabled` por defecto — copiar `deploy/nginx-apicore.conf`
  directo a `/etc/nginx/conf.d/apicore.conf` (nginx.conf ya
  incluye todo `/etc/nginx/conf.d/*.conf`), sin symlink.
- **SELinux** (la causa más común de "nginx anda pero da 502"): por
  default, el dominio de nginx (`httpd_t`) tiene bloqueado hacer conexiones
  salientes a puertos no estándar — incluido el `proxy_pass` hacia
  `127.0.0.1:8787` de este mismo backend. Sin este paso, nginx devuelve
  **502 Bad Gateway** aunque el backend esté corriendo bien:
  ```bash
  sudo setsebool -P httpd_can_network_connect 1
  ```
  (`getenforce` para confirmar si SELinux está en `Enforcing`; `sudo tail -f
  /var/log/audit/audit.log | grep denied` mientras probás el sitio, si algo
  más queda bloqueado).
- **firewalld**: por default bloquea el tráfico entrante a 80/443 desde
  afuera del propio servidor:
  ```bash
  sudo firewall-cmd --permanent --add-service=http
  sudo firewall-cmd --permanent --add-service=https   # si vas a usar el bloque TLS
  sudo firewall-cmd --reload
  ```

### Opción B: backend Node.js

Todo el código vive en `node/` — ver "Backend Node.js (`node/`)" un poco más
abajo para el detalle de qué está portado y qué no.

Requisitos en el servidor:

- **Node.js 18 o superior** (usa `fetch` global — no hace falta instalar
  ningún paquete HTTP client aparte). En RHEL/CentOS/Rocky/Alma:
  `sudo dnf module install -y nodejs:20` (o el módulo LTS disponible en tu
  versión); en Debian/Ubuntu, el paquete `nodejs` del repo del sistema suele
  quedar viejo — conviene el repo de [NodeSource](https://github.com/nodesource/distributions).
- Conectividad de red hacia el core bancario y el Domain Controller de
  Active Directory (igual que la Opción A). Sybase queda aparte — ver el
  aviso de abajo.

Pasos:

1. Copiar el repo al servidor (por ejemplo `/opt/apicore`).
2. Completar `profiles.local.json`, `parametria.local.json` y
   `security.local.json` en la **raíz del repo** (no dentro de `node/`) —
   son los mismos archivos que usa el backend PowerShell.
3. `cd /opt/apicore/node && npm install --omit=dev` (instala
   `ldapts`, la única dependencia externa).
4. Instalar el servicio con **`deploy/apicore-node.service`**
   (unidad systemd — corre `node server.js` como usuario sin privilegios,
   solo escucha en `127.0.0.1:8787`). El archivo trae los pasos de
   instalación en su propio comentario.
5. Publicarlo con **`deploy/nginx-apicore-node.conf`** (reverse
   proxy nginx → `127.0.0.1:8787`, probado contra nginx 1.18/1.24). Incluye
   un bloque HTTPS comentado para producción.

Las mismas notas de RHEL de la Opción A aplican tal cual acá (SELinux
`httpd_can_network_connect`, firewalld, `conf.d/` en vez de
`sites-available`) — son cosas de nginx, no cambian según el backend.

### Conexión a Sybase en el backend Node.js

A diferencia del backend PowerShell (ODBC directo vía `System.Data.Odbc`),
Node.js no tiene ningún driver ODBC/Sybase maduro y mantenido, y SAP no
provee ningún binding oficial de Node.js para su Open Client/Server ("OCS",
el sucesor de Sybase OpenClient) — sí para Python, Perl y PHP. La solución
implementada en `node/lib/sybaseClient.js` es invocar **`isql`** (la
herramienta de línea de comandos que trae el OCS) **como subproceso** por
cada query, y parsear su salida.

**Requisitos en el servidor** (además de lo que ya pide la Opción B más
arriba):

- SAP OCS instalado (probado contra OCS 16.0) — el instalador deja todo en
  `/opt/sap` por default (configurable, ver más abajo). No hace falta
  `unixODBC` ni ningún driver ODBC: `sybaseClient.js` habla directo con
  `isql`.
- El archivo `interfaces` de Sybase **no hace falta que tenga el server
  registrado** — `sybaseClient.js` conecta directo por `host:puerto`,
  tomándolos del mismo `NetworkAddress=host,puerto` que ya tiene el
  `connectionString` de Parametría (no hay que duplicar esa configuración
  en ningún otro lado).

**Variables de entorno** (todas opcionales, con default para una instalación
estándar en `/opt/sap`):

| Variable | Default | Para qué |
|---|---|---|
| `SYBASE_HOME` | `/opt/sap` | Raíz de la instalación del OCS |
| `SYBASE_OCS_DIR` | `OCS-16_0` | Subcarpeta de la versión del OCS instalada |
| `SYBASE_ISQL_PATH` | `$SYBASE_HOME/$SYBASE_OCS_DIR/bin/isql` | Ruta al binario, por si no sigue la convención de carpetas de arriba |
| `SYBASE_ENV_SCRIPT` | `$SYBASE_HOME/SYBASE.sh` | Script que arma el entorno del OCS (`SYBASE`/`SYBASE_OCS`/`PATH`/`LD_LIBRARY_PATH`, incluida `lib3p64/`, donde vive la librería de cifrado del login) — `sybaseClient.js` lo "sourcea" en un `bash -c` antes de invocar `isql`, en vez de reconstruir esas variables a mano (armarlas a mano y olvidarse de `lib3p64/` es justo lo que rompía el login con `CS-LIBRARY error: comn_cryptolib_load()... Failed to load library`) |
| `SYBASE_LANG` | `en_US.UTF-8` | Locale que se le fuerza a `isql` — sin esto falla con "context allocation routine failed... localization files" si el `LANG` del sistema (ej. `es_ES.UTF-8`) no está en `locales.dat` del OCS |
| `SYBASE_ISQL_TIMEOUT_MS` | `30000` | Corta y mata el proceso `isql` si no respondió en ese tiempo |
| `SYBASE_ISQL_WIDTH` | `8000` | Ancho de pantalla que se le pide a `isql` (`-w`) — evita que una tabla ancha se corte en varias líneas y rompa el parseo |

Para setearlas, agregá líneas `Environment=` a `deploy/apicore-node.service`
(por ejemplo `Environment=SYBASE_LANG=es_AR.UTF-8`) y
`sudo systemctl daemon-reload && sudo systemctl restart apicore-node`.

**Trade-offs conocidos de este enfoque** (aceptados, no son bugs — están
documentados también como comentario en el propio `sybaseClient.js`):

- La contraseña de Sybase viaja como argumento de línea de comandos (`-P`)
  del proceso `isql` mientras corre esa query puntual — visible vía
  `ps aux`/`/proc/<pid>/cmdline` para cualquier otro usuario con acceso al
  mismo servidor durante esa ventana. Si esto es inaceptable en tu
  organización, la alternativa es restringir `hidepid=2` en `/proc` a nivel
  de sistema operativo.
- El parseo de la tabla de resultados de `isql` es por posición de columna
  (usa la línea de guiones para ubicar cada columna) — funciona bien con
  los datos típicos de esta app (códigos de cuenta, DNI, montos), pero un
  valor con salto de línea embebido rompería el parseo.
- Solo se parsea el primer result set de la query — los flows de este repo
  hacen un único `SELECT` por step SQL, no hace falta más.

**Verificar la conectividad antes de correr un flow real:**

```bash
source /opt/sap/SYBASE.sh
LANG=en_US.UTF-8 isql -S<host>:<puerto> -U<usuario> -P<clave>
1> select getdate()
2> go
```

Si devuelve la fecha/hora del servidor, la conectividad de base está OK.
El botón **"Probar conexión"** de Parametría en la propia app hace
exactamente esta misma prueba (usando el `connectionString` ya guardado),
así que una vez configurado no hace falta repetir esto a mano.

### Backend Node.js (`node/`)

Port completo del backend a Node.js (sin dependencias de frameworks web —
usa el módulo `http` nativo, igual de "a mano" que el router de
`server.ps1`), pensado para el mismo contrato de API que ya consume
`wwwroot/app.js`:

```
node/
  server.js              Entry point: mismas rutas /api/* + estáticos que server.ps1
  package.json           Única dependencia externa: ldapts (bind LDAP)
  lib/
    jsonPath.js               Port de modules/JsonPath.psm1
    variableSubstitution.js   Port de modules/VariableSubstitution.psm1
    profileStore.js           Port de modules/ProfileStore.psm1
    parametriaStore.js        Port de modules/ParametriaStore.psm1
    flowStore.js              Port de modules/FlowStore.psm1
    flowEngine.js             Port de modules/FlowEngine.psm1 (fetch en vez de HttpClient)
    securityStore.js          Port de modules/SecurityStore.psm1 (ldapts en vez de LDAP .NET)
    processedOperationsStore.js  Port de modules/ProcessedOperationsStore.psm1
    sybaseClient.js           Sin equivalente PowerShell — conecta a Sybase vía isql (subproceso), ver "Conexión a Sybase en el backend Node.js" arriba
```

Cada archivo de `node/lib/` es un port 1:1 del `.psm1` equivalente (mismo
comportamiento, mismos nombres de campo en las respuestas JSON) — se
verificó ejecutando el mismo flow HTTP de punta a punta (login LDAP real,
extractVariables, omitIfNull, OAuth2, prevención de duplicados, guardado de
archivos) contra un servidor de prueba, y además con el `wwwroot/app.js`
real corriendo en un navegador sin ningún cambio.

> **Login contra Active Directory en Linux:** tanto el bind LDAP de
> PowerShell (`System.DirectoryServices.Protocols`) como el de Node.js
> (`ldapts`) son multiplataforma — el login funciona igual contra el mismo
> Domain Controller sin importar qué backend elijas. Si el Domain
> Controller usa un certificado de una CA interna y tildás "Usar LDAPS
> (SSL)" en la config de AD, esa CA tiene que estar en el almacén de
> confianza del servidor Linux o el bind va a fallar por certificado no
> confiable.

> **Un usuario a la vez:** como dice "Limitaciones conocidas" más abajo,
> ninguno de los dos backends está pensado como servicio con muchos
> usuarios concurrentes ejecutando flows largos al mismo tiempo. Si varias
> personas van a usar este deployment Linux a la vez, tenerlo en cuenta.

## Qué resuelve

- Login obligatorio contra **Active Directory** (la contraseña nunca se
  guarda) con administración local de usuarios y **roles**
  (admin/operador/lectura) que controlan quién puede ejecutar flows y quién
  puede administrar usuarios — ver "Módulo de seguridad" más abajo.
- Autenticación por **API Key** (header configurable), **Bearer token
  estático** u **OAuth2 client_credentials** (el servidor obtiene y cachea el
  `access_token` automáticamente antes de cada request).
- Flows multi-paso: cada paso es un request HTTP cuyo path, headers y body
  pueden usar variables (`{{variable}}`) provenientes de los inputs
  ingresados por el usuario o extraídas de la respuesta de un paso anterior.
- Log de ejecución paso a paso (estado, HTTP status, duración,
  respuesta/error) en la propia página, exportable a `.txt` desde el
  navegador. La respuesta que la página muestra corta a los 200.000
  caracteres (antes 800; se subió porque algunas respuestas con muchas
  cuentas superan ampliamente los 800); el
  detalle completo de cada request/response de negocio (no de la
  obtención de token) queda siempre entero, sin cortar, en
  `logs/http.log` — ver "Logs en disco" más abajo.
- Gestión de "perfiles" de conexión desde la UI web (nombre, URL base, tipo de
  autenticación, ApiKey/Bearer estático y los campos básicos de OAuth2 —
  `tokenUrl`/`clientId`/`clientSecret`). Los campos de OAuth2 más avanzados
  (`tokenParams`, `tokenHeaders`, etc., ver más abajo) se completan editando
  `profiles.local.json`.
- Botón **"Probar token"** para verificar la obtención del token OAuth2 sin
  ejecutar ningún flow de negocio.
- Los flows y perfiles viven en archivos JSON junto al script: se pueden
  editar, agregar o distribuir sin tocar código. Los cambios en `Flows/` se
  ven apenas se recarga la página (no hace falta reiniciar el servidor).

## Estructura del proyecto

```
server.ps1              Entry point: HttpListener + rutas /api/* + estáticos
Iniciar.bat             Doble click para arrancar sin lidiar con la política de ejecución de PowerShell
modules/
  JsonPath.psm1          Navegación de JSON por notación de puntos ("data.balance", "items[0].id")
  VariableSubstitution.psm1  Reemplazo de {{variable}} en templates
  ProfileStore.psm1      Lee/escribe profiles.local.json
  ParametriaStore.psm1   Lee/escribe parametria.local.json
  FlowStore.psm1         Lee todos los Flows/*.json
  FlowEngine.psm1        Ejecuta un flow paso a paso, incluye el caché de token OAuth2
  SecurityStore.psm1     Login (AD) + sesiones + usuarios/roles + auditoría (ver "Módulo de seguridad")
  ProcessedOperationsStore.psm1  Registro de operaciones ya procesadas, evita duplicados (ver "Prevención de operaciones duplicadas")
node/                    Backend Node.js alternativo (ver "Backend Node.js (node/)")
wwwroot/
  index.html, app.js, styles.css   Front-end (vanilla JS, sin build step) — compartido por los dos backends
deploy/
  apicore.service         Unidad systemd, backend PowerShell (ver "Instalación en Linux")
  nginx-apicore.conf      Reverse proxy nginx, backend PowerShell (ver "Instalación en Linux")
  apicore-node.service    Unidad systemd, backend Node.js (ver "Instalación en Linux")
  nginx-apicore-node.conf Reverse proxy nginx, backend Node.js (ver "Instalación en Linux")
Flows/                   *.json de flows (ver "Cómo definir un flow nuevo") — compartido por los dos backends
files/                   Archivos de salida pfout-.../pfouterror-... (no versionado, se crea solo)
profiles.sample.json      Plantilla de perfiles (sin secretos)
parametria.sample.json   Plantilla de parametría (ver "Módulo de parametría")
security.sample.json    Plantilla de seguridad (conexión AD + usuarios, ver "Módulo de seguridad")
```

## Módulo de seguridad (login + Active Directory + roles)

Toda la app queda detrás de un login: al abrir `http://localhost:8787/` se
muestra una pantalla de usuario/contraseña antes de mostrar flows, perfiles o
cualquier otra cosa. La contraseña **nunca se guarda** en ningún archivo ni se
loguea — se usa un instante para validarla contra Active Directory (bind
LDAP) y se descarta. Lo que la app sí guarda localmente es, para cada
usuario habilitado, su nombre de cuenta de AD y qué **rol** tiene acá adentro.

### Configuración inicial

1. Copiá `security.sample.json` a `security.local.json` (no se versiona, ver
   `.gitignore` — igual que `profiles.local.json`/`parametria.local.json`).
2. Completá el bloque `ad` con los datos del Domain Controller contra el que
   validar contraseñas — **no hace falta que la PC donde corre
   ApiCore esté unida al dominio**, alcanza con que llegue por red
   al DC (mismo criterio que la conexión a Sybase: apuntás a un host/puerto
   puntual, no se asume nada del entorno):
   ```json
   {
     "ad": {
       "server": "dc01.voii.com.ar",
       "port": 389,
       "useSsl": false,
       "domain": "voii.com.ar"
     },
     "users": []
   }
   ```
   `port`/`useSsl` también se pueden dejar en los valores de arriba (389,
   `false`) para LDAP simple; para LDAPS usá `"port": 636, "useSsl": true`.
3. **Bootstrap del primer administrador:** con `"users": []` (lista vacía),
   el primer login que valide correctamente contra AD se da de alta
   automáticamente como el primer usuario, con rol `admin` — así no hace
   falta editar el JSON a mano para crear el primer usuario. Una vez que
   existe al menos un usuario en la lista, este atajo deja de aplicar: a
   partir de ahí, un usuario que no esté en la lista (o que esté
   deshabilitado) no puede entrar aunque su contraseña de AD sea correcta,
   tenga que darlo de alta un admin desde el panel "Usuarios..." (o editando
   `security.local.json` directamente).
4. Los pasos siguientes (agregar más usuarios, cambiar roles, reconfigurar la
   conexión AD) se hacen desde la propia UI: botón **"Usuarios..."** en el
   header, visible solo para rol `admin`.

### Roles

| Rol | Puede ejecutar flows (`POST /api/run`) | Puede administrar usuarios/AD | Puede ver/editar Parametría |
|---|---|---|---|
| `admin` | Sí | Sí | Sí |
| `operador` | Sí | No | **No** |
| `lectura` | **No** (ve flows y perfiles, pero el botón "Ejecutar flow" queda deshabilitado y el servidor rechaza `/api/run` con 403 igual si se lo llama directo) | No | **No** |

Parametría (botón "Parametría..." en el header, `GET`/`POST /api/parametria`
y `POST /api/test-sybase`) es **exclusiva de `admin`** — trae valores de
cuenta y, sobre todo, la contraseña de Sybase (que nunca se manda de vuelta
al navegador, pero sí se puede pisar sin verla). `operador` puede correr
flows y usar el botón **"Probar token"** (prueba la obtención del token
OAuth2 del perfil elegido — no tiene relación con Parametría) con
normalidad; el botón "Parametría..." directamente no se le muestra, y el
servidor rechaza esas tres rutas con 403 igual si se llaman directo.

Los roles están fijos en
`Test-RoleCanRunFlow`/`Test-RoleCanManageUsers`/`Test-RoleCanManageParametria`
(`modules/SecurityStore.psm1`, con el mismo criterio en
`node/lib/securityStore.js` para el backend Node.js) — no hay UI para
inventar roles nuevos ni para restringir un rol a un subconjunto de flows
todavía, aunque el código queda en un único lugar para agregarlo si hiciera
falta. La app nunca deja sin ningún admin habilitado: no se puede eliminar,
deshabilitar, ni sacarle el rol de admin al último administrador habilitado
(tanto desde la UI como llamando a `/api/users` directo).

### Sesiones

Al loguearse, el servidor genera un token (32 bytes al azar) y lo guarda en
memoria (`$Global:SecuritySessions`, se pierde si se reinicia el servidor —
mismo criterio que el caché de token OAuth2 de los perfiles) con una
expiración de 8 horas. La UI lo guarda en `sessionStorage` (se pierde si se
cierra la pestaña/navegador, a propósito para una app que mueve plata — no
en `localStorage`) y lo manda como `Authorization: Bearer <token>` en cada
llamada a `/api/*` (`apiFetch` en `wwwroot/app.js`). Un 401 en cualquier
llamada limpia la sesión del lado del cliente y vuelve a mostrar la pantalla
de login.

En cada request autenticado, el servidor no solo mira si el token existe:
vuelve a leer `security.local.json` y confirma que ese usuario siga
habilitado y toma su rol **actual** (no el que tenía al momento del login) —
si un admin deshabilita a alguien, le cambia el rol, o lo elimina, eso tiene
efecto inmediato en la próxima request de esa sesión, sin esperar a que el
token expire ni a que la persona vuelva a loguearse.

### Auditoría

`logs/security.log` (mismo directorio que `logs/http.log`, no versionado)
registra, con fecha/hora: logins exitosos y fallidos (usuario, nunca la
contraseña), el bootstrap del primer admin, altas/bajas/ediciones de
usuarios (quién lo hizo y a quién), cambios en la configuración de AD,
ejecuciones de flow denegadas por rol, y **cada ejecución de un flow**
(usuario, rol, flow, perfil, y cuántos pasos terminaron ok/error) — para un
flow CSV, una línea por fila/operación, así queda trazado quién ejecutó
cada Plazo Fijo dado de alta, y cada archivo guardado en `files/` (nombre
del archivo y quién lo guardó, ver "Archivos de salida (`files/`)"). Nunca
incluye los inputs de la fila ni la respuesta del banco (pueden traer datos
bancarios reales); el detalle completo de cada request/response sigue en
`logs/http.log`.

### Limitaciones conocidas

- La validación contra AD usa `System.DirectoryServices.Protocols` (LDAP
  puro, `Test-AdCredentials` en `modules/SecurityStore.psm1`) — funciona
  igual en Windows y en Linux/macOS, siempre que haya conectividad de red
  hacia el Domain Controller.
- Pensado originalmente para uso local en Windows (`http://localhost:...`),
  donde el token/login viajan por HTTP plano dentro de la propia máquina —
  aceptable en ese contexto. Si se expone en red (por ejemplo, el
  deployment Linux de "Instalación en Linux (nginx + systemd)"), usar el
  bloque HTTPS de `deploy/nginx-apicore.conf` para que ese
  tráfico no viaje en claro entre el navegador y el servidor.

## Configurar perfiles de conexión

Los perfiles se completan editando `profiles.local.json` (o desde la UI web
para los campos que ya soporta: nombre, URL base, tipo de autenticación,
header/token de ApiKey o Bearer). Para crearlo:

```powershell
copy profiles.sample.json profiles.local.json
```

La plantilla trae dos ejemplos:

```json
[
  {
    "name": "Sandbox",
    "baseUrl": "https://sandbox.coreapi.example.com/v1",
    "authType": "Bearer",
    "apiKeyHeaderName": "X-Api-Key",
    "apiKeyOrToken": ""
  },
  {
    "name": "IBS",
    "baseUrl": "https://ibs-twapi03.voii.com.ar/ibsapi",
    "authType": "OAuth2ClientCredentials",
    "tokenUrl": "https://ibs-twapi03.voii.com.ar/ibsapi/Token",
    "clientId": "",
    "clientSecret": ""
  }
]
```

`authType` acepta:

- `"ApiKey"` — usa `apiKeyHeaderName` + `apiKeyOrToken` como header fijo.
- `"Bearer"` — usa `apiKeyOrToken` como `Authorization: Bearer <valor>` fijo.
- `"OAuth2ClientCredentials"` — antes de cada request, el servidor pide un
  token y lo cachea en memoria (nunca en disco, se pierde si reiniciás el
  servidor) hasta ~30s antes de que venza. Todo el proceso de obtención del
  token es **parametrizable por perfil** — ver la próxima sección.

Podés completar `tokenUrl`/`clientId`/`clientSecret` desde el diálogo
"Nuevo.../Editar..." de la UI (elegí `OAuth2ClientCredentials` en "Tipo de
autenticación"), o editando `profiles.local.json` directamente con un editor
de texto. En cualquier caso, **nunca pegues un secreto real en un archivo que
se vaya a commitear** (ni en `Flows/*.json`, ni en `profiles.sample.json`) —
`profiles.local.json` está en `.gitignore` justamente para esto. Los campos
más avanzados (`tokenParams`, `tokenHeaders`, `tokenAccessTokenPath`, etc.)
todavía no tienen UI propia y se completan por archivo.

### Parametrizar cómo se obtiene el token OAuth2

Por default (sin agregar nada más al perfil), la obtención de token hace
exactamente lo que necesita el core **IBS**: `POST {tokenUrl}` con body
`grant_type=client_credentials&client_id={clientId}&client_secret={clientSecret}`
(form-urlencoded), lee `access_token`/`expires_in` del root de la respuesta, y
aplica el token como `Authorization: Bearer <token>` en cada request. Para un
banco distinto que necesite otro formato, un perfil puede agregar cualquiera
de estos campos opcionales (todos con ese mismo default si se omiten):

| Campo | Default | Para qué sirve |
|---|---|---|
| `tokenMethod` | `"POST"` | Método HTTP del token request. |
| `tokenParams` | `{ "grant_type": "client_credentials", "client_id": "{{clientId}}", "client_secret": "{{clientSecret}}" }` | Los campos que se mandan en el body del token request. Se puede agregar/renombrar campos (ej. `"scope"`) o cambiar los nombres si el banco espera otros. Los valores admiten `{{clientId}}`/`{{clientSecret}}`. |
| `tokenBodyContentType` | `"application/x-www-form-urlencoded"` | Formato del body de `tokenParams`. También acepta `"application/json"` (manda un objeto JSON con esos mismos campos). |
| `tokenHeaders` | *(ninguno)* | Headers extra para el token request (ej. si el banco pide una API key también en el pedido de token). Admite `{{clientId}}`/`{{clientSecret}}`. |
| `tokenAccessTokenPath` | `"access_token"` | Path (notación de puntos, como en `extractVariables`) al valor del token dentro de la respuesta. |
| `tokenExpiresInPath` | `"expires_in"` | Path al TTL en segundos dentro de la respuesta. |
| `tokenAuthHeaderName` | `"Authorization"` | Nombre del header con el que se manda el token en los requests posteriores. |
| `tokenAuthHeaderFormat` | `"Bearer {{token}}"` | Formato del valor de ese header; admite `{{token}}`. |

Ejemplo de perfil para un banco hipotético que devuelve `{"data":{"token":"...","ttlSeconds":600}}`
y espera el token en un header `X-Access-Token` sin el prefijo `Bearer`:

```json
{
  "name": "OtroBanco",
  "baseUrl": "https://api.otrobanco.example.com",
  "authType": "OAuth2ClientCredentials",
  "tokenUrl": "https://api.otrobanco.example.com/oauth/token",
  "clientId": "...",
  "clientSecret": "...",
  "tokenAccessTokenPath": "data.token",
  "tokenExpiresInPath": "data.ttlSeconds",
  "tokenAuthHeaderName": "X-Access-Token",
  "tokenAuthHeaderFormat": "{{token}}"
}
```

### Probar la obtención del token sin ejecutar un flow

Con un perfil de tipo `OAuth2ClientCredentials` seleccionado, el botón
**"Probar token"** (al lado del selector de perfil) llama solo al paso de
obtención del token — ignora cualquier token cacheado, pide uno nuevo, y
muestra si funcionó (con un preview parcial del token y cuándo vence) o el
error exacto devuelto por el banco, sin depender de que ningún otro endpoint
de negocio esté disponible. Es la forma más rápida de confirmar que
`tokenUrl`/`clientId`/`clientSecret` (y el resto de los campos de la sección
anterior, si los personalizaste) están bien configurados.

## Módulo de parametría

El botón **"Parametría..."** (al lado de "Probar token") abre un formulario
para configurar valores fijos que varios flows necesitan y que casi nunca
cambian de una ejecución a otra, agrupados por tipo de cuenta:

- **Cuenta Corriente**: código de cuenta, código de sistema, transacción.
- **Caja de Ahorro**: código de sistema, transacción (el código de
  cuenta sigue siendo manual en cada flow, porque cambia por operación).
- **Plazo Fijo**: código de producto, código de movimiento.
- **Conexión Sybase**: connection string, usuario y contraseña — ver
  "Conexión a una base Sybase (para steps SQL)" más abajo. A diferencia de
  las demás categorías, esto no es un conjunto de variables `{{...}}` para
  usar en cualquier flow: solo lo usan internamente los steps de tipo
  `"type": "sql"`.

Se guardan en `parametria.local.json` (plantilla en `parametria.sample.json`,
igual mecánica que los perfiles: el archivo local **no se versiona**, está en
`.gitignore`, porque va a tener códigos de cuenta reales del banco).

Dentro de un flow, estos valores están disponibles como variables de sistema
con nombre fijo (no hace falta declararlos como inputs):

- `{{ctaCteCodigoCuenta}}`, `{{ctaCteCodigoSistema}}`, `{{ctaCteTransaccion}}`
- `{{cajaAhorroCodigoSistema}}`, `{{cajaAhorroTransaccion}}`
- `{{plazoFijoCodigoProducto}}`, `{{plazoFijoCodigoMovimiento}}`

`renglon1` existió acá para Cuenta Corriente y Caja de Ahorro, pero se sacó:
"Alta de Plazo Fijos - File" (el único flow operativo hoy) arma esos
`Renglon1`/`Renglon2`/`Renglon3` directamente en su propio `bodyTemplate`
(fijos o por fila, según el paso — ver "Flow 'Alta de Plazo Fijos - File'"
más abajo), no desde Parametría.
Si necesitás otra combinación de campos parametrizados, agregá una nueva
categoría a `parametria.local.json`/`parametria.sample.json` y a
`Get-ParametriaVariables` en `modules/FlowEngine.psm1`.

### Conexión a una base Sybase (para steps SQL)

En el diálogo de Parametría, la sección **"Conexión Sybase"** tiene tres
campos:

- **Connection string**: el connection string ODBC completo, con
  `{{usuario}}`/`{{password}}` como placeholders en vez de las credenciales
  reales — ej. `Driver={Adaptive Server Enterprise};NetworkAddress=Aconquija4.bv.voii.com.ar,5000;Database=Banksys;Uid={{usuario}};Pwd={{password}}`.
  El nombre exacto del driver (`Adaptive Server Enterprise`, `SYBASE ASE ODBC Driver`, etc.) depende de qué driver ODBC tengas instalado — la app no
  asume ninguno en particular ni instala nada, solo arma el string que le
  vas a pasar a `System.Data.Odbc.OdbcConnection`. El driver SAP/Sybase ASE
  usa `NetworkAddress=host,puerto` (una sola clave, separada por coma) para
  indicar a qué servidor conectarse — **no** `Server=host;Port=puerto` como
  claves separadas; con esas dos claves el driver las ignora silenciosamente
  y falla con un error como `There is no server listening at :5000` (host
  vacío, antes de los dos puntos).
- **Usuario** y **Contraseña**: se sustituyen en el connection string. La
  contraseña **nunca vuelve al navegador** en el `GET /api/parametria` (el
  campo siempre aparece vacío al abrir el diálogo) y, si la dejás vacía al
  guardar, se conserva la que ya estaba — mismo criterio que
  `clientSecret`/`apiKeyOrToken` en los perfiles.

Botón **"Probar conexión"**: abre la conexión ODBC con los valores del
formulario (usando la contraseña ya guardada si la dejaste en blanco) y
avisa si conectó o el error exacto, sin ejecutar ninguna consulta.

**Requisito:** la máquina donde corre `server.ps1` tiene que tener ya
instalado un driver ODBC de Sybase/SAP ASE (por ejemplo, el que trae Sybase
Open Client, PowerBuilder, o el cliente del banco) — esta app no instala,
descarga ni empaqueta ningún driver, solo lo usa si ya está.

### Steps de tipo SQL (consultas contra Sybase)

Un step de un flow puede declarar `"type": "sql"` en vez de hacer un
request HTTP. En ese caso no usa `method`/`pathTemplate`/`headers`/
`bodyTemplate` — solo `query`:

```json
{
  "name": "Consultar saldo en Sybase",
  "type": "sql",
  "query": "SELECT saldo FROM cuentas WHERE numeroCuenta = {{numeroCuenta}}",
  "extractVariables": { "saldo": "rows[0].saldo" },
  "expectedStatusCode": 200
}
```

- `query` admite los mismos placeholders `{{variable}}` que `pathTemplate`/
  `bodyTemplate` (inputs del usuario, parametría, variables extraídas en
  pasos previos, `{{nowDate}}`/etc.).
- La conexión se abre con el connection string + usuario + contraseña
  configurados en Parametría (ver arriba) — no hace falta declararlos en el
  flow.
- El resultado de la consulta se envuelve como `{ "rows": [ {columna: valor, ...}, ... ] }` y `extractVariables` funciona exactamente igual que en un
  step HTTP (notación de puntos con índice de array, ej. `"rows[0].saldo"`
  o `"rows[2].numeroCuenta"`).
- `expectedStatusCode` no aplica a un step SQL (no hay HTTP status): el
  step se marca en error solo si la conexión o la consulta tiran una
  excepción (ODBC no disponible, SQL inválido, etc.), no por la cantidad de
  filas devueltas.
- Se loguea en `logs/http.log` igual que un step HTTP (mismo formato
  `>>> REQUEST`/`<<< RESPONSE`), con el connection string logueado con la
  contraseña como `***REDACTED***` (nunca en texto plano).
- `requireVariables` (opcional, array de nombres): después de aplicar
  `extractVariables`, el step SQL falla explícitamente (con un mensaje
  claro) si alguna de esas variables no quedó seteada — por ejemplo, porque
  la columna vino `NULL`. Sin esto, una variable no encontrada simplemente
  no pisa nada y el flow sigue de largo: un step **posterior** que la
  necesite recién fallaría ahí (y solo si el placeholder `{{...}}` sin
  reemplazar termina rompiendo el JSON — no siempre pasa, ej. dentro de un
  campo entre comillas queda como string "raro" pero sigue siendo JSON
  válido). Útil cuando un step **anterior** en la misma cadena no depende de
  esa variable y se ejecutaría igual sin ella — por ejemplo, un débito que
  no debería dispararse si un step SQL previo no encontró a qué cuenta
  acreditar después. Ningún flow lo usa hoy ("Alta de Plazo Fijos - File"
  resuelve ese mismo caso distinto, sin step SQL propio — ver más abajo),
  pero queda disponible para el que lo necesite.

**Riesgo de inyección SQL:** `query` se arma con el mismo mecanismo de
reemplazo de texto plano que usan `pathTemplate`/`bodyTemplate` — no
escapa comillas ni nada por el estilo. Un valor con una comilla simple
puede romper la consulta, y si alguna vez un input viniera de una fuente no
confiable, esto habilita inyección SQL. Pensado para los mismos inputs
manuales/de parametría, ya confiables, que usa el resto de la app — no para
pasar datos externos sin validar.

## Cómo definir un flow nuevo

Cada archivo en `Flows/*.json` sigue esta forma (idéntica a la que ya tenían
los flows de ejemplo):

```json
{
  "name": "Nombre visible",
  "description": "Qué hace este flow",
  "inputs": [
    { "variableName": "accountNumber", "label": "Número de cuenta", "defaultValue": "", "secret": false }
  ],
  "steps": [
    {
      "name": "Nombre del paso",
      "method": "GET",
      "pathTemplate": "/accounts/{{accountNumber}}/balance",
      "headers": { "Accept": "application/json" },
      "bodyTemplate": null,
      "bodyContentType": "application/json",
      "extractVariables": { "balance": "data.balance" },
      "expectedStatusCode": 200
    }
  ]
}
```

- `pathTemplate`, `bodyTemplate` y los valores de `headers` admiten
  placeholders `{{variable}}` que se resuelven con los inputs del usuario o
  con variables extraídas en pasos previos.
- `bodyContentType` es opcional (default `"application/json"`); usalo para
  endpoints que esperan `application/x-www-form-urlencoded` u otro formato.
- `omitIfNull` (opcional, array de nombres de campo, solo con
  `bodyContentType` JSON): para un campo opcional que el banco espera que
  directamente **no aparezca** en el JSON en vez de ir vacío o en `null`.
  Armá el `bodyTemplate` con el placeholder sin comillas (ej.
  `"codigoCuenta": {{cuecodSistema4}}`) y que la variable, cuando no
  corresponda, resuelva al literal JSON `null` (no a texto vacío ni a un
  `{{...}}` sin reemplazar, que rompería el JSON) — con `omitIfNull:
  ["codigoCuenta"]` en el step, esa clave se borra del body antes de
  mandarlo si terminó en `null`. Ver "Alta de Plazo Fijos - File" más
  abajo para un ejemplo real (`codigoCuenta` de la cuenta de Plazo Fijo,
  opcional para el banco).
- `extractVariables` mapea `nombreDeVariable -> path` dentro del JSON de
  respuesta (notación de puntos, con índices de array opcionales, ej.
  `"items[0].id"`). El valor extraído queda disponible para los pasos
  siguientes del mismo flow.
- Si la respuesta HTTP no coincide con `expectedStatusCode` (default `200`),
  el flow se detiene y el paso queda marcado como error.
- Los cambios en `Flows/` se leen del disco en cada request a `/api/flows` —
  solo hace falta recargar la página del navegador, no reiniciar el servidor.
- Ningún step con `method` `GET`/`HEAD` debe llevar `bodyTemplate` — el motor
  lo ignora si lo definís (ver "Limitaciones conocidas").
- Un flow con `"enabled": false` en el JSON se ignora por completo: no
  aparece en la lista de la UI ni se puede ejecutar (ni por nombre desde
  `/api/run`). Útil para dejar en el repo un flow de ejemplo o en desuso sin
  que aparezca como opción activa ni se pueda disparar por accidente. Sin ese
  campo (o con `true`), el flow está activo — es el comportamiento de
  siempre. Ninguno de los dos flows que quedan hoy lo usa.
- `"hidden": true` es distinto: saca al flow de la lista que muestra la UI
  (`GET /api/flows`, filtrado en `server.ps1`), pero lo sigue dejando
  ejecutable por nombre vía `/api/run` (`Get-Flows` no lo filtra ahí) — para
  una dependencia interna que otro flow llama por atrás y que no tiene
  sentido que alguien elija a mano. Es el caso de
  `Flows/recupera-cuentas-sql.json` (ver "Flow 'Recupera cuentas (SQL)'" más
  abajo): existe, se puede ejecutar, pero no aparece en la lista de la UI.

### Flows que cargan sus inputs desde un archivo CSV (carga masiva)

Un flow pensado para tipear a mano puede tener una versión "Files" que, en
vez de mostrar un formulario, pide un archivo `.csv` y ejecuta el flow una
vez por cada fila (ej. `Flows/plazo-fijo-cocos-files-sql.json`). Para esto:

```json
{
  "name": "Nombre visible Files",
  "inputMode": "csv",
  "inputs": [ /* mismo array que el flow original, en el orden que van las columnas */ ],
  "steps": [ /* idénticos al flow original */ ]
}
```

- `"inputMode": "csv"` es lo único que cambia respecto de un flow normal —
  hace que la UI muestre una zona de archivo (con drag & drop, además del
  selector de siempre) en vez del formulario.
- El CSV **no lleva fila de encabezado**: la columna 1 de cada fila es el
  primer elemento de `inputs`, la columna 2 el segundo, y así — el mismo
  orden en que están declarados en `inputs`. Los valores no necesitan
  comillas salvo que el campo tenga una coma (ver más abajo).
- Cada fila se ejecuta como una corrida independiente del flow completo (los
  mismos pasos, en el mismo orden, con la misma lógica de "si un paso falla
  no se ejecutan los siguientes de esa fila"). El motor de ejecución
  (`Invoke-Flow`) es el mismo que usa cualquier otro flow — no hay un
  endpoint de "batch" separado — así que si una fila falla, se sigue
  procesando el resto.
- A diferencia de un flow normal, para `inputMode: "csv"` **no se muestra la
  tabla de log paso a paso** en pantalla (quedaría enorme con muchas filas) —
  solo el resumen ok/error por paso (ver más abajo). El detalle completo de
  cada request/response de cada fila sigue quedando, igual que siempre, en
  `logs/http.log`.
- Si `Importe` (u otro campo numérico) viene de un CSV separado por comas,
  los decimales tienen que ir con punto (`1500.50`), no con coma, porque la
  coma es el separador de columnas.
- El parser de CSV de la UI (`parseCsvLine` en `wwwroot/app.js`) respeta
  comillas envolventes tipo `"texto"` (las que agrega Excel al exportar):
  un campo entrecomillado **sí** puede contener comas sin que corten la
  columna — necesario para `Apellido y Nombre` en formato
  `"APELLIDO, Nombre"`, el más común en Argentina. Una comilla doble `""`
  dentro de un campo entrecomillado es una comilla literal (misma regla que
  usa Excel).
- Mientras procesa el CSV (y al terminar), la UI muestra un resumen con el
  **total de registros** y, por cada paso del flow (ej. Débito en Cuenta
  Corriente, Crédito en Caja de Ahorro, Alta de Plazo Fijo), cuántas filas lo
  completaron bien (en verde) y cuántas no (en rojo). Un paso cuenta como "no"
  tanto si ese paso específico falló como si no llegó a ejecutarse (porque un
  paso anterior de la misma fila falló, la fila tenía mal la cantidad de
  columnas, o hubo un error de red antes de tener respuesta) — así el total
  ok+error de cada paso siempre coincide con la cantidad de filas procesadas
  hasta ese momento.
- Al terminar de procesar todas las filas, la UI guarda automáticamente en
  el servidor (carpeta `files/`, ver "Archivos de salida (`files/`)" más
  abajo) hasta dos `.csv`: uno con el detalle de los plazos fijos dados de
  alta y otro con las filas que fallaron.

### Archivos de salida (`files/`)

`wwwroot/app.js` (`saveOutputFiles`) arma, al terminar de procesar un flow
CSV, hasta dos archivos y los manda a `POST /api/save-output`
(`server.ps1`), que los escribe en `<carpeta de la app>/files/` (se crea
sola si no existe; **no se versiona**, está en `.gitignore`, porque va a
tener datos bancarios reales). Los dos comparten el mismo timestamp
(`yyyyMMddHHmmss`, generado una sola vez al terminar el lote), para que se
identifiquen como del mismo archivo procesado:

- **`pfout-<timestamp>.csv`** — una fila por cada plazo fijo dado de alta
  (no una fila por cada item que devuelve la API), tomando la respuesta del
  **último paso** del flow (la alta del plazo fijo) de cada fila del CSV de
  origen que llegó a completarse con éxito. La respuesta trae un array
  `output` con 2 items por plazo fijo (función 1 = capital, función 3 =
  interés) que comparten `operacion`/`vencimiento`/`tem`/`tna`/`importeNeto`
  — se unifican en una sola fila con columnas `numeroComprobante`, `cuit` y
  `apellidoNombre` (tomados de la fila de entrada, columnas 5, 1 y 2 del
  CSV de origen respectivamente), `operacion`, `vencimiento`, `tem`, `tna`,
  `importeNeto`, `montoCapital`, `montoInteres`, `otros` (si algún item
  viene con una función distinta de 1 o 3, no se pierde: queda listado ahí
  en vez de en una columna propia) e `idMensaje` al final — el mismo valor
  generado para esa fila (ver `{{idMensajeGenerado}}`), para poder cruzar
  cada plazo fijo dado de alta con su `IdMensaje` real. **Con encabezado.**
  Asume que el último step del flow es el que da de alta el plazo fijo y
  devuelve ese formato — no es genérico para cualquier otro flow CSV que se
  agregue en el futuro.
- **`pfouterror-<timestamp>.csv`** — una fila por cada fila del CSV de
  origen que **no** terminó de darse de alta (columnas de más/menos, cuenta
  no encontrada en Sybase, operación bloqueada por duplicada — ver más
  abajo —, o cualquier paso del banco en error), con la fila **tal cual
  vino en el archivo de entrada** (mismas columnas, mismo orden) más el
  `IdMensaje` generado para esa fila al final. **Sin encabezado**, igual
  que el archivo de entrada — pensado para poder inspeccionar o volver a
  subir las filas que fallaron.

Si no hubo ningún plazo fijo dado de alta, no se genera `pfout-...`; si no
hubo ninguna fila fallada, no se genera `pfouterror-...`. `POST
/api/save-output` valida que `prefix` (`pfout-`/`pfouterror-`) y
`timestamp` tengan un formato estricto (`[a-zA-Z0-9-]` y 14 dígitos,
respectivamente) antes de armar el nombre de archivo — es la única defensa
contra path traversal en un endpoint que escribe a disco a partir de un
valor que arma el cliente.

Además de guardarse en `files/`, cada archivo se descarga automáticamente
al navegador apenas se guarda (`downloadTextFile`, mismo mecanismo Blob +
`<a download>` que ya usaba "Guardar log..."), sin esperar a que el usuario
lo pida.

**Panel "Archivos de salida..."** (botón en la barra superior, visible para
cualquier usuario logueado): lista todo lo que hay guardado en `files/` que
matchee el patrón `(pfout|pfouterror)-<14 dígitos>.csv` — nombre, fecha y
tamaño, más recientes primero — y permite volver a descargar cualquiera,
útil si se cerró el navegador antes de que la descarga automática
terminara o si hace falta recuperar el de una corrida anterior. Dos rutas
nuevas, implementadas igual en los dos backends:

- `GET /api/output-files` — devuelve `[{ name, size, mtime }, ...]`.
- `GET /api/output-files/content?name=<archivo>` — devuelve `{ name,
  content }` con el contenido completo del archivo (el cliente arma el
  Blob y dispara la descarga, igual que al terminar un CSV). Valida `name`
  contra el mismo patrón estricto de arriba antes de tocar el disco —
  misma defensa contra path traversal que `/api/save-output` — y además
  registra en el log de seguridad quién descargó qué archivo.

### Prevención de operaciones duplicadas

Antes de procesar ninguna fila de un CSV, la UI manda al servidor las
`(cuit, numeroComprobante)` de **todo el archivo** en una sola consulta
(`POST /api/check-operations`) para saber cuáles ya se procesaron con
éxito antes — evita duplicar un débito/crédito/alta de plazo fijo real por
subir el mismo archivo dos veces, o por repetir un comprobante en un
archivo distinto. Si el chequeo en sí falla (error de red, servidor caído),
se aborta el archivo entero por seguridad — no sigue de largo como si no
hubiera duplicados.

Una fila cuyo `(cuit, numeroComprobante)` ya está registrado queda
**bloqueada directamente, sin excepción ni confirmación**: no se llama a
ningún endpoint del banco para esa fila (se chequea antes incluso que la
cuenta en Sybase) y termina en `pfouterror-...` con el motivo del bloqueo.
No hay forma de "forzar" el reproceso desde la UI — si hace falta de
verdad, hoy solo se puede editando a mano
`logs/processed-operations.json`.

El registro (`modules/ProcessedOperationsStore.psm1`,
`logs/processed-operations.json`, no versionado) solo se llena con
operaciones que **realmente se dieron de alta** (mismo criterio que decide
si una fila entra a `pfout-...`) — nunca con filas que fallaron o se
bloquearon, así que sí se pueden reintentar sin quedar frenadas para
siempre por su propio intento fallido. El registro se guarda en un solo
`POST /api/register-operations` al terminar de procesar todo el archivo
(no una llamada por fila), con todas las operaciones exitosas de ese lote.

Cada vez que `POST /api/check-operations` encuentra una o más operaciones
duplicadas se deja constancia en `logs/security.log`, con el usuario que
subió el archivo y el detalle de cada `(cuit, numeroComprobante)`
bloqueado (misma línea de tiempo que logins, ejecuciones de flows, etc.).

### Variables de sistema (fecha/hora sin pedirlas al usuario)

Además de los inputs del usuario y las variables extraídas de pasos previos,
todo flow tiene disponibles automáticamente:

- `{{nowDate}}` — fecha actual, `yyyy-MM-dd`.
- `{{nowDateTime}}` — fecha y hora actual, `yyyy-MM-dd HH:mm:ss`.
- `{{nowTime}}` — hora actual, `HH:mm:ss`.
- `{{nowCompact}}` — fecha y hora actual sin separadores, `yyyyMMddHHmm`
  (útil para IDs de mensaje tipo `202608251243`).
- `{{idMensajeGenerado}}` — `IdMensaje` generado automáticamente,
  `PFC` + fecha y hora actual sin separadores con segundos y milisegundos,
  `yyyyMMddHHmmssfff` (ej. `PFC20260828143205123`). Los milisegundos al
  final son para que no se repita entre filas de un mismo archivo (con solo
  segundos, dos filas procesadas dentro del mismo segundo tendrían el mismo
  valor). `Invoke-Flow` la recalcula en cada corrida (una por fila en un
  flow CSV) como valor por defecto, pero
  "Alta de Plazo Fijos - File" la genera del lado del cliente
  (`wwwroot/app.js`, `generateIdMensaje`) y la manda como input de la fila
  (un input pisa la variable de sistema del mismo nombre) — así el cliente
  conoce el valor exacto usado en cada fila y lo puede agregar a "Descargar
  detalle de Plazos Fijos..." (el servidor no lo devuelve en la respuesta).
  `idMensaje` no es una columna del CSV de entrada: se genera solo por fila.

Útil para campos como `FechaMovimiento`/`FechaNegocio`/`FechayHoraMensaje`
que el sistema debe completar solo, sin que el usuario los tenga que tipear
(ver `Flows/plazo-fijo-cocos-files-sql.json`). `{{nowCompact}}` queda
disponible para el que lo necesite, aunque hoy ningún flow lo usa.

### Inputs con opciones fijas (selector en vez de campo de texto)

Un input puede declararse como selector en lugar de caja de texto libre,
útil cuando el valor real que espera la API es un código interno (`"C"`,
`" "`, etc.) que no tiene sentido que el usuario tipee a mano:

```json
{
  "variableName": "tipoMovimiento",
  "label": "Tipo de movimiento",
  "type": "select",
  "options": [
    { "label": "Crédito", "value": "C" },
    { "label": "Débito", "value": " " }
  ],
  "defaultValue": "C"
}
```

Sin `"type": "select"` (o sin `"options"`), el input se renderiza como
siempre, una caja de texto.

Con `"type": "textarea"` el input se renderiza como una caja de texto
multilínea (4 filas) en vez de un `<input>` de una sola línea — útil para
texto largo, como una consulta SQL escrita a mano. Ninguno de los dos flows
que quedan hoy usa `select` ni `textarea`, pero ambos tipos siguen
disponibles para el próximo flow que se agregue.

### Flow "Recupera cuentas (SQL)"

`Flows/recupera-cuentas-sql.json` es una consulta SQL fija que trae, por
cada `nrodoc` + `sistcod` (código de sistema 4/5, moneda 0, estado de cuenta
1/2), la `cuecod` más chica, sin duplicados (`GROUP BY nrodoc, sistcod` +
`MIN(cuecod)`). El único input manual es `nrodoc`, que se pega tal cual
dentro del `IN (...)` de la consulta — admite uno o varios números de
documento separados por coma (ej. `20308626971` o
`20308626971,23237103769`).

`nrodoc`/`cuecod` se traen con `CAST(... AS VARCHAR(20))` en vez de como
número — no es un capricho de formato: probando con un driver ODBC (no
Sybase) durante el desarrollo, un `nrodoc` de 11 dígitos volvió truncado
y con el signo cambiado porque el driver reportó la columna como entero
de 32 bits en vez de uno más ancho. Devolverlo como texto evita depender
de que el driver ODBC infiera bien el tipo — para un identificador
(no algo con lo que se hagan cuentas) no hay ninguna desventaja.

Tiene `"hidden": true` (ver "Cómo definir un flow nuevo"): no aparece en la
lista de flows de la UI porque no está pensado para elegirse a mano — lo usa
"Alta de Plazo Fijos - File" por atrás (`wwwroot/app.js`, función
`fetchAccountsByCuit`) para buscar, en una sola consulta, las cuentas de
todos los CUIT de un archivo antes de procesar ninguna fila. Sigue siendo
ejecutable por nombre vía `/api/run` si hiciera falta correrlo suelto.

### Flow "Alta de Plazo Fijos - File"

`Flows/plazo-fijo-cocos-files-sql.json` es hoy el único flow operativo de la
app: carga un archivo `.csv` con operaciones de Plazo Fijo y, por cada fila,
busca las cuentas del cliente en Sybase, debita de Cuenta Corriente,
acredita en Caja de Ahorro y da de alta el Plazo Fijo. El CSV de entrada
tiene 6 columnas, sin encabezado, en este orden: `CUIT, Apellido y Nombre,
Monto, Plazo, Nro_Comprobante, Circuito`. `Apellido y Nombre` (input
`apellidoNombre`) se usa en el `Renglon2` del paso de débito — ver más abajo.
`idMensaje` no es columna del CSV: se genera solo por fila
(`{{idMensajeGenerado}}`, ver "Variables de sistema").

`Circuito` decide, fila por fila, cuáles de los 3 steps se ejecutan (ver
`wwwroot/app.js`, función `runFlowFromCsv`):

- `0`: flujo completo, como antes — débito en Cuenta Corriente, crédito en
  Caja de Ahorro y alta de Plazo Fijo.
- `1`: solo la API de alta de Plazo Fijo — no se debita Cuenta Corriente ni
  se acredita Caja de Ahorro. Las cuentas (`cuecodSistema5`/`cuecodSistema4`)
  se siguen resolviendo igual que para cualquier fila (`fetchAccountsByCuit`
  las busca para **todos** los CUIT del archivo antes del loop, sin importar
  Circuito); esta fila simplemente no ejecuta los dos primeros steps. El
  step de alta se corre por nombre vía `/api/run` contra
  `Flows/plazo-fijo-cocos-files-solo-alta.json` ("Alta de Plazo Fijo
  (solo)"), un flow oculto (`"hidden": true`, no aparece en la lista) con el
  mismo step 3, body y `omitIfNull` que el flow completo.
- Cualquier otro valor: la fila queda directamente en error (`El campo
  Circuito debe ser 0 o 1...`), sin llamar a ningún endpoint del banco.

El resumen por step (`#csvSummary`) refleja esto: una fila con Circuito = 1
suma "sin ejecutar (Circuito = 1)" en los steps 1 y 2 en vez de contarlos
como error.

**El flow en sí solo tiene 3 steps HTTP** (débito en Cuenta Corriente,
crédito en Caja de Ahorro, alta de Plazo Fijo) — **no** tiene ningún step
SQL. La búsqueda de cuentas en Sybase no se hace por fila: la UI
(`wwwroot/app.js`, función `fetchAccountsByCuit`) junta los CUIT **únicos**
de todo el archivo antes de procesar ninguna fila y hace **una sola**
consulta a Sybase para todos juntos (reusando el flow "Recupera cuentas
(SQL)", que ya soporta una lista de `nrodoc` separados por coma) — en vez
de una consulta por fila, o incluso una por cada CUIT repetido. El
resultado se guarda en un `Map` en memoria (`cuit -> {cuecodSistema5,
cuecodSistema4}`) y, al procesar cada fila, esos dos valores se agregan
como inputs extra (`cuecodSistema5`/`cuecodSistema4`) además de las 6
columnas del CSV — el motor no exige que un input declarado en `flow.inputs`
sea la única fuente de variables, así que esto funciona sin declararlos ahí
(si estuvieran en `inputs`, la UI los pediría como columnas del CSV, que ya
no lo son).

Si no se encontró `cuecodSistema5` (Caja de Ahorro, adonde va la plata)
para el CUIT de una fila, esa fila queda directamente en error **sin
llamar a ningún endpoint del banco** — nunca se debita de Cuenta Corriente
sin saber a qué cuenta acreditar. Si no se encontró `cuecodSistema4`
(cuenta administrativa de Plazo Fijo, campo opcional para el banco), la
fila sigue igual, pasando el texto literal `null` para esa variable — el
alta de Plazo Fijo se arma con `"codigoCuenta": null` (JSON válido) y el
step usa `"omitIfNull": ["codigoCuenta"]` (campo opcional de un step HTTP,
en `modules/FlowEngine.psm1`) para borrar esa clave del body antes de
mandarlo, en vez de mandarla vacía o en `null` — el banco espera que
directamente no aparezca. Con cuenta encontrada, `codigoCuenta` sigue
yendo como número sin comillas (`"codigoCuenta": 2104`).

Si algún valor de la primera columna no es puramente numérico, se aborta
el archivo entero antes de mandar ninguna consulta (defensa contra
inyección SQL al armar la lista de CUIT para el `IN (...)`).

**Renglon1/Renglon2/Renglon3** de los dos pasos de débito/crédito no salen
de Parametría (ver "Módulo de parametría" más arriba: ese campo se sacó):

- Paso 1, débito en Cuenta Corriente — armados por fila, con datos del
  cliente: `Renglon1` = `"Benef.: CUIL Nro.:" + cuit`, `Renglon2` =
  `"Nom.:" + apellidoNombre`, `Renglon3` fijo en `"Ref.: VAR"`.
- Paso 2, crédito en Caja de Ahorro — fijos, iguales en todas las filas (el
  "Orig." de la operación es siempre Cocos Capital S.A., no el cliente):
  `Renglon1` = `"Orig.: CUIL Nro.: 30708424478"`, `Renglon2` =
  `"Nom.: Cocos Capital S.A."`, `Renglon3` = `"Ref: VAR"` (sin el punto
  después de "Ref", a diferencia del paso 1 — así lo pidieron).

### Panel de resultado de un step SQL

Para cualquier flow cuyo último step sea `"type": "sql"` (hoy solo
"Recupera cuentas (SQL)", oculto de la lista pero renderiza igual si se
corre por nombre) la tabla de log paso a paso tampoco se muestra: en su
lugar aparece una tabla HTML con el array `rows` de la respuesta (columnas
= las que devuelve la consulta, en el mismo orden). El detalle completo
sigue disponible en `logs/http.log` y en "Guardar log...".

## Logs en disco

Cada paso de un flow que llega a mandar un request (no la obtención interna
del token OAuth2, para no loguear `client_secret`) se registra en
`logs/http.log`, creado junto al script: primero el bloque `>>> REQUEST`
(método, URL, headers, body) y después, cuando llega, el bloque
`<<< RESPONSE` (HTTP status, duración, body completo sin el corte a
200.000 caracteres que sí tiene la UI) — en ese orden cronológico, aunque el request
se escribe antes de mandarse, así queda registrado igual si la respuesta
nunca llega (timeout, host inalcanzable).

Es append-only (crece con cada ejecución, nunca se rota ni se limpia solo) y
**no se versiona** (`logs/` está en `.gitignore`) porque va a contener datos
bancarios reales — números de cuenta, DNIs, importes. El header
`Authorization` (y el header de ApiKey, si el perfil usa ese tipo de
autenticación) se guarda como `***REDACTED***`, nunca el valor real.

`logs/security.log` — ver "Auditoría" en "Módulo de seguridad" — y
`logs/processed-operations.json` — ver "Prevención de operaciones
duplicadas" — viven en la misma carpeta, tampoco se versionan.

## Limitaciones conocidas

- Soporta REST con ApiKey, Bearer estático u OAuth2 client_credentials. No
  soporta mTLS ni SOAP.
- Las credenciales (`apiKeyOrToken`, `clientSecret`, y la contraseña de
  Sybase en `parametria.local.json`) se guardan en texto plano en disco. Son
  archivos locales, no se versionan, pero no están cifrados.
- Los steps `"type": "sql"` requieren un driver ODBC de Sybase/SAP ASE ya
  instalado en la máquina (backend PowerShell) o el Open Client/Server de
  SAP con `isql` disponible (backend Node.js) — la app no instala ni
  empaqueta ninguno de los dos. Tampoco escapan el SQL armado por `query`
  (mismo mecanismo de texto plano que `pathTemplate`/`bodyTemplate`);
  pensado para inputs ya confiables, no para datos externos sin validar
  (ver "Steps de tipo SQL" más arriba). El backend Node.js además parsea
  la salida de texto de `isql` por posición de columna — ver "Conexión a
  Sybase en el backend Node.js" para el detalle y sus trade-offs conocidos.
- El **backend PowerShell** atiende un request HTTP a la vez
  (`HttpListener.GetContext()` sincrónico) — pensado para un solo usuario
  ejecutando flows manualmente, no para uso concurrente. El **backend
  Node.js** sí atiende requests en paralelo (I/O asíncrono nativo), pero
  ninguno de los dos backends fue pensado ni probado como servicio
  productivo con muchos usuarios concurrentes ejecutando flows largos al
  mismo tiempo.
- El diálogo de perfiles de la UI no expone los campos de OAuth2 más
  avanzados (`tokenParams`, `tokenHeaders`, `tokenAccessTokenPath`, etc.) —
  se completan editando `profiles.local.json` directamente.
- Ningún step de un flow debe llevar body en un método `GET`/`HEAD`: el
  motor lo ignora aunque `bodyTemplate` esté definido, porque en Windows
  PowerShell 5.1 (.NET Framework) `HttpClient` tira una excepción si se le
  asigna body en esos métodos.
- La extracción de variables de la respuesta asume JSON; no soporta XML/SOAP.
