param([int]$Port = 18900, [switch]$Remove)
$ErrorActionPreference = 'Stop'
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Invalid panel port.' }
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ProfileRoot = if ($env:STARPORT_PI_STATE) { [IO.Path]::GetFullPath($env:STARPORT_PI_STATE) } else { Join-Path $env:LOCALAPPDATA 'StarportPi' }
$Digest = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($ProfileRoot))
$Suffix = ([BitConverter]::ToString($Digest)).Replace('-','').Substring(0,12).ToLower()
$TaskName = "Starport Pi $Suffix"
if ($Remove) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; return }
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw 'This profile already has a startup task. Inspect it before replacing.' }
$Node = (Get-Command node -ErrorAction Stop).Source
& $Node (Join-Path $RepoRoot 'scripts\prepare-profile.mjs') $ProfileRoot
if ($LASTEXITCODE -ne 0) { throw 'Profile initialization failed.' }
$Launcher = Join-Path $ProfileRoot 'start-panel.ps1'
function Quote-Literal([string]$Value) { "'" + $Value.Replace("'", "''") + "'" }
$Entry = Join-Path $RepoRoot 'bin\starport-pi.mjs'
$Body = '$env:STARPORT_PI_STATE = ' + (Quote-Literal $ProfileRoot) + "`r`n" + '& ' + (Quote-Literal $Node) + ' ' + (Quote-Literal $Entry) + " panel $Port`r`n"
[IO.File]::WriteAllText($Launcher, $Body, [Text.UTF8Encoding]::new($false))
$Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $Launcher + '"')
$CurrentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
$Principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null
Write-Host "Registered $TaskName for this user's next sign-in. No administrator password was saved."
