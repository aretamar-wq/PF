# Registro de operaciones (cuit + numeroComprobante) que ya se ejecutaron con
# éxito, para poder bloquear una fila que intente repetir la misma operación
# antes de llamar a ningún endpoint del banco. En MariaDB (tabla
# "operaciones_procesadas") — reemplaza logs/processed-operations.json (ver
# deploy/mariadb-schema.sql y "Base de datos (MariaDB)" en el README).
# Requiere que MariaDbClient.psm1 ya esté importado (ver server.ps1).
#
# Find-DuplicateOperations arma un solo WHERE con el índice único (cuit,
# numero_comprobante) en vez de traer toda la tabla — pensado también para
# cuando la tabla crezca mucho.

function ConvertTo-OperationRecord {
    param($Row)
    return [pscustomobject]@{
        cuit              = $Row.cuit
        numeroComprobante = $Row.numero_comprobante
        idMensaje         = $Row.id_mensaje
        processedAt       = $Row.processed_at
        processedBy       = $Row.processed_by
    }
}

function Get-ProcessedOperations {
    param([Parameter(Mandatory = $true)][string]$RootDir)
    $rows = @(Invoke-DbQuery -RootDir $RootDir -Sql 'SELECT * FROM operaciones_procesadas ORDER BY id')
    return @($rows | ForEach-Object { ConvertTo-OperationRecord -Row $_ })
}

function Find-DuplicateOperations {
    # Dado un array de {cuit, numeroComprobante}, devuelve los que YA están
    # registrados como procesados (con fecha/usuario de esa vez), para poder
    # avisar y bloquear esas filas puntuales sin tocar el resto del archivo.
    param(
        [Parameter(Mandatory = $true)][string]$RootDir,
        [Parameter(Mandatory = $true)] $Operations
    )

    $ops = @($Operations)
    if ($ops.Count -eq 0) { return @() }

    $conditions = @($ops | ForEach-Object { '(cuit = ? AND numero_comprobante = ?)' }) -join ' OR '
    $params = @()
    foreach ($op in $ops) {
        $params += [string]$op.cuit
        $params += [string]$op.numeroComprobante
    }

    $rows = @(Invoke-DbQuery -RootDir $RootDir -Sql @"
SELECT cuit, numero_comprobante, id_mensaje, processed_at, processed_by
FROM operaciones_procesadas
WHERE $conditions
"@ -Params $params)

    return @($rows | ForEach-Object {
        [pscustomobject]@{
            cuit              = $_.cuit
            numeroComprobante = $_.numero_comprobante
            processedAt       = $_.processed_at
            processedBy       = $_.processed_by
        }
    })
}

function Add-ProcessedOperations {
    # No vuelve a chequear duplicados acá — eso ya se hizo (Find-DuplicateOperations)
    # antes de ejecutar el flow; esto solo registra lo que efectivamente se dio de alta.
    param(
        [Parameter(Mandatory = $true)][string]$RootDir,
        [Parameter(Mandatory = $true)] $Operations,
        [Parameter(Mandatory = $true)][string]$Username
    )

    $ops = @($Operations)
    if ($ops.Count -eq 0) { return }

    $now = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $connection = New-DbConnection -RootDir $RootDir
    $transaction = $connection.BeginTransaction()
    try {
        foreach ($op in $ops) {
            $cmd = $connection.CreateCommand()
            $cmd.Transaction = $transaction
            # ON DUPLICATE KEY UPDATE como no-op (id = id): la UNIQUE KEY
            # (cuit, numero_comprobante) evita una fila duplicada si esta misma
            # operación ya se había registrado antes (ej. una carrera entre dos
            # corridas), sin tirar un error de constraint.
            $cmd.CommandText = @'
INSERT INTO operaciones_procesadas (cuit, numero_comprobante, id_mensaje, processed_at, processed_by)
VALUES (?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE id = id
'@
            Add-DbCommandParameters -Command $cmd -Params @([string]$op.cuit, [string]$op.numeroComprobante, [string]$op.idMensaje, $now, $Username)
            [void]$cmd.ExecuteNonQuery()
        }
        $transaction.Commit()
    } catch {
        $transaction.Rollback()
        throw
    } finally {
        $connection.Close()
    }
}

Export-ModuleMember -Function Get-ProcessedOperations, Find-DuplicateOperations, Add-ProcessedOperations
