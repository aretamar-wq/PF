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

    switch ([string]$Profile.authType) {
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

function Invoke-Flow {
    param(
        [Parameter(Mandatory = $true)] $Profile,
        [Parameter(Mandatory = $true)] $Flow,
        [Parameter(Mandatory = $true)] [hashtable]$InputValues
    )

    $handler = New-Object System.Net.Http.HttpClientHandler
    $httpClient = New-Object System.Net.Http.HttpClient($handler)
    $httpClient.Timeout = [TimeSpan]::FromSeconds(60)

    $variables = @{}
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

                if (-not [string]::IsNullOrEmpty($step.bodyTemplate)) {
                    $bodyText = Expand-Template -Template $step.bodyTemplate -Variables $variables
                    $contentType = 'application/json'
                    if ($contentTypeFromHeaders) { $contentType = $contentTypeFromHeaders }
                    if ($step.bodyContentType) { $contentType = [string]$step.bodyContentType }
                    $request.Content = New-Object System.Net.Http.StringContent($bodyText, [System.Text.Encoding]::UTF8, $contentType)
                }

                $entry.requestSummary = "$($step.method) $url"

                $response = $httpClient.SendAsync($request).GetAwaiter().GetResult()
                $responseBody = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()

                $entry.httpStatusCode = [int]$response.StatusCode
                $entry.responseSummary = if ($responseBody.Length -gt 800) { $responseBody.Substring(0, 800) + '...' } else { $responseBody }

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

    if ([string]$Profile.authType -ne 'OAuth2ClientCredentials') {
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

Export-ModuleMember -Function Invoke-Flow, Test-TokenAcquisition
