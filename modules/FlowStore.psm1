# Lee todos los flows (*.json) de la carpeta Flows/. Cada archivo se lee de forma
# independiente: si uno tiene un JSON inválido, se ignora y se avisa por consola en
# vez de tirar abajo el resto de los flows. Un flow con "enabled": false en su JSON
# se salta por completo (no aparece en la lista ni se puede ejecutar por nombre) —
# útil para dejar guardados en el repo flows de ejemplo/en desuso sin que estorben.

function Get-Flows {
    param([Parameter(Mandatory = $true)][string]$FlowsDir)

    $flows = @()
    if (-not (Test-Path $FlowsDir)) {
        return $flows
    }

    $files = Get-ChildItem -Path $FlowsDir -Filter '*.json' | Sort-Object Name
    foreach ($file in $files) {
        try {
            $json = Get-Content -Path $file.FullName -Raw -Encoding UTF8
            $flow = $json | ConvertFrom-Json
            if ($null -ne $flow -and $flow.enabled -ne $false) {
                $flows += $flow
            }
        } catch {
            Write-Warning "No se pudo leer el flow '$($file.Name)': $($_.Exception.Message)"
        }
    }

    return $flows
}

Export-ModuleMember -Function Get-Flows
