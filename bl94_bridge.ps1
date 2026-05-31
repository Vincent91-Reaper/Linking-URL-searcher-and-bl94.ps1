param(
    [string]$Bl94Path = (Join-Path $PSScriptRoot 'bl94.ps1'),
    [int]$PollIntervalMs = 500
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$serviceUrlPattern = "(?i)https?://(?:[A-Za-z0-9-]+\.)*(?:qobuz\.com|tidal\.com|deezer\.com|beatport\.com|music\.apple\.com)(?:/[^\s<>`"']*)?"
$seenUrlExpiry = [TimeSpan]::FromHours(6)
$lastClipboard = $null
$seenUrls = @{}

function Get-MusicServiceUrlFromText {
    param([string]$Text)

    if (-not $Text) { return $null }

    $match = [regex]::Match($Text, $serviceUrlPattern)
    if (-not $match.Success) { return $null }

    $url = $match.Value.TrimEnd('.', ',', ';')

    while ($url.EndsWith(')') -and (($url.ToCharArray() | Where-Object { $_ -eq ')' }).Count -gt ($url.ToCharArray() | Where-Object { $_ -eq '(' }).Count)) {
        $url = $url.Substring(0, $url.Length - 1)
    }

    while ($url.EndsWith(']') -and (($url.ToCharArray() | Where-Object { $_ -eq ']' }).Count -gt ($url.ToCharArray() | Where-Object { $_ -eq '[' }).Count)) {
        $url = $url.Substring(0, $url.Length - 1)
    }

    while ($url.EndsWith('}') -and (($url.ToCharArray() | Where-Object { $_ -eq '}' }).Count -gt ($url.ToCharArray() | Where-Object { $_ -eq '{' }).Count)) {
        $url = $url.Substring(0, $url.Length - 1)
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

        $expiredUrls = @($seenUrls.Keys | Where-Object { $seenUrls[$_] -lt [DateTime]::UtcNow.Subtract($seenUrlExpiry) })
        foreach ($url in $expiredUrls) {
            $seenUrls.Remove($url)
        }
    } catch {
        Write-Host ("[Bridge] {0}" -f $_) -ForegroundColor Red
    }

    Start-Sleep -Milliseconds $PollIntervalMs
}
