# BankCoreFlowRunner

Aplicación de escritorio para Windows, **portable** (un solo `.exe`, sin instalador),
que ejecuta *flows* — secuencias de llamadas a las APIs REST de un core bancario —
definidos en archivos JSON editables sin recompilar.

Pensada para automatizar operaciones repetitivas contra un core bancario (consultas
de saldo, movimientos, transferencias, etc.) donde cada flow puede encadenar varios
llamados HTTP, pasando datos de la respuesta de un paso como entrada del siguiente.

> **Importante:** este proyecto se generó sin conocer la especificación real del
> core bancario a integrar. Los flows incluidos en `Flows/*.json` son **ejemplos**
> con endpoints y estructuras de respuesta ficticios — hay que editarlos (o agregar
> nuevos) para que coincidan con las APIs reales.

## Qué resuelve

- Autenticación por **API Key** (header configurable), **Bearer token estático**
  u **OAuth2 client_credentials** (obtiene y cachea el `access_token`
  automáticamente antes de cada request, sin pasos manuales).
- Flows multi-paso: cada paso es un request HTTP cuyo path, headers y body pueden
  usar variables (`{{variable}}`) provenientes de los inputs ingresados por el
  usuario o extraídas de la respuesta de un paso anterior.
- Log de ejecución paso a paso (estado, HTTP status, duración, respuesta/error),
  exportable a `.txt`.
- Gestión de "perfiles" de conexión (URL base + credenciales), configurados por
  archivo (`profiles.local.json`) — ver más abajo.
- Los flows y perfiles viven en archivos JSON junto al `.exe`: se pueden editar,
  agregar o distribuir sin volver a compilar.

## Estructura del proyecto

```
BankCoreFlowRunner.sln
src/BankCoreFlowRunner/
  Models/        Profile, FlowDefinition, FlowStep, StepLogEntry, etc.
  Services/      ProfileStore, FlowStore, VariableSubstitution, JsonPathExtractor, FlowEngine
  ViewModels/     MainViewModel (MVVM, sin dependencias externas)
  Common/         ObservableObjectBase, RelayCommand/AsyncRelayCommand
  Converters/     StatusToBrushConverter (color del estado en la grilla de log)
  Flows/          *.json de ejemplo (se copian junto al exe)
  profiles.sample.json  plantilla de perfil (sin secretos)
```

## Requisitos para compilar

- Windows con **.NET 8 SDK** (`dotnet --version` ≥ 8.0) y el workload de
  escritorio de Windows (viene incluido si instalás el SDK con Visual Studio, o
  se instala solo al compilar un proyecto WPF con el SDK standalone).
- Este proyecto usa WPF (`net8.0-windows`), por lo que **debe compilarse en
  Windows** (no en Linux/macOS).

## Compilar y generar el ejecutable portable

Desde la carpeta del repo, en una consola de Windows:

```powershell
dotnet publish src/BankCoreFlowRunner/BankCoreFlowRunner.csproj `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:EnableCompressionInSingleFile=true `
  -o publish
```

Esto genera `publish\BankCoreFlowRunner.exe`, autocontenido (no requiere tener
.NET instalado en la máquina destino). Junto al exe se copian:

- `Flows\*.json` — los flows disponibles.
- `profiles.sample.json` — plantilla de perfil.

Para distribuir la app de forma portable (USB, carpeta compartida, etc.), copiá
la carpeta `publish` completa — el exe necesita la carpeta `Flows` al lado para
poder leer los flows en tiempo de ejecución.

## Configurar perfiles de conexión (por archivo)

Los perfiles se configuran editando directamente `profiles.local.json` — este
archivo **no se versiona** (está en `.gitignore`) porque contiene credenciales
reales. Para crearlo, copiá la plantilla:

```powershell
copy src\BankCoreFlowRunner\profiles.sample.json src\BankCoreFlowRunner\profiles.local.json
```

(o, en la carpeta ya publicada, `copy profiles.sample.json profiles.local.json`)
y completá los datos. La plantilla trae dos ejemplos:

```json
[
  {
    "Name": "Sandbox",
    "BaseUrl": "https://sandbox.coreapi.example.com/v1",
    "AuthType": "Bearer",
    "ApiKeyHeaderName": "X-Api-Key",
    "ApiKeyOrToken": ""
  },
  {
    "Name": "IBS",
    "BaseUrl": "https://ibs-twapi03.voii.com.ar/ibsapi",
    "AuthType": "OAuth2ClientCredentials",
    "TokenUrl": "https://ibs-twapi03.voii.com.ar/ibsapi/Token",
    "ClientId": "",
    "ClientSecret": ""
  }
]
```

`AuthType` acepta:

- `"ApiKey"` — usa `ApiKeyHeaderName` + `ApiKeyOrToken` como header fijo.
- `"Bearer"` — usa `ApiKeyOrToken` como `Authorization: Bearer <valor>` fijo.
- `"OAuth2ClientCredentials"` — antes de cada request, la app hace
  `POST {TokenUrl}` con body `grant_type=client_credentials&client_id={ClientId}&client_secret={ClientSecret}`
  (form-urlencoded), toma `access_token`/`expires_in` de la respuesta y lo
  cachea en memoria (nunca en disco) hasta ~30s antes de que venza, renovándolo
  solo cuando corresponde. Este es el caso del core **IBS**
  (`https://ibs-twapi03.voii.com.ar/ibsapi/Token`).

Completá `ClientId` y `ClientSecret` reales directamente en `profiles.local.json`
con un editor de texto — **nunca los pegues en un archivo que se vaya a commitear**
(ni en `Flows/*.json`, ni en `profiles.sample.json`). El diálogo "Nuevo.../Editar..."
de la UI sirve hoy para Nombre, URL base, tipo de autenticación y el token/API key
estático; los campos de OAuth2 (`TokenUrl`/`ClientId`/`ClientSecret`) se completan
solo por archivo por ahora.

Una vez configurado el perfil, elegí un flow de la lista de la izquierda, completá
los inputs y tocá **Ejecutar flow**. El log de la derecha muestra cada paso con su
estado (la obtención del token OAuth2, si aplica, ocurre de forma transparente,
no aparece como un paso propio en el log).

## Cómo definir un flow nuevo

Cada archivo en `Flows/*.json` sigue esta forma:

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
      "extractVariables": { "balance": "data.balance" },
      "expectedStatusCode": 200
    }
  ]
}
```

- `pathTemplate`, `bodyTemplate` y los valores de `headers` admiten placeholders
  `{{variable}}` que se resuelven con los inputs del usuario o con variables
  extraídas en pasos previos.
- `extractVariables` mapea `nombreDeVariable -> path` dentro del JSON de
  respuesta (notación de puntos, con índices de array opcionales, ej.
  `"items[0].id"`). El valor extraído queda disponible para los pasos
  siguientes del mismo flow.
- Si la respuesta HTTP no coincide con `expectedStatusCode`, el flow se detiene
  y el paso queda marcado como error.
- Después de agregar o editar un archivo en `Flows/`, usá el botón **Recargar
  flows** en la app (no hace falta reiniciarla).

## Limitaciones conocidas (v1)

- Soporta REST con API Key, Bearer estático u OAuth2 client_credentials. No
  soporta mTLS ni SOAP — si el core bancario real los requiere, hay que
  extender `FlowEngine`/`Profile`.
- Las credenciales (`ApiKeyOrToken`, `ClientSecret`) se guardan en texto plano en
  `profiles.local.json`. Evaluar cifrado (DPAPI de Windows, por ejemplo) antes de
  manejar credenciales de producción.
- El diálogo de edición de perfiles de la UI todavía no expone los campos de
  OAuth2 (`TokenUrl`/`ClientId`/`ClientSecret`) — se completan editando
  `profiles.local.json` directamente.
- La extracción de variables de la respuesta asume JSON; no soporta XML/SOAP.
