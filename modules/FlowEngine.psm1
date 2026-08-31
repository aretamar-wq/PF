# Ejecuta un flow: encadena requests HTTP sustituyendo variables ({{var}}) entre pasos.
# Requiere que JsonPath.psm1 y VariableSubstitution.psm1 ya estén importados en la sesión.

function Build-TokenRequestContent {
    param(
        [string]$ContentType,
        [System.Collections.Specialized.OrderedDictionary]$Params
    )

    if ($ContentType -ieq 'application/json') {
        $json = $Params | ConvertTo-Json -Depth 5
        return New-Object System.Net.Http.StringContent($json, [System.Text.Encoding]::UTF8, 'application/json')
    }

    if ($ContentType -ieq 'application/x-www-form-urlencoded') {
        $pairs = New-Object 'System.Collections.Generic.List[System.Collections.Generic.KeyValuePair[string,string]]'
        foreach ($key in $Params.Keys) {
            $pairs.Add([System.Collections.Generic.KeyValuePair[string,string]]::new($key, [string]$Params[$key]))
        }
        return [System.Net.Http.FormUrlEncodedContent]::new($pairs)
    }

    # Content-Type no reconocido: se manda como key=value&key2=value2 sin encodear, tal cual.
    $rawPairs = foreach ($key in $Params.Keys) { "$key=$($Params[$key])" }
    $raw = $rawPairs -join '&'
    return New-Object System.Net.Http.StringContent($raw, [System.Text.Encoding]::UTF8, $ContentType)
}

function Write-HttpLog {
    param(
        [string]$LogsDir,
        [string]$FileName,
        [string]$Content
    )

    if ([string]::IsNullOrEmpty($LogsDir)) { return }

    try {
        if (-not (Test-Path $LogsDir)) {
            New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
        }
        $path = Join-Path $LogsDir $FileName
        Add-Content -Path $path -Value $Content -Encoding UTF8
    } catch {
        # Un problema de logging (disco lleno, permisos) nunca debe romper la ejecución del flow.
    }
}

function Get-LoggableHeaderLines {
    param(
        [Parameter(Mandatory = $true)] $Headers,
        [string]$ApiKeyHeaderName
    )

    $lines = foreach ($header in $Headers) {
        $name = $header.Key
        if ($name -ieq 'Authorization' -or ($ApiKeyHeaderName -and $name -ieq $ApiKeyHeaderName)) {
            "$name`: ***REDACTED***"
        } else {
            "$name`: $(@($header.Value) -join ', ')"
        }
    }
    return ($lines -join "`n")
}

function Get-ProfileStringOrDefault {
    param($Profile, [string]$PropertyName, [string]$Default)
    $value = $Profile.$PropertyName
    if ([string]::IsNullOrEmpty([string]$value)) { return $Default }
    return [string]$value
}

function Get-OrRefreshAccessToken {
    param(
        [Parameter(Mandatory = $true)] $Profile,
        [Parameter(Mandatory = $true)] [System.Net.Http.HttpClient]$HttpClient
    )

    $now = [DateTime]::UtcNow
    if ($Global:TokenCache.ContainsKey($Profile.name)) {
        $cached = $Global:TokenCache[$Profile.name]
        if ($cached.ExpiresAtUtc -gt $now) {
            return $cached.AccessToken
        }
    }

    $variables = @{
        clientId     = [string]$Profile.clientId
        clientSecret = [string]$Profile.clientSecret
    }

    $tokenMethod = Get-ProfileStringOrDefault -Profile $Profile -PropertyName 'tokenMethod' -Default 'POST'
    $tokenBodyContentType = Get-ProfileStringOrDefault -Profile $Profile -PropertyName 'tokenBodyContentType' -Default 'application/x-www-form-urlencoded'
    $accessTokenPath = Get-ProfileStringOrDefault -Profile $Profile -PropertyName 'tokenAccessTokenPath' -Default 'access_token'
    $expiresInPath = Get-ProfileStringOrDefault -Profile $Profile -PropertyName 'tokenExpiresInPath' -Default 'expires_in'

    # Parámetros del body del token request: por default, el client_credentials clásico.
    # Un perfil puede pisar "tokenParams" para agregar/renombrar campos (ej. "scope", u otros
    # nombres de campo que use un banco distinto), con placeholders {{clientId}}/{{clientSecret}}.
    $tokenParams = [ordered]@{
        grant_type    = 'client_credentials'
        client_id     = '{{clientId}}'
        client_secret = '{{clientSecret}}'
    }
    if ($Profile.tokenParams) {
        $tokenParams = [ordered]@{}
        foreach ($paramProp in $Profile.tokenParams.PSObject.Properties) {
            $tokenParams[$paramProp.Name] = [string]$paramProp.Value
        }
    }

    $resolvedParams = [ordered]@{}
    foreach ($key in $tokenParams.Keys) {
        $resolvedParams[$key] = Expand-Template -Template $tokenParams[$key] -Variables $variables
    }

    $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::new($tokenMethod), [string]$Profile.tokenUrl)
    $request.Content = Build-TokenRequestContent -ContentType $tokenBodyContentType -Params $resolvedParams

    if ($Profile.tokenHeaders) {
        foreach ($headerProp in $Profile.tokenHeaders.PSObject.Properties) {
            if ($headerProp.Name -ieq 'Content-Type') { continue }
            $headerValue = Expand-Template -Template ([string]$headerProp.Value) -Variables $variables
            [void]$request.Headers.TryAddWithoutValidation($headerProp.Name, $headerValue)
        }
    }

    $response = $HttpClient.SendAsync($request).GetAwaiter().GetResult()
    $responseBody = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()

    if (-not $response.IsSuccessStatusCode) {
        throw "No se pudo obtener el token OAuth2 en '$($Profile.tokenUrl)' (HTTP $([int]$response.StatusCode)): $responseBody"
    }

    $tokenJson = $responseBody | ConvertFrom-Json
    $accessToken = Get-JsonPathValue -Data $tokenJson -Path $accessTokenPath
    if ([string]::IsNullOrEmpty([string]$accessToken)) {
        throw "La respuesta del endpoint de token no contiene un valor en '$accessTokenPath'."
    }

    $expiresInRaw = Get-JsonPathValue -Data $tokenJson -Path $expiresInPath
    $expiresIn = 300
    if (-not [string]::IsNullOrEmpty([string]$expiresInRaw)) {
        $parsed = 0
        if ([int]::TryParse([string]$expiresInRaw, [ref]$parsed)) { $expiresIn = $parsed }
    }

    $Global:TokenCache[$Profile.name] = @{
        AccessToken  = [string]$accessToken
        ExpiresAtUtc = $now.AddSeconds([Math]::Max(30, $expiresIn - 30))
    }

    return [string]$accessToken
}

function Add-AuthHeader {
    param(
        [Parameter(Mandatory = $true)] [System.Net.Http.HttpRequestMessage]$Request,
        [Parameter(Mandatory = $true)] $Profile,
        [Parameter(Mandatory = $true)] [System.Net.Http.HttpClient]$HttpClient
    )

    switch (([string]$Profile.authType).Trim()) {
        'ApiKey' {
            [void]$Request.Headers.TryAddWithoutValidation([string]$Profile.apiKeyHeaderName, [string]$Profile.apiKeyOrToken)
        }
        'Bearer' {
            $Request.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', [string]$Profile.apiKeyOrToken)
        }
        'OAuth2ClientCredentials' {
            $token = Get-OrRefreshAccessToken -Profile $Profile -HttpClient $HttpClient

            $headerName = Get-ProfileStringOrDefault -Profile $Profile -PropertyName 'tokenAuthHeaderName' -Default 'Authorization'
            $headerFormat = Get-ProfileStringOrDefault -Profile $Profile -PropertyName 'tokenAuthHeaderFormat' -Default 'Bearer {{token}}'
            $headerValue = Expand-Template -Template $headerFormat -Variables @{ token = $token }

            [void]$Request.Headers.TryAddWithoutValidation($headerName, $headerValue)
        }
        default {
            # None: sin header de autenticación.
        }
    }
}

function Get-ParametriaVariables {
    param($Parametria)

    $variables = @{}
    if ($null -eq $Parametria) { return $variables }

    if ($Parametria.cuentaCorriente) {
        $variables['ctaCteCodigoCuenta']  = [string]$Parametria.cuentaCorriente.codigoCuenta
        $variables['ctaCteCodigoSistema'] = [string]$Parametria.cuentaCorriente.codigoSistema
        $variables['ctaCteTransaccion']   = [string]$Parametria.cuentaCorriente.transaccion
    }

    if ($Parametria.cajaDeAhorro) {
        $variables['cajaAhorroCodigoSistema'] = [string]$Parametria.cajaDeAhorro.codigoSistema
        $variables['cajaAhorroTransaccion']   = [string]$Parametria.cajaDeAhorro.transaccion
    }

    if ($Parametria.plazoFijo) {
        $variables['plazoFijoCodigoProducto']   = [string]$Parametria.plazoFijo.codigoProducto
        $variables['plazoFijoCodigoMovimiento'] = [string]$Parametria.plazoFijo.codigoMovimiento
    }

    return $variables
}

# El usuario/contraseña de Sybase se resuelven acá, aparte de Get-ParametriaVariables
# a propósito: si entraran al pool general de variables ({{sybaseUsuario}}/
# {{sybasePassword}}), un flow HTTP podría llegar a interpolarlos por error en un
# path/body/header y terminar logueando la contraseña en texto plano. Solo se usan
# para armar el connection string de una conexión Sybase real.
function Get-SybaseConnectionString {
    param(
        # AllowEmptyString: sin esto, PowerShell rechaza un "" (a diferencia de un
        # string con solo espacios) antes de que el cuerpo de la función llegue a
        # correr el chequeo de IsNullOrWhiteSpace de abajo, y el mensaje de error
        # en español nunca se ve para ese caso.
        [Parameter(Mandatory = $true)] [AllowEmptyString()] [string]$ConnectionStringTemplate,
        [string]$Usuario,
        [string]$Password
    )

    if ([string]::IsNullOrWhiteSpace($ConnectionStringTemplate)) {
        throw 'El connection string de Sybase está vacío en la Parametría.'
    }

    $credentialVariables = @{
        usuario  = [string]$Usuario
        password = [string]$Password
    }
    return Expand-Template -Template $ConnectionStringTemplate -Variables $credentialVariables
}

# Enmascara Pwd=.../Password=... para poder loguear el connection string sin
# exponer la contraseña real en logs/http.log (mismo criterio que el header
# Authorization).
function Get-RedactedSybaseConnectionString {
    param([string]$ConnectionString)
    if ([string]::IsNullOrEmpty($ConnectionString)) { return $ConnectionString }
    return [regex]::Replace($ConnectionString, '(?i)(Pwd|Password)\s*=\s*[^;]*', '$1=***REDACTED***')
}

function Test-SybaseConnection {
    param(
        [Parameter(Mandatory = $true)] [AllowEmptyString()] [string]$ConnectionStringTemplate,
        [string]$Usuario,
        [string]$Password
    )

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $connectionString = Get-SybaseConnectionString -ConnectionStringTemplate $ConnectionStringTemplate -Usuario $Usuario -Password $Password
        $connection = New-Object System.Data.Odbc.OdbcConnection($connectionString)
        try {
            $connection.Open()
        } finally {
            $connection.Dispose()
        }
        $stopwatch.Stop()
        return [pscustomobject][ordered]@{
            ok         = $true
            message    = "Conexión exitosa en $($stopwatch.ElapsedMilliseconds) ms."
            durationMs = $stopwatch.ElapsedMilliseconds
        }
    } catch {
        $stopwatch.Stop()
        return [pscustomobject][ordered]@{
            ok         = $false
            message    = $_.Exception.Message
            durationMs = $stopwatch.ElapsedMilliseconds
        }
    }
}

# Ejecuta un step de flow con "type": "sql" contra Sybase vía ODBC (requiere que el
# driver ODBC de Sybase/SAP ASE ya esté instalado en la máquina que corre server.ps1
# — este módulo no instala ni empaqueta ningún driver). El resultado se envuelve como
# { "rows": [ {columna: valor, ...}, ... ] } y de ahí en más se trata exactamente
# igual que la respuesta JSON de un step HTTP: mismo mecanismo de extractVariables
# (Get-JsonPathValue, ej. "rows[0].saldo"), mismo límite de 200.000 caracteres para
# lo que se manda al navegador, mismo archivo logs/http.log.
#
# IMPORTANTE: $queryText se arma con el mismo Expand-Template sin escapar que usan
# los bodies HTTP — un valor que traiga una comilla simple puede romper la consulta
# o (si viniera de un origen no confiable) habilitar inyección SQL. Pensado para
# los mismos inputs manuales/parametría ya confiables que usa el resto de la app,
# no para datos externos sin validar.
function Invoke-SqlStep {
    param(
        [Parameter(Mandatory = $true)] $Step,
        [Parameter(Mandatory = $true)] $Flow,
        [Parameter(Mandatory = $true)] [hashtable]$Variables,
        $Parametria,
        [string]$LogsDir,
        [Parameter(Mandatory = $true)] $Entry
    )

    if ($null -eq $Parametria -or $null -eq $Parametria.sybase) {
        throw "No hay una conexión Sybase configurada en la Parametría (botón 'Parametría...' > Conexión Sybase)."
    }

    $queryText = Expand-Template -Template ([string]$Step.query) -Variables $Variables
    $connectionString = Get-SybaseConnectionString -ConnectionStringTemplate ([string]$Parametria.sybase.connectionString) -Usuario ([string]$Parametria.sybase.usuario) -Password ([string]$Parametria.sybase.password)
    $redactedConnectionString = Get-RedactedSybaseConnectionString -ConnectionString $connectionString

    $Entry.requestSummary = "SQL (Sybase): $queryText"

    $logTimestamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
    $requestLogText = (
        ">>> REQUEST [$logTimestamp] Flow=$($Flow.name) | Step=$($Step.name) (SQL)",
        "ConnectionString: $redactedConnectionString",
        'Query:',
        $queryText,
        '---'
    ) -join "`n"
    # Igual que en un step HTTP: se loguea antes de ejecutar la consulta, así queda
    # registrada aunque la conexión nunca llegue a abrirse.
    Write-HttpLog -LogsDir $LogsDir -FileName 'http.log' -Content $requestLogText

    $connection = New-Object System.Data.Odbc.OdbcConnection($connectionString)
    try {
        $connection.Open()
        $command = $connection.CreateCommand()
        $command.CommandText = $queryText
        $command.CommandTimeout = 60

        $rows = @()
        $reader = $command.ExecuteReader()
        try {
            $columnNames = @()
            for ($i = 0; $i -lt $reader.FieldCount; $i++) { $columnNames += $reader.GetName($i) }
            while ($reader.Read()) {
                $row = [ordered]@{}
                for ($i = 0; $i -lt $columnNames.Count; $i++) {
                    $value = $reader.GetValue($i)
                    if ($value -is [DBNull]) { $value = $null }
                    $row[$columnNames[$i]] = $value
                }
                $rows += [pscustomobject]$row
            }
        } finally {
            $reader.Close()
        }

        $resultObject = [pscustomobject]@{ rows = $rows }
        $responseBody = $resultObject | ConvertTo-Json -Depth 10

        $responseLogTimestamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
        $responseLogText = (
            "<<< RESPONSE [$responseLogTimestamp] Flow=$($Flow.name) | Step=$($Step.name) (SQL) | OK, $($rows.Count) fila(s)",
            'Body:',
            $responseBody,
            '---'
        ) -join "`n"
        Write-HttpLog -LogsDir $LogsDir -FileName 'http.log' -Content $responseLogText

        $Entry.httpStatusCode = $null
        $Entry.responseSummary = if ($responseBody.Length -gt 200000) { $responseBody.Substring(0, 200000) + '...' } else { $responseBody }

        if ($Step.extractVariables) {
            $responseJson = $responseBody | ConvertFrom-Json
            foreach ($extractProp in $Step.extractVariables.PSObject.Properties) {
                $extracted = Get-JsonPathValue -Data $responseJson -Path $extractProp.Value
                if ($null -ne $extracted) {
                    $Variables[$extractProp.Name] = [string]$extracted
                }
            }
        }

        # requireVariables (opcional): nombres de variables que este step tiene que
        # haber dejado seteadas (vía extractVariables) para que el step cuente como
        # exitoso. Sin esto, una columna NULL/ausente simplemente no pisa la variable
        # y el flow sigue de largo — un step siguiente que la necesite como número sin
        # comillas (ej. un codigoCuenta) fallaría recién ahí con un JSON inválido, pero
        # un step anterior que no dependa de esa variable (ej. un débito) ya se habría
        # ejecutado. requireVariables corta acá, antes de que corra ningún step
        # posterior, en vez de confiar en que el banco rechace un body armado a medias.
        if ($Step.requireVariables) {
            foreach ($requiredName in @($Step.requireVariables)) {
                if (-not $Variables.ContainsKey($requiredName) -or [string]::IsNullOrEmpty([string]$Variables[$requiredName])) {
                    throw "El step SQL no encontró un valor para la variable requerida '$requiredName' (columna vacía o ausente en el resultado de la consulta)."
                }
            }
        }

        $Entry.status = 'Success'
    } finally {
        $connection.Dispose()
    }
}

function Invoke-Flow {
    param(
        [Parameter(Mandatory = $true)] $Profile,
        [Parameter(Mandatory = $true)] $Flow,
        [Parameter(Mandatory = $true)] [hashtable]$InputValues,
        [string]$LogsDir,
        $Parametria
    )

    $handler = New-Object System.Net.Http.HttpClientHandler
    $httpClient = New-Object System.Net.Http.HttpClient($handler)
    $httpClient.Timeout = [TimeSpan]::FromSeconds(60)

    # Variables de sistema disponibles en cualquier flow (ej. {{nowDate}} para
    # una FechaMovimiento/FechaNegocio que no debe pedirse al usuario), seguidas
    # de los valores de parametría (Cuenta Corriente/Caja de Ahorro/Plazo Fijo).
    # Un input del usuario con el mismo nombre pisa a ambos.
    $now = Get-Date
    $variables = @{
        nowDate           = $now.ToString('yyyy-MM-dd')
        nowDateTime       = $now.ToString('yyyy-MM-dd HH:mm:ss')
        nowTime           = $now.ToString('HH:mm:ss')
        nowCompact        = $now.ToString('yyyyMMddHHmm')
        idMensajeGenerado = 'PFC' + $now.ToString('yyyyMMddHHmmss')
    }
    $parametriaVariables = Get-ParametriaVariables -Parametria $Parametria
    foreach ($key in $parametriaVariables.Keys) {
        $variables[$key] = $parametriaVariables[$key]
    }
    foreach ($key in $InputValues.Keys) {
        $variables[$key] = $InputValues[$key]
    }

    $log = @()

    try {
        foreach ($step in @($Flow.steps)) {
            $entry = [ordered]@{
                name            = $step.name
                status          = 'Running'
                requestSummary  = $null
                responseSummary = $null
                httpStatusCode  = $null
                durationMs      = 0
                errorMessage    = $null
            }

            $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
            try {
                if ((([string]$step.type).Trim()) -ieq 'sql') {
                    Invoke-SqlStep -Step $step -Flow $Flow -Variables $variables -Parametria $Parametria -LogsDir $LogsDir -Entry $entry
                } else {
                $path = Expand-Template -Template $step.pathTemplate -Variables $variables
                $baseUrl = ([string]$Profile.baseUrl).TrimEnd('/')
                $relativePath = $path.TrimStart('/')
                $url = "$baseUrl/$relativePath"

                $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::new($step.method), $url)
                Add-AuthHeader -Request $request -Profile $Profile -HttpClient $httpClient

                $contentTypeFromHeaders = $null
                if ($step.headers) {
                    foreach ($headerProp in $step.headers.PSObject.Properties) {
                        if ($headerProp.Name -ieq 'Content-Type') {
                            $contentTypeFromHeaders = [string]$headerProp.Value
                            continue
                        }
                        $headerValue = Expand-Template -Template ([string]$headerProp.Value) -Variables $variables
                        [void]$request.Headers.TryAddWithoutValidation($headerProp.Name, $headerValue)
                    }
                }

                # GET/HEAD nunca llevan body: en Windows PowerShell 5.1 (.NET Framework), HttpClient
                # delega en HttpWebRequest, que tira "Cannot send a content-body with this verb-type"
                # si se le asigna Content en esos métodos (PowerShell 7 / .NET moderno no tiene esta
                # restricción, por eso no aparecía en pruebas hechas con pwsh).
                $methodAllowsBody = ($step.method -ine 'GET') -and ($step.method -ine 'HEAD')

                if ($methodAllowsBody -and -not [string]::IsNullOrEmpty($step.bodyTemplate)) {
                    $bodyText = Expand-Template -Template $step.bodyTemplate -Variables $variables
                    $contentType = 'application/json'
                    if ($contentTypeFromHeaders) { $contentType = $contentTypeFromHeaders }
                    if ($step.bodyContentType) { $contentType = [string]$step.bodyContentType }

                    # omitIfNull (opcional, array de nombres de campo): para un campo
                    # opcional que el banco espera que directamente NO aparezca en el
                    # JSON en vez de ir null/vacío (no "el campo, sin valor"). El
                    # bodyTemplate arma el valor sin comillas (ej. {{cuecodSistema4}})
                    # de forma que, si la variable no se encontró, quede como el
                    # literal JSON "null" (no como texto sin reemplazar, que rompería
                    # el JSON) — acá se parsea el body ya armado y se borra por
                    # completo cualquier campo de la lista que haya quedado en null,
                    # antes de mandarlo.
                    if ($step.omitIfNull -and $contentType -ieq 'application/json') {
                        try {
                            $bodyJson = $bodyText | ConvertFrom-Json
                            foreach ($propName in @($step.omitIfNull)) {
                                $prop = $bodyJson.PSObject.Properties[$propName]
                                if ($null -ne $prop -and $null -eq $prop.Value) {
                                    $bodyJson.PSObject.Properties.Remove($propName)
                                }
                            }
                            $bodyText = $bodyJson | ConvertTo-Json -Depth 10
                        } catch {
                            # El bodyTemplate no resultó en JSON parseable (no debería
                            # pasar si bodyContentType es json); se manda tal cual,
                            # sin aplicar omitIfNull.
                        }
                    }

                    $request.Content = New-Object System.Net.Http.StringContent($bodyText, [System.Text.Encoding]::UTF8, $contentType)
                }

                $entry.requestSummary = "$($step.method) $url"

                $logTimestamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
                $requestHeaderLines = Get-LoggableHeaderLines -Headers $request.Headers -ApiKeyHeaderName ([string]$Profile.apiKeyHeaderName)
                $requestLogText = (
                    ">>> REQUEST [$logTimestamp] Flow=$($Flow.name) | Step=$($step.name)",
                    "$($step.method) $url",
                    $requestHeaderLines,
                    'Body:',
                    $(if ($request.Content) { $bodyText } else { '(sin body)' }),
                    '---'
                ) -join "`n"
                # Se loguea antes de mandar el request: así queda un registro aunque la
                # respuesta nunca llegue (timeout, host inalcanzable, etc.).
                Write-HttpLog -LogsDir $LogsDir -FileName 'http.log' -Content $requestLogText

                $response = $httpClient.SendAsync($request).GetAwaiter().GetResult()
                $responseBody = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()

                $responseLogTimestamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
                $responseLogText = (
                    "<<< RESPONSE [$responseLogTimestamp] Flow=$($Flow.name) | Step=$($step.name) | HTTP $([int]$response.StatusCode) ($($stopwatch.ElapsedMilliseconds) ms)",
                    'Body:',
                    $responseBody,
                    '---'
                ) -join "`n"
                Write-HttpLog -LogsDir $LogsDir -FileName 'http.log' -Content $responseLogText

                $entry.httpStatusCode = [int]$response.StatusCode
                # Se manda al navegador casi entera (hasta 200.000 caracteres, ~200KB):
                # algunas respuestas (ej. "Recupera cuentas" con muchas cuentas/operaciones)
                # superan ampliamente los 800 caracteres que se usaban antes, y la UI necesita
                # el JSON completo para poder parsearlo (ej. filtrar cuentas por código de
                # sistema). El corte a 200.000 sigue existiendo solo como resguardo ante una
                # respuesta verdaderamente enorme. logs/http.log siempre guarda el body entero.
                $entry.responseSummary = if ($responseBody.Length -gt 200000) { $responseBody.Substring(0, 200000) + '...' } else { $responseBody }

                $expectedStatus = 200
                if ($step.expectedStatusCode) { $expectedStatus = [int]$step.expectedStatusCode }

                if ([int]$response.StatusCode -ne $expectedStatus) {
                    $entry.status = 'Error'
                    $entry.errorMessage = "Se esperaba HTTP $expectedStatus y se recibió HTTP $([int]$response.StatusCode)."
                } else {
                    if ($step.extractVariables -and -not [string]::IsNullOrWhiteSpace($responseBody)) {
                        try {
                            $responseJson = $responseBody | ConvertFrom-Json
                            foreach ($extractProp in $step.extractVariables.PSObject.Properties) {
                                $extracted = Get-JsonPathValue -Data $responseJson -Path $extractProp.Value
                                if ($null -ne $extracted) {
                                    $variables[$extractProp.Name] = [string]$extracted
                                }
                            }
                        } catch {
                            # La respuesta no era JSON parseable; se ignora la extracción de variables.
                        }
                    }
                    $entry.status = 'Success'
                }
                }
            } catch {
                $entry.status = 'Error'
                $entry.errorMessage = $_.Exception.Message
            } finally {
                $stopwatch.Stop()
                $entry.durationMs = $stopwatch.ElapsedMilliseconds
            }

            $log += [pscustomobject]$entry

            if ($entry.status -eq 'Error') {
                break
            }
        }
    } finally {
        $httpClient.Dispose()
        $handler.Dispose()
    }

    return $log
}

function Test-TokenAcquisition {
    param([Parameter(Mandatory = $true)] $Profile)

    if (([string]$Profile.authType).Trim() -ne 'OAuth2ClientCredentials') {
        return [pscustomobject][ordered]@{
            ok      = $false
            message = "El perfil '$($Profile.name)' no usa OAuth2ClientCredentials (authType actual: '$($Profile.authType)')."
        }
    }

    # Ignora cualquier token cacheado: esto siempre prueba la obtención real, no un valor viejo.
    if ($Global:TokenCache.ContainsKey($Profile.name)) {
        $Global:TokenCache.Remove($Profile.name)
    }

    $handler = New-Object System.Net.Http.HttpClientHandler
    $httpClient = New-Object System.Net.Http.HttpClient($handler)
    $httpClient.Timeout = [TimeSpan]::FromSeconds(30)

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $token = Get-OrRefreshAccessToken -Profile $Profile -HttpClient $httpClient
        $stopwatch.Stop()

        $preview = if ($token.Length -gt 10) { $token.Substring(0, 6) + '...' + $token.Substring($token.Length - 4) } else { $token }
        $expiresAtUtc = $null
        if ($Global:TokenCache.ContainsKey($Profile.name)) {
            $expiresAtUtc = $Global:TokenCache[$Profile.name].ExpiresAtUtc.ToString('o')
        }

        return [pscustomobject][ordered]@{
            ok           = $true
            message      = "Token obtenido correctamente en $($stopwatch.ElapsedMilliseconds) ms."
            tokenPreview = $preview
            expiresAtUtc = $expiresAtUtc
            durationMs   = $stopwatch.ElapsedMilliseconds
        }
    } catch {
        $stopwatch.Stop()
        return [pscustomobject][ordered]@{
            ok         = $false
            message    = $_.Exception.Message
            durationMs = $stopwatch.ElapsedMilliseconds
        }
    } finally {
        $httpClient.Dispose()
        $handler.Dispose()
    }
}

Export-ModuleMember -Function Invoke-Flow, Test-TokenAcquisition, Test-SybaseConnection
