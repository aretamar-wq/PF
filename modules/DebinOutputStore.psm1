# Registro en MariaDB del contenido de dbnout-...csv y dbnconsulta-...csv
# (ver "Archivos de salida (files/)" en el README) con quién ejecutó la
# carga y cuándo — además del .csv que ya se guarda en files/ (ver
# handleSaveOutput en server.ps1), no en reemplazo. Tablas "dbn_out" y
# "dbn_consulta" (ver deploy/mariadb-schema.sql), puramente de
# registro/auditoría: no se leen para deduplicar (eso lo sigue haciendo
# ProcessedOperationsStore.psm1). Requiere que MariaDbClient.psm1 ya esté
# importado (ver server.ps1). Mismo criterio que node/lib/debinOutputStore.js.

# Mismo parser que Split-CsvLine en wwwroot/app.js (parseCsvLine/parseCsvText) —
# el contenido que llega acá ya viene armado por saveOutputFiles con
# csvEscape, así que hay que interpretarlo con las mismas reglas (comillas
# dobles para escapar una comilla, campos entre comillas para valores con
# coma/salto de línea).
function ConvertFrom-CsvLine {
    param([Parameter(Mandatory = $true)][string]$Line)

    $cells = New-Object System.Collections.Generic.List[string]
    $cell = New-Object System.Text.StringBuilder
    $inQuotes = $false

    for ($i = 0; $i -lt $Line.Length; $i++) {
        $ch = $Line[$i]
        if ($inQuotes) {
            if ($ch -eq '"') {
                if ($i + 1 -lt $Line.Length -and $Line[$i + 1] -eq '"') {
                    [void]$cell.Append('"')
                    $i++
                } else {
                    $inQuotes = $false
                }
            } else {
                [void]$cell.Append($ch)
            }
        } elseif ($ch -eq '"' -and $cell.Length -eq 0) {
            $inQuotes = $true
        } elseif ($ch -eq ',') {
            $cells.Add($cell.ToString())
            [void]$cell.Clear()
        } else {
            [void]$cell.Append($ch)
        }
    }
    $cells.Add($cell.ToString())
    return , $cells.ToArray()
}

function ConvertFrom-CsvText {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)

    $lines = @($Text -split "`r`n|`r|`n" | Where-Object { $_.Length -gt 0 })
    return @($lines | ForEach-Object { , (ConvertFrom-CsvLine -Line $_) })
}

function ConvertTo-CsvRecords {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$CsvContent)

    $lines = @(ConvertFrom-CsvText -Text $CsvContent)
    if ($lines.Count -le 1) { return @() }

    $header = $lines[0]
    $records = @()
    for ($r = 1; $r -lt $lines.Count; $r++) {
        $row = $lines[$r]
        $record = [ordered]@{}
        for ($c = 0; $c -lt $header.Count; $c++) {
            $record[$header[$c]] = if ($c -lt $row.Count) { $row[$c] } else { '' }
        }
        $records += [pscustomobject]$record
    }
    return $records
}

function Add-DbnOutRows {
    param(
        [Parameter(Mandatory = $true)][string]$RootDir,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$CsvContent,
        [Parameter(Mandatory = $true)][string]$Username
    )

    $records = @(ConvertTo-CsvRecords -CsvContent $CsvContent)
    if ($records.Count -eq 0) { return }

    $now = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $connection = New-DbConnection -RootDir $RootDir
    $transaction = $connection.BeginTransaction()
    try {
        foreach ($record in $records) {
            $cmd = $connection.CreateCommand()
            $cmd.Transaction = $transaction
            $cmd.CommandText = @'
INSERT INTO dbn_out (
   credito_cuit, credito_cbu, credito_titular,
   debito_cuit, debito_cbu, debito_titular,
   id_comprobante, moneda, importe,
   codigo_respuesta, descripcion_respuesta, id_respuesta, id_mensaje, realizado,
   ejecutado_por, ejecutado_en
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
'@
            Add-DbCommandParameters -Command $cmd -Params @(
                [string]$record.creditoCuit, [string]$record.creditoCbu, [string]$record.creditoTitular,
                [string]$record.debitoCuit, [string]$record.debitoCbu, [string]$record.debitoTitular,
                [string]$record.idComprobante, [string]$record.moneda, [string]$record.importe,
                [string]$record.codigoRespuesta, [string]$record.descripcionRespuesta, [string]$record.idRespuesta, [string]$record.idMensaje, [string]$record.realizado,
                $Username, $now
            )
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

function Add-DbnConsultaRows {
    param(
        [Parameter(Mandatory = $true)][string]$RootDir,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$CsvContent,
        [Parameter(Mandatory = $true)][string]$Username
    )

    $records = @(ConvertTo-CsvRecords -CsvContent $CsvContent)
    if ($records.Count -eq 0) { return }

    $now = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $connection = New-DbConnection -RootDir $RootDir
    $transaction = $connection.BeginTransaction()
    try {
        foreach ($record in $records) {
            $rest = [ordered]@{}
            foreach ($prop in $record.PSObject.Properties) {
                if ($prop.Name -notin @('idMensaje', 'idComprobante', 'idOperacion', 'errorConsulta')) {
                    $rest[$prop.Name] = $prop.Value
                }
            }
            $restJson = $rest | ConvertTo-Json -Depth 10 -Compress

            $cmd = $connection.CreateCommand()
            $cmd.Transaction = $transaction
            $cmd.CommandText = @'
INSERT INTO dbn_consulta (
   id_mensaje, id_comprobante, id_operacion, error_consulta, respuesta_json,
   ejecutado_por, ejecutado_en
) VALUES (?, ?, ?, ?, ?, ?, ?)
'@
            Add-DbCommandParameters -Command $cmd -Params @(
                [string]$record.idMensaje, [string]$record.idComprobante, [string]$record.idOperacion, [string]$record.errorConsulta,
                $restJson, $Username, $now
            )
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

Export-ModuleMember -Function Add-DbnOutRows, Add-DbnConsultaRows
