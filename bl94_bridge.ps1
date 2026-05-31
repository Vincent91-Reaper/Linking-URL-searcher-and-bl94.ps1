param(
    [string]$Bl94Path = (Join-Path $PSScriptRoot 'bl94.ps1'),
    [int]$PollIntervalMs = 500
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$serviceDomainsPattern = '(?:qobuz\.com|tidal\.com|deezer\.com|beatport\.com|music\.apple\.com)'
# Stop at whitespace, HTML tag delimiters, quotes, or backticks so copied panel text/HTML does not bleed into the URL.
$serviceUrlPattern = '(?i)https?://(?:[A-Za-z0-9-]+\.)*{0}(?:/[^\s<>\x27\x60"]*)?' -f $serviceDomainsPattern
$seenUrlExpiry = [TimeSpan]::FromHours(6)
$seenUrlCleanupInterval = [TimeSpan]::FromMinutes(1)
$nextSeenUrlCleanupUtc = [DateTime]::UtcNow.Add($seenUrlCleanupInterval)
$trailingDelimiterPairs = @(@('(', ')'), @('[', ']'), @('{', '}'))
$lastClipboard = $null
$seenUrls = @{}

function Remove-UnmatchedTrailingDelimiter {
    param(
        [string]$Value,
        [char]$OpenDelimiter,
        [char]$CloseDelimiter
    )

    if (-not $Value) { return $Value }

    $openCount = 0
    $closeCount = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq $OpenDelimiter) {
            $openCount += 1
        } elseif ($ch -eq $CloseDelimiter) {
            $closeCount += 1
        }
    }

    while ($Value.EndsWith([string]$CloseDelimiter) -and $closeCount -gt $openCount) {
        $Value = $Value.Substring(0, $Value.Length - 1)
        $closeCount -= 1
    }

    return $Value
}

function Get-MusicServiceUrlFromText {
    param([string]$Text)

    if (-not $Text) { return $null }

    $match = [regex]::Match($Text, $serviceUrlPattern)
    if (-not $match.Success) { return $null }

    $url = $match.Value
    foreach ($delimiterPair in $trailingDelimiterPairs) {
        $url = Remove-UnmatchedTrailingDelimiter $url $delimiterPair[0] $delimiterPair[1]
    }

    return $url
}

if (-not (Test-Path -LiteralPath $Bl94Path -PathType Leaf)) {
    throw "bl94.ps1 was not found at: $Bl94Path"
}

Write-Host 'Music service URL to bl94 bridge is running.' -ForegroundColor Yellow
Write-Host 'Copy a Qobuz, Tidal, Deezer, Apple Music, or Beatport URL to start bl94 automatically.' -ForegroundColor Yellow
Write-Host 'Press Ctrl+C to stop.' -ForegroundColor Yellow

while ($true) {
    try {
        $clipboard = Get-Clipboard -Raw -ErrorAction SilentlyContinue
        if ($clipboard -and $clipboard -ne $lastClipboard) {
            $candidate = Get-MusicServiceUrlFromText $clipboard

            if ($candidate -and -not $seenUrls.ContainsKey($candidate)) {
                $seenUrls[$candidate] = [DateTime]::UtcNow
                Write-Host ("[Bridge] Sending URL to bl94: {0}" -f $candidate) -ForegroundColor Green
                & $Bl94Path -InitialInput $candidate -Once
                Write-Host '[Bridge] Waiting for the next copied URL...' -ForegroundColor Yellow
            }

            $lastClipboard = $clipboard
        }

        $nowUtc = [DateTime]::UtcNow
        if ($seenUrls.Count -gt 0 -and $nowUtc -ge $nextSeenUrlCleanupUtc) {
            $expirationThreshold = $nowUtc.Subtract($seenUrlExpiry)
            [string[]]$expiredUrls = $seenUrls.Keys | Where-Object { $seenUrls[$_] -lt $expirationThreshold }
            foreach ($url in $expiredUrls) {
                $seenUrls.Remove($url)
            }
            $nextSeenUrlCleanupUtc = $nowUtc.Add($seenUrlCleanupInterval)
        }
    } catch {
        Write-Host ("[Bridge] {0}" -f $_) -ForegroundColor Red
    }

    Start-Sleep -Milliseconds $PollIntervalMs
}
