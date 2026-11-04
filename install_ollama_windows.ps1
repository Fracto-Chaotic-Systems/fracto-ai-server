param()

$ErrorActionPreference = 'Stop'
$release = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'ollama_release.json') -Raw | ConvertFrom-Json
if ($release.version -notmatch '^\d+\.\d+\.\d+$' -or
    $release.windows_amd64.sha256 -notmatch '^[a-f0-9]{64}$' -or
    $release.windows_amd64.url -ne "https://github.com/ollama/ollama/releases/download/v$($release.version)/ollama-windows-amd64.zip") {
    throw 'Invalid pinned Ollama release specification'
}
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
    throw 'This installer requires x64 Windows'
}
$runtime = Join-Path $PSScriptRoot 'runtime/ollama'
$null = New-Item -ItemType Directory -Path $runtime -Force
$versionDirectory = Join-Path $runtime $release.version
$executable = Join-Path $versionDirectory 'ollama.exe'
$recordPath = Join-Path $runtime 'installation.json'
if (Test-Path -LiteralPath $recordPath) {
    $existing = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
    if ($existing.version -ne $release.version) {
        throw 'A different managed Ollama version is installed; prepare an explicit upgrade instead of replacing it during startup'
    }
    if ($existing.archive_sha256 -eq $release.windows_amd64.sha256 -and (Test-Path -LiteralPath $executable)) {
        Write-Output 'Pinned Ollama installation already available'
        return
    }
}
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($runtime))
if ($drive.AvailableFreeSpace -lt 10GB) { throw 'At least 10 GiB of free disk is required for Ollama installation' }
$archive = Join-Path $runtime "ollama-windows-amd64-v$($release.version).zip"
$archiveValid = (Test-Path -LiteralPath $archive) -and
    ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -eq $release.windows_amd64.sha256)
if (-not $archiveValid) {
    $partial = "$archive.partial"
    & curl.exe --fail --location --retry 2 --silent --show-error --output $partial $release.windows_amd64.url
    if ($LASTEXITCODE -ne 0) { throw 'Ollama package download failed; a later startup can retry' }
    if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $release.windows_amd64.sha256) {
        [IO.File]::Delete($partial)
        throw 'Ollama package checksum mismatch'
    }
    if ([IO.File]::Exists($archive)) { [IO.File]::Replace($partial, $archive, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($partial, $archive) }
}
# Publish a new version directory only after a complete, verified extraction.
$staging = Join-Path $runtime ("extract-$([guid]::NewGuid().ToString('N'))")
Expand-Archive -LiteralPath $archive -DestinationPath $staging
if (-not (Test-Path -LiteralPath (Join-Path $staging 'ollama.exe'))) { throw 'Ollama executable missing from verified package' }
if (Test-Path -LiteralPath $versionDirectory) { throw 'An incomplete version directory exists; preserve it for inspection instead of overwriting it' }
[IO.Directory]::Move($staging, $versionDirectory)
$null = New-Item -ItemType Directory -Path (Join-Path $runtime 'models') -Force
$record = [ordered]@{
    schema_version = 1; version = $release.version; archive_sha256 = $release.windows_amd64.sha256
    executable_relative = "$($release.version)/ollama.exe"; installed_at_utc = [DateTime]::UtcNow.ToString('o')
    source = $release.windows_amd64.url
}
$temporary = "$recordPath.tmp"
$record | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
if ([IO.File]::Exists($recordPath)) { [IO.File]::Replace($temporary, $recordPath, [System.Management.Automation.Language.NullString]::Value) }
else { [IO.File]::Move($temporary, $recordPath) }
Write-Output "Installed pinned Ollama $($release.version)"
