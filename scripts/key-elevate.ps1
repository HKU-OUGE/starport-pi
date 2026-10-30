param([Parameter(Mandatory=$true)][string]$Node, [Parameter(Mandatory=$true)][string]$Helper, [Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference = 'Stop'
foreach ($Value in @($Node,$Helper,$Request)) { if ($Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) { throw 'Invalid helper path.' } }
$Process = Start-Process -FilePath $Node -ArgumentList @('"' + $Helper + '"', '"' + $Request + '"') -Verb RunAs -Wait -PassThru
exit $Process.ExitCode
