param(
    [string]$Bl94Path = (Join-Path $PSScriptRoot 'bl94.ps1'),
    [int]$PollIntervalMs = 500,
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

function Get-UrlFromBridgeRequest {
    param([System.Net.HttpListenerRequest]$Request)

    $body = Get-RequestBody $Request
    if (-not $body) { return $null }

    $contentType = [string]$Request.ContentType
    if ($contentType -match '(?i)application/json') {
        try {
            $payload = $body | ConvertFrom-Json
            return Get-MusicServiceUrlFromText ([string]$payload.url)
        } catch {
            return $null
        }
    }

    return Get-MusicServiceUrlFromText $body
}

function Add-BridgeUrl {
    param([string]$Url)

    if (-not $Url) { return 'ignored' }
    if ($seenUrls.ContainsKey($Url)) { return 'duplicate' }

    $seenUrls[$Url] = [DateTime]::UtcNow
    $queuedUrls.Enqueue($Url)
    return 'queued'
}

function Get-PowerShellHostPath {
    $command = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $command = Get-Command powershell -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    return $null
}

function Quote-CommandLineArgument {
    param([string]$Value)

    if ($null -eq $Value) { return '""' }
    return '"{0}"' -f ($Value -replace '"', '\"')
}

function Start-Bl94Process {
    param([string]$Url)

    $powerShellHost = Get-PowerShellHostPath
    if (-not $powerShellHost) {
        throw 'Could not find pwsh or powershell to launch bl94.ps1.'
    }

    $arguments = @(
        '-NoProfile',
        '-File',
        (Quote-CommandLineArgument $Bl94Path),
        '-InitialInput',
        (Quote-CommandLineArgument $Url),
        '-Once'
    )

    Write-Host ("[Bridge] Starting bl94 for URL: {0}" -f $Url) -ForegroundColor Green
    return Start-Process -FilePath $powerShellHost -ArgumentList $arguments -NoNewWindow -PassThru
}

function Invoke-SeenUrlCleanup {
    $nowUtc = [DateTime]::UtcNow
    if ($seenUrls.Count -gt 0 -and $nowUtc -ge $script:nextSeenUrlCleanupUtc) {
        $expirationThreshold = $nowUtc.Subtract($seenUrlExpiry)
        foreach ($url in ($seenUrls.Keys | Where-Object { $seenUrls[$_] -lt $expirationThreshold })) {
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
                $context = $contextTask.GetAwaiter().GetResult()
                $contextTask = $listener.GetContextAsync()

                if ($context.Request.HttpMethod -eq 'OPTIONS') {
                    Write-BridgeResponse $context 204 ''
                } elseif ($context.Request.HttpMethod -ne 'POST' -or $context.Request.Url.AbsolutePath -ne '/bridge-url') {
                    Write-BridgeResponse $context 404 (ConvertTo-JsonResponse 'not_found' 'Use POST /bridge-url.')
                } else {
                    $candidate = Get-UrlFromBridgeRequest $context.Request
                    $queueStatus = Add-BridgeUrl $candidate
                    Write-BridgeResponse $context 200 (ConvertTo-JsonResponse $queueStatus $queueStatus)

                    if ($queueStatus -eq 'queued') {
                        Write-Host ("[Bridge] Queued URL from RED Purchase Links first panel: {0}" -f $candidate) -ForegroundColor Green
                    }
                }
            }

            if ($activeBl94 -and $activeBl94.HasExited) {
                Write-Host ("[Bridge] bl94 exited with code {0}." -f $activeBl94.ExitCode) -ForegroundColor Yellow
                $activeBl94.Dispose()
                $activeBl94 = $null
            }

            if (-not $activeBl94 -and $queuedUrls.Count -gt 0) {
                $nextUrl = [string]$queuedUrls.Dequeue()
                $activeBl94 = Start-Bl94Process $nextUrl
            }

            Invoke-SeenUrlCleanup
        } catch {
            Write-Host ("[Bridge] {0}" -f $_) -ForegroundColor Red
        }
    }
} finally {
    if ($contextTask) { $contextTask.Dispose() }
    if ($listener.IsListening) { $listener.Stop() }
    $listener.Close()
}
