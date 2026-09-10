# Cifra/descifra campos sensibles guardados en MariaDB (contraseña de
# Sybase en Parametría, client_id/client_secret/client_cert_passphrase en
# Perfiles) con AES-256-GCM — mismo algoritmo, mismo formato de
# almacenamiento y la misma clave que node/lib/cryptoUtil.js, así que un
# valor cifrado por un backend lo puede descifrar el otro sin problema.
#
# .NET Framework (Windows PowerShell 5.1) no tiene ninguna clase de AES-GCM
# en la BCL (existe en .NET moderno vía System.Security.Cryptography.AesGcm,
# pero no en .NET Framework) — se usa BouncyCastle.Cryptography (librería
# .NET vendorizada en modules/lib/, ver "Base de datos (MariaDB)" en el
# README) en los dos runtimes (Desktop y Core) para tener un solo código de
# cifrado, en vez de dos implementaciones distintas según la edición de
# PowerShell.
#
# Formato guardado: "<iv hex>:<authTag hex>:<ciphertext hex>", igual que
# cryptoUtil.js — IV de 12 bytes (recomendado para GCM, no 16 como CBC),
# al azar en cada llamada a Protect-CryptoValue (cifrar el mismo valor dos
# veces dos veces da un resultado distinto cada vez, a propósito).

$script:CryptoAssembliesLoaded = $false

function Import-CryptoAssemblies {
    if ($script:CryptoAssembliesLoaded) { return }

    $libDir = if ($PSVersionTable.PSEdition -eq 'Core') {
        Join-Path $PSScriptRoot 'lib/core'
    } else {
        Join-Path $PSScriptRoot 'lib/desktop'
    }

    Add-Type -Path (Join-Path $libDir 'BouncyCastle.Cryptography.dll') -ErrorAction Stop
    $script:CryptoAssembliesLoaded = $true
}

function ConvertFrom-HexStringToBytes {
    param([Parameter(Mandatory = $true)][string]$Hex)

    if ($Hex.Length % 2 -ne 0) {
        throw 'Cadena hexadecimal de longitud impar.'
    }
    $bytes = [byte[]]::new($Hex.Length / 2)
    for ($i = 0; $i -lt $bytes.Length; $i++) {
        $bytes[$i] = [Convert]::ToByte($Hex.Substring($i * 2, 2), 16)
    }
    return $bytes
}

function ConvertTo-HexStringFromBytes {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    return -join ($Bytes | ForEach-Object { $_.ToString('x2') })
}

function Get-CryptoKeyBytes {
    param([Parameter(Mandatory = $true)][string]$HexKey)

    $bytes = ConvertFrom-HexStringToBytes -Hex $HexKey
    if ($bytes.Length -ne 32) {
        throw ('La clave de cifrado (encryptionKey en db.local.json) tiene que ser exactamente 32 bytes en ' +
               'hexadecimal (64 caracteres) — ver "Base de datos (MariaDB)" en el README para cómo generarla.')
    }
    return $bytes
}

# IV de 12 bytes (96 bits) — tamaño recomendado para GCM (evita el paso
# extra de derivación de IV que hace GCM con otros tamaños), mismo criterio
# que cryptoUtil.js.
$script:GcmIvLength = 12
$script:GcmTagLengthBits = 128

function Protect-CryptoValue {
    param(
        [string]$PlainText,
        [Parameter(Mandatory = $true)][string]$HexKey
    )

    if ([string]::IsNullOrEmpty($PlainText)) { return '' }

    Import-CryptoAssemblies
    $keyBytes = Get-CryptoKeyBytes -HexKey $HexKey

    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $iv = [byte[]]::new($script:GcmIvLength)
    try { $rng.GetBytes($iv) } finally { $rng.Dispose() }

    $plainBytes = [System.Text.Encoding]::UTF8.GetBytes($PlainText)

    $keyParam = [Org.BouncyCastle.Crypto.Parameters.KeyParameter]::new($keyBytes)
    $gcmParams = [Org.BouncyCastle.Crypto.Parameters.AeadParameters]::new($keyParam, $script:GcmTagLengthBits, $iv)
    $cipher = [Org.BouncyCastle.Crypto.Modes.GcmBlockCipher]::new([Org.BouncyCastle.Crypto.Engines.AesEngine]::new())
    $cipher.Init($true, $gcmParams)

    $outBuf = [byte[]]::new($cipher.GetOutputSize($plainBytes.Length))
    $len = $cipher.ProcessBytes($plainBytes, 0, $plainBytes.Length, $outBuf, 0)
    $len += $cipher.DoFinal($outBuf, $len)

    $tagLength = $script:GcmTagLengthBits / 8
    $ciphertext = $outBuf[0..($len - $tagLength - 1)]
    $authTag = $outBuf[($len - $tagLength)..($len - 1)]

    return (ConvertTo-HexStringFromBytes -Bytes $iv) + ':' + (ConvertTo-HexStringFromBytes -Bytes $authTag) + ':' + (ConvertTo-HexStringFromBytes -Bytes $ciphertext)
}

function Unprotect-CryptoValue {
    param(
        [string]$Stored,
        [Parameter(Mandatory = $true)][string]$HexKey
    )

    if ([string]::IsNullOrEmpty($Stored)) { return '' }

    $parts = $Stored.Split(':')
    if ($parts.Count -ne 3) {
        throw 'El valor cifrado en la base tiene un formato inválido (se esperaba "iv:authTag:ciphertext").'
    }

    Import-CryptoAssemblies
    $keyBytes = Get-CryptoKeyBytes -HexKey $HexKey
    $iv = ConvertFrom-HexStringToBytes -Hex $parts[0]
    $authTag = ConvertFrom-HexStringToBytes -Hex $parts[1]
    $ciphertext = ConvertFrom-HexStringToBytes -Hex $parts[2]

    $keyParam = [Org.BouncyCastle.Crypto.Parameters.KeyParameter]::new($keyBytes)
    $gcmParams = [Org.BouncyCastle.Crypto.Parameters.AeadParameters]::new($keyParam, $script:GcmTagLengthBits, $iv)
    $cipher = [Org.BouncyCastle.Crypto.Modes.GcmBlockCipher]::new([Org.BouncyCastle.Crypto.Engines.AesEngine]::new())
    $cipher.Init($false, $gcmParams)

    # GcmBlockCipher espera el authTag pegado al final del ciphertext para
    # descifrar (Node/cryptoUtil.js los guarda por separado en el string
    # "iv:authTag:ciphertext" — se concatenan acá antes de pasarlos al
    # cifrador, no es un cambio de formato, solo cómo se arma el buffer que
    # entiende BouncyCastle).
    $combined = $ciphertext + $authTag
    $outBuf = [byte[]]::new($cipher.GetOutputSize($combined.Length))
    $len = $cipher.ProcessBytes($combined, 0, $combined.Length, $outBuf, 0)
    $len += $cipher.DoFinal($outBuf, $len)

    return [System.Text.Encoding]::UTF8.GetString($outBuf, 0, $len)
}

Export-ModuleMember -Function Protect-CryptoValue, Unprotect-CryptoValue
