# Ownership regression tests. All process and task mutations are mocked.
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$Script = Join-Path $Repo 'scripts\uninstall.ps1'
$OriginalState = $env:STARPORT_PI_STATE
$Fixture = Join-Path ([IO.Path]::GetTempPath()) ('starport uninstall test ' + [Guid]::NewGuid().ToString('N'))
$env:STARPORT_PI_STATE = $Fixture
$global:StarportRemovalCalls = @()
$global:StarportRemovalProcesses = @()
$global:StarportRemovalTask = $null
function Get-CimInstance {
    param($ClassName, $Filter)
    if ($Filter -match '^ProcessId=(\d+)$') { return @($global:StarportRemovalProcesses | Where-Object { $_.ProcessId -eq [int]$Matches[1] }) }
    return $global:StarportRemovalProcesses
}
function Get-ScheduledTask { param($TaskName, $ErrorAction) return $global:StarportRemovalTask }
function Stop-ScheduledTask { param($TaskName, $ErrorAction) $global:StarportRemovalCalls += 'task-stop' }
function Unregister-ScheduledTask { param($TaskName, $Confirm) $global:StarportRemovalCalls += 'task-remove' }
function Stop-Process {
    param($Id, $ErrorAction)
    $global:StarportRemovalCalls += [int]$Id
    $global:StarportRemovalProcesses = @($global:StarportRemovalProcesses | Where-Object { $_.ProcessId -ne $Id })
}
function Process-Row($Id, $Name, $Exe, $CommandLine, $Created) {
    [pscustomobject]@{ ProcessId=$Id; Name=$Name; ExecutablePath=$Exe; CommandLine=$CommandLine; CreationDate=$Created }
}
try {
    New-Item -ItemType Directory -Path $Fixture | Out-Null
    $Lock = Join-Path $Fixture 'panel.lock'
    [IO.File]::WriteAllText($Lock, '10001')
    $Created = (Get-Item $Lock).CreationTimeUtc.AddSeconds(-1)
    $Entry = Join-Path $Repo 'bin\starport-pi.mjs'
    $ProxyExe = Join-Path $Fixture 'tools\mihomo.exe'
    $KnownHosts = Join-Path $Fixture 'connections\alpha\known_hosts'
    @{ proxy=@{binary=$ProxyExe}; servers=@{alpha=@{knownHostsFile=$KnownHosts}} } | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Fixture 'config.json')
    $Panel = Process-Row 10001 'node.exe' 'node.exe' ('node.exe "' + $Entry + '" panel') $Created
    $global:StarportRemovalProcesses = @(
        $Panel
        (Process-Row 10002 'cloudflared.exe' 'cloudflared.exe' ('cloudflared.exe tunnel run --token-file "' + (Join-Path $Fixture 'cloudflare\tunnel-token') + '"') $Created)
        (Process-Row 10003 'mihomo.exe' $ProxyExe ('mihomo.exe -d "' + (Join-Path $Fixture 'network') + '"') $Created)
        (Process-Row 10004 'ssh.exe' 'ssh.exe' ('ssh.exe -N -o "UserKnownHostsFile=\"' + $KnownHosts.Replace('\','/') + '\"" -R example') $Created)
        (Process-Row 10005 'node.exe' 'node.exe' ('node.exe "' + $Entry + '" panel') $Created)
        (Process-Row 10006 'cloudflared.exe' 'cloudflared.exe' 'cloudflared.exe tunnel run --token-file "D:\other\token"' $Created)
    )
    $global:StarportRemovalTask = [pscustomobject]@{ Actions=@([pscustomobject]@{ Arguments='-File "' + (Join-Path $Fixture 'start-panel.ps1') + '"' }) }
    & $Script
    if ($global:StarportRemovalCalls.Count) { throw 'Plan mutated a process or task.' }
    & $Script -Apply
    foreach ($Expected in @('task-stop','task-remove',10001,10002,10003,10004)) {
        if ($global:StarportRemovalCalls -notcontains $Expected) { throw "Expected owned action was missing: $Expected" }
    }
    if ($global:StarportRemovalCalls.Count -ne 6) { throw 'Unrelated process or extra action was touched.' }
    if (-not (Test-Path (Join-Path $Fixture 'config.json'))) { throw 'Private state was removed.' }
    $global:StarportRemovalCalls = @()
    $Panel.CreationDate = (Get-Date).AddMinutes(1)
    $global:StarportRemovalProcesses = @($Panel)
    $Rejected = $false
    try { & $Script -Apply } catch { $Rejected = $true }
    if (-not $Rejected -or $global:StarportRemovalCalls.Count) { throw 'Recycled PID was not rejected before mutation.' }
    Write-Host 'PASS: removal plan is read-only; apply stops only owned controls; state survives; recycled PIDs are rejected.'
} finally {
    $env:STARPORT_PI_STATE = $OriginalState
    Remove-Item -LiteralPath $Fixture -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Variable StarportRemovalCalls,StarportRemovalProcesses,StarportRemovalTask -Scope Global -ErrorAction SilentlyContinue
}
