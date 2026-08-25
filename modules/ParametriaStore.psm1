# Lee/escribe parametria.local.json: valores fijos reutilizables por categoría de
# cuenta (Cuenta Corriente, Caja de Ahorro, Plazo Fijo) que los flows usan en vez
# de pedirlos a mano en cada ejecución.

function Get-DefaultParametria {
    [pscustomobject]@{
        cuentaCorriente = [pscustomobject]@{
            codigoCuenta  = ''
            codigoSistema = ''
            transaccion   = ''
            renglon1      = ''
        }
        cajaDeAhorro = [pscustomobject]@{
            codigoSistema = ''
            transaccion   = ''
            renglon1      = ''
        }
        plazoFijo = [pscustomobject]@{
            codigoProducto   = ''
            codigoMovimiento = ''
        }
    }
}

function Get-ParametriaFilePath {
    param([Parameter(Mandatory = $true)][string]$RootDir)
    return Join-Path $RootDir 'parametria.local.json'
}

function Get-Parametria {
    param([Parameter(Mandatory = $true)][string]$RootDir)

    $path = Get-ParametriaFilePath -RootDir $RootDir
    if (-not (Test-Path $path)) {
        return Get-DefaultParametria
    }

    $json = Get-Content -Path $path -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($json)) {
        return Get-DefaultParametria
    }

    $parsed = $json | ConvertFrom-Json
    if ($null -eq $parsed) { return Get-DefaultParametria }
    return $parsed
}

function Save-Parametria {
    param(
        [Parameter(Mandatory = $true)][string]$RootDir,
        [Parameter(Mandatory = $true)] $Parametria
    )

    $path = Get-ParametriaFilePath -RootDir $RootDir
    $json = $Parametria | ConvertTo-Json -Depth 10
    Set-Content -Path $path -Value $json -Encoding UTF8
}

Export-ModuleMember -Function Get-Parametria, Save-Parametria
