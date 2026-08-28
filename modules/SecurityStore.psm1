# Módulo de seguridad: login contra Active Directory (la contraseña nunca se guarda,
# solo se usa un instante para el bind LDAP), administración local de usuarios
# habilitados + su rol, sesiones en memoria (tokens Bearer) y auditoría en
# logs/security.log. Lee/escribe security.local.json (nunca versionado, ver
# .gitignore) — mismo patrón que ProfileStore.psm1/ParametriaStore.psm1.

# Roles fijos: qué puede hacer cada uno se resuelve acá (Test-RoleCanManageUsers /
# Test-RoleCanRunFlow), no hay UI para inventar roles nuevos.
$script:ValidRoles = @('admin', 'operador', 'lectura')

function Get-DefaultSecurity {
    [pscustomobject]@{
        ad = [pscustomobject]@{
            server = ''
            port   = 389
            useSsl = $false
            domain = ''
        }
        users = @()
    }
}

function Get-SecurityFilePath {
    param([Parameter(Mandatory = $true)][string]$RootDir)
    return Join-Path $RootDir 'security.local.json'
}

function Get-Security {
    param([Parameter(Mandatory = $true)][string]$RootDir)

    $path = Get-SecurityFilePath -RootDir $RootDir
    if (-not (Test-Path $path)) {
        return Get-DefaultSecurity
    }

    $json = Get-Content -Path $path -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($json)) {
        return Get-DefaultSecurity
    }

    $parsed = $json | ConvertFrom-Json
    if ($null -eq $parsed) { return Get-DefaultSecurity }
    if (-not $parsed.ad) { $parsed | Add-Member -NotePropertyName ad -NotePropertyValue (Get-DefaultSecurity).ad }
    if ($null -eq $parsed.users) { $parsed | Add-Member -NotePropertyName users -NotePropertyValue @() -Force }
    $parsed.users = @($parsed.users)
    return $parsed
}

function Save-Security {
    param(
        [Parameter(Mandatory = $true)][string]$RootDir,
        [Parameter(Mandatory = $true)] $Security
    )

    $path = Get-SecurityFilePath -RootDir $RootDir
    $json = $Security | ConvertTo-Json -Depth 10
    Set-Content -Path $path -Value $json -Encoding UTF8
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
        # System.DirectoryServices.AccountManagement es específico de Windows (usa
        # las mismas APIs que ADSI) — no está disponible corriendo en Linux/macOS.
        # El resto de la app puede desarrollarse/probarse fuera de Windows, pero
        # esta función puntual solo puede ejercitarse en el Windows real donde
        # corre BankCoreFlowRunner.
        Add-Type -AssemblyName System.DirectoryServices.AccountManagement -ErrorAction Stop
    } catch {
        return [pscustomobject]@{ ok = $false; message = "No se pudo cargar el soporte de Active Directory en esta máquina (requiere Windows): $($_.Exception.Message)" }
    }

    $server = [string]$AdConfig.server
    if ($AdConfig.port) { $server = "$server`:$($AdConfig.port)" }

    $contextOptions = [System.DirectoryServices.AccountManagement.ContextOptions]::Negotiate
    if ($AdConfig.useSsl) {
        $contextOptions = $contextOptions -bor [System.DirectoryServices.AccountManagement.ContextOptions]::SecureSocketLayer
    }

    $upn = if ($Username -like '*@*' -or $Username -like '*\*') {
        $Username
    } elseif (-not [string]::IsNullOrWhiteSpace([string]$AdConfig.domain)) {
        "$Username@$($AdConfig.domain)"
    } else {
        $Username
    }

    $pc = $null
    try {
        $pc = New-Object System.DirectoryServices.AccountManagement.PrincipalContext(
            [System.DirectoryServices.AccountManagement.ContextType]::Domain, $server)
        $ok = $pc.ValidateCredentials($upn, $Password, $contextOptions)
        if ($ok) {
            return [pscustomobject]@{ ok = $true; message = 'OK' }
        }
        return [pscustomobject]@{ ok = $false; message = 'Usuario o contraseña inválidos en Active Directory.' }
    } catch {
        # El mensaje de la excepción puede incluir detalles de conexión (host/puerto),
        # pero nunca la contraseña (nunca se interpola $Password en ningún lado acá).
        return [pscustomobject]@{ ok = $false; message = "No se pudo validar contra Active Directory: $($_.Exception.Message)" }
    } finally {
        if ($pc) { $pc.Dispose() }
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

# --- Usuarios locales --------------------------------------------------------

function Get-SecurityUsers {
    param([Parameter(Mandatory = $true)][string]$RootDir)
    return @((Get-Security -RootDir $RootDir).users)
}

function Find-SecurityUser {
    param([Parameter(Mandatory = $true)][string]$RootDir, [Parameter(Mandatory = $true)][string]$Username)
    return @(Get-SecurityUsers -RootDir $RootDir) | Where-Object { $_.username -ieq $Username } | Select-Object -First 1
}

function Test-IsLastEnabledAdmin {
    # Evita que la app quede sin ningún admin habilitado (nadie podría volver a
    # gestionar usuarios). Se llama antes de borrar/deshabilitar/cambiarle el rol
    # a un admin.
    param([Parameter(Mandatory = $true)][string]$RootDir, [Parameter(Mandatory = $true)][string]$Username)
    $users = @(Get-SecurityUsers -RootDir $RootDir)
    $otherEnabledAdmins = @($users | Where-Object { $_.username -ine $Username -and $_.role -eq 'admin' -and $_.enabled })
    $target = $users | Where-Object { $_.username -ieq $Username } | Select-Object -First 1
    return ($target -and $target.role -eq 'admin' -and $target.enabled -and $otherEnabledAdmins.Count -eq 0)
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

    $security = Get-Security -RootDir $RootDir
    $users = @($security.users)
    $existingIndex = -1
    for ($i = 0; $i -lt $users.Count; $i++) {
        if ($users[$i].username -ieq $Username) { $existingIndex = $i; break }
    }

    $record = [pscustomobject][ordered]@{
        username    = $Username
        role        = $Role
        enabled     = $Enabled
        displayName = $DisplayName
    }

    if ($existingIndex -ge 0) {
        $users[$existingIndex] = $record
    } else {
        $users += $record
    }

    $security.users = $users
    Save-Security -RootDir $RootDir -Security $security
}

function Remove-SecurityUser {
    param(
        [Parameter(Mandatory = $true)][string]$RootDir,
        [Parameter(Mandatory = $true)][string]$Username
    )

    $security = Get-Security -RootDir $RootDir
    $security.users = @(@($security.users) | Where-Object { $_.username -ine $Username })
    Save-Security -RootDir $RootDir -Security $security
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
    Get-Security, Save-Security, Get-DefaultSecurity, `
    Test-AdCredentials, `
    Get-ValidRoles, Test-RoleCanManageUsers, Test-RoleCanRunFlow, `
    Get-SecurityUsers, Find-SecurityUser, Test-IsLastEnabledAdmin, Add-OrUpdateSecurityUser, Remove-SecurityUser, `
    New-Session, Get-SessionUser, Remove-Session, `
    Write-SecurityLog
