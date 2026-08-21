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
  navegador.
- Gestión de "perfiles" de conexión desde la UI web (salvo los tres campos de
  OAuth2, que hoy se completan editando `profiles.local.json` — ver abajo).
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
  FlowStore.psm1         Lee todos los Flows/*.json
  FlowEngine.psm1        Ejecuta un flow paso a paso, incluye el caché de token OAuth2
wwwroot/
  index.html, app.js, styles.css   Front-end (vanilla JS, sin build step)
Flows/                   *.json de flows (ver "Cómo definir un flow nuevo")
profiles.sample.json      Plantilla de perfiles (sin secretos)
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
- `"OAuth2ClientCredentials"` — antes de cada request, el servidor hace
  `POST {tokenUrl}` con body `grant_type=client_credentials&client_id={clientId}&client_secret={clientSecret}`
  (form-urlencoded), toma `access_token`/`expires_in` de la respuesta y lo
  cachea en memoria (nunca en disco, y se pierde si reiniciás el servidor)
  hasta ~30s antes de que venza. Este es el caso del core **IBS**.

Completá `clientId`/`clientSecret` reales directamente en `profiles.local.json`
con un editor de texto — **nunca los pegues en un archivo que se vaya a
commitear** (ni en `Flows/*.json`, ni en `profiles.sample.json`). La UI web
hoy edita nombre/URL base/tipo de auth/ApiKey-Bearer; los tres campos de
OAuth2 se completan por archivo.

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

## Limitaciones conocidas

- Soporta REST con ApiKey, Bearer estático u OAuth2 client_credentials. No
  soporta mTLS ni SOAP.
- Las credenciales (`apiKeyOrToken`, `clientSecret`) se guardan en texto
  plano en `profiles.local.json`. Es un archivo local, no se versiona, pero
  no está cifrado en disco.
- El servidor atiende un request HTTP a la vez (`HttpListener.GetContext()`
  sincrónico) — pensado para un solo usuario ejecutando flows manualmente,
  no para uso concurrente ni como servicio productivo expuesto a la red.
- El diálogo de perfiles de la UI todavía no expone los campos de OAuth2
  (`tokenUrl`/`clientId`/`clientSecret`) — se completan editando
  `profiles.local.json` directamente.
- La extracción de variables de la respuesta asume JSON; no soporta XML/SOAP.
