# Migra, una sola vez, los datos que hubiera en los archivos JSON locales
# (security.local.json, profiles.local.json, parametria.local.json,
# logs/processed-operations.json) a las tablas de MariaDB que los
# reemplazan — ver deploy/mariadb-schema.sql y "Base de datos (MariaDB)" en
# el README. Equivalente PowerShell de
# node/scripts/migrate-json-to-mariadb.js (mismo comportamiento) — para
# instalaciones que corren solo el backend PowerShell y no tienen Node.js.
#
# Uso (desde la raíz del repo, con db.local.json ya configurado y el schema
# ya aplicado contra la base):
#   pwsh modules/scripts/Migrate-JsonToMariaDb.ps1
#
# Es seguro correrlo más de una vez: usuarios/perfiles se upsertean por su
# clave (username/name), y las operaciones procesadas tienen UNIQUE KEY
# (cuit, numero_comprobante) — no duplica filas.

$ErrorActionPreference = 'Stop'

$rootDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$modulesDir = Join-Path $rootDir 'modules'

Import-Module (Join-Path $modulesDir 'MariaDbClient.psm1') -Force
Import-Module (Join-Path $modulesDir 'CryptoUtil.psm1') -Force
Import-Module (Join-Path $modulesDir 'SecurityStore.psm1') -Force
Import-Module (Join-Path $modulesDir 'ProfileStore.psm1') -Force
Import-Module (Join-Path $modulesDir 'ParametriaStore.psm1') -Force

function Read-JsonIfExists {
    param([Parameter(Mandatory = $true)][string]$FilePath)

    if (-not (Test-Path $FilePath)) { return $null }
    $text = Get-Content -Path $FilePath -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return $text | ConvertFrom-Json
}

function Invoke-MigrateSecurity {
    $filePath = Join-Path $rootDir 'security.local.json'
    $security = Read-JsonIfExists -FilePath $filePath
    if (-not $security) {
        Write-Host '- security.local.json: no existe o está vacío, nada para migrar.'
        return
    }

    if ($security.ad) {
        Save-AdConfig -RootDir $rootDir -AdConfig $security.ad
        Write-Host "- Configuración de AD migrada (server='$($security.ad.server)')."
    }

    $users = @($security.users)
    foreach ($user in $users) {
        Add-OrUpdateSecurityUser -RootDir $rootDir -Username $user.username -Role $user.role -Enabled ([bool]$user.enabled) -DisplayName ([string]$user.displayName)
    }
    Write-Host "- $($users.Count) usuario(s) migrado(s) desde security.local.json."
}

function Invoke-MigrateProfiles {
    $filePath = Join-Path $rootDir 'profiles.local.json'
    $profiles = Read-JsonIfExists -FilePath $filePath
    if (-not $profiles) {
        Write-Host '- profiles.local.json: no existe o está vacío, nada para migrar.'
        return
    }

    $array = @($profiles)
    $incomingNames = @($array | ForEach-Object { $_.name })
    $existing = @(Get-Profiles -RootDir $rootDir)
    $merged = @($existing | Where-Object { $_.name -notin $incomingNames }) + $array
    Save-Profiles -RootDir $rootDir -Profiles $merged
    Write-Host "- $($array.Count) perfil(es) migrado(s) desde profiles.local.json."
}

function Invoke-MigrateParametria {
    $filePath = Join-Path $rootDir 'parametria.local.json'
    $parametria = Read-JsonIfExists -FilePath $filePath
    if (-not $parametria) {
        Write-Host '- parametria.local.json: no existe o está vacío, nada para migrar.'
        return
    }
    Save-Parametria -RootDir $rootDir -Parametria $parametria
    Write-Host '- Parametría migrada desde parametria.local.json.'
}

function Invoke-MigrateProcessedOperations {
    $filePath = Join-Path (Join-Path $rootDir 'logs') 'processed-operations.json'
    $operations = Read-JsonIfExists -FilePath $filePath
    if (-not $operations) {
        Write-Host '- logs/processed-operations.json: no existe o está vacío, nada para migrar.'
        return
    }

    $array = @($operations)
    $migrated = 0
    foreach ($op in $array) {
        # INSERT directo (no Add-ProcessedOperations, que pisa processedAt/
        # processedBy con el momento de la migración) — se conserva la fecha
        # y el usuario originales tal cual estaban en el archivo.
        Invoke-DbNonQuery -RootDir $rootDir -Sql @'
INSERT INTO operaciones_procesadas (cuit, numero_comprobante, id_mensaje, processed_at, processed_by)
VALUES (?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE id = id
'@ -Params @([string]$op.cuit, [string]$op.numeroComprobante, [string]$op.idMensaje, $op.processedAt, [string]$op.processedBy) | Out-Null
        $migrated++
    }
    Write-Host "- $migrated operación(es) procesada(s) migrada(s) desde logs/processed-operations.json."
}

Write-Host "Migrando datos locales de $rootDir a MariaDB...`n"
Invoke-MigrateSecurity
Invoke-MigrateProfiles
Invoke-MigrateParametria
Invoke-MigrateProcessedOperations
Write-Host "`nListo. Los archivos *.local.json originales NO se borraron ni se modificaron —"
Write-Host 'podés revisarlos y borrarlos a mano una vez que confirmes que la app funciona bien contra MariaDB.'
