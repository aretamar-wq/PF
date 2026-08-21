# Ejecuta un flow: encadena requests HTTP sustituyendo variables ({{var}}) entre pasos.
# Requiere que JsonPath.psm1 y VariableSubstitution.psm1 ya estén importados en la sesión.

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

    $pairs = New-Object 'System.Collections.Generic.List[System.Collections.Generic.KeyValuePair[string,string]]'
    $pairs.Add([System.Collections.Generic.KeyValuePair[string,string]]::new('grant_type', 'client_credentials'))
    $pairs.Add([System.Collections.Generic.KeyValuePair[string,string]]::new('client_id', [string]$Profile.clientId))
    $pairs.Add([System.Collections.Generic.KeyValuePair[string,string]]::new('client_secret', [string]$Profile.clientSecret))
    $content = [System.Net.Http.FormUrlEncodedContent]::new($pairs)

    $response = $HttpClient.PostAsync($Profile.tokenUrl, $content).GetAwaiter().GetResult()
    $bodyText = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()

    if (-not $response.IsSuccessStatusCode) {
        throw "No se pudo obtener el token OAuth2 en '$($Profile.tokenUrl)' (HTTP $([int]$response.StatusCode)): $bodyText"
    }

    $tokenObj = $bodyText | ConvertFrom-Json
    $accessToken = $tokenObj.access_token
    if ([string]::IsNullOrEmpty($accessToken)) {
        throw "La respuesta del endpoint de token no contiene 'access_token'."
    }

    $expiresIn = 300
    if ($tokenObj.expires_in) {
        $expiresIn = [int]$tokenObj.expires_in
    }

    $Global:TokenCache[$Profile.name] = @{
        AccessToken  = $accessToken
        ExpiresAtUtc = $now.AddSeconds([Math]::Max(30, $expiresIn - 30))
    }

    return $accessToken
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
            $Request.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $token)
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

Export-ModuleMember -Function Invoke-Flow
