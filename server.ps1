#Requires -Version 5.1
<#
ApiCore - servidor web local para ejecutar flows contra APIs de un core
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

$modulesDir = Join-Path $scriptRoot 'modules'
Import-Module (Join-Path $modulesDir 'JsonPath.psm1') -Force
Import-Module (Join-Path $modulesDir 'VariableSubstitution.psm1') -Force
Import-Module (Join-Path $modulesDir 'ProfileStore.psm1') -Force
Import-Module (Join-Path $modulesDir 'ParametriaStore.psm1') -Force
Import-Module (Join-Path $modulesDir 'FlowStore.psm1') -Force
Import-Module (Join-Path $modulesDir 'FlowEngine.psm1') -Force
Import-Module (Join-Path $modulesDir 'SecurityStore.psm1') -Force
Import-Module (Join-Path $modulesDir 'ProcessedOperationsStore.psm1') -Force

$Global:TokenCache = @{}
$Global:SecuritySessions = @{}
$flowsDir = Join-Path $scriptRoot 'Flows'
$wwwRoot = Join-Path $scriptRoot 'wwwroot'
$logsDir = Join-Path $scriptRoot 'logs'
$filesDir = Join-Path $scriptRoot 'files'

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

function Get-BearerToken {
    param($Request)
    $header = $Request.Headers['Authorization']
    if ([string]::IsNullOrEmpty($header)) { return $null }
    if ($header -notmatch '^Bearer\s+(.+)$') { return $null }
    return $Matches[1].Trim()
}

function Get-ClientAddress {
    param($Request)
    try { return [string]$Request.RemoteEndPoint.Address } catch { return '?' }
}

function Get-AuthenticatedSession {
    # A diferencia de solo mirar el token, esto vuelve a chequear contra
    # security.local.json en cada request (no confía en el rol cacheado al hacer
    # login): si un admin deshabilita o elimina a un usuario, o le cambia el rol,
    # eso tiene efecto inmediato en la próxima request de esa sesión, en vez de
    # recién cuando el token expire (hasta 8hs después).
    param($Request, [string]$RootDir)

    $session = Get-SessionUser -Token (Get-BearerToken -Request $Request)
    if ($null -eq $session) { return $null }

    $currentUser = Find-SecurityUser -RootDir $RootDir -Username $session.username
    if (-not $currentUser -or -not $currentUser.enabled) {
        Remove-Session -Token (Get-BearerToken -Request $Request)
        return $null
    }

    $session.role = $currentUser.role
    $session.displayName = $currentUser.displayName
    return $session
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

Write-Host "ApiCore corriendo en $prefix (Ctrl+C para detener)" -ForegroundColor Green
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

            # Todo /api/* (salvo /api/login) requiere una sesión válida. Los archivos
            # estáticos (index.html/app.js/styles.css, rama GET del final) siguen sin
            # auth a propósito: si no, la pantalla de login no tendría cómo cargar.
            $authRequired = $path.StartsWith('/api/') -and $path -ne '/api/login'
            $session = $null
            if ($authRequired) {
                $session = Get-AuthenticatedSession -Request $request -RootDir $scriptRoot
            }

            if ($authRequired -and $null -eq $session) {
                Write-JsonResponse -Response $response -StatusCode 401 -Body ([pscustomobject]@{ error = 'Sesión inválida o expirada. Iniciá sesión de nuevo.' })
            }
            elseif ($method -eq 'POST' -and $path -eq '/api/login') {
                $bodyText = Read-RequestBody -Request $request
                $payload = $bodyText | ConvertFrom-Json
                $username = [string]$payload.username
                $password = [string]$payload.password
                $clientAddress = Get-ClientAddress -Request $request

                if ([string]::IsNullOrWhiteSpace($username) -or [string]::IsNullOrWhiteSpace($password)) {
                    Write-JsonResponse -Response $response -StatusCode 400 -Body ([pscustomobject]@{ error = 'Usuario y contraseña son obligatorios.' })
                } else {
                    $security = Get-Security -RootDir $scriptRoot
                    $users = @($security.users)
                    $localUser = $users | Where-Object { $_.username -ieq $username } | Select-Object -First 1

                    # Bootstrap: si todavía no hay ningún usuario configurado localmente,
                    # el primer login exitoso contra AD se auto-promueve a admin — si no,
                    # nadie podría entrar nunca a dar de alta al primer usuario. Una vez que
                    # existe al menos un usuario, este atajo no aplica más.
                    $isBootstrap = $users.Count -eq 0

                    if (-not $isBootstrap -and (-not $localUser -or -not $localUser.enabled)) {
                        Write-SecurityLog -LogsDir $logsDir -Message "LOGIN DENEGADO usuario='$username' (no habilitado en la app) desde $clientAddress"
                        Write-JsonResponse -Response $response -StatusCode 401 -Body ([pscustomobject]@{ error = 'Usuario no habilitado en esta aplicación. Pedile a un administrador que te dé de alta.' })
                    } else {
                        $adResult = Test-AdCredentials -AdConfig $security.ad -Username $username -Password $password
                        if (-not $adResult.ok) {
                            Write-SecurityLog -LogsDir $logsDir -Message "LOGIN FALLIDO usuario='$username' desde $clientAddress ($($adResult.message))"
                            Write-JsonResponse -Response $response -StatusCode 401 -Body ([pscustomobject]@{ error = $adResult.message })
                        } else {
                            if ($isBootstrap) {
                                Add-OrUpdateSecurityUser -RootDir $scriptRoot -Username $username -Role 'admin' -Enabled $true
                                $localUser = Find-SecurityUser -RootDir $scriptRoot -Username $username
                                Write-SecurityLog -LogsDir $logsDir -Message "BOOTSTRAP: '$username' se dio de alta como el primer administrador (login exitoso, sin usuarios configurados todavía)"
                            }
                            $token = New-Session -Username $localUser.username -Role $localUser.role -DisplayName $localUser.displayName
                            Write-SecurityLog -LogsDir $logsDir -Message "LOGIN OK usuario='$($localUser.username)' rol='$($localUser.role)' desde $clientAddress"
                            Write-JsonResponse -Response $response -StatusCode 200 -Body ([pscustomobject]@{
                                token       = $token
                                username    = $localUser.username
                                role        = $localUser.role
                                displayName = $localUser.displayName
                            })
                        }
                    }
                }
            }
            elseif ($method -eq 'POST' -and $path -eq '/api/logout') {
                Remove-Session -Token (Get-BearerToken -Request $request)
                Write-JsonResponse -Response $response -StatusCode 200 -Body ([pscustomobject]@{ ok = $true })
            }
            elseif ($method -eq 'GET' -and $path -eq '/api/me') {
                Write-JsonResponse -Response $response -StatusCode 200 -Body ([pscustomobject]@{
                    username    = $session.username
                    role        = $session.role
                    displayName = $session.displayName
                    canManageUsers = Test-RoleCanManageUsers -Role $session.role
                })
            }
            elseif ($method -eq 'GET' -and $path -eq '/api/users') {
                if (-not (Test-RoleCanManageUsers -Role $session.role)) {
                    Write-JsonResponse -Response $response -StatusCode 403 -Body ([pscustomobject]@{ error = 'No tenés permiso para administrar usuarios.' })
                } else {
                    Write-JsonResponse -Response $response -StatusCode 200 -Body (@(Get-SecurityUsers -RootDir $scriptRoot))
                }
            }
            elseif ($method -eq 'POST' -and $path -eq '/api/users') {
                if (-not (Test-RoleCanManageUsers -Role $session.role)) {
                    Write-JsonResponse -Response $response -StatusCode 403 -Body ([pscustomobject]@{ error = 'No tenés permiso para administrar usuarios.' })
                } else {
                    $bodyText = Read-RequestBody -Request $request
                    $incoming = $bodyText | ConvertFrom-Json
                    $targetUsername = [string]$incoming.username
                    $targetRole = [string]$incoming.role
                    $targetEnabled = [bool]$incoming.enabled

                    if ([string]::IsNullOrWhiteSpace($targetUsername)) {
                        Write-JsonResponse -Response $response -StatusCode 400 -Body ([pscustomobject]@{ error = 'Falta el nombre de usuario.' })
                    } elseif ($targetRole -notin (Get-ValidRoles)) {
                        Write-JsonResponse -Response $response -StatusCode 400 -Body ([pscustomobject]@{ error = "Rol inválido. Roles válidos: $((Get-ValidRoles) -join ', ')." })
                    } elseif (-not $targetEnabled -and (Test-IsLastEnabledAdmin -RootDir $scriptRoot -Username $targetUsername)) {
                        Write-JsonResponse -Response $response -StatusCode 400 -Body ([pscustomobject]@{ error = 'No se puede deshabilitar al último administrador habilitado.' })
                    } elseif ($targetRole -ne 'admin' -and (Test-IsLastEnabledAdmin -RootDir $scriptRoot -Username $targetUsername)) {
                        Write-JsonResponse -Response $response -StatusCode 400 -Body ([pscustomobject]@{ error = 'No se puede sacarle el rol de administrador al último administrador habilitado.' })
                    } else {
                        Add-OrUpdateSecurityUser -RootDir $scriptRoot -Username $targetUsername -Role $targetRole -Enabled $targetEnabled -DisplayName ([string]$incoming.displayName)
                        Write-SecurityLog -LogsDir $logsDir -Message "USUARIO '$targetUsername' (rol='$targetRole', habilitado=$targetEnabled) dado de alta/editado por '$($session.username)'"
                        Write-JsonResponse -Response $response -StatusCode 200 -Body ([pscustomobject]@{ ok = $true })
                    }
                }
            }
            elseif ($method -eq 'DELETE' -and $path -eq '/api/users') {
                if (-not (Test-RoleCanManageUsers -Role $session.role)) {
                    Write-JsonResponse -Response $response -StatusCode 403 -Body ([pscustomobject]@{ error = 'No tenés permiso para administrar usuarios.' })
                } else {
                    $targetUsername = $request.QueryString['username']
                    if (Test-IsLastEnabledAdmin -RootDir $scriptRoot -Username $targetUsername) {
                        Write-JsonResponse -Response $response -StatusCode 400 -Body ([pscustomobject]@{ error = 'No se puede eliminar al último administrador habilitado.' })
                    } else {
                        Remove-SecurityUser -RootDir $scriptRoot -Username $targetUsername
                        Write-SecurityLog -LogsDir $logsDir -Message "USUARIO '$targetUsername' eliminado por '$($session.username)'"
                        Write-JsonResponse -Response $response -StatusCode 200 -Body ([pscustomobject]@{ ok = $true })
                    }
                }
            }
            elseif ($method -eq 'GET' -and $path -eq '/api/security-config') {
                if (-not (Test-RoleCanManageUsers -Role $session.role)) {
                    Write-JsonResponse -Response $response -StatusCode 403 -Body ([pscustomobject]@{ error = 'No tenés permiso para administrar usuarios.' })
                } else {
                    $security = Get-Security -RootDir $scriptRoot
                    Write-JsonResponse -Response $response -StatusCode 200 -Body ([pscustomobject]@{ ad = $security.ad })
                }
            }
            elseif ($method -eq 'POST' -and $path -eq '/api/security-config') {
                if (-not (Test-RoleCanManageUsers -Role $session.role)) {
                    Write-JsonResponse -Response $response -StatusCode 403 -Body ([pscustomobject]@{ error = 'No tenés permiso para administrar usuarios.' })
                } else {
                    $bodyText = Read-RequestBody -Request $request
                    $incoming = $bodyText | ConvertFrom-Json
                    $security = Get-Security -RootDir $scriptRoot
                    $security.ad = [pscustomobject]@{
                        server = [string]$incoming.server
                        port   = [int]$incoming.port
                        useSsl = [bool]$incoming.useSsl
                        domain = [string]$incoming.domain
                    }
                    Save-Security -RootDir $scriptRoot -Security $security
                    Write-SecurityLog -LogsDir $logsDir -Message "CONFIG AD actualizada por '$($session.username)' (server='$($security.ad.server)', domain='$($security.ad.domain)')"
                    Write-JsonResponse -Response $response -StatusCode 200 -Body ([pscustomobject]@{ ok = $true })
                }
            }
            elseif ($method -eq 'GET' -and $path -eq '/api/profiles') {
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
                # "hidden": true saca un flow de esta lista sin sacarle la posibilidad de
                # ejecutarlo por nombre vía /api/run (Get-Flows de esa ruta no filtra nada) —
                # lo usa 'Recupera cuentas (SQL)', una dependencia interna de 'Plazo Fijo
                # Cocos Files (SQL)' que no está pensada para elegirse a mano en la UI.
                $flows = @(Get-Flows -FlowsDir $flowsDir) | Where-Object { -not $_.hidden }
                $summary = @($flows | ForEach-Object {
                    [pscustomobject][ordered]@{
                        name        = $_.name
                        description = $_.description
                        inputMode   = $_.inputMode
                        inputs      = $_.inputs
                        steps       = @($_.steps | ForEach-Object { [pscustomobject]@{ name = $_.name; type = $_.type } })
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
                } elseif (-not (Test-RoleCanRunFlow -Role $session.role -FlowName $selectedFlow.name)) {
                    Write-SecurityLog -LogsDir $logsDir -Message "EJECUCIÓN DENEGADA usuario='$($session.username)' rol='$($session.role)' flow='$($selectedFlow.name)' (rol sin permiso para ejecutar)"
                    Write-JsonResponse -Response $response -StatusCode 403 -Body ([pscustomobject]@{ error = "Tu rol ('$($session.role)') no tiene permiso para ejecutar flows." })
                } else {
                    $inputValues = @{}
                    if ($payload.inputs) {
                        foreach ($prop in $payload.inputs.PSObject.Properties) {
                            $inputValues[$prop.Name] = [string]$prop.Value
                        }
                    }

                    $parametria = Get-Parametria -RootDir $scriptRoot
                    $log = @(Invoke-Flow -Profile $selectedProfile -Flow $selectedFlow -InputValues $inputValues -LogsDir $logsDir -Parametria $parametria)

                    # Una entrada por cada corrida de /api/run (para un flow CSV, una por fila
                    # del archivo — cada operación bancaria individual queda trazada a quién la
                    # ejecutó, no solo a qué flow/perfil). Nunca incluye los inputs ni la
                    # respuesta (pueden traer datos bancarios reales) — el detalle completo de
                    # cada request/response sigue en logs/http.log.
                    $okSteps = @($log | Where-Object { $_.status -eq 'Success' }).Count
                    $errorSteps = @($log | Where-Object { $_.status -ne 'Success' }).Count
                    Write-SecurityLog -LogsDir $logsDir -Message "EJECUCIÓN flow='$($selectedFlow.name)' perfil='$($selectedProfile.name)' usuario='$($session.username)' rol='$($session.role)' pasos_ok=$okSteps pasos_error=$errorSteps"

                    Write-JsonResponse -Response $response -StatusCode 200 -Body $log
                }
            }
            elseif ($method -eq 'POST' -and $path -eq '/api/save-output') {
                # Guarda un archivo generado por el cliente (hoy, el detalle de Plazos
                # Fijos dados de alta o de filas que fallaron en un CSV batch) en
                # files/, en vez de depender de la descarga del navegador — así el
                # archivo queda en un lugar fijo y predecible en el disco del servidor.
                # $prefix/$timestamp los arma el cliente (p.ej. "pfout-"/"20260831195022"),
                # pero se validan acá con formato estricto: es la única defensa contra
                # path traversal en un endpoint que escribe archivos a partir de input
                # del cliente.
                $bodyText = Read-RequestBody -Request $request
                $payload = $bodyText | ConvertFrom-Json
                $prefix = [string]$payload.prefix
                $timestamp = [string]$payload.timestamp
                $content = [string]$payload.content

                if ($prefix -notmatch '^[a-zA-Z0-9-]{1,40}$') {
                    Write-JsonResponse -Response $response -StatusCode 400 -Body ([pscustomobject]@{ error = 'Prefijo de archivo inválido.' })
                } elseif ($timestamp -notmatch '^\d{14}$') {
                    Write-JsonResponse -Response $response -StatusCode 400 -Body ([pscustomobject]@{ error = 'Timestamp inválido (se espera yyyyMMddHHmmss).' })
                } else {
                    if (-not (Test-Path $filesDir)) {
                        New-Item -ItemType Directory -Path $filesDir -Force | Out-Null
                    }
                    $fileName = "$prefix$timestamp.csv"
                    $filePath = Join-Path $filesDir $fileName
                    Set-Content -Path $filePath -Value $content -Encoding UTF8
                    Write-SecurityLog -LogsDir $logsDir -Message "ARCHIVO DE SALIDA '$fileName' guardado por '$($session.username)'"
                    Write-JsonResponse -Response $response -StatusCode 200 -Body ([pscustomobject]@{ ok = $true; fileName = $fileName })
                }
            }
            elseif ($method -eq 'POST' -and $path -eq '/api/check-operations') {
                # Antes de procesar un CSV, el cliente manda todas las (cuit,
                # numeroComprobante) del archivo de una sola vez (no una consulta
                # por fila) para saber cuáles ya se procesaron antes — evita
                # duplicar una operación bancaria real por subir el mismo archivo
                # dos veces, o por repetir un comprobante en otro archivo distinto.
                $bodyText = Read-RequestBody -Request $request
                $payload = $bodyText | ConvertFrom-Json
                $operations = @()
                if ($payload.operations) {
                    foreach ($op in @($payload.operations)) {
                        $operations += [pscustomobject]@{ cuit = [string]$op.cuit; numeroComprobante = [string]$op.numeroComprobante }
                    }
                }
                $duplicates = @(Find-DuplicateOperations -RootDir $scriptRoot -Operations $operations)
                if ($duplicates.Count -gt 0) {
                    $detalle = ($duplicates | ForEach-Object { "cuit='$($_.cuit)' comprobante='$($_.numeroComprobante)'" }) -join '; '
                    Write-SecurityLog -LogsDir $logsDir -Message "OPERACIONES DUPLICADAS DETECTADAS: $($duplicates.Count) por '$($session.username)' (bloqueadas, no se ejecutan) -> $detalle"
                }
                Write-JsonResponse -Response $response -StatusCode 200 -Body ([pscustomobject]@{ duplicates = $duplicates })
            }
            elseif ($method -eq 'POST' -and $path -eq '/api/register-operations') {
                # Se llama una sola vez al terminar de procesar el CSV, con las
                # operaciones que realmente se dieron de alta con éxito (no las que
                # fallaron ni las que se bloquearon por duplicadas) — así quedan
                # registradas para bloquear un reintento futuro del mismo comprobante.
                $bodyText = Read-RequestBody -Request $request
                $payload = $bodyText | ConvertFrom-Json
                $operations = @()
                if ($payload.operations) {
                    foreach ($op in @($payload.operations)) {
                        $operations += [pscustomobject]@{ cuit = [string]$op.cuit; numeroComprobante = [string]$op.numeroComprobante; idMensaje = [string]$op.idMensaje }
                    }
                }
                if ($operations.Count -gt 0) {
                    Add-ProcessedOperations -RootDir $scriptRoot -Operations $operations -Username $session.username
                    Write-SecurityLog -LogsDir $logsDir -Message "OPERACIONES REGISTRADAS: $($operations.Count) por '$($session.username)' (antiduplicado)"
                }
                Write-JsonResponse -Response $response -StatusCode 200 -Body ([pscustomobject]@{ ok = $true; registered = $operations.Count })
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
