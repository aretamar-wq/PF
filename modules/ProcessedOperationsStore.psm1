# Lleva el registro de operaciones (cuit + numeroComprobante) que ya se
# ejecutaron con éxito, para poder bloquear una fila que intente repetir la
# misma operación (mismo archivo subido dos veces, el mismo comprobante
# reaparece en dos archivos distintos, o se reprocesa un archivo que ya
# había corrido bien) antes de llamar a ningún endpoint del banco — evita
# duplicar un débito/crédito/alta de plazo fijo real por error.
# logs/processed-operations.json (no se versiona, está en logs/ que ya
# está en .gitignore entero).

function Get-ProcessedOperationsFilePath {
    param([Parameter(Mandatory = $true)][string]$RootDir)
    return Join-Path (Join-Path $RootDir 'logs') 'processed-operations.json'
}

function Get-ProcessedOperations {
    param([Parameter(Mandatory = $true)][string]$RootDir)

    $path = Get-ProcessedOperationsFilePath -RootDir $RootDir
    if (-not (Test-Path $path)) { return @() }

    $json = Get-Content -Path $path -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($json)) { return @() }

    $parsed = $json | ConvertFrom-Json
    if ($null -eq $parsed) { return @() }
    return @($parsed)
}

function Save-ProcessedOperations {
    param(
        [Parameter(Mandatory = $true)][string]$RootDir,
        [Parameter(Mandatory = $true)] $Operations
    )

    $logsDir = Join-Path $RootDir 'logs'
    if (-not (Test-Path $logsDir)) {
        New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
    }

    $path = Get-ProcessedOperationsFilePath -RootDir $RootDir
    $array = @($Operations)
    $json = if ($array.Count -eq 0) {
        '[]'
    } else {
        $rendered = $array | ConvertTo-Json -Depth 10
        if ($array.Count -eq 1) { "[$rendered]" } else { $rendered }
    }
    Set-Content -Path $path -Value $json -Encoding UTF8
}

function Find-DuplicateOperations {
    # Dado un array de {cuit, numeroComprobante}, devuelve los que YA están
    # registrados como procesados (con fecha/usuario de esa vez), para poder
    # avisar y bloquear esas filas puntuales sin tocar el resto del archivo.
    param(
        [Parameter(Mandatory = $true)][string]$RootDir,
        [Parameter(Mandatory = $true)] $Operations
    )

    $existing = @(Get-ProcessedOperations -RootDir $RootDir)
    $index = @{}
    foreach ($record in $existing) {
        $key = "$($record.cuit)|$($record.numeroComprobante)"
        if (-not $index.ContainsKey($key)) { $index[$key] = $record }
    }

    $duplicates = @()
    foreach ($op in @($Operations)) {
        $key = "$($op.cuit)|$($op.numeroComprobante)"
        if ($index.ContainsKey($key)) {
            $match = $index[$key]
            $duplicates += [pscustomobject]@{
                cuit              = [string]$op.cuit
                numeroComprobante = [string]$op.numeroComprobante
                processedAt       = $match.processedAt
                processedBy       = $match.processedBy
            }
        }
    }
    return $duplicates
}

function Add-ProcessedOperations {
    # No vuelve a chequear duplicados acá — eso ya se hizo (Find-DuplicateOperations)
    # antes de ejecutar el flow; esto solo registra lo que efectivamente se dio de alta.
    param(
        [Parameter(Mandatory = $true)][string]$RootDir,
        [Parameter(Mandatory = $true)] $Operations,
        [Parameter(Mandatory = $true)][string]$Username
    )

    $existing = @(Get-ProcessedOperations -RootDir $RootDir)
    $now = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $new = @(@($Operations) | ForEach-Object {
        [pscustomobject]@{
            cuit              = [string]$_.cuit
            numeroComprobante = [string]$_.numeroComprobante
            idMensaje         = [string]$_.idMensaje
            processedAt       = $now
            processedBy       = $Username
        }
    })
    Save-ProcessedOperations -RootDir $RootDir -Operations (@($existing) + $new)
}

Export-ModuleMember -Function Get-ProcessedOperations, Find-DuplicateOperations, Add-ProcessedOperations
