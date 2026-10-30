param([switch]$InstallPrerequisites = $true, [switch]$LaunchPanel = $true)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'windows-path.ps1')
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    if (-not $InstallPrerequisites) { throw 'Install Node.js 22.19+ and run this script again.' }
    winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw 'Node.js installation failed.' }
    Update-InstallPath
}
$NodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$NpmPath = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
& $NodePath -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||a===22&&b>=19?0:1)"
if ($LASTEXITCODE -ne 0) { throw 'Node.js 22.19 or later is required.' }
function Find-WorkingPython {
    $Candidates = @((Get-Command python -CommandType Application -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })) + @((Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'))
    foreach ($Candidate in $Candidates) {
        if (-not $Candidate -or -not (Test-Path $Candidate)) { continue }
        try {
            $null = & $Candidate -I -c 'import sys; sys.exit(0 if sys.version_info >= (3,12) else 1)' 2>$null
            if ($LASTEXITCODE -eq 0) { return $Candidate }
        } catch { }
    }
    return $null
}
$PythonPath = Find-WorkingPython
if (-not $PythonPath) {
    if (-not $InstallPrerequisites) { throw 'Install Python 3.12+ for DSW connection tools.' }
    winget install --id Python.Python.3.12 --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw 'Python installation failed.' }
    Update-InstallPath
    $PythonPath = Find-WorkingPython
    if (-not $PythonPath) { throw 'Python 3.12+ did not become available. Disable the empty Windows Store python alias or restart PowerShell.' }
}
$env:STARPORT_PYTHON = $PythonPath
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    if (-not $InstallPrerequisites) { throw 'Enable Windows OpenSSH Client in Optional Features, then run this script again.' }
    $SshInstall = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile -Command "Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0"'
    if ($SshInstall.ExitCode -ne 0) { throw 'OpenSSH installation failed or system approval was cancelled.' }
    Update-InstallPath
    if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { throw 'Restart PowerShell after enabling OpenSSH, then run this script again.' }
}
Push-Location $ProjectRoot
try {
    & $NpmPath ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    & $NpmPath run build
    if ($LASTEXITCODE -ne 0) { throw 'Web panel build failed.' }
    & $NpmPath test
    if ($LASTEXITCODE -ne 0) { throw 'Client verification failed.' }
} finally { Pop-Location }
$Launcher = Join-Path $ProjectRoot 'starport-pi.cmd'
$EntryPath = Join-Path $ProjectRoot 'bin\starport-pi.mjs'
[IO.File]::WriteAllText($Launcher, "@echo off`r`nchcp 65001 >nul`r`nset `"STARPORT_PYTHON=$PythonPath`"`r`n`"$NodePath`" `"$EntryPath`" %*`r`n", [Text.UTF8Encoding]::new($false))
Write-Host 'Ready. Use the web deployment wizard, or run .\starport-pi.cmd panel later.'
Write-Host 'WSL2 is optional. No Windows disks are exposed to model tools.'

if ($LaunchPanel) {
    & $NodePath $EntryPath panel --open
}
