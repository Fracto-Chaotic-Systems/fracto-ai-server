function Assert-FractoModelLocalPath([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Model storage migration does not follow reparse points'
            }
        }
        $parent = [IO.Directory]::GetParent($current)
        $current = if ($parent) { $parent.FullName } else { $null }
    }
}

function Get-FractoModelSHA256([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Get-FractoOllamaModelsDirectory([string]$Runtime) {
    $configuration = Join-Path $Runtime 'storage.json'
    if (-not (Test-Path -LiteralPath $configuration)) { return (Join-Path $Runtime 'models') }
    $storage = Get-Content -LiteralPath $configuration -Raw | ConvertFrom-Json
    $directory = [string]$storage.models_directory
    if ($storage.schema_version -ne 1 -or $directory -notmatch '^[A-Za-z]:[\\/]' -or
        $directory.Length -gt 1024) { throw 'Invalid managed Ollama storage configuration' }
    $directory = [IO.Path]::GetFullPath($directory)
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        throw 'Configured Ollama model storage is unavailable'
    }
    return $directory
}
