# Cliente MariaDB para el backend PowerShell (MySqlConnector, librería .NET
# vendorizada en modules/lib/ — ver "Base de datos (MariaDB)" en el README).
# PowerShell no tiene un driver nativo para MariaDB (a diferencia de Sybase,
# que sí tiene ODBC vía System.Data.Odbc), así que se usa esta librería en
# vez de eso. Reemplaza *.local.json como almacenamiento de usuarios/roles,
# perfiles, parametría, antiduplicado y el registro de dbnout-/dbnconsulta-
# — mismas tablas que ya usa el backend Node.js (ver
# deploy/mariadb-schema.sql), la misma base sirve a los dos backends.
#
# Dos carpetas de DLLs porque el runtime de PowerShell cambia según la
# edición: "Desktop" (Windows PowerShell 5.1, .NET Framework — el que ya
# viene instalado en Windows) usa modules/lib/desktop/ (build net461 de
# MySqlConnector + los paquetes System.Buffers/System.Memory/etc. que .NET
# Framework no trae de fábrica); "Core" (pwsh 7+) usa modules/lib/core/
# (build net6.0, autocontenido, sin dependencias extra). Mismo criterio que
# usa CryptoUtil.psm1 para BouncyCastle.Cryptography.
#
# Los parámetros de una consulta van con placeholders "?" en orden (mismo
# estilo que ya usa node/lib/mariadbClient.js con mysql2, y que
# FlowEngine.psm1 ya usa para Sybase vía System.Data.Odbc) — MySqlConnector
# soporta "?" posicional además del "@nombre" que es su estilo nativo.

$script:MariaDbAssembliesLoaded = $false

function Import-MariaDbAssemblies {
    if ($script:MariaDbAssembliesLoaded) { return }

    $libDir = if ($PSVersionTable.PSEdition -eq 'Core') {
        Join-Path $PSScriptRoot 'lib/core'
    } else {
        Join-Path $PSScriptRoot 'lib/desktop'
    }

    # Orden de carga: dependencias primero, MySqlConnector al final — no es
    # estrictamente necesario (el CLR resuelve assemblies por nombre/versión,
    # no por orden de Add-Type), pero deja más claro en qué DLL buscar si
    # algún día falta una y tira "no se pudo cargar el archivo o ensamblado".
    $dlls = if ($PSVersionTable.PSEdition -eq 'Core') {
        @('MySqlConnector.dll')
    } else {
        @(
            'System.Runtime.CompilerServices.Unsafe.dll',
            'System.Numerics.Vectors.dll',
            'System.Buffers.dll',
            'System.Memory.dll',
            'System.Threading.Tasks.Extensions.dll',
            'MySqlConnector.dll'
        )
    }

    foreach ($dll in $dlls) {
        Add-Type -Path (Join-Path $libDir $dll) -ErrorAction Stop
    }

    $script:MariaDbAssembliesLoaded = $true
}

function Get-DbConfigFilePath {
    param([Parameter(Mandatory = $true)][string]$RootDir)
    return Join-Path $RootDir 'db.local.json'
}

function Read-DbConfigFile {
    param([Parameter(Mandatory = $true)][string]$RootDir)

    $path = Get-DbConfigFilePath -RootDir $RootDir
    if (-not (Test-Path $path)) {
        throw "No se encontró $path. Copiá db.sample.json a db.local.json y completá los datos de conexión a MariaDB."
    }
    $json = Get-Content -Path $path -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($json)) {
        throw "$path está vacío. Completá los datos de conexión a MariaDB."
    }
    return $json | ConvertFrom-Json
}

function Get-DbConfig {
    param([Parameter(Mandatory = $true)][string]$RootDir)

    $parsed = Read-DbConfigFile -RootDir $RootDir
    if (-not $parsed.host -or -not $parsed.database -or -not $parsed.user) {
        throw 'db.local.json está incompleto: hacen falta al menos host, database y user.'
    }
    return [pscustomobject]@{
        host     = [string]$parsed.host
        port     = if ($parsed.port) { [int]$parsed.port } else { 3306 }
        database = [string]$parsed.database
        user     = [string]$parsed.user
        password = if ($parsed.password) { [string]$parsed.password } else { '' }
    }
}

# Clave de cifrado (AES-256-GCM, ver CryptoUtil.psm1) para los campos
# sensibles guardados en MariaDB — vive en el mismo db.local.json que el
# resto de la conexión, no en la base (cifrar con una clave guardada en la
# misma tabla que lo cifrado no protege nada). Mismo archivo/clave que ya
# usa el backend Node.js: los dos backends pueden leer/escribir los mismos
# valores cifrados sin problema (ver dbConfigStore.js). Se genera una sola
# vez (ver "Base de datos (MariaDB)" en el README) — no hay forma de
# recuperar el valor cifrado si se pierde esta clave.
function Get-EncryptionKey {
    param([Parameter(Mandatory = $true)][string]$RootDir)

    $parsed = Read-DbConfigFile -RootDir $RootDir
    if (-not $parsed.encryptionKey) {
        throw ('db.local.json no tiene configurado "encryptionKey" (hace falta para cifrar/descifrar contraseñas y ' +
               'secretos guardados en MariaDB). Ver "Base de datos (MariaDB)" en el README para cómo generarla.')
    }
    return [string]$parsed.encryptionKey
}

function Get-DbConnectionString {
    param([Parameter(Mandatory = $true)][string]$RootDir)

    $config = Get-DbConfig -RootDir $RootDir
    return "Server=$($config.host);Port=$($config.port);Database=$($config.database);User=$($config.user);Password=$($config.password);"
}

function New-DbConnection {
    param([Parameter(Mandatory = $true)][string]$RootDir)

    Import-MariaDbAssemblies
    $connStr = Get-DbConnectionString -RootDir $RootDir
    $connection = [MySqlConnector.MySqlConnection]::new($connStr)
    $connection.Open()
    return $connection
}

function Add-DbCommandParameters {
    param($Command, [object[]]$Params)

    if ($Params) {
        foreach ($value in $Params) {
            $p = $Command.CreateParameter()
            $p.Value = if ($null -eq $value) { [DBNull]::Value } else { $value }
            [void]$Command.Parameters.Add($p)
        }
    }
}

function ConvertFrom-DbReader {
    # Vuelca el reader entero a un array de pscustomobject (una propiedad por
    # columna, con el nombre de columna tal cual viene de la base) — mismo
    # criterio que las filas planas que devuelve mysql2 del lado Node.js.
    param($Reader)

    $rows = @()
    while ($Reader.Read()) {
        $row = [ordered]@{}
        for ($i = 0; $i -lt $Reader.FieldCount; $i++) {
            $value = $Reader.GetValue($i)
            if ($value -is [DBNull]) { $value = $null }
            $row[$Reader.GetName($i)] = $value
        }
        $rows += [pscustomobject]$row
    }
    return $rows
}

# Corre un SELECT y devuelve las filas (array de pscustomobject). Abre y
# cierra su propia conexión — server.ps1 atiende un request a la vez (ver
# "Limitaciones conocidas"), así que no hace falta un pool propio; el
# pooling interno de MySqlConnector (activado por default en el connection
# string) ya evita rehacer el handshake TCP en cada llamada.
function Invoke-DbQuery {
    param(
        [Parameter(Mandatory = $true)][string]$RootDir,
        [Parameter(Mandatory = $true)][string]$Sql,
        [object[]]$Params
    )

    $connection = New-DbConnection -RootDir $RootDir
    try {
        $cmd = $connection.CreateCommand()
        $cmd.CommandText = $Sql
        Add-DbCommandParameters -Command $cmd -Params $Params
        $reader = $cmd.ExecuteReader()
        try {
            return @(ConvertFrom-DbReader -Reader $reader)
        } finally {
            $reader.Close()
        }
    } finally {
        $connection.Close()
    }
}

# Corre un INSERT/UPDATE/DELETE de una sola sentencia (sin transacción) y
# devuelve la cantidad de filas afectadas. Para operaciones que necesitan
# varias sentencias atómicas (alta de usuario + rol, reemplazo completo de
# perfiles, etc.) los stores abren su propia conexión con New-DbConnection
# y manejan la transacción a mano (ver Save-Profiles en ProfileStore.psm1
# para el ejemplo).
function Invoke-DbNonQuery {
    param(
        [Parameter(Mandatory = $true)][string]$RootDir,
        [Parameter(Mandatory = $true)][string]$Sql,
        [object[]]$Params
    )

    $connection = New-DbConnection -RootDir $RootDir
    try {
        $cmd = $connection.CreateCommand()
        $cmd.CommandText = $Sql
        Add-DbCommandParameters -Command $cmd -Params $Params
        return $cmd.ExecuteNonQuery()
    } finally {
        $connection.Close()
    }
}

Export-ModuleMember -Function `
    Import-MariaDbAssemblies, `
    Get-DbConfigFilePath, Get-DbConfig, Get-EncryptionKey, Get-DbConnectionString, `
    New-DbConnection, Add-DbCommandParameters, ConvertFrom-DbReader, `
    Invoke-DbQuery, Invoke-DbNonQuery
