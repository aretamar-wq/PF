# Valores fijos reutilizables por categoría de cuenta (Cuenta Corriente, Caja
# de Ahorro, Plazo Fijo) + conexión Sybase, en MariaDB (tabla "parametria",
# fila única id=1) — reemplaza parametria.local.json (ver
# deploy/mariadb-schema.sql y "Base de datos (MariaDB)" en el README). Misma
# API pública que antes (Get-Parametria/Save-Parametria). Requiere que
# MariaDbClient.psm1 y CryptoUtil.psm1 ya estén importados (ver server.ps1).
#
# sybase_password se guarda cifrada (AES-256-GCM, ver CryptoUtil.psm1) — es
# la contraseña real de la base bancaria, no algo que deba quedar legible
# con un SELECT directo a la tabla. El resto de los campos de Parametría no
# son secretos (códigos de cuenta/producto/movimiento, o el connection
# string sin la contraseña) y se guardan tal cual.

function Get-DefaultParametria {
    [pscustomobject]@{
        cuentaCorriente = [pscustomobject]@{
            codigoCuenta  = ''
            codigoSistema = ''
            transaccion   = ''
        }
        cajaDeAhorro = [pscustomobject]@{
            codigoSistema = ''
            transaccion   = ''
        }
        plazoFijo = [pscustomobject]@{
            codigoProducto   = ''
            codigoMovimiento = ''
        }
        sybase = [pscustomobject]@{
            connectionString = 'Driver={Adaptive Server Enterprise};NetworkAddress=Aconquija4.bv.voii.com.ar,5000;Database=Banksys;Uid={{usuario}};Pwd={{password}}'
            usuario          = ''
            password         = ''
        }
    }
}

function ConvertTo-ParametriaRecord {
    param($Row)
    return [pscustomobject]@{
        cuentaCorriente = [pscustomobject]@{
            codigoCuenta  = $Row.cc_codigo_cuenta
            codigoSistema = $Row.cc_codigo_sistema
            transaccion   = $Row.cc_transaccion
        }
        cajaDeAhorro = [pscustomobject]@{
            codigoSistema = $Row.ca_codigo_sistema
            transaccion   = $Row.ca_transaccion
        }
        plazoFijo = [pscustomobject]@{
            codigoProducto   = $Row.pf_codigo_producto
            codigoMovimiento = $Row.pf_codigo_movimiento
        }
        sybase = [pscustomobject]@{
            connectionString = $Row.sybase_connection_string
            usuario          = $Row.sybase_usuario
            password         = $Row.sybase_password
        }
    }
}

function Get-Parametria {
    param([Parameter(Mandatory = $true)][string]$RootDir)

    $rows = @(Invoke-DbQuery -RootDir $RootDir -Sql 'SELECT * FROM parametria WHERE id = 1')
    if ($rows.Count -eq 0) { return Get-DefaultParametria }

    $parametria = ConvertTo-ParametriaRecord -Row $rows[0]
    if ($parametria.sybase.password) {
        $parametria.sybase.password = Unprotect-CryptoValue -Stored $parametria.sybase.password -HexKey (Get-EncryptionKey -RootDir $RootDir)
    }
    return $parametria
}

function Save-Parametria {
    param(
        [Parameter(Mandatory = $true)][string]$RootDir,
        [Parameter(Mandatory = $true)] $Parametria
    )

    $cc = if ($Parametria.cuentaCorriente) { $Parametria.cuentaCorriente } else { [pscustomobject]@{} }
    $ca = if ($Parametria.cajaDeAhorro) { $Parametria.cajaDeAhorro } else { [pscustomobject]@{} }
    $pf = if ($Parametria.plazoFijo) { $Parametria.plazoFijo } else { [pscustomobject]@{} }
    $sybase = if ($Parametria.sybase) { $Parametria.sybase } else { [pscustomobject]@{} }

    $encryptedPassword = if ($sybase.password) { Protect-CryptoValue -PlainText ([string]$sybase.password) -HexKey (Get-EncryptionKey -RootDir $RootDir) } else { '' }

    Invoke-DbNonQuery -RootDir $RootDir -Sql @'
INSERT INTO parametria (
   id, cc_codigo_cuenta, cc_codigo_sistema, cc_transaccion,
   ca_codigo_sistema, ca_transaccion,
   pf_codigo_producto, pf_codigo_movimiento,
   sybase_connection_string, sybase_usuario, sybase_password
) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
   cc_codigo_cuenta = VALUES(cc_codigo_cuenta),
   cc_codigo_sistema = VALUES(cc_codigo_sistema),
   cc_transaccion = VALUES(cc_transaccion),
   ca_codigo_sistema = VALUES(ca_codigo_sistema),
   ca_transaccion = VALUES(ca_transaccion),
   pf_codigo_producto = VALUES(pf_codigo_producto),
   pf_codigo_movimiento = VALUES(pf_codigo_movimiento),
   sybase_connection_string = VALUES(sybase_connection_string),
   sybase_usuario = VALUES(sybase_usuario),
   sybase_password = VALUES(sybase_password)
'@ -Params @(
        [string]$cc.codigoCuenta,
        [string]$cc.codigoSistema,
        [string]$cc.transaccion,
        [string]$ca.codigoSistema,
        [string]$ca.transaccion,
        [string]$pf.codigoProducto,
        [string]$pf.codigoMovimiento,
        [string]$sybase.connectionString,
        [string]$sybase.usuario,
        $encryptedPassword
    ) | Out-Null
}

Export-ModuleMember -Function Get-DefaultParametria, Get-Parametria, Save-Parametria
