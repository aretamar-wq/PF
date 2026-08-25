# Navegación simple de JSON por notación de puntos con índices de array opcionales,
# ej: "data.accounts[0].balance". Equivalente al JsonPathExtractor de la versión WPF.

function Get-JsonPathValue {
    param(
        [Parameter(Mandatory = $true)] $Data,
        [Parameter(Mandatory = $true)] [string]$Path
    )

    $current = $Data

    foreach ($rawSegment in $Path -split '\.') {
        if ($null -eq $current) { return $null }

        if ($rawSegment -notmatch '^([^\[\]]+)(\[(\d+)\])?$') {
            return $null
        }

        $propertyName = $Matches[1]
        $hasIndex = $Matches[2]
        $index = $Matches[3]

        if ($current -is [System.Collections.IDictionary]) {
            if (-not $current.Contains($propertyName)) { return $null }
            $current = $current[$propertyName]
        } else {
            $prop = $current.PSObject.Properties[$propertyName]
            if ($null -eq $prop) { return $null }
            $current = $prop.Value
        }

        if ($hasIndex) {
            if ($null -eq $current) { return $null }
            $i = [int]$index
            $items = @($current)
            if ($i -ge $items.Count) { return $null }
            $current = $items[$i]
        }
    }

    return $current
}

Export-ModuleMember -Function Get-JsonPathValue
