# Lee todos los flows (*.json) de la carpeta Flows/. Cada archivo se lee de forma
# independiente: si uno tiene un JSON inválido, se ignora y se avisa por consola en
# vez de tirar abajo el resto de los flows.

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
            if ($null -ne $flow) {
                $flows += $flow
            }
        } catch {
            Write-Warning "No se pudo leer el flow '$($file.Name)': $($_.Exception.Message)"
        }
    }

    return $flows
}

Export-ModuleMember -Function Get-Flows
