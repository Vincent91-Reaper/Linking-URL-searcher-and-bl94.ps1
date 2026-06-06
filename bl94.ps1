param(
    [string]$InitialInput = $null,
    [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ----------------- CONFIG (edit to match your environment) -----------------
$DestRoot = "D:\Music to upload to redacted"                      # Windows folder where downloaders write albums
$BeatportdlWSLDir = "/home/polsp/projects/beatportdlmodification" # WSL dir containing your beatportdl executable
$DeemixCliWSLDir = "/home/polsp/convert-deemix-gui-to-cli"        # WSL dir containing deemix-cli cli.js
$BeatportStreamLive = $true                                       # true = show live output in PS
$UseInteractiveWSL = $false                                       # true => open interactive WSL session (may re-prompt)
$BruceleeExe = "/home/polsp/.local/bin/brucelee94"
$BL94HelperWSLPath = "/home/polsp/bl94_helper.py"
# Base flags (common for all uploads)
$BruceleeUpBaseFlags = @('-s','WEB')
# Note: -ow flag removed per request
# ---------------------------------------------------------------------------

$script:IntroShown = $false

function Read-Bold {
    param([string]$Message)
    Write-Host ("{0}: " -f $Message) -ForegroundColor Cyan -NoNewline
    return Read-Host
}

function Get-AlbumFolder {
    try {
        $folder = Get-ChildItem -Directory -Path $DestRoot -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($folder) { return $folder.FullName } else { return $null }
    } catch { return $null }
}

function Get-NewAlbumFolderSince {
    param(
        [datetime]$StartUtc,
        [int]$TimeoutSeconds = 3
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)

    while ([DateTime]::UtcNow -lt $deadline) {
        $candidate = Get-AlbumFolder

        if ($candidate) {
            try {
                $item = Get-Item -LiteralPath $candidate
                $hasMusic = Get-ChildItem -LiteralPath $candidate -File -Recurse -Include *.flac, *.m4a -ErrorAction SilentlyContinue | Select-Object -First 1

                if ($item.LastWriteTimeUtc -gt $StartUtc) {
                    if ($hasMusic) {
                        return $candidate
                    }
                }
            } catch {}
        }

        Start-Sleep -Milliseconds 100
    }

    return $null
}

function Convert-ToWSLPath {
    param([string]$windowsPath)
    if (-not $windowsPath) { return $null }
    if ($windowsPath -match '^([A-Za-z]):\\(.*)$') {
        $drive = $matches[1].ToLower()
        $rest = $matches[2] -replace '\\','/'
        return "/mnt/$drive/$rest"
    } else {
        return ($windowsPath -replace '\\','/')
    }
}

function Convert-FromWSLPath {
    param([string]$wslPath)
    if (-not $wslPath) { return $null }
    if ($wslPath -match '^/mnt/([a-zA-Z])/(.*)$') {
        $drive = $matches[1].ToUpper()
        $rest = $matches[2] -replace '/','\'
        return "${drive}:\$rest"
    }
    return ($wslPath -replace '/','\')
}

function Test-WSLPath {
    param([string]$wslPath)
    & wsl -- test -d "$wslPath"
    return ($LASTEXITCODE -eq 0)
}

function Ensure-BruceleeExists {
    & wsl -- test -x $BruceleeExe
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'brucelee94 not found/executable at' $BruceleeExe 'inside WSL.' -ForegroundColor Red
        return $false
    }
    return $true
}

function Strip-BeatportRegion {
    param([string]$url)
    if (-not $url) { return $url }
    if ($url -match '^https?://www\.beatport\.com/([a-z]{2})/(.+)$') {
        return "https://www.beatport.com/$($matches[2])"
    }
    return $url
}

function Invoke-FlacConverterInWSL {
    param([string]$albumFolder)

    $scriptDir = $PSScriptRoot
    if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition }
    $converterScript = Join-Path $scriptDir 'flac_converter.ps1'

    if (-not (Test-Path -LiteralPath $converterScript)) {
        Write-Host "flac_converter.ps1 not found at $converterScript. Aborting to avoid uploading .m4a files." -ForegroundColor Red
        return $null
    }

    $converterWsl = Convert-ToWSLPath $converterScript
    $albumWsl = Convert-ToWSLPath $albumFolder
    $converterWslEsc = $converterWsl -replace "'", "'\''"
    $albumWslEsc = $albumWsl -replace "'", "'\''"

    $bashCmd = "pwsh -NoProfile -File '$converterWslEsc' -Path '$albumWslEsc' -Verbose"
    $convOutput = & wsl -- bash -lc $bashCmd *>&1 | Tee-Object -Variable convText
    $convExit = $LASTEXITCODE
    if ($convExit -ne 0) {
        Write-Host "FLAC conversion failed or aborted (exit code $convExit). Aborting upload flow." -ForegroundColor Red
        if ($convText) {
            Write-Host "=== Converter output (for debugging) ===" -ForegroundColor Yellow
            $convText | ForEach-Object { Write-Host $_ }
            Write-Host "=== End converter output ===" -ForegroundColor Yellow
        }
        return $null
    }

    $convPathLine = $convText | Select-String -Pattern 'Conversion complete\. FLAC files are in:\s*(.+)$' | Select-Object -Last 1
    if ($convPathLine -and $convPathLine.Matches.Count -gt 0) {
        $newWslPath = $convPathLine.Matches[0].Groups[1].Value.Trim()
        $newWinPath = Convert-FromWSLPath $newWslPath
        if ($newWinPath -and (Test-Path -LiteralPath $newWinPath)) {
            return $newWinPath
        }
    }

    return $albumFolder
}

function Brucelee-Upload {
    param(
        [string]$albumFolder,
        [string]$musicUrl,
        [bool]$isQobuz = $false
    )

    if (-not (Ensure-BruceleeExists)) { return }

    if (Get-Variable -Name wslPath -Scope Global -ErrorAction SilentlyContinue) {
        $wslPath = $global:wslPath
        Remove-Variable -Name wslPath -Scope Global -ErrorAction SilentlyContinue
    } else {
        $wslPath = Convert-ToWSLPath $albumFolder
    }

    if (-not $wslPath) {
        Write-Host 'Unable to determine WSL album path. Aborting upload.' -ForegroundColor Red
        return
    }

    $flags = @()
    $flags += $BruceleeUpBaseFlags

    # Encode album path so spaces, brackets, apostrophes, Unicode, etc. cannot
    # break argument passing.
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($wslPath)
    $b64 = [Convert]::ToBase64String($bytes)

    $helperArgs = @(
        "python3",
        $BL94HelperWSLPath,
        "--brucelee-exe",
        $BruceleeExe,
        "--flags",
        ($flags -join " ")
    )

    $normalizedUrl = Strip-BeatportRegion $musicUrl

    if ($normalizedUrl) {
        # IMPORTANT:
        # Do not pass raw URLs through WSL.
        # URLs can contain &, ?, =, #, %, Unicode, etc.
        # Passing them raw can cause bash to split the command and treat later args
        # like --b64path as separate shell commands.
        #
        # bl94_helper.py v9 supports these base64 URL arguments.
        $urlBytes = [System.Text.Encoding]::UTF8.GetBytes($normalizedUrl)
        $b64Url = [Convert]::ToBase64String($urlBytes)

        $helperArgs += @("--b64-metadata-url", $b64Url)
        $helperArgs += @("--b64-original-url", $b64Url)
    }

    $helperArgs += @("--b64path", $b64)

    # Use the original invocation style.
    # Do NOT use wsl.exe --exec here because your brucelee94 environment/config
    # appears to behave differently with --exec.
    & wsl -- $helperArgs
    $helperExit = $LASTEXITCODE

    if ($helperExit -ne 0) {
        Write-Host 'Automated upload failed (helper). Please inspect helper output above.' -ForegroundColor Yellow
    }
}

function Resize-FLAC-Artwork {
    param([string]$albumFolder)

    $scriptDir = $PSScriptRoot
    if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition }
    $resizeScript = Join-Path $scriptDir 'resize_flac_cover.py'

    if (-not (Test-Path -LiteralPath $resizeScript -PathType Leaf)) {
        Write-Host "resize_flac_cover.py not found at $resizeScript. Aborting resize." -ForegroundColor Red
        $global:LASTEXITCODE = 2
        return
    }

    & python $resizeScript "$albumFolder"
}

function Run-UploadFlow {
    param(
        [string]$InitialInput
    )

    if (-not $script:IntroShown) {
        Write-Host 'Enter a download link (or path to an existing folder). The script will auto-select the appropriate tool.' -ForegroundColor Yellow
        $script:IntroShown = $true
    }

    if ($InitialInput) {
        $linkInput = $InitialInput
        # Replace ASCII control characters (0-31 and DEL) before display so copied multi-line or escape-sequence text stays on one safe console line.
        $displayInput = $linkInput -replace '[\x00-\x1F\x7F]', '?'
        Write-Host ("Using provided input (non-interactive): {0}" -f $displayInput) -ForegroundColor Cyan
    } else {
        $linkInput = Read-Bold 'Enter link or folder path'
    }
    if (-not $linkInput) { Write-Host 'No input provided. Aborting.' -ForegroundColor Red; return }

    $albumFolder = $null
    $url = $null
    $isQobuz = $false
    $isDeezer = $false
    $choice = $null
    $shouldUpload = $false

    try {
        if (Test-Path -LiteralPath $linkInput -PathType Container) {
            $choice = '5'
            $albumFolder = (Resolve-Path -LiteralPath $linkInput).ProviderPath
        }
    } catch {}

    if (-not $choice) {
        if ($linkInput -match '(?i)deezer') {
            $choice = '6'
            $url = $linkInput
            $isDeezer = $true
        } elseif ($linkInput -match '(?i)qobuz') {
            $choice = '1'
            $url = $linkInput
            $isQobuz = $true
        } elseif ($linkInput -match '(?i)beatport') {
            $choice = '2'
            $url = $linkInput
        } elseif ($linkInput -match '(?i)music\.apple\.com|apple\.com') {
            $choice = '3'
            $url = $linkInput
        } elseif ($linkInput -match '(?i)tidal|listen\.tidal') {
            $choice = '4'
            $url = $linkInput
        } else {
            Write-Host 'Which tool do you want to use?' -ForegroundColor Yellow
            Write-Host '1 = Qobuz-cli (Qobuz only)' -ForegroundColor Yellow
            Write-Host '2 = Beatportdl (WSL direct run, single-URL mode)' -ForegroundColor Yellow
            Write-Host '3 = AppleDownloader (WSL)' -ForegroundColor Yellow
            Write-Host '4 = tidal-dl-ng (WSL virtualenv)' -ForegroundColor Yellow
            Write-Host '5 = None (use existing folder)' -ForegroundColor Yellow
            Write-Host '6 = deemix-cli (WSL, Deezer)' -ForegroundColor Yellow

            $choice = Read-Bold 'Enter 1, 2, 3, 4, 5 or 6'
            if ($choice -in @('1','2','3','4','6')) {
                $url = Read-Bold 'Enter the music URL'
                if (-not $url) { Write-Host 'No URL provided. Aborting.' -ForegroundColor Red; return }
            } elseif ($choice -eq '5') {
                $albumFolder = Read-Bold 'Enter the full path of the existing music folder (Windows path)'
                if (-not $albumFolder) { Write-Host 'No folder provided. Aborting.' -ForegroundColor Red; return }
                if (-not (Test-Path -LiteralPath $albumFolder)) { Write-Host 'Provided folder does not exist:' $albumFolder -ForegroundColor Red; return }
            } else {
                Write-Host 'Invalid choice. Aborting.' -ForegroundColor Red
                return
            }
        }
    }

    switch ($choice) {
        '1' {
            if (-not $url) { Write-Host 'No URL provided. Aborting.' -ForegroundColor Red; return }
            if ($url -match '(?i)deezer') {
                Write-Host 'Qobuz-cli flow is for Qobuz only. Use Deemix option 6 for Deezer.' -ForegroundColor Red
                return
            }

            $dlStartUtc = [DateTime]::UtcNow
            Push-Location 'C:\Users\polsp\modify-qobuz-cli'
            try { & qcli download $url } finally { Pop-Location }

            $albumFolder = Get-NewAlbumFolderSince -StartUtc $dlStartUtc -TimeoutSeconds 3
            if (-not $albumFolder) { Write-Host 'No new album folder found after Qobuz-cli.' -ForegroundColor Red; return }

            $scriptDir = $PSScriptRoot
            if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition }
            $addMdScript = Join-Path $scriptDir 'add_md5.py'
            if (Test-Path -LiteralPath $addMdScript) {
                & python $addMdScript -r $albumFolder
                $mdExit = $LASTEXITCODE
                if ($mdExit -ne 0) {
                    Write-Host "add_md5.py returned non-zero exit code $mdExit. Aborting upload." -ForegroundColor Red
                    $shouldUpload = $false
                    return
                }
            } else {
                Write-Host "add_md5.py not found at $addMdScript. Skipping MD5 addition." -ForegroundColor Yellow
            }
            $shouldUpload = $true
        }

        '2' {
            if (-not $url) { Write-Host 'No URL provided. Aborting Beatport run.' -ForegroundColor Red; return }

            if (-not (Test-WSLPath $BeatportdlWSLDir)) {
                Write-Host 'Beatportdl WSL directory not found:' $BeatportdlWSLDir -ForegroundColor Red
                return
            }

            $dlStartUtc = [DateTime]::UtcNow
            if ($UseInteractiveWSL) {
                & wsl -- bash -ic "cd $BeatportdlWSLDir; ./beatportdl '$url'"
            } else {
                $beatBash = "cd $BeatportdlWSLDir; ./beatportdl -q '$url' 2>&1 | tee /tmp/beatportdl.run.log"
                & wsl -- bash -lc $beatBash
            }

            $albumFolder = Get-NewAlbumFolderSince -StartUtc $dlStartUtc -TimeoutSeconds 3
            if (-not $albumFolder) {
                Write-Host 'No album folder found after beatportdl run. Showing WSL log tail for debugging...' -ForegroundColor Yellow
                & wsl -- bash -lc 'if [ -f /tmp/beatportdl.run.log ]; then tail -n 200 /tmp/beatportdl.run.log; else echo "/tmp/beatportdl.run.log not found"; fi'
                return
            }

            Resize-FLAC-Artwork $albumFolder
            $resizeExit = $LASTEXITCODE
            if ($resizeExit -ne 0) {
                Write-Host "resize_flac_cover.py returned non-zero exit code $resizeExit. Aborting upload." -ForegroundColor Yellow
                $shouldUpload = $false
                return
            }

            $shouldUpload = $true
        }

        '3' {
            if (-not $url) { Write-Host 'No URL provided. Aborting.' -ForegroundColor Red; return }
            $dlStartUtc = [DateTime]::UtcNow
            $cmd = "cd ~/downloader; ./main '" + ($url -replace "'","'\''") + "'"
            & wsl -- bash -lc $cmd

            $albumFolder = Get-NewAlbumFolderSince -StartUtc $dlStartUtc -TimeoutSeconds 3
            if (-not $albumFolder) { Write-Host 'No new album folder found after AppleDownloader.' -ForegroundColor Red; return }

            $convertedFolder = Invoke-FlacConverterInWSL $albumFolder
            if (-not $convertedFolder) { return }
            $albumFolder = $convertedFolder

            $shouldUpload = $true
        }

        '4' {
            if (-not $url) { Write-Host 'No URL provided. Aborting.' -ForegroundColor Red; return }
            $dlStartUtc = [DateTime]::UtcNow
            $singleQuotedUrl = "'" + ($url -replace "'", "'\\''") + "'"
            $bashCmd = 'export TERM=xterm-256color; source ~/tidal-ng-venv/bin/activate && tidal-dl-ng dl ' + $singleQuotedUrl
            & wsl -- bash -ic $bashCmd
            $tidalExit = $LASTEXITCODE

            $albumFolder = Get-NewAlbumFolderSince -StartUtc $dlStartUtc -TimeoutSeconds 3
            if (-not $albumFolder) {
                Write-Host 'No new album folder found after tidal-dl-ng run. Showing WSL log tail for debugging...' -ForegroundColor Yellow
                & wsl -- bash -lc 'if [ -f /tmp/tidal-dl-ng.run.log ]; then tail -n 200 /tmp/tidal-dl-ng.run.log; else echo "/tmp/tidal-dl-ng.run.log not found"; fi'
                return
            }

            if ($tidalExit -ne 0) {
                Write-Host "tidal-dl-ng returned non-zero exit code $tidalExit. Check WSL output for details." -ForegroundColor Yellow
            }
            $shouldUpload = $true
        }

        '5' {
            if (-not $albumFolder) {
                $albumFolder = Read-Bold 'Enter the full path of the existing music folder (Windows path)'
                if (-not $albumFolder) { Write-Host 'No folder provided. Aborting.' -ForegroundColor Red; return }
                if (-not (Test-Path -LiteralPath $albumFolder)) { Write-Host 'Provided folder does not exist:' $albumFolder -ForegroundColor Red; return }
            }
            $manualMetadataUrl = Read-Bold 'Enter a metadata/source URL to use for brucelee94 (or leave blank to enter it when brucelee prompts)'
            if ($manualMetadataUrl) {
                $url = $manualMetadataUrl
                if ($manualMetadataUrl -match '(?i)qobuz') { $isQobuz = $true }
            } else {
                $url = $null
                $isQobuz = $false
            }
            $shouldUpload = $true
        }

        '6' {
            if (-not $url) { Write-Host 'No URL provided. Aborting deemix-cli run.' -ForegroundColor Red; return }

            if (-not (Test-WSLPath $DeemixCliWSLDir)) {
                Write-Host 'deemix-cli WSL directory not found:' $DeemixCliWSLDir -ForegroundColor Red
                return
            }

            $dlStartUtc = [DateTime]::UtcNow

            # Safely quote values for bash. This keeps URLs with &, ?, =, #, %, etc. intact.
            $deemixCliDirEsc = $DeemixCliWSLDir -replace "'", "'\''"
            $urlEscForBash = $url -replace "'", "'\''"

            $bashCmd = @"
set -o pipefail
cd '$deemixCliDirEsc'
node cli.js dl '$urlEscForBash' 2>&1 | tee /tmp/deemix-cli.run.log
"@

            & wsl -- bash -lc $bashCmd
            $deemixExit = $LASTEXITCODE

            if ($deemixExit -ne 0) {
                Write-Host "deemix-cli returned non-zero exit code $deemixExit. Showing WSL log tail..." -ForegroundColor Yellow
                & wsl -- bash -lc 'if [ -f /tmp/deemix-cli.run.log ]; then tail -n 200 /tmp/deemix-cli.run.log; else echo "/tmp/deemix-cli.run.log not found"; fi'
            }

            $albumFolder = Get-NewAlbumFolderSince -StartUtc $dlStartUtc -TimeoutSeconds 3
            if (-not $albumFolder) {
                Write-Host 'No album folder found after deemix-cli run.' -ForegroundColor Yellow
                return
            }

            $shouldUpload = $true
        }

        Default {
            Write-Host 'Invalid choice' -ForegroundColor Red
            return
        }
    }

    if (-not $albumFolder) {
        $albumFolder = Get-AlbumFolder
        if ($albumFolder) { $albumFolder = $albumFolder.Trim() }
    }

    if (-not $albumFolder) { Write-Host 'No album folder determined. Aborting flow.' -ForegroundColor Red; return }

    Write-Host 'Album folder:' $albumFolder -ForegroundColor Cyan

    if ($shouldUpload) {
        Brucelee-Upload $albumFolder $url $isQobuz
    } else {
        Write-Host 'Upload skipped due to earlier errors or conditions not met.' -ForegroundColor Yellow
    }
}

$nextInput = $InitialInput
while ($true) {
    try {
        Run-UploadFlow -InitialInput $nextInput
    } catch {
        Write-Host 'Unhandled error:' $_ -ForegroundColor Red
    }
    if ($Once) { break }
    $nextInput = Read-Bold 'Enter a folder path or URL'
    if (-not $nextInput) { break }
}

Write-Host 'Exiting. Goodbye!' -ForegroundColor Yellow