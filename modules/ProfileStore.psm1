# Lee/escribe profiles.local.json (perfiles de conexión con sus credenciales).
# Este archivo nunca se versiona: contiene client secrets / tokens en texto plano.

function Get-ProfilesFilePath {
    param([Parameter(Mandatory = $true)][string]$RootDir)
    return Join-Path $RootDir 'profiles.local.json'
}

function Get-Profiles {
    param([Parameter(Mandatory = $true)][string]$RootDir)

    $path = Get-ProfilesFilePath -RootDir $RootDir
    if (-not (Test-Path $path)) {
        return @()
    }

    $json = Get-Content -Path $path -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($json)) {
        return @()
    }

    $profiles = $json | ConvertFrom-Json
    if ($null -eq $profiles) { return @() }
    return @($profiles)
}

function Save-Profiles {
    param(
        [Parameter(Mandatory = $true)][string]$RootDir,
        [Parameter(Mandatory = $true)] $Profiles
    )

    $path = Get-ProfilesFilePath -RootDir $RootDir
    $array = @($Profiles)

    $json = if ($array.Count -eq 0) {
        '[]'
    } else {
        $rendered = $array | ConvertTo-Json -Depth 10
        if ($array.Count -eq 1) { "[$rendered]" } else { $rendered }
    }

    Set-Content -Path $path -Value $json -Encoding UTF8
}

Export-ModuleMember -Function Get-Profiles, Save-Profiles
