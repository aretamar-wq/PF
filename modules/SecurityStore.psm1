# Módulo de seguridad: login contra Active Directory (la contraseña nunca se
# guarda, solo se usa un instante para el bind LDAP), administración de
# usuarios habilitados + su rol, y auditoría en logs/security.log.
#
# Usuarios/roles y la configuración de AD viven en MariaDB (tablas usuarios,
# rol, rol_usuarios, configuracion_ad — ver deploy/mariadb-schema.sql y "Base
# de datos (MariaDB)" en el README), no en security.local.json — ese archivo
# se dejó de usar (ver modules/scripts/Migrate-JsonToMariaDb.ps1 para migrar
# los datos que hubiera). A diferencia del resto de este archivo, las
# sesiones (tokens Bearer) siguen en memoria (nunca se persisten, ni en
# disco ni en la base — se pierden al reiniciar el servidor, a propósito).
#
# rol_usuarios es una relación usuarios<->rol modelada con tabla intermedia,
# pero usuario_id es su PRIMARY KEY: fuerza como máximo una fila por usuario,
# o sea un solo rol por usuario — mismo comportamiento que antes (un rol
# plano por usuario en el JSON), solo que normalizado en la base. Requiere
# que MariaDbClient.psm1 ya esté importado (ver server.ps1).

$script:ValidRoles = @('admin', 'operador', 'lectura')

# --- Configuración de Active Directory ----------------------------------------

function Get-AdConfig {
    param([Parameter(Mandatory = $true)][string]$RootDir)

    $rows = @(Invoke-DbQuery -RootDir $RootDir -Sql 'SELECT server, port, use_ssl, domain FROM configuracion_ad WHERE id = 1')
    if ($rows.Count -eq 0) {
        return [pscustomobject]@{ server = ''; port = 389; useSsl = $false; domain = '' }
    }
    $row = $rows[0]
    return [pscustomobject]@{
        server = $row.server
        port   = $row.port
        useSsl = [bool]$row.use_ssl
        domain = $row.domain
    }
}

function Save-AdConfig {
    param(
        [Parameter(Mandatory = $true)][string]$RootDir,
        [Parameter(Mandatory = $true)] $AdConfig
    )

    Invoke-DbNonQuery -RootDir $RootDir -Sql @'
INSERT INTO configuracion_ad (id, server, port, use_ssl, domain) VALUES (1, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE server = VALUES(server), port = VALUES(port), use_ssl = VALUES(use_ssl), domain = VALUES(domain)
'@ -Params @(
        [string]$AdConfig.server,
        $(if ($AdConfig.port) { [int]$AdConfig.port } else { 389 }),
        $(if ($AdConfig.useSsl) { 1 } else { 0 }),
        [string]$AdConfig.domain
    ) | Out-Null
}

# --- Autenticación contra Active Directory --------------------------------

function Test-AdCredentials {
    param(
        [Parameter(Mandatory = $true)] $AdConfig,
        [Parameter(Mandatory = $true)] [string]$Username,
        [Parameter(Mandatory = $true)] [string]$Password
    )

    if ([string]::IsNullOrWhiteSpace([string]$AdConfig.server)) {
        return [pscustomobject]@{ ok = $false; message = 'No hay un servidor de Active Directory configurado (ver Parametría de seguridad).' }
    }

    try {
        # System.DirectoryServices.Protocols es LDAP puro (a diferencia de
        # System.DirectoryServices.AccountManagement, que usa ADSI y solo corre en
        # Windows) — funciona igual en Windows y en Linux/macOS, así que
        # ApiCore puede autenticar contra el mismo Domain Controller
        # sin importar en qué SO corra el servidor.
        Add-Type -AssemblyName System.DirectoryServices.Protocols -ErrorAction Stop
    } catch {
        return [pscustomobject]@{ ok = $false; message = "No se pudo cargar el soporte de LDAP en esta máquina: $($_.Exception.Message)" }
    }

    $port = if ($AdConfig.port) { [int]$AdConfig.port } else { 389 }
    $identifier = New-Object System.DirectoryServices.Protocols.LdapDirectoryIdentifier([string]$AdConfig.server, $port)

    $upn = if ($Username -like '*@*' -or $Username -like '*\*') {
        $Username
    } elseif (-not [string]::IsNullOrWhiteSpace([string]$AdConfig.domain)) {
        "$Username@$($AdConfig.domain)"
    } else {
        $Username
    }

    $connection = $null
    try {
        $connection = New-Object System.DirectoryServices.Protocols.LdapConnection($identifier)
        $connection.AuthType = [System.DirectoryServices.Protocols.AuthType]::Basic
        $connection.SessionOptions.ProtocolVersion = 3
        if ($AdConfig.useSsl) {
            $connection.SessionOptions.SecureSocketLayer = $true
        }
        # Bind "simple" (usuario/contraseña en texto plano dentro del request LDAP) —
        # por eso useSsl debería estar prendido en producción, para que ese request
        # viaje cifrado igual que con LDAPS. La contraseña solo vive en $Password
        # durante este bind puntual y se descarta enseguida (nunca se persiste).
        $credential = New-Object System.Net.NetworkCredential($upn, $Password)
        $connection.Bind($credential)
        return [pscustomobject]@{ ok = $true; message = 'OK' }
    } catch [System.DirectoryServices.Protocols.LdapException] {
        if ($_.Exception.ErrorCode -eq 49) {
            return [pscustomobject]@{ ok = $false; message = 'Usuario o contraseña inválidos en Active Directory.' }
        }
        return [pscustomobject]@{ ok = $false; message = "No se pudo validar contra Active Directory: $($_.Exception.Message)" }
    } catch {
        # El mensaje de la excepción puede incluir detalles de conexión (host/puerto),
        # pero nunca la contraseña (nunca se interpola $Password en ningún lado acá).
        return [pscustomobject]@{ ok = $false; message = "No se pudo validar contra Active Directory: $($_.Exception.Message)" }
    } finally {
        if ($connection) { $connection.Dispose() }
    }
}

# --- Roles -----------------------------------------------------------------

function Get-ValidRoles {
    return @($script:ValidRoles)
}

function Test-RoleCanManageUsers {
    param([Parameter(Mandatory = $true)][string]$Role)
    return $Role -eq 'admin'
}

function Test-RoleCanManageParametria {
    # Parametría trae valores de cuenta y, sobre todo, la contraseña de Sybase
    # (aunque nunca se manda de vuelta al navegador, sí se puede pisar) — mismo
    # criterio que Test-RoleCanManageUsers: solo admin. 'operador' puede correr
    # flows y probar el token OAuth2 del perfil elegido, pero no ver ni tocar
    # Parametría (ni siquiera "Probar conexión" de Sybase).
    param([Parameter(Mandatory = $true)][string]$Role)
    return $Role -eq 'admin'
}

function Test-RoleCanRunFlow {
    param(
        [Parameter(Mandatory = $true)][string]$Role,
        [string]$FlowName
    )
    # 'lectura' es solo consulta: puede ver flows/perfiles/logs pero no ejecutar
    # nada (ni un simple SELECT vía Consulta SQL, ni mucho menos un Plazo Fijo).
    # admin/operador pueden correr cualquier flow — no hay restricción por flow
    # individual todavía, pero queda un único lugar para agregarla si hiciera falta.
    return $Role -in @('admin', 'operador')
}

# --- Usuarios ----------------------------------------------------------------

$script:UserSelectSql = @'
SELECT u.username, u.display_name, u.enabled, r.nombre AS role
FROM usuarios u
LEFT JOIN rol_usuarios ru ON ru.usuario_id = u.id
LEFT JOIN rol r ON r.id = ru.rol_id
'@

function ConvertTo-UserRecord {
    param($Row)
    return [pscustomobject]@{
        username    = $Row.username
        role        = $Row.role
        enabled     = [bool]$Row.enabled
        displayName = if ($Row.display_name) { $Row.display_name } else { '' }
    }
}

function Get-SecurityUsers {
    param([Parameter(Mandatory = $true)][string]$RootDir)
    $rows = @(Invoke-DbQuery -RootDir $RootDir -Sql "$script:UserSelectSql ORDER BY u.username")
    return @($rows | ForEach-Object { ConvertTo-UserRecord -Row $_ })
}

function Find-SecurityUser {
    param([Parameter(Mandatory = $true)][string]$RootDir, [Parameter(Mandatory = $true)][string]$Username)
    $rows = @(Invoke-DbQuery -RootDir $RootDir -Sql "$script:UserSelectSql WHERE LOWER(u.username) = LOWER(?)" -Params @($Username))
    if ($rows.Count -eq 0) { return $null }
    return ConvertTo-UserRecord -Row $rows[0]
}

function Test-IsLastEnabledAdmin {
    # Evita que la app quede sin ningún admin habilitado (nadie podría volver a
    # gestionar usuarios). Se llama antes de borrar/deshabilitar/cambiarle el rol
    # a un admin.
    param([Parameter(Mandatory = $true)][string]$RootDir, [Parameter(Mandatory = $true)][string]$Username)

    $target = Find-SecurityUser -RootDir $RootDir -Username $Username
    if (-not $target -or $target.role -ne 'admin' -or -not $target.enabled) { return $false }

    $rows = @(Invoke-DbQuery -RootDir $RootDir -Sql @'
SELECT COUNT(*) AS total
FROM usuarios u
JOIN rol_usuarios ru ON ru.usuario_id = u.id
JOIN rol r ON r.id = ru.rol_id
WHERE r.nombre = 'admin' AND u.enabled = 1 AND LOWER(u.username) <> LOWER(?)
'@ -Params @($Username))
    return ([int]$rows[0].total -eq 0)
}

function Add-OrUpdateSecurityUser {
    param(
        [Parameter(Mandatory = $true)][string]$RootDir,
        [Parameter(Mandatory = $true)][string]$Username,
        [Parameter(Mandatory = $true)][string]$Role,
        [bool]$Enabled = $true,
        [string]$DisplayName = ''
    )

    if ($Role -notin (Get-ValidRoles)) {
        throw "Rol inválido: '$Role'. Roles válidos: $((Get-ValidRoles) -join ', ')."
    }

    $connection = New-DbConnection -RootDir $RootDir
    $transaction = $connection.BeginTransaction()
    try {
        $cmd = $connection.CreateCommand()
        $cmd.Transaction = $transaction
        $cmd.CommandText = @'
INSERT INTO usuarios (username, display_name, enabled) VALUES (?, ?, ?)
ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), enabled = VALUES(enabled)
'@
        Add-DbCommandParameters -Command $cmd -Params @($Username, $DisplayName, $(if ($Enabled) { 1 } else { 0 }))
        [void]$cmd.ExecuteNonQuery()

        $cmd2 = $connection.CreateCommand()
        $cmd2.Transaction = $transaction
        $cmd2.CommandText = 'SELECT id FROM usuarios WHERE LOWER(username) = LOWER(?)'
        Add-DbCommandParameters -Command $cmd2 -Params @($Username)
        $userId = $cmd2.ExecuteScalar()

        $cmd3 = $connection.CreateCommand()
        $cmd3.Transaction = $transaction
        $cmd3.CommandText = 'SELECT id FROM rol WHERE nombre = ?'
        Add-DbCommandParameters -Command $cmd3 -Params @($Role)
        $roleId = $cmd3.ExecuteScalar()

        # usuario_id es la PRIMARY KEY de rol_usuarios: este INSERT ... ON
        # DUPLICATE KEY pisa el rol existente en vez de agregar una segunda fila
        # — así se mantiene "un solo rol por usuario" aunque la relación esté
        # modelada como tabla intermedia.
        $cmd4 = $connection.CreateCommand()
        $cmd4.Transaction = $transaction
        $cmd4.CommandText = 'INSERT INTO rol_usuarios (usuario_id, rol_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE rol_id = VALUES(rol_id)'
        Add-DbCommandParameters -Command $cmd4 -Params @($userId, $roleId)
        [void]$cmd4.ExecuteNonQuery()

        $transaction.Commit()
    } catch {
        $transaction.Rollback()
        throw
    } finally {
        $connection.Close()
    }
}

function Remove-SecurityUser {
    param(
        [Parameter(Mandatory = $true)][string]$RootDir,
        [Parameter(Mandatory = $true)][string]$Username
    )

    # ON DELETE CASCADE en rol_usuarios.usuario_id se encarga de borrar también
    # la fila de rol_usuarios de este usuario.
    Invoke-DbNonQuery -RootDir $RootDir -Sql 'DELETE FROM usuarios WHERE LOWER(username) = LOWER(?)' -Params @($Username) | Out-Null
}

# --- Sesiones (tokens Bearer en memoria, se pierden al reiniciar el servidor,
# mismo criterio que $Global:TokenCache para el token OAuth2 en FlowEngine) ----

function New-SessionToken {
    # Ojo: el método estático RandomNumberGenerator.Fill(byte[]) recién existe
    # desde .NET 6 — en Windows PowerShell 5.1 (.NET Framework) no está, y
    # tira "no contiene ningún método llamado 'Fill'". Create()+GetBytes() de
    # instancia sí existe desde .NET Framework 2.0, así que funciona igual en
    # PowerShell 5.1 y en pwsh 7.
    $bytes = [byte[]]::new(32)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

function New-Session {
    param(
        [Parameter(Mandatory = $true)][string]$Username,
        [Parameter(Mandatory = $true)][string]$Role,
        [string]$DisplayName = '',
        [int]$LifetimeHours = 8
    )

    if (-not $Global:SecuritySessions) { $Global:SecuritySessions = @{} }

    $token = New-SessionToken
    $Global:SecuritySessions[$token] = @{
        username     = $Username
        role         = $Role
        displayName  = $DisplayName
        expiresAtUtc = [DateTime]::UtcNow.AddHours($LifetimeHours)
    }
    return $token
}

function Get-SessionUser {
    param([string]$Token)

    if ([string]::IsNullOrEmpty($Token)) { return $null }
    if (-not $Global:SecuritySessions) { $Global:SecuritySessions = @{} }
    if (-not $Global:SecuritySessions.ContainsKey($Token)) { return $null }

    $session = $Global:SecuritySessions[$Token]
    if ([DateTime]::UtcNow -gt $session.expiresAtUtc) {
        $Global:SecuritySessions.Remove($Token)
        return $null
    }
    return [pscustomobject]$session
}

function Remove-Session {
    param([string]$Token)
    if (-not $Global:SecuritySessions) { return }
    if ($Token -and $Global:SecuritySessions.ContainsKey($Token)) {
        $Global:SecuritySessions.Remove($Token)
    }
}

# --- Auditoría --------------------------------------------------------------

function Write-SecurityLog {
    param(
        [Parameter(Mandatory = $true)][string]$LogsDir,
        [Parameter(Mandatory = $true)][string]$Message
    )

    try {
        if (-not (Test-Path $LogsDir)) {
            New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
        }
        $timestamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        $path = Join-Path $LogsDir 'security.log'
        Add-Content -Path $path -Value "[$timestamp] $Message" -Encoding UTF8
    } catch {
        # Igual que Write-HttpLog en FlowEngine.psm1: un problema de logging nunca
        # debe romper el login ni la gestión de usuarios.
    }
}

Export-ModuleMember -Function `
    Get-AdConfig, Save-AdConfig, `
    Test-AdCredentials, `
    Get-ValidRoles, Test-RoleCanManageUsers, Test-RoleCanManageParametria, Test-RoleCanRunFlow, `
    Get-SecurityUsers, Find-SecurityUser, Test-IsLastEnabledAdmin, Add-OrUpdateSecurityUser, Remove-SecurityUser, `
    New-Session, Get-SessionUser, Remove-Session, `
    Write-SecurityLog
