param(
    [string]$Bl94Path = (Join-Path $PSScriptRoot 'bl94.ps1'),
    [int]$PollIntervalMs = 50,
    [string]$ListenPrefix = 'http://127.0.0.1:17894/'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$serviceDomainsPattern = '(?:qobuz\.com|tidal\.com|deezer\.com|beatport\.com|music\.apple\.com)'
# Stop at whitespace, HTML tag delimiters, double quotes, or backticks so panel text/HTML does not bleed into the URL.
# Use a hex escape for the backtick to keep the PowerShell string quoting unambiguous.
$serviceUrlPattern = '(?i)https?://(?:[A-Za-z0-9-]+\.)*{0}(?:/[^\s<>\x60"]*)?' -f $serviceDomainsPattern
$seenUrlExpiry = [TimeSpan]::FromHours(6)
$seenUrlCleanupInterval = [TimeSpan]::FromMinutes(1)
$nextSeenUrlCleanupUtc = [DateTime]::UtcNow.Add($seenUrlCleanupInterval)
$trailingDelimiterPairs = @(@('(', ')'), @('[', ']'), @('{', '}'))
$seenUrls = @{}
$queuedUrls = [System.Collections.Queue]::new()
$activeBl94 = $null
$activeBridgeItem = $null

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

function ConvertTo-JsonResponse {
    param(
        [string]$Status,
        [string]$Message
    )

    return (@{ status = $Status; message = $Message } | ConvertTo-Json -Compress)
}

function Write-BridgeResponse {
    param(
        [System.Net.HttpListenerContext]$Context,
        [int]$StatusCode,
        [string]$Body
    )

    $response = $Context.Response
    $response.StatusCode = $StatusCode
    $response.ContentType = 'application/json; charset=utf-8'
    $response.Headers['Access-Control-Allow-Origin'] = '*'
    $response.Headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    $response.Headers['Access-Control-Allow-Headers'] = 'Content-Type'

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
    $response.ContentLength64 = $bytes.Length
    $response.OutputStream.Write($bytes, 0, $bytes.Length)
    $response.OutputStream.Close()
}

function Get-RequestBody {
    param([System.Net.HttpListenerRequest]$Request)

    if (-not $Request.HasEntityBody) { return '' }

    $encoding = $Request.ContentEncoding
    if (-not $encoding) { $encoding = [System.Text.Encoding]::UTF8 }

    $reader = [System.IO.StreamReader]::new($Request.InputStream, $encoding)
    try {
        return $reader.ReadToEnd()
    } finally {
        $reader.Dispose()
    }
}

function Parse-BridgeTimestamp {
    param([string]$Value)

    if (-not $Value) { return $null }

    $parsed = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse($Value, [ref]$parsed)) {
        return $parsed.UtcDateTime
    }

    return $null
}

function Get-BridgePayloadFromRequest {
    param([System.Net.HttpListenerRequest]$Request)

    $body = Get-RequestBody $Request
    $payload = [ordered]@{
        Url         = $null
        Source      = ''
        SendSource  = ''
        ServiceLabel = ''
        SentAtUtc   = $null
        FirstSeenAtUtc = $null
        EnqueuedUtc = $null
        AttemptIndex = $null
        RawBodyLength = ($body | ForEach-Object { [string]$_ }).Length
    }

    if (-not $body) {
        return [pscustomobject]$payload
    }

    $contentType = [string]$Request.ContentType
    if ($contentType -match '(?i)application/json') {
        try {
            $json = $body | ConvertFrom-Json
            $payload.Url = Get-MusicServiceUrlFromText ([string]$json.url)
            $payload.Source = [string]$json.source
            $payload.SendSource = [string]$json.sendSource
            $payload.ServiceLabel = [string]$json.serviceLabel
            $payload.SentAtUtc = Parse-BridgeTimestamp ([string]$json.sentAtUtc)
            $payload.FirstSeenAtUtc = Parse-BridgeTimestamp ([string]$json.firstSeenAtUtc)
            if ($null -ne $json.attemptIndex -and ([string]$json.attemptIndex -match '^\d+$')) {
                $payload.AttemptIndex = [int]$json.attemptIndex
            }
            return [pscustomobject]$payload
        } catch {
            $payload.Url = $null
            return [pscustomobject]$payload
        }
    }

    $payload.Url = Get-MusicServiceUrlFromText $body
    return [pscustomobject]$payload
}

function Add-BridgeUrl {
    param([pscustomobject]$Payload)

    $Url = [string]$Payload.Url

    if (-not $Url) { return 'ignored' }
    if ($seenUrls.ContainsKey($Url)) { return 'duplicate' }

    $seenUrls[$Url] = [DateTime]::UtcNow

    # Keep only the newest pending URL while bl94 is busy.
    # This avoids long delays caused by stale queued URLs.
    if ($activeBl94 -and $queuedUrls.Count -gt 0) {
        while ($queuedUrls.Count -gt 0) {
            [void]$queuedUrls.Dequeue()
        }
    }

    $payload.EnqueuedUtc = [DateTime]::UtcNow
    $queuedUrls.Enqueue($payload)
    return 'queued'
}

function Get-PowerShellHostPath {
    $command = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $command = Get-Command powershell -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    return $null
}

function ConvertTo-ProcessArgumentString {
    param([string[]]$Arguments)

    $quotedArguments = foreach ($argument in $Arguments) {
        if ($null -eq $argument) {
            '""'
        } elseif ($argument -notmatch '[\s"]' -and $argument.Length -gt 0) {
            $argument
        } else {
            # Follow Windows command-line escaping rules: double backslashes before quotes and at the end of quoted arguments.
            '"' + (($argument -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
        }
    }

    return ($quotedArguments -join ' ')
}

function Start-Bl94Process {
    param([string]$Url)

    $powerShellHost = Get-PowerShellHostPath
    if (-not $powerShellHost) {
        throw 'Could not find pwsh or powershell to launch bl94.ps1.'
    }

    Write-Host ("[Bridge] Starting bl94 for URL: {0}" -f $Url) -ForegroundColor Green

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $powerShellHost
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $false

    $startInfo.Arguments = ConvertTo-ProcessArgumentString @('-NoProfile', '-File', $Bl94Path, '-InitialInput', $Url, '-Once')

    return [System.Diagnostics.Process]::Start($startInfo)
}

function Invoke-SeenUrlCleanup {
    $nowUtc = [DateTime]::UtcNow
    if ($seenUrls.Count -gt 0 -and $nowUtc -ge $script:nextSeenUrlCleanupUtc) {
        $expirationThreshold = $nowUtc.Subtract($seenUrlExpiry)
        $expiredUrls = @($seenUrls.Keys | Where-Object { $seenUrls[$_] -lt $expirationThreshold })
        foreach ($url in $expiredUrls) {
            $seenUrls.Remove($url)
        }
        $script:nextSeenUrlCleanupUtc = $nowUtc.Add($seenUrlCleanupInterval)
    }
}

if (-not (Test-Path -LiteralPath $Bl94Path -PathType Leaf)) {
    throw "bl94.ps1 was not found at: $Bl94Path"
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($ListenPrefix)
$listener.Start()
$contextTask = $listener.GetContextAsync()

Write-Host 'Music service URL to bl94 bridge is running.' -ForegroundColor Yellow
Write-Host ("Listening for RED Purchase Links first-panel URLs at {0}bridge-url" -f $ListenPrefix) -ForegroundColor Yellow
Write-Host 'The clipboard is ignored. Press Ctrl+C to stop.' -ForegroundColor Yellow

try {
    while ($true) {
        try {
            if ($contextTask.AsyncWaitHandle.WaitOne($PollIntervalMs)) {
                do {
                    $context = $contextTask.GetAwaiter().GetResult()
                    $contextTask = $listener.GetContextAsync()

                    if ($context.Request.HttpMethod -eq 'OPTIONS') {
                        Write-BridgeResponse $context 204 ''
                    } elseif ($context.Request.HttpMethod -ne 'POST' -or $context.Request.Url.AbsolutePath -ne '/bridge-url') {
                        Write-BridgeResponse $context 404 (ConvertTo-JsonResponse 'not_found' 'Use POST /bridge-url.')
                    } else {
                        $receivedUtc = [DateTime]::UtcNow
                        $bridgePayload = Get-BridgePayloadFromRequest $context.Request
                        $queueStatus = Add-BridgeUrl $bridgePayload
                        Write-BridgeResponse $context 200 (ConvertTo-JsonResponse $queueStatus $queueStatus)

                        $receiveLagMs = $null
                        if ($bridgePayload.SentAtUtc) {
                            $receiveLagMs = [int][Math]::Round($receivedUtc.Subtract($bridgePayload.SentAtUtc).TotalMilliseconds)
                        }
                        $discoveryLagMs = $null
                        if ($bridgePayload.FirstSeenAtUtc) {
                            $discoveryLagMs = [int][Math]::Round($receivedUtc.Subtract($bridgePayload.FirstSeenAtUtc).TotalMilliseconds)
                        }

                        $attemptLabel = if ($null -ne $bridgePayload.AttemptIndex) { [string]$bridgePayload.AttemptIndex } else { '-' }
                        $lagLabel = if ($null -ne $receiveLagMs) { "$receiveLagMs ms" } else { 'n/a' }
                        $discoveryLagLabel = if ($null -ne $discoveryLagMs) { "$discoveryLagMs ms" } else { 'n/a' }
                        $activeState = if ($activeBl94) { 'busy' } else { 'idle' }

                        Write-Host ("[Bridge][recv {0}] status={1} active={2} queue={3} service={4} sendSource={5} attempt={6} sendLag={7} firstSeenLag={8} url={9}" -f $receivedUtc.ToString('HH:mm:ss.fff'), $queueStatus, $activeState, $queuedUrls.Count, $bridgePayload.ServiceLabel, $bridgePayload.SendSource, $attemptLabel, $lagLabel, $discoveryLagLabel, $bridgePayload.Url) -ForegroundColor Cyan
                    }
                } while ($contextTask.AsyncWaitHandle.WaitOne(0))
            }

            if ($activeBl94 -and $activeBl94.HasExited) {
                if ($activeBridgeItem) {
                    Write-Host ("[Bridge][done {0}] exit={1} url={2}" -f ([DateTime]::UtcNow.ToString('HH:mm:ss.fff')), $activeBl94.ExitCode, $activeBridgeItem.Url) -ForegroundColor Yellow
                } else {
                    Write-Host ("[Bridge][done {0}] exit={1}" -f ([DateTime]::UtcNow.ToString('HH:mm:ss.fff')), $activeBl94.ExitCode) -ForegroundColor Yellow
                }
                $activeBl94.Dispose()
                $activeBl94 = $null
                $activeBridgeItem = $null
            }

            if (-not $activeBl94 -and $queuedUrls.Count -gt 0) {
                $nextItem = $queuedUrls.Dequeue()
                $nextUrl = [string]$nextItem.Url
                $activeBridgeItem = $nextItem

                $startLagMs = $null
                if ($nextItem.SentAtUtc) {
                    $startLagMs = [int][Math]::Round(([DateTime]::UtcNow).Subtract($nextItem.SentAtUtc).TotalMilliseconds)
                }
                $firstSeenLagMs = $null
                if ($nextItem.FirstSeenAtUtc) {
                    $firstSeenLagMs = [int][Math]::Round(([DateTime]::UtcNow).Subtract($nextItem.FirstSeenAtUtc).TotalMilliseconds)
                }
                $queueWaitMs = $null
                if ($nextItem.EnqueuedUtc) {
                    $queueWaitMs = [int][Math]::Round(([DateTime]::UtcNow).Subtract($nextItem.EnqueuedUtc).TotalMilliseconds)
                }
                $startLagLabel = if ($null -ne $startLagMs) { "$startLagMs ms" } else { 'n/a' }
                $firstSeenLagLabel = if ($null -ne $firstSeenLagMs) { "$firstSeenLagMs ms" } else { 'n/a' }
                $queueWaitLabel = if ($null -ne $queueWaitMs) { "$queueWaitMs ms" } else { 'n/a' }
                Write-Host ("[Bridge][start {0}] queueWait={1} sendLag={2} firstSeenLag={3} url={4}" -f ([DateTime]::UtcNow.ToString('HH:mm:ss.fff')), $queueWaitLabel, $startLagLabel, $firstSeenLagLabel, $nextUrl) -ForegroundColor Green

                $activeBl94 = Start-Bl94Process $nextUrl
            }

            Invoke-SeenUrlCleanup
        } catch {
            Write-Host ("[Bridge] {0}" -f $_) -ForegroundColor Red
        }
    }
} finally {
    if ($listener.IsListening) { $listener.Stop() }
    $listener.Close()
}
