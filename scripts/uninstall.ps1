param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ProfileRoot = if ($env:STARPORT_PI_STATE) { [IO.Path]::GetFullPath($env:STARPORT_PI_STATE) } else { Join-Path $env:LOCALAPPDATA 'StarportPi' }
$Digest = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($ProfileRoot))
$Suffix = ([BitConverter]::ToString($Digest)).Replace('-','').Substring(0,12).ToLower()
$TaskName = "Starport Pi $Suffix"
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$StartupFile = Join-Path $ProfileRoot 'start-panel.ps1'
if ($Task -and -not ($Task.Actions | Where-Object { $_.Arguments -like ('*"' + $StartupFile + '"*') })) {
    throw 'The startup task does not match this profile. Nothing was stopped.'
}

function Test-ArgumentPath([string]$CommandLine, [string]$Expected) {
    $Pattern = '(?:^|\s)"?' + [regex]::Escape($Expected.Replace('\','/')) + '"?(?=\s|$)'
    return $CommandLine.Replace('\','/') -match $Pattern
}

$ProcessList = @(Get-CimInstance Win32_Process)
$Owned = @{}
$LockFile = Join-Path $ProfileRoot 'panel.lock'
if (Test-Path $LockFile) {
    $PanelPid = 0
    if (-not [int]::TryParse((Get-Content -LiteralPath $LockFile -Raw).Trim(), [ref]$PanelPid) -or $PanelPid -lt 1) { throw 'Invalid panel lock. Inspect this profile before uninstalling.' }
    $Panel = $ProcessList | Where-Object { $_.ProcessId -eq $PanelPid } | Select-Object -First 1
    if ($Panel) {
        $Created = $Panel.CreationDate.ToUniversalTime()
        $Locked = (Get-Item -LiteralPath $LockFile).CreationTimeUtc
        if ($Panel.Name -ne 'node.exe' -or -not $Panel.CommandLine -or -not (Test-ArgumentPath $Panel.CommandLine (Join-Path $RepoRoot 'bin\starport-pi.mjs')) -or $Panel.CommandLine -notmatch '(?:^|\s)panel(?:\s|$)' -or $Locked -lt $Created -or ($Locked - $Created).TotalSeconds -gt 60) {
            throw 'The running panel could not be safely attributed to this profile. Close its console first, then retry.'
        }
        $Owned[$Panel.ProcessId] = @{ Process=$Panel; Kind='panel' }
    }
}
$ConfigFile = Join-Path $ProfileRoot 'config.json'
$Config = if (Test-Path $ConfigFile) { Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json } else { $null }
$TokenFile = Join-Path $ProfileRoot 'cloudflare\tunnel-token'
$NetworkDir = Join-Path $ProfileRoot 'network'
foreach ($ProcessInfo in $ProcessList) {
    if (-not $ProcessInfo.CommandLine) { continue }
    if ($ProcessInfo.Name -eq 'cloudflared.exe' -and (Test-ArgumentPath $ProcessInfo.CommandLine $TokenFile)) {
        $Owned[$ProcessInfo.ProcessId] = @{ Process=$ProcessInfo; Kind='connector' }
    }
    if ($Config -and $Config.proxy.binary -and $ProcessInfo.ExecutablePath -eq $Config.proxy.binary -and (Test-ArgumentPath $ProcessInfo.CommandLine $NetworkDir)) {
        $Owned[$ProcessInfo.ProcessId] = @{ Process=$ProcessInfo; Kind='proxy' }
    }
    if ($ProcessInfo.Name -eq 'ssh.exe' -and $ProcessInfo.CommandLine -match '(?:^|\s)-N(?:\s|$)' -and $Config) {
        foreach ($Property in $Config.servers.PSObject.Properties) {
            $KnownHosts = $Property.Value.knownHostsFile
            if ($KnownHosts -and [IO.Path]::GetFullPath($KnownHosts).StartsWith($ProfileRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
                $Expected = 'UserKnownHostsFile="' + $KnownHosts.Replace('\','/') + '"'
                if ($ProcessInfo.CommandLine.Replace('\"','"').Replace('\','/').Contains($Expected)) { $Owned[$ProcessInfo.ProcessId] = @{ Process=$ProcessInfo; Kind='egress tunnel' } }
            }
        }
    }
}
Write-Host ('Startup registration: ' + $(if ($Task) { 'present' } else { 'absent' }))
Write-Host ('Identified profile processes: ' + $Owned.Count)
Write-Host 'Repository, configuration, credentials, session history and remote data will be retained.'
if (-not $Apply) { Write-Host 'Plan only. Run with -Apply to disable the startup task and stop the identified processes.'; return }
if ($Task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
foreach ($Item in ($Owned.Values | Sort-Object @{ Expression={ if ($_.Kind -eq 'panel') { 0 } else { 1 } } })) {
    # Recheck process identity immediately before stopping; never kill a recycled PID.
    $Current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $Item.Process.ProcessId)
    if (-not $Current) { continue }
    if ($Current.CreationDate -ne $Item.Process.CreationDate -or $Current.CommandLine -ne $Item.Process.CommandLine) { throw 'A process changed during uninstall. It was not stopped.' }
    Stop-Process -Id $Current.ProcessId -ErrorAction Stop
}
Write-Host 'Startup registration removed and identified local processes stopped. Private state and remote workers were retained.'
Write-Host 'Older tunnels created without profile-specific known-host files need separate ownership verification; they are not stopped by guessing.'
