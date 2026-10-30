param([switch]$InstallPrerequisites = $true, [switch]$LaunchPanel = $true)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    if (-not $InstallPrerequisites) { throw 'Install Node.js 22.19+ and run this script again.' }
    winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw 'Node.js installation failed.' }
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
}
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    if (-not $InstallPrerequisites) { throw 'Install Python 3.12+ for DSW connection tools.' }
    winget install --id Python.Python.3.12 --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw 'Python installation failed.' }
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
}
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    if (-not $InstallPrerequisites) { throw 'Enable Windows OpenSSH Client in Optional Features, then run this script again.' }
    $SshInstall = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile -Command "Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0"'
    if ($SshInstall.ExitCode -ne 0) { throw 'OpenSSH installation failed or system approval was cancelled.' }
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { throw 'Restart PowerShell after enabling OpenSSH, then run this script again.' }
}
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||a===22&&b>=19?0:1)"
if ($LASTEXITCODE -ne 0) { throw 'Node.js 22.19 or later is required.' }
Push-Location $ProjectRoot
try {
    npm.cmd ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Web panel build failed.' }
    npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw 'Client verification failed.' }
} finally { Pop-Location }
$Launcher = Join-Path $ProjectRoot 'starport-pi.cmd'
$NodePath = (Get-Command node).Source
$EntryPath = Join-Path $ProjectRoot 'bin\starport-pi.mjs'
[IO.File]::WriteAllText($Launcher, "@echo off`r`nchcp 65001 >nul`r`n`"$NodePath`" `"$EntryPath`" %*`r`n", [Text.UTF8Encoding]::new($false))
Write-Host "Ready. Run .\starport-pi.cmd configure, then .\starport-pi.cmd auth."
Write-Host 'WSL2 is optional. No Windows disks are exposed to model tools.'

if ($LaunchPanel) {
    Start-Process 'http://127.0.0.1:18900/'
    & $NodePath $EntryPath panel
}
