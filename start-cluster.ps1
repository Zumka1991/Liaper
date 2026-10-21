param([switch]$Build, [switch]$WebOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$pgCtl = Join-Path $env:LOCALAPPDATA 'Liaper\PostgreSQL16\pgsql\bin\pg_ctl.exe'
$pgData = Join-Path $projectRoot 'data\postgres'
if ((Test-Path -LiteralPath $pgCtl) -and (Test-Path -LiteralPath (Join-Path $pgData 'PG_VERSION'))) {
    & $pgCtl -D $pgData status *> $null
    if ($LASTEXITCODE -ne 0) {
        & $pgCtl -D $pgData -l (Join-Path $projectRoot 'data\postgres.log') -o '-h 127.0.0.1 -p 5432' -w start
        if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL could not start. Check data\postgres.log.' }
    }
}
if (-not (Test-Path -LiteralPath '.env')) { throw 'Configure DATABASE_URL and LIAPER_STORAGE_SECRET in .env first.' }
if ($Build -or -not (Test-Path -LiteralPath 'target\debug\liaper-files.exe')) {
    cargo build --workspace
    if ($LASTEXITCODE -ne 0) { throw 'Backend build failed. Stop running binaries before rebuilding.' }
}
$logDir = Join-Path $projectRoot 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
function Start-LiaperService([string]$Name, [int]$Port) {
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        Write-Host "$Name is already listening on $Port"
        return
    }
    Start-Process -FilePath (Join-Path $projectRoot "target\debug\$Name.exe") -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "$Name-$Port.stdout.log") -RedirectStandardError (Join-Path $logDir "$Name-$Port.stderr.log")
}
Start-LiaperService 'liaper-control' 4000
Start-LiaperService 'liaper-files' 4201
$env:NODE_PORT='4101'
$env:NODE_ID='node-ru-1'
$env:NODE_NAME='SFU Node 1'
$env:NODE_REGION='RU-Central'
Start-LiaperService 'liaper-node' 4101
$env:NODE_PORT='4102'
$env:NODE_ID='node-ru-2'
$env:NODE_NAME='SFU Node 2'
$env:NODE_REGION='RU-East'
Start-LiaperService 'liaper-node' 4102
if (-not (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npm.cmd run dev' -WorkingDirectory (Join-Path $projectRoot 'clients\web-desktop') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'web.stdout.log') -RedirectStandardError (Join-Path $logDir 'web.stderr.log')
}
$desktopExe = Join-Path $projectRoot 'clients\web-desktop\src-tauri\target\debug\liaper-desktop.exe'
if (-not $WebOnly -and (Test-Path -LiteralPath $desktopExe) -and -not (Get-Process liaper-desktop -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $desktopExe -WorkingDirectory $projectRoot
}
Write-Host 'Liaper: control 4000, media 4101/4102, encrypted files 4201, Web 5173. Logs: data\logs'
