param([switch]$Worker)

$ErrorActionPreference = 'Stop'
$runtime = Join-Path $PSScriptRoot 'runtime/ollama'
$null = New-Item -ItemType Directory -Path $runtime -Force
function Save-EngineStatus([string]$State, [string]$ErrorCode = '', [string]$Version = '') {
    $destination = Join-Path $runtime 'status.json'
    $temporary = "$destination.$PID.tmp"
    [ordered]@{ schema_version = 1; state = $State; version = $Version; error = $ErrorCode
        local_only = $true; bind = 'loopback'; updated_at_utc = [DateTime]::UtcNow.ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
    if ([IO.File]::Exists($destination)) { [IO.File]::Replace($temporary, $destination, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($temporary, $destination) }
}
if (-not $Worker) {
    $arguments = @('-NoProfile', '-File', ('"' + $PSCommandPath + '"'), '-Worker')
    $null = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden
    exit 0
}
$mutex = [Threading.Mutex]::new($false, 'Local\FractoOllamaLoopback11434')
$locked = $false
try {
    try { $locked = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { exit 0 }
    # Do not take over, kill or advertise an engine that this installation did not start.
    $occupied = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq 11434 })
    if ($occupied.Count -gt 0) { Save-EngineStatus 'unavailable' 'port_in_use'; exit 0 }
    Save-EngineStatus 'installing'
    & (Join-Path $PSScriptRoot 'install_ollama_windows.ps1')
    $release = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'ollama_release.json') -Raw | ConvertFrom-Json
    $executable = Join-Path $runtime "$($release.version)/ollama.exe"
    # Process-local configuration; do not rewrite the user's global environment.
    $env:OLLAMA_NO_CLOUD = '1'
    $env:OLLAMA_HOST = '127.0.0.1:11434'
    $env:OLLAMA_MODELS = Join-Path $runtime 'models'
    $env:OLLAMA_MAX_LOADED_MODELS = '1'
    $env:OLLAMA_NUM_PARALLEL = '1'
    $env:OLLAMA_MAX_QUEUE = '16'
    $env:OLLAMA_CONTEXT_LENGTH = '4096'
    $env:OLLAMA_KEEP_ALIVE = '0'
    $logs = Join-Path $runtime 'logs'
    $null = New-Item -ItemType Directory -Path $logs -Force
    $attempt = 0
    while ($true) {
        $attempt++
        Save-EngineStatus 'starting' '' $release.version
        # Keep only the most recent launch logs; never remove unrelated runtime files.
        Get-ChildItem -LiteralPath $logs -File | Where-Object { $_.Name -match '^serve-\d{8}T\d{9}Z\.(stdout|stderr)\.log$' } |
            Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip 18 |
            ForEach-Object { Remove-Item -LiteralPath $_.FullName }
        $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
        $engine = Start-Process -FilePath $executable -ArgumentList @('serve') -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $logs "serve-$stamp.stdout.log") `
            -RedirectStandardError (Join-Path $logs "serve-$stamp.stderr.log")
        $ready = $false
        for ($index = 0; $index -lt 30 -and -not $engine.HasExited; $index++) {
            try {
                $api = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 1
                if ($api.version -eq $release.version) { $ready = $true; break }
            } catch {}
            Start-Sleep -Seconds 1
        }
        if ($ready) { Save-EngineStatus 'ready' '' $release.version }
        else { Save-EngineStatus 'unavailable' 'engine_not_ready' $release.version }
        $engine.WaitForExit()
        Save-EngineStatus 'retry_wait' 'engine_exited' $release.version
        Start-Sleep -Seconds ([math]::Min(60, 5 * $attempt))
    }
} catch {
    Save-EngineStatus 'failed' 'installation_or_start_failed'
    exit 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
