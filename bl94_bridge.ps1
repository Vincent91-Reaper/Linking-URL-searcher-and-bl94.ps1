param(
    [string]$Bl94Path = (Join-Path $PSScriptRoot 'bl94.ps1'),
    [int]$PollIntervalMs = 500
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$serviceUrlPattern = '(?i)^https?://(?:www\.)?(?:qobuz\.com|tidal\.com|listen\.tidal\.com|deezer\.com|beatport\.com|music\.apple\.com)/'
$lastClipboard = $null
$seenUrls = @{}

if (-not (Test-Path -LiteralPath $Bl94Path -PathType Leaf)) {
    throw "bl94.ps1 was not found at: $Bl94Path"
}

Write-Host 'Music service URL -> bl94 bridge is running.' -ForegroundColor Yellow
Write-Host 'Copy a Qobuz, Tidal, Deezer, Apple Music, or Beatport URL to start bl94 automatically.' -ForegroundColor Yellow
Write-Host 'Press Ctrl+C to stop.' -ForegroundColor Yellow

while ($true) {
    try {
        $clipboard = Get-Clipboard -Raw -ErrorAction SilentlyContinue
        if ($clipboard -and $clipboard -ne $lastClipboard) {
            $candidate = $clipboard.Trim()

            if ($candidate -match $serviceUrlPattern -and -not $seenUrls.ContainsKey($candidate)) {
                $seenUrls[$candidate] = [DateTime]::UtcNow
                Write-Host ("[Bridge] Sending URL to bl94: {0}" -f $candidate) -ForegroundColor Green
                & $Bl94Path -InitialInput $candidate -Once
                Write-Host '[Bridge] Waiting for the next copied URL...' -ForegroundColor Yellow
            }

            $lastClipboard = $clipboard
        }

        $expiredUrls = @($seenUrls.Keys | Where-Object { $seenUrls[$_] -lt [DateTime]::UtcNow.AddHours(-6) })
        foreach ($url in $expiredUrls) {
            $seenUrls.Remove($url)
        }
    } catch {
        Write-Host ("[Bridge] {0}" -f $_) -ForegroundColor Red
    }

    Start-Sleep -Milliseconds $PollIntervalMs
}
