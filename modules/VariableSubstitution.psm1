# Reemplaza placeholders {{variable}} dentro de un template usando un hashtable de variables.
# Recorre los matches en orden inverso para poder empalmar el string sin invalidar índices.

function Expand-Template {
    param(
        [string]$Template,
        [hashtable]$Variables
    )

    if ([string]::IsNullOrEmpty($Template)) {
        return $Template
    }

    $pattern = [regex]'\{\{\s*(\w+)\s*\}\}'
    $result = $Template
    $foundMatches = $pattern.Matches($Template)

    for ($i = $foundMatches.Count - 1; $i -ge 0; $i--) {
        $m = $foundMatches[$i]
        $key = $m.Groups[1].Value
        if ($Variables.ContainsKey($key)) {
            $value = [string]$Variables[$key]
            $result = $result.Substring(0, $m.Index) + $value + $result.Substring($m.Index + $m.Length)
        }
    }

    return $result
}

Export-ModuleMember -Function Expand-Template
