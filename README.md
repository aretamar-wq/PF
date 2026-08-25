# BankCoreFlowRunner

Aplicación web local, **portable** (nada para instalar), que ejecuta *flows* —
secuencias de llamadas a las APIs REST de un core bancario — definidos en
archivos JSON editables sin reiniciar nada.

El servidor es un script de **PowerShell** (el que ya viene instalado en
cualquier Windows 10/11), que expone una API local y sirve una página web
sencilla (HTML/CSS/JS, sin frameworks ni dependencias) para manejarla desde el
navegador. No hay que compilar nada ni instalar .NET, Node, Python ni ningún
runtime adicional.

> **Importante:** los flows en `Flows/*.json` para consulta de saldo,
> movimientos y transferencia son **ejemplos** con endpoints ficticios — hay
> que editarlos para que coincidan con las APIs reales. El flow
> `consulta-plazos-fijos.json` y la autenticación OAuth2 del perfil `IBS` sí
> están armados contra endpoints reales que nos pasaron.

## Cómo correrla (sin instalar nada)

1. Descargá o cloná el repo — es solo texto, no hay nada para compilar.
2. Copiá `profiles.sample.json` a `profiles.local.json` (este archivo **no se
   versiona**, ver `.gitignore`) y completá tus credenciales — ver
   "Configurar perfiles" más abajo.
3. Hacé doble click en **`Iniciar.bat`**. Esto abre PowerShell, levanta el
   servidor local y abre tu navegador en `http://localhost:8787/`
   automáticamente.
   - Si preferís lanzarlo a mano: `powershell -ExecutionPolicy Bypass -File server.ps1`
     (el `-ExecutionPolicy Bypass` es solo para esa ejecución, no cambia
     ninguna configuración del sistema).
   - Si el puerto 8787 está ocupado: `powershell -ExecutionPolicy Bypass -File server.ps1 -Port 8899`
4. Para cerrarla, cerrá la ventana de PowerShell (o Ctrl+C).

## Qué resuelve

- Autenticación por **API Key** (header configurable), **Bearer token
  estático** u **OAuth2 client_credentials** (el servidor obtiene y cachea el
  `access_token` automáticamente antes de cada request).
- Flows multi-paso: cada paso es un request HTTP cuyo path, headers y body
  pueden usar variables (`{{variable}}`) provenientes de los inputs
  ingresados por el usuario o extraídas de la respuesta de un paso anterior.
- Log de ejecución paso a paso (estado, HTTP status, duración,
  respuesta/error) en la propia página, exportable a `.txt` desde el
  navegador. La respuesta que la página muestra corta a los 800
  caracteres; el detalle completo de cada request/response de negocio
  (no de la obtención de token) queda en `logs/requests.log` y
  `logs/responses.log` — ver "Logs en disco" más abajo.
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
wwwroot/
  index.html, app.js, styles.css   Front-end (vanilla JS, sin build step)
Flows/                   *.json de flows (ver "Cómo definir un flow nuevo")
profiles.sample.json      Plantilla de perfiles (sin secretos)
parametria.sample.json   Plantilla de parametría (ver "Módulo de parametría")
```

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

- **Cuenta Corriente**: código de cuenta, código de sistema, transacción,
  renglón 1.
- **Caja de Ahorro**: código de sistema, transacción, renglón 1 (el código de
  cuenta sigue siendo manual en cada flow, porque cambia por operación).
- **Plazo Fijo**: código de producto, código de movimiento.

Se guardan en `parametria.local.json` (plantilla en `parametria.sample.json`,
igual mecánica que los perfiles: el archivo local **no se versiona**, está en
`.gitignore`, porque va a tener códigos de cuenta reales del banco).

Dentro de un flow, estos valores están disponibles como variables de sistema
con nombre fijo (no hace falta declararlos como inputs):

- `{{ctaCteCodigoCuenta}}`, `{{ctaCteCodigoSistema}}`, `{{ctaCteTransaccion}}`, `{{ctaCteRenglon1}}`
- `{{cajaAhorroCodigoSistema}}`, `{{cajaAhorroTransaccion}}`, `{{cajaAhorroRenglon1}}`
- `{{plazoFijoCodigoProducto}}`, `{{plazoFijoCodigoMovimiento}}`

Por eso "Débito/Crédito" está separado en dos flows —
`Flows/debito-credito-cuenta-corriente.json` y
`Flows/debito-credito-caja-de-ahorro.json` — en vez de uno solo con un
selector: cada uno referencia directamente las variables de su categoría.
Si necesitás otra combinación de campos parametrizados, agregá una nueva
categoría a `parametria.local.json`/`parametria.sample.json` y a
`Get-ParametriaVariables` en `modules/FlowEngine.psm1`.

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

### Flows que cargan sus inputs desde un archivo CSV (carga masiva)

Un flow pensado para tipear a mano puede tener una versión "Files" que, en
vez de mostrar un formulario, pide un archivo `.csv` y ejecuta el flow una
vez por cada fila (ej. `Flows/plazo-fijo-cocos-files.json`, copia de
`Flows/plazo-fijo-cocos.json`). Para esto:

```json
{
  "name": "Nombre visible Files",
  "inputMode": "csv",
  "inputs": [ /* mismo array que el flow original, en el orden que van las columnas */ ],
  "steps": [ /* idénticos al flow original */ ]
}
```

- `"inputMode": "csv"` es lo único que cambia respecto de un flow normal —
  hace que la UI muestre un selector de archivo en vez del formulario.
- El CSV **no lleva fila de encabezado**: la columna 1 de cada fila es el
  primer elemento de `inputs`, la columna 2 el segundo, y así — el mismo
  orden en que están declarados en `inputs`. Los valores no necesitan
  comillas salvo que el campo tenga una coma (no soportado, ver más abajo).
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
- El parser de CSV de la UI es simple: separa por comas y sólo entiende
  comillas envolventes tipo `"texto"` (las que agrega Excel al exportar) —
  no soporta comas dentro de un campo entrecomillado.
- Mientras procesa el CSV (y al terminar), la UI muestra un resumen con el
  **total de registros** y, por cada paso del flow (ej. Débito en Cuenta
  Corriente, Crédito en Caja de Ahorro, Alta de Plazo Fijo), cuántas filas lo
  completaron bien (en verde) y cuántas no (en rojo). Un paso cuenta como "no"
  tanto si ese paso específico falló como si no llegó a ejecutarse (porque un
  paso anterior de la misma fila falló, la fila tenía mal la cantidad de
  columnas, o hubo un error de red antes de tener respuesta) — así el total
  ok+error de cada paso siempre coincide con la cantidad de filas procesadas
  hasta ese momento.
- Botón **"Descargar detalle de Plazos Fijos..."**: al terminar de procesar
  (o incluso a mitad de proceso), descarga un `.csv` con una fila por cada
  elemento del array `output` que devuelve la respuesta del **último paso**
  del flow (para `Plazo Fijo Cocos Files`, la alta del plazo fijo) en cada
  fila que llegó a completarse con éxito — columnas `fila` (la fila del CSV
  de origen), `operacion`, `funcion`, `accesorio`, `monto`, `vencimiento`,
  `tem`, `tna`, `importeNeto`. Una fila del CSV de origen que falló (en
  cualquier paso) no agrega nada a este archivo. Asume que el último step
  del flow es el que da de alta el plazo fijo y devuelve ese formato — no es
  genérico para cualquier otro flow CSV que se agregue en el futuro.

### Variables de sistema (fecha/hora sin pedirlas al usuario)

Además de los inputs del usuario y las variables extraídas de pasos previos,
todo flow tiene disponibles automáticamente:

- `{{nowDate}}` — fecha actual, `yyyy-MM-dd`.
- `{{nowDateTime}}` — fecha y hora actual, `yyyy-MM-dd HH:mm:ss`.
- `{{nowTime}}` — hora actual, `HH:mm:ss`.
- `{{nowCompact}}` — fecha y hora actual sin separadores, `yyyyMMddHHmm`
  (útil para IDs de mensaje tipo `202608251243`).

Útil para campos como `FechaMovimiento`/`FechaNegocio`/`FechayHoraMensaje`
que el sistema debe completar solo, sin que el usuario los tenga que tipear
(ver `Flows/debito-credito-cuenta-corriente.json`). `{{nowCompact}}` no lo usa
ningún flow por ahora (`idMensaje` es manual en todos), pero queda disponible
para el que lo necesite.

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

## Logs en disco

Cada paso de un flow que llega a mandar un request (no la obtención interna
del token OAuth2, para no loguear `client_secret`) se registra en
`logs/http.log`, creado junto al script: primero el bloque `>>> REQUEST`
(método, URL, headers, body) y después, cuando llega, el bloque
`<<< RESPONSE` (HTTP status, duración, body completo sin el corte a 800
caracteres que sí tiene la UI) — en ese orden cronológico, aunque el request
se escribe antes de mandarse, así queda registrado igual si la respuesta
nunca llega (timeout, host inalcanzable).

Es append-only (crece con cada ejecución, nunca se rota ni se limpia solo) y
**no se versiona** (`logs/` está en `.gitignore`) porque va a contener datos
bancarios reales — números de cuenta, DNIs, importes. El header
`Authorization` (y el header de ApiKey, si el perfil usa ese tipo de
autenticación) se guarda como `***REDACTED***`, nunca el valor real.

## Limitaciones conocidas

- Soporta REST con ApiKey, Bearer estático u OAuth2 client_credentials. No
  soporta mTLS ni SOAP.
- Las credenciales (`apiKeyOrToken`, `clientSecret`) se guardan en texto
  plano en `profiles.local.json`. Es un archivo local, no se versiona, pero
  no está cifrado en disco.
- El servidor atiende un request HTTP a la vez (`HttpListener.GetContext()`
  sincrónico) — pensado para un solo usuario ejecutando flows manualmente,
  no para uso concurrente ni como servicio productivo expuesto a la red.
- El diálogo de perfiles de la UI no expone los campos de OAuth2 más
  avanzados (`tokenParams`, `tokenHeaders`, `tokenAccessTokenPath`, etc.) —
  se completan editando `profiles.local.json` directamente.
- Ningún step de un flow debe llevar body en un método `GET`/`HEAD`: el
  motor lo ignora aunque `bodyTemplate` esté definido, porque en Windows
  PowerShell 5.1 (.NET Framework) `HttpClient` tira una excepción si se le
  asigna body en esos métodos.
- La extracción de variables de la respuesta asume JSON; no soporta XML/SOAP.
