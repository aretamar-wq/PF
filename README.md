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

- Autenticación por **API Key** (header configurable) o **Bearer token**.
- Flows multi-paso: cada paso es un request HTTP cuyo path, headers y body pueden
  usar variables (`{{variable}}`) provenientes de los inputs ingresados por el
  usuario o extraídas de la respuesta de un paso anterior.
- Log de ejecución paso a paso (estado, HTTP status, duración, respuesta/error),
  exportable a `.txt`.
- Gestión de "perfiles" de conexión (URL base + credenciales) desde la propia UI.
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

## Primer uso

1. Copiá `profiles.sample.json` a `profiles.local.json` (este archivo **no se
   versiona**, queda ignorado por git — ver `.gitignore`) o simplemente creá un
   perfil nuevo desde la UI con el botón **Nuevo...**.
2. Completá URL base, tipo de autenticación (API Key o Bearer) y el token/API key
   real. El token se pide en un campo de contraseña y se guarda en
   `profiles.local.json`, en texto plano en disco — si el core bancario lo exige,
   considerá cifrar ese archivo o usar un vault en un futuro incremento.
3. Elegí un flow de la lista de la izquierda, completá los inputs y tocá
   **Ejecutar flow**. El log de la derecha muestra cada paso con su estado.

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

- Solo soporta REST con autenticación por API Key (header) o Bearer token. No
  soporta OAuth2/mTLS ni SOAP — si el core bancario real los requiere, hay que
  extender `FlowEngine`/`Profile`.
- El token se guarda en texto plano en `profiles.local.json`. Evaluar cifrado
  (DPAPI de Windows, por ejemplo) antes de manejar credenciales de producción.
- La extracción de variables de la respuesta asume JSON; no soporta XML/SOAP.
