#Requires -Version 5.1
<#
BankCoreFlowRunner - servidor web local para ejecutar flows contra APIs de un core
bancario. No requiere instalar nada: corre con el PowerShell que ya trae Windows.
Uso: doble click en Iniciar.bat, o "powershell -ExecutionPolicy Bypass -File server.ps1"
#>
param(
    [int]$Port = 8787
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# En Windows PowerShell 5.1 (a diferencia de PowerShell 7/pwsh) System.Net.Http no
# se carga por default; sin esto, FlowEngine.psm1 falla con "No se encuentra el tipo
# [System.Net.Http.HttpClientHandler]" apenas se intenta ejecutar un flow.
Add-Type -AssemblyName System.Net.Http

Import-Module (Join-Path $scriptRoot 'modules\JsonPath.psm1') -Force
Import-Module (Join-Path $scriptRoot 'modules\VariableSubstitution.psm1') -Force
Import-Module (Join-Path $scriptRoot 'modules\ProfileStore.psm1') -Force
Import-Module (Join-Path $scriptRoot 'modules\ParametriaStore.psm1') -Force
Import-Module (Join-Path $scriptRoot 'modules\FlowStore.psm1') -Force
Import-Module (Join-Path $scriptRoot 'modules\FlowEngine.psm1') -Force

$Global:TokenCache = @{}
$flowsDir = Join-Path $scriptRoot 'Flows'
$wwwRoot = Join-Path $scriptRoot 'wwwroot'
$logsDir = Join-Path $scriptRoot 'logs'

function ConvertTo-JsonArraySafe {
    param($Items, [int]$Depth = 10)
    $array = @($Items)
    if ($array.Count -eq 0) { return '[]' }
    $json = $array | ConvertTo-Json -Depth $Depth
    if ($array.Count -eq 1) { return "[$json]" }
    return $json
}

function Write-JsonResponse {
    param($Response, [int]$StatusCode, $Body)

    $json = if ($Body -is [array]) {
        ConvertTo-JsonArraySafe -Items $Body
    } else {
        $Body | ConvertTo-Json -Depth 10
    }

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $Response.StatusCode = $StatusCode
    $Response.ContentType = 'application/json; charset=utf-8'
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Response.OutputStream.Close()
}

function Write-FileResponse {
    param($Response, [string]$FilePath, [string]$ContentType)

    $bytes = [System.IO.File]::ReadAllBytes($FilePath)
    $Response.StatusCode = 200
    $Response.ContentType = $ContentType
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Response.OutputStream.Close()
}

function Get-ContentType {
    param([string]$Extension)
    switch ($Extension.ToLowerInvariant()) {
        '.html' { return 'text/html; charset=utf-8' }
        '.js'   { return 'application/javascript; charset=utf-8' }
        '.css'  { return 'text/css; charset=utf-8' }
        default { return 'application/octet-stream' }
    }
}

function Read-RequestBody {
    param($Request)
    $reader = New-Object System.IO.StreamReader($Request.InputStream, [System.Text.Encoding]::UTF8)
    try {
        return $reader.ReadToEnd()
    } finally {
        $reader.Close()
    }
}

function Get-MaskedProfile {
    param($Profile)
    [pscustomobject][ordered]@{
        name             = $Profile.name
        baseUrl          = $Profile.baseUrl
        authType         = $Profile.authType
        apiKeyHeaderName = $Profile.apiKeyHeaderName
        hasApiKeyOrToken = -not [string]::IsNullOrEmpty($Profile.apiKeyOrToken)
        tokenUrl         = $Profile.tokenUrl
        clientId         = $Profile.clientId
        hasClientSecret  = -not [string]::IsNullOrEmpty($Profile.clientSecret)
    }
}

$listener = New-Object System.Net.HttpListener
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)

try {
    $listener.Start()
} catch {
    Write-Error "No se pudo iniciar el servidor en $prefix. ¿Ya hay una instancia corriendo, o el puerto está ocupado? Probá con -Port <otro>. $($_.Exception.Message)"
    exit 1
}

Write-Host "BankCoreFlowRunner corriendo en $prefix (Ctrl+C para detener)" -ForegroundColor Green
try {
    Start-Process $prefix
} catch {
    Write-Warning "No se pudo abrir el navegador automáticamente. Abrí $prefix manualmente."
}

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        try {
            $path = $request.Url.AbsolutePath
            $method = $request.HttpMethod

            if ($method -eq 'GET' -and $path -eq '/api/profiles') {
                $profiles = @(Get-Profiles -RootDir $scriptRoot)
                $masked = @($profiles | ForEach-Object { Get-MaskedProfile -Profile $_ })
                Write-JsonResponse -Response $response -StatusCode 200 -Body $masked
            }
            elseif ($method -eq 'POST' -and $path -eq '/api/profiles') {
                $bodyText = Read-RequestBody -Request $request
                $incoming = $bodyText | ConvertFrom-Json
                $profiles = @(Get-Profiles -RootDir $scriptRoot)

                $existingIndex = -1
                for ($i = 0; $i -lt $profiles.Count; $i++) {
                    if ($profiles[$i].name -eq $incoming.name) { $existingIndex = $i; break }
                }

                $updated = [ordered]@{
                    name             = $incoming.name
                    baseUrl          = $incoming.baseUrl
                    authType         = $incoming.authType
                    apiKeyHeaderName = $incoming.apiKeyHeaderName
                    apiKeyOrToken    = $incoming.apiKeyOrToken
                    tokenUrl         = $incoming.tokenUrl
                    clientId         = $incoming.clientId
                    clientSecret     = $incoming.clientSecret
                }

                if ($existingIndex -ge 0) {
                    # Si el form no mandó un secreto nuevo, conservar el que ya había guardado.
                    if ([string]::IsNullOrEmpty($updated.apiKeyOrToken)) { $updated.apiKeyOrToken = $profiles[$existingIndex].apiKeyOrToken }
                    if ([string]::IsNullOrEmpty($updated.clientSecret)) { $updated.clientSecret = $profiles[$existingIndex].clientSecret }
                    $profiles[$existingIndex] = [pscustomobject]$updated
                } else {
                    $profiles += [pscustomobject]$updated
                }

                Save-Profiles -RootDir $scriptRoot -Profiles $profiles
                Write-JsonResponse -Response $response -StatusCode 200 -Body ([pscustomobject]@{ ok = $true })
            }
            elseif ($method -eq 'DELETE' -and $path -eq '/api/profiles') {
                $name = $request.QueryString['name']
                $profiles = @(@(Get-Profiles -RootDir $scriptRoot) | Where-Object { $_.name -ne $name })
                Save-Profiles -RootDir $scriptRoot -Profiles $profiles
                Write-JsonResponse -Response $response -StatusCode 200 -Body ([pscustomobject]@{ ok = $true })
            }
            elseif ($method -eq 'GET' -and $path -eq '/api/flows') {
                $flows = @(Get-Flows -FlowsDir $flowsDir)
                $summary = @($flows | ForEach-Object {
                    [pscustomobject][ordered]@{
                        name        = $_.name
                        description = $_.description
                        inputMode   = $_.inputMode
                        inputs      = $_.inputs
                        steps       = @($_.steps | ForEach-Object { [pscustomobject]@{ name = $_.name } })
                    }
                })
                Write-JsonResponse -Response $response -StatusCode 200 -Body $summary
            }
            elseif ($method -eq 'POST' -and $path -eq '/api/run') {
                $bodyText = Read-RequestBody -Request $request
                $payload = $bodyText | ConvertFrom-Json

                $profiles = @(Get-Profiles -RootDir $scriptRoot)
                $selectedProfile = $profiles | Where-Object { $_.name -eq $payload.profileName } | Select-Object -First 1

                $flows = @(Get-Flows -FlowsDir $flowsDir)
                $selectedFlow = $flows | Where-Object { $_.name -eq $payload.flowName } | Select-Object -First 1

                if ($null -eq $selectedProfile) {
                    Write-JsonResponse -Response $response -StatusCode 400 -Body ([pscustomobject]@{ error = "Perfil '$($payload.profileName)' no encontrado." })
                } elseif ($null -eq $selectedFlow) {
                    Write-JsonResponse -Response $response -StatusCode 400 -Body ([pscustomobject]@{ error = "Flow '$($payload.flowName)' no encontrado." })
                } else {
                    $inputValues = @{}
                    if ($payload.inputs) {
                        foreach ($prop in $payload.inputs.PSObject.Properties) {
                            $inputValues[$prop.Name] = [string]$prop.Value
                        }
                    }

                    $parametria = Get-Parametria -RootDir $scriptRoot
                    $log = @(Invoke-Flow -Profile $selectedProfile -Flow $selectedFlow -InputValues $inputValues -LogsDir $logsDir -Parametria $parametria)
                    Write-JsonResponse -Response $response -StatusCode 200 -Body $log
                }
            }
            elseif ($method -eq 'GET' -and $path -eq '/api/parametria') {
                $parametria = Get-Parametria -RootDir $scriptRoot
                # La contraseña de Sybase nunca sale del servidor en texto plano, ni
                # siquiera hacia la propia UI (mismo criterio que apiKeyOrToken/
                # clientSecret en /api/profiles): el formulario la deja en blanco y el
                # POST conserva la guardada si no se manda una nueva.
                if ($parametria.sybase) {
                    $parametria.sybase.password = ''
                }
                Write-JsonResponse -Response $response -StatusCode 200 -Body $parametria
            }
            elseif ($method -eq 'POST' -and $path -eq '/api/parametria') {
                $bodyText = Read-RequestBody -Request $request
                $incoming = $bodyText | ConvertFrom-Json

                # La contraseña de Sybase nunca se manda de vuelta al navegador (ver GET
                # /api/parametria más abajo), así que si el form la manda vacía es porque
                # el usuario no la tocó: hay que conservar la que ya estaba guardada, no
                # pisarla con "".
                if ($incoming.sybase -and [string]::IsNullOrEmpty([string]$incoming.sybase.password)) {
                    $existing = Get-Parametria -RootDir $scriptRoot
                    if ($existing.sybase) {
                        $incoming.sybase.password = $existing.sybase.password
                    }
                }

                Save-Parametria -RootDir $scriptRoot -Parametria $incoming
                Write-JsonResponse -Response $response -StatusCode 200 -Body ([pscustomobject]@{ ok = $true })
            }
            elseif ($method -eq 'POST' -and $path -eq '/api/test-sybase') {
                $bodyText = Read-RequestBody -Request $request
                $payload = $bodyText | ConvertFrom-Json

                # El diálogo de Parametría nunca precarga la contraseña guardada (por
                # seguridad, ver GET /api/parametria), así que si el usuario prueba la
                # conexión sin retipearla, el form manda "" — en ese caso se usa la que
                # ya está guardada en vez de intentar conectar con contraseña vacía.
                $password = [string]$payload.password
                if ([string]::IsNullOrEmpty($password)) {
                    $existing = Get-Parametria -RootDir $scriptRoot
                    if ($existing.sybase) {
                        $password = [string]$existing.sybase.password
                    }
                }

                $result = Test-SybaseConnection -ConnectionStringTemplate ([string]$payload.connectionString) -Usuario ([string]$payload.usuario) -Password $password
                Write-JsonResponse -Response $response -StatusCode 200 -Body $result
            }
            elseif ($method -eq 'POST' -and $path -eq '/api/test-token') {
                $bodyText = Read-RequestBody -Request $request
                $payload = $bodyText | ConvertFrom-Json

                $profiles = @(Get-Profiles -RootDir $scriptRoot)
                $selectedProfile = $profiles | Where-Object { $_.name -eq $payload.profileName } | Select-Object -First 1

                if ($null -eq $selectedProfile) {
                    Write-JsonResponse -Response $response -StatusCode 400 -Body ([pscustomobject]@{ ok = $false; message = "Perfil '$($payload.profileName)' no encontrado." })
                } else {
                    $result = Test-TokenAcquisition -Profile $selectedProfile
                    Write-JsonResponse -Response $response -StatusCode 200 -Body $result
                }
            }
            elseif ($method -eq 'GET') {
                $relative = if ($path -eq '/') { 'index.html' } else { $path.TrimStart('/') }
                $filePath = Join-Path $wwwRoot $relative
                $fullWwwRoot = [System.IO.Path]::GetFullPath($wwwRoot)
                $fullFilePath = [System.IO.Path]::GetFullPath($filePath)
                $wwwRootPrefix = $fullWwwRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

                if ($fullFilePath.StartsWith($wwwRootPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path $fullFilePath -PathType Leaf)) {
                    $ext = [System.IO.Path]::GetExtension($fullFilePath)
                    Write-FileResponse -Response $response -FilePath $fullFilePath -ContentType (Get-ContentType -Extension $ext)
                } else {
                    $response.StatusCode = 404
                    $response.OutputStream.Close()
                }
            }
            else {
                $response.StatusCode = 404
                $response.OutputStream.Close()
            }
        } catch {
            try {
                Write-JsonResponse -Response $response -StatusCode 500 -Body ([pscustomobject]@{ error = $_.Exception.Message })
            } catch {
                # El cliente ya se había desconectado o la respuesta se cerró; no hay nada más para hacer.
            }
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
