param([string]$ModelsDirectory = (Join-Path $env:LOCALAPPDATA 'Fracto/ollama/models'))

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ollama_storage.ps1')
$runtime = Join-Path $PSScriptRoot 'runtime/ollama'
$source = Get-FractoOllamaModelsDirectory $runtime
if ($ModelsDirectory -notmatch '^[A-Za-z]:[\\/]') { throw 'Model destination must be an absolute local drive path' }
$destination = [IO.Path]::GetFullPath($ModelsDirectory).TrimEnd('\', '/')
$source = [IO.Path]::GetFullPath($source).TrimEnd('\', '/')
if ($destination -eq $source) { Write-Output 'Requested model storage is already configured'; return }
if ($destination.StartsWith("$source\", [StringComparison]::OrdinalIgnoreCase) -or
    $source.StartsWith("$destination\", [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Model source and destination must be separate directories'
}
if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw 'Source model storage is unavailable' }
Assert-FractoModelLocalPath $source
Assert-FractoModelLocalPath $destination
$entries = @(Get-ChildItem -LiteralPath $source -Recurse -Force)
if (@($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) {
    throw 'Model migration does not follow reparse points'
}
$files = @($entries | Where-Object { -not $_.PSIsContainer })
foreach ($file in $files) {
    $relative = $file.FullName.Substring($source.Length + 1)
    if ($relative -notmatch '^blobs[\\/]sha256-[a-f0-9]{64}$' -and
        $relative -notmatch '^manifests(?:-v2)?[\\/]' -and
        $relative -notmatch '^metadata[\\/]sha256-[a-f0-9]{64}\.json$') {
        throw 'Unexpected model storage file; preserve and inspect source before migration'
    }
}
$required = ($files | Measure-Object Length -Sum).Sum
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($destination))
if ($drive.AvailableFreeSpace -lt ($required + 1GB)) { throw 'Insufficient disk space for verified model copy' }
$null = New-Item -ItemType Directory -Path $destination -Force
# Publish each verified blob before its manifest. Never delete or alter the source.
$ordered = $files | Sort-Object @{Expression = { if ($_.FullName.Substring($source.Length + 1) -match '^blobs[\\/]') { 0 } else { 1 } }}, FullName
$buffer = New-Object byte[] (16MB)
foreach ($file in $ordered) {
    $relative = $file.FullName.Substring($source.Length + 1)
    $target = Join-Path $destination $relative
    Assert-FractoModelLocalPath $target
    $expected = if ($relative -match '^blobs[\\/]sha256-([a-f0-9]{64})$') { $Matches[1] } else {
        Get-FractoModelSHA256 $file.FullName
    }
    if (Test-Path -LiteralPath $target) {
        if ((Get-FractoModelSHA256 $target) -ne $expected) {
            throw 'Destination contains different model content; nothing was overwritten'
        }
        continue
    }
    $null = New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force
    $partial = "$target.$([guid]::NewGuid().ToString('N')).partial"
    $inputStream = $null; $outputStream = $null
    try {
        $inputStream = [IO.File]::OpenRead($file.FullName)
        $outputStream = [IO.File]::Open($partial, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) { $outputStream.Write($buffer, 0, $read) }
        $outputStream.Flush($true)
    } finally {
        if ($inputStream) { $inputStream.Dispose() }
        if ($outputStream) { $outputStream.Dispose() }
    }
    if ((Get-FractoModelSHA256 $partial) -ne $expected) {
        [IO.File]::Delete($partial)
        throw 'Copied model checksum mismatch; storage configuration is unchanged'
    }
    [IO.File]::Move($partial, $target)
}
$configuration = Join-Path $runtime 'storage.json'
$temporary = "$configuration.$([guid]::NewGuid().ToString('N')).tmp"
@{schema_version = 1; models_directory = $destination} | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
if ([IO.File]::Exists($configuration)) { [IO.File]::Replace($temporary, $configuration, [System.Management.Automation.Language.NullString]::Value) }
else { [IO.File]::Move($temporary, $configuration) }
Write-Output 'Verified model copy completed; original preserved. Restart the managed native engine to use the new storage.'
