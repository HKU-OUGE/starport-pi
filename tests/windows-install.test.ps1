$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\windows-path.ps1')
$OriginalPath = $env:Path
$Fixture = Join-Path ([IO.Path]::GetTempPath()) ('starport path test ' + [Guid]::NewGuid().ToString('N'))
$SessionTools = Join-Path $Fixture 'session tools'
$InstalledPython = Join-Path $Fixture 'new python'
try {
    New-Item -ItemType Directory -Path $SessionTools, $InstalledPython | Out-Null
    foreach ($Name in @('node', 'npm', 'ssh')) {
        [IO.File]::WriteAllText((Join-Path $SessionTools "starport-$Name-probe.cmd"), "@echo off`r`necho session-tool-ok`r`n", [Text.Encoding]::ASCII)
    }
    [IO.File]::WriteAllText((Join-Path $InstalledPython 'starport-python-probe.cmd'), "@echo off`r`necho python-tool-ok`r`n", [Text.Encoding]::ASCII)
    $MachinePath = Join-Path $env:SystemRoot 'System32'
    $UserPath = $InstalledPython
    # Reproduce the old overwrite: it loses tools present only in the process PATH.
    $env:Path = $MachinePath + ';' + $UserPath
    if (Get-Command starport-node-probe.cmd -ErrorAction SilentlyContinue) { throw 'Fixture did not reproduce the overwritten process PATH.' }
    $env:Path = $SessionTools + ';' + $OriginalPath
    Update-InstallPath -MachinePath $MachinePath -UserPath $UserPath
    foreach ($Name in @('node', 'npm', 'ssh')) {
        $Output = & (Get-Command "starport-$Name-probe.cmd" -ErrorAction Stop).Source
        if ($Output -ne 'session-tool-ok') { throw "Session-only $Name was lost after refresh." }
    }
    if ((& (Get-Command starport-python-probe.cmd -ErrorAction Stop).Source) -ne 'python-tool-ok') { throw 'New Python path was not added.' }
    $Refreshed = $env:Path
    Update-InstallPath -MachinePath $MachinePath -UserPath $UserPath
    if ($env:Path -ne $Refreshed) { throw 'Repeated refresh must be idempotent.' }
    $Merged = Merge-InstallPath -CurrentPath 'C:\Tools;C:\Tools\;"C:\With Space";;' -MachinePath 'c:/tools;C:\Windows' -UserPath 'C:\With Space;D:\Python'
    if ($Merged -ne 'C:\Tools;C:\With Space;C:\Windows;D:\Python') { throw 'Case, quotes, duplicates or empty entries were not normalized.' }
    Write-Host 'PASS: process-only tools survive refresh; new paths are found; repeat refresh is stable.'
} finally {
    $env:Path = $OriginalPath
    Remove-Item -LiteralPath $Fixture -Recurse -Force -ErrorAction SilentlyContinue
}
