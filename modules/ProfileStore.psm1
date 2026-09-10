# Perfiles de conexión (con sus credenciales) en MariaDB, tabla "perfiles" —
# reemplaza profiles.local.json (ver deploy/mariadb-schema.sql y "Base de
# datos (MariaDB)" en el README). Misma API pública que antes
# (Get-Profiles/Save-Profiles): Save-Profiles sigue recibiendo el array
# completo y reemplaza el contenido entero de la tabla en una transacción,
# igual que antes sobrescribía el archivo entero. Requiere que
# MariaDbClient.psm1 y CryptoUtil.psm1 ya estén importados (ver server.ps1).
#
# client_id/client_secret/client_cert_passphrase se guardan cifrados
# (AES-256-GCM, ver CryptoUtil.psm1) — no algo que deba quedar legible con
# un SELECT directo a la tabla. apiKeyOrToken queda sin cifrar por ahora (no
# se pidió); el resto de los campos (baseUrl/novaBaseUrl/authType/tokenUrl/
# clientCertPfxPath) no son secretos.

# Campos de un perfil que se guardan cifrados en la base — un solo lugar
# donde agregar/sacar uno si hace falta cambiar el alcance más adelante.
$script:EncryptedFields = @('clientId', 'clientSecret', 'clientCertPassphrase')

# Campos OAuth2 avanzados que no tienen columna propia (ver
# deploy/mariadb-schema.sql, token_extra_json) — se guardan tal cual en un
# solo JSON y se aplanan de vuelta al nivel superior del objeto perfil al
# leer, para que FlowEngine.psm1 siga viendo $Profile.tokenParams, etc.,
# sin enterarse de que están en una columna aparte.
$script:TokenExtraFields = @(
    'tokenParams', 'tokenHeaders', 'tokenAccessTokenPath', 'tokenAuthHeaderFormat',
    'tokenAuthHeaderName', 'tokenBodyContentType', 'tokenExpiresInPath', 'tokenMethod'
)

function ConvertTo-ProfileRecord {
    param($Row, [Parameter(Mandatory = $true)][string]$RootDir)

    $profile = [ordered]@{
        name                 = $Row.name
        baseUrl              = $Row.base_url
        novaBaseUrl          = $Row.nova_base_url
        authType             = $Row.auth_type
        apiKeyHeaderName     = $Row.api_key_header_name
        apiKeyOrToken        = $Row.api_key_or_token
        tokenUrl             = $Row.token_url
        clientId             = $Row.client_id
        clientSecret         = $Row.client_secret
        clientCertPfxPath    = $Row.client_cert_pfx_path
        clientCertPassphrase = $Row.client_cert_passphrase
    }

    if ($Row.token_extra_json) {
        $extra = $Row.token_extra_json | ConvertFrom-Json
        foreach ($prop in $extra.PSObject.Properties) {
            $profile[$prop.Name] = $prop.Value
        }
    }

    $needsKey = $false
    foreach ($field in $script:EncryptedFields) {
        if ($profile[$field]) { $needsKey = $true; break }
    }
    if ($needsKey) {
        $key = Get-EncryptionKey -RootDir $RootDir
        foreach ($field in $script:EncryptedFields) {
            if ($profile[$field]) { $profile[$field] = Unprotect-CryptoValue -Stored $profile[$field] -HexKey $key }
        }
    }

    return [pscustomobject]$profile
}

function Get-Profiles {
    param([Parameter(Mandatory = $true)][string]$RootDir)

    $rows = @(Invoke-DbQuery -RootDir $RootDir -Sql 'SELECT * FROM perfiles ORDER BY name')
    return @($rows | ForEach-Object { ConvertTo-ProfileRecord -Row $_ -RootDir $RootDir })
}

function Save-Profiles {
    param(
        [Parameter(Mandatory = $true)][string]$RootDir,
        [Parameter(Mandatory = $true)] $Profiles
    )

    $array = @($Profiles)

    $key = $null
    foreach ($profile in $array) {
        foreach ($field in $script:EncryptedFields) {
            if ($profile.$field) { $key = Get-EncryptionKey -RootDir $RootDir; break }
        }
        if ($key) { break }
    }

    $connection = New-DbConnection -RootDir $RootDir
    $transaction = $connection.BeginTransaction()
    try {
        # Reemplazo total, igual que la escritura completa del archivo JSON de
        # antes: se borra todo y se vuelve a insertar la lista entera, en vez de
        # hacer un diff fila por fila.
        $deleteCmd = $connection.CreateCommand()
        $deleteCmd.Transaction = $transaction
        $deleteCmd.CommandText = 'DELETE FROM perfiles'
        [void]$deleteCmd.ExecuteNonQuery()

        foreach ($profile in $array) {
            $tokenExtra = [ordered]@{}
            foreach ($field in $script:TokenExtraFields) {
                $prop = $profile.PSObject.Properties[$field]
                if ($prop -and $null -ne $prop.Value) { $tokenExtra[$field] = $prop.Value }
            }
            $tokenExtraJson = if ($tokenExtra.Count -gt 0) { $tokenExtra | ConvertTo-Json -Depth 10 -Compress } else { $null }

            $clientId = if ($profile.clientId) { Protect-CryptoValue -PlainText $profile.clientId -HexKey $key } else { '' }
            $clientSecret = if ($profile.clientSecret) { Protect-CryptoValue -PlainText $profile.clientSecret -HexKey $key } else { '' }
            $clientCertPassphrase = if ($profile.clientCertPassphrase) { Protect-CryptoValue -PlainText $profile.clientCertPassphrase -HexKey $key } else { '' }

            $insertCmd = $connection.CreateCommand()
            $insertCmd.Transaction = $transaction
            $insertCmd.CommandText = @'
INSERT INTO perfiles (
   name, base_url, nova_base_url, auth_type, api_key_header_name, api_key_or_token,
   token_url, client_id, client_secret, client_cert_pfx_path, client_cert_passphrase,
   token_extra_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
'@
            Add-DbCommandParameters -Command $insertCmd -Params @(
                [string]$profile.name,
                [string]$profile.baseUrl,
                [string]$profile.novaBaseUrl,
                [string]$profile.authType,
                [string]$profile.apiKeyHeaderName,
                [string]$profile.apiKeyOrToken,
                [string]$profile.tokenUrl,
                $clientId,
                $clientSecret,
                [string]$profile.clientCertPfxPath,
                $clientCertPassphrase,
                $tokenExtraJson
            )
            [void]$insertCmd.ExecuteNonQuery()
        }

        $transaction.Commit()
    } catch {
        $transaction.Rollback()
        throw
    } finally {
        $connection.Close()
    }
}

Export-ModuleMember -Function Get-Profiles, Save-Profiles
