# Local Files Toolkit - one-time setup for Windows.
# If a ready-made app is in electron-app\dist there is nothing to install: the app contains everything
# it needs. Otherwise this installs Node.js and the app's files so it can run from source. Either way it
# checks that everything worked and tells you plainly if a Windows setting or permission is in the way.
# Safe to run more than once: every step checks first and skips what is already there.
# Started by Setup.bat - just double-click that.

$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$script:todo = New-Object System.Collections.Generic.List[string]   # things YOU need to do or change
$script:failed = $false

function Step($t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "  [ok] $t" -ForegroundColor Green }
function Info($t) { Write-Host "       $t" -ForegroundColor Gray }
function Warn($t) { Write-Host "  [!]  $t" -ForegroundColor Yellow }
function Bad($t)  { Write-Host "  [x]  $t" -ForegroundColor Red; $script:failed = $true }
function Need($t) { if (-not $script:todo.Contains($t)) { $script:todo.Add($t) } }

# Programs installed during this run are not on PATH yet in this window - re-read it from Windows.
function Refresh-Path {
    $m = [Environment]::GetEnvironmentVariable('Path', 'Machine'); $u = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($m, $u) | Where-Object { $_ }) -join ';'
}
function Have($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# Install with winget and explain failures in plain words. Returns $true if the program is usable afterwards.
function Winget-Install($id, $label, $check) {
    if (-not (Have 'winget')) {
        Bad "$label is missing and Windows' installer tool (winget) isn't available on this PC."
        Need "Get winget: open the Microsoft Store, search for 'App Installer', click Update/Get, then run Setup again. (On a school/work PC the Store or App Installer may be blocked - then install $label by hand from the link shown below.)"
        return $false
    }
    Info "Installing $label with winget (a Windows permission prompt may appear - click Yes)..."
    $out = (& winget install -e --id $id --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-String)
    $code = $LASTEXITCODE
    Refresh-Path
    if (& $check) { return $true }
    if ($out -match '0x80070659|forbidden by system policy|blocked by (group )?policy|AppLocker|administrator has blocked') {
        Bad "Windows is blocking the installation of $label (an administrator policy)."
        Need "This PC's policy blocks installing programs (common on school/work PCs). Ask the person who manages it to allow $label, or use a PC where you can install software."
    } elseif ($out -match '0x80070005|Access is denied|requires? (administrator|elevation)|elevat') {
        Bad "Installing $label needs administrator permission and it wasn't granted."
        Need "Right-click Setup.bat and choose 'Run as administrator' (or click Yes when Windows asks), then run Setup again."
    } elseif ($out -match 'Failed when opening source|certificate|SSL|proxy|network|timed out|0x80072') {
        Bad "Couldn't download $label - the network blocked it."
        Need "Check your internet connection. On a school/work/VPN network, the download may be filtered - try another network."
    } elseif ($out -match 'No package found|source.*(fail|unavailable)|0x8a15') {
        Bad "winget couldn't find or download $label."
        Need "Open the Microsoft Store, update 'App Installer', check your internet connection, then run Setup again."
    } else {
        Bad "Installing $label didn't finish (winget code $code)."
    }
    Info 'winget said:'
    ($out -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 6) | ForEach-Object { Info $_ }
    return $false
}

Write-Host ''
Write-Host '  Local Files Toolkit - setup' -ForegroundColor Green
Write-Host '  Checks what you have, installs what is missing, and tells you if a setting is in the way.' -ForegroundColor Gray

# ---------------------------------------------------------------- the app
$exe = 'electron-app\dist\Local Files Toolkit-win32-x64\Local Files Toolkit.exe'
$packaged = Test-Path -LiteralPath $exe

if ($packaged) {
    Step 'The app'
    Ok 'A ready-made app is in electron-app\dist - nothing needs installing (no Python or Node.js needed).'
    # Files that came from the internet (a zip, a download) are marked, and Windows then shows a blue
    # "Windows protected your PC" box the first time. Detect that so you know it's expected and safe to pass.
    try {
        if (Get-Item -LiteralPath $exe -Stream 'Zone.Identifier' -ErrorAction Stop) {
            Warn "Windows has marked the app as downloaded from the internet."
            Need "The first time you open the app, Windows may show 'Windows protected your PC'. Click 'More info', then 'Run anyway'. (Or right-click Local Files Toolkit.exe > Properties > tick 'Unblock' > OK, once.)"
        }
    } catch { }
} else {
    Step 'Internet connection'
    $online = $false
    try { $null = Invoke-WebRequest -Uri 'https://registry.npmjs.org/' -UseBasicParsing -TimeoutSec 12; $online = $true } catch {}
    if ($online) { Ok 'Online.' }
    else {
        Warn "Couldn't reach the internet (or it is filtered). The downloads below may fail."
        Need 'Connect to the internet (a school/work network or VPN may block downloads - try another network), then run Setup again.'
    }

    Step 'Node.js (runs the app from source)'
    Info 'There is no ready-made app here, so the app runs from source. That needs Node.js and a one-time download of Electron.'
    if (Have 'npm') { Ok ('Found: node ' + ((& node --version 2>&1 | Out-String).Trim())) }
    elseif (Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js' { Have 'npm' }) { Ok ('Node.js installed: ' + ((& node --version 2>&1 | Out-String).Trim())) }
    else { Need 'Install Node.js (the LTS version) from https://nodejs.org, then run Setup again.' }

    if (Have 'npm') {
        Step "The app's files"
        Push-Location 'electron-app'
        Info 'Installing the files the app needs (first run only - a few hundred MB, can take a few minutes)...'
        $o = (& npm install 2>&1 | Out-String)
        if (-not (Test-Path 'node_modules\electron\dist\electron.exe')) {
            Info 'Downloading the Electron program file...'
            $o += (& node 'node_modules\electron\install.js' 2>&1 | Out-String)
        }
        if (Test-Path 'node_modules\electron\dist\electron.exe') { Ok 'App files are ready.' }
        else {
            Bad "The app's files couldn't be installed."
            if ($o -match 'EPERM|EACCES|operation not permitted|access is denied') {
                Need "Windows or your antivirus blocked writing to this folder. Move the whole 'Local Files Fixer' folder somewhere simple like C:\LocalFilesToolkit, or turn off 'Controlled folder access' (Windows Security > Virus & threat protection > Ransomware protection) or add an exclusion for this folder, then run Setup again."
            } elseif ($o -match 'ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network|proxy|certificate|socket hang up|getaddrinfo') {
                Need 'The download was blocked or interrupted. Check your internet connection (a school/work network or VPN may filter it), delete the electron-app\node_modules folder, and run Setup again.'
            } elseif ($o -match 'ENOSPC|no space') {
                Need 'The disk is full. Free up at least 1 GB and run Setup again.'
            } else {
                Need 'Delete the electron-app\node_modules folder and run Setup again. If it keeps failing, antivirus may be quarantining Electron - add this folder to its exclusions.'
            }
            Info (($o -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 4) -join ' | ')
        }
        Pop-Location
    }
}

# ---------------------------------------------------------------- settings that affect Send files
Step 'Settings for sending files to your phone / Mac'
try {
    $pub = @(Get-NetConnectionProfile -ErrorAction Stop | Where-Object { $_.NetworkCategory -eq 'Public' -and $_.IPv4Connectivity -ne 'Disconnected' })
    if ($pub.Count -eq 0) { Ok 'Your network is set to Private, so other devices on it can reach the app.' }
    foreach ($p in $pub) {
        Warn "Your network '$($p.Name)' is set to Public, which blocks other devices from reaching the app."
        Need "Set '$($p.Name)' to Private so Send files works over your Wi-Fi: Settings > Network & internet > Wi-Fi > $($p.Name) > Network profile type > Private network. (Skip this on networks you don't trust.)"
    }
} catch { Info "Couldn't check the network profile - that's fine." }
Info 'The first time you share, Windows asks to allow the app through the firewall - click Allow'
Info '(tick Private, and also Public if you use the PC''s hotspot).'

# ---------------------------------------------------------------- summary
Write-Host ''
Write-Host '--------------------------------------------------------------' -ForegroundColor DarkGray
if ($script:todo.Count -eq 0 -and -not $script:failed) {
    Write-Host '  All set. Open the app with "Local Files Toolkit.bat".' -ForegroundColor Green
} else {
    if ($script:todo.Count -gt 0) {
        Write-Host '  THINGS YOU NEED TO DO OR CHANGE:' -ForegroundColor Yellow
        $i = 1; foreach ($t in $script:todo) { Write-Host ("  {0}. {1}" -f $i, $t) -ForegroundColor Yellow; $i++ }
        Write-Host ''
    }
    if ($script:failed) { Write-Host '  Then double-click Setup.bat again - it skips whatever is already done.' -ForegroundColor Gray }
    else { Write-Host '  Nothing is blocking you - you can open the app with "Local Files Toolkit.bat".' -ForegroundColor Green }
}
exit 0
