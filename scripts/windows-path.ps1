# Process-local refresh. Do not replace entries supplied by a shell or tool manager.
function Merge-InstallPath {
    param([string]$CurrentPath, [string]$MachinePath, [string]$UserPath)
    $Seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $Entries = [System.Collections.Generic.List[string]]::new()
    foreach ($PathGroup in @($CurrentPath, $MachinePath, $UserPath)) {
        foreach ($RawEntry in ($PathGroup -split ';')) {
            $Entry = [Environment]::ExpandEnvironmentVariables($RawEntry.Trim().Trim('"'))
            if (-not $Entry) { continue }
            $Normalized = $Entry.Replace('/', '\').TrimEnd([char[]]'\')
            if ($Seen.Add($Normalized)) { $Entries.Add($Entry) }
        }
    }
    return ($Entries -join ';')
}

function Update-InstallPath {
    param(
        [string]$MachinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine'),
        [string]$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    )
    $env:Path = Merge-InstallPath -CurrentPath $env:Path -MachinePath $MachinePath -UserPath $UserPath
}
