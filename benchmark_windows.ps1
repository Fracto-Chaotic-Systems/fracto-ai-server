param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9][a-z0-9-]{0,39}$')]
    [string]$NodeLabel,
    [ValidateRange(3, 120)][int]$SampleCount = 12,
    [ValidateRange(1, 30)][int]$IntervalSeconds = 5,
    [ValidateRange(0, 10)][int]$CpuProbeSeconds = 3,
    [ValidateRange(1, 65535)][int[]]$MainPorts = @(3001, 3101),
    [ValidateRange(0, 65535)][int]$ReadyPort = 0,
    [ValidateRange(0, 300)][int]$SettleSeconds = 0,
    [ValidatePattern('^(?:[a-fA-F0-9-]{36}|legacy-[0-9]+)?$')][string]$RunId = '',
    [ValidatePattern('^(?:[a-fA-F0-9-]{36})?$')][string]$ExpectedStartupId = ''
)

# Windows PowerShell 5.1 and PowerShell 7. No installations or service changes.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$startedAt = [DateTime]::UtcNow
$issues = [System.Collections.Generic.List[string]]::new()

function Read-CapacityClass([string]$ClassName, [string]$Filter = '') {
    try {
        if ($Filter) { return @(Get-CimInstance -ClassName $ClassName -Filter $Filter) }
        return @(Get-CimInstance -ClassName $ClassName)
    } catch {
        if (-not $issues.Contains($ClassName)) { $issues.Add($ClassName) }
        return @()
    }
}

function Get-Summary($Values) {
    $numbers = @($Values | Where-Object { $null -ne $_ } | Sort-Object)
    if ($numbers.Count -eq 0) { return $null }
    $stats = $numbers | Measure-Object -Average -Minimum -Maximum
    return [ordered]@{
        count = $numbers.Count
        minimum = [math]::Round($stats.Minimum, 3)
        average = [math]::Round($stats.Average, 3)
        maximum = [math]::Round($stats.Maximum, 3)
        p95 = [math]::Round($numbers[[math]::Max(0, [math]::Ceiling($numbers.Count * 0.95) - 1)], 3)
    }
}

$os = @(Read-CapacityClass 'Win32_OperatingSystem')
$system = @(Read-CapacityClass 'Win32_ComputerSystem')
if ($os.Count -eq 0 -or $system.Count -eq 0) {
    throw 'Windows capacity inventory unavailable. Run in a local Windows PowerShell session with CIM access.'
}
$cpus = @(Read-CapacityClass 'Win32_Processor' | ForEach-Object {
    [ordered]@{ model = $_.Name; physical_cores = $_.NumberOfCores
        logical_processors = $_.NumberOfLogicalProcessors; maximum_clock_mhz = $_.MaxClockSpeed }
})
$gpus = @(Read-CapacityClass 'Win32_VideoController' | ForEach-Object {
    # AdapterRAM is uint32; never treat it or a GPU name suffix as verified VRAM.
    [ordered]@{ model = $_.Name; driver_version = $_.DriverVersion
        wmi_reported_adapter_ram_bytes = [double]$_.AdapterRAM; verified_vram_gib = $null }
})
$disks = @(Read-CapacityClass 'Win32_LogicalDisk' 'DriveType = 3' | ForEach-Object {
    [ordered]@{ drive = $_.DeviceID; capacity_gib = [math]::Round($_.Size / 1GB, 2)
        free_gib = [math]::Round($_.FreeSpace / 1GB, 2) }
})

$inventory = [ordered]@{
    os = [ordered]@{ edition = $os[0].Caption; version = $os[0].Version; build = $os[0].BuildNumber; architecture = $os[0].OSArchitecture }
    physical_ram_gib = [math]::Round($system[0].TotalPhysicalMemory / 1GB, 2)
    cpu = $cpus; gpu = $gpus; fixed_disks = $disks
    ollama_command_available = [bool](Get-Command ollama -ErrorAction SilentlyContinue)
}
$outputDirectory = Join-Path $PSScriptRoot 'runtime/benchmarks'
$null = New-Item -ItemType Directory -Path $outputDirectory -Force
$suffix = $startedAt.ToString('yyyyMMddTHHmmssfffZ')
if ($RunId) { $suffix = $RunId }
$reportPath = Join-Path $outputDirectory ("windows-baseline-{0}-{1}.json" -f $NodeLabel, $suffix)
function Save-Report([string]$Destination, $Value) {
    $temporary = "$Destination.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temporary -Encoding UTF8
        if ([IO.File]::Exists($Destination)) { [IO.File]::Replace($temporary, $Destination, [System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $Destination) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}
Save-Report ($reportPath -replace '\.json$', '.inventory.json') ([ordered]@{
    schema_version = 1; phase = 'inventory'; node_label = $NodeLabel
    fracto_startup_id = $RunId; observed_at_utc = [DateTime]::UtcNow.ToString('o'); inventory = $inventory
})

$client = [System.Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromMilliseconds(1000)
function Test-StartupReady {
    $response = $null
    $body = $null
    try {
        $response = $client.GetAsync("http://127.0.0.1:$ReadyPort/readyz").GetAwaiter().GetResult()
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
        $successful = [int]$response.StatusCode -eq 200
    } catch { return $false }
    finally { if ($null -ne $response) { $response.Dispose() } }
    if ($body.contract_version -ne 1 -or $null -eq $body.services) { return $false }
    if ($ExpectedStartupId -and $body.startup_id -ne $ExpectedStartupId) { throw 'Fracto startup changed during collection' }
    if ($RunId -match '^legacy-([0-9]+)$') {
        if ($null -eq $body.uptime_seconds) { return $false }
        $epoch = [math]::Round([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [double]$body.uptime_seconds)
        if ([math]::Abs($epoch - [double]$Matches[1]) -gt 5) { throw 'Fracto startup changed during collection' }
    }
    return ($successful -and $body.status -eq 'ready')
}
function Measure-LocalHealth([int]$Port, [string]$Route) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $response = $null
    try {
        $response = $client.GetAsync("http://127.0.0.1:$Port$Route", [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        return [ordered]@{ port = $Port; route = $Route; status = [int]$response.StatusCode
            latency_ms = [math]::Round($watch.Elapsed.TotalMilliseconds, 2); error = $null }
    } catch {
        return [ordered]@{ port = $Port; route = $Route; status = $null
            latency_ms = $null; error = 'unreachable_or_timeout' }
    } finally {
        if ($null -ne $response) { $response.Dispose() }
    }
}

Write-Host 'Discovering standard local Fracto main listeners (response bodies are not collected)...'
$discovery = @($MainPorts | ForEach-Object { Measure-LocalHealth $_ '/healthz' })
$activePorts = @($discovery | Where-Object { $null -ne $_.status } | ForEach-Object { $_.port })
$samples = [System.Collections.Generic.List[object]]::new()
$probe = $null
try {
    if ($ReadyPort -gt 0) {
        $readyDeadline = [DateTime]::UtcNow.AddMinutes(15)
        $stableSince = $null
        $settled = $false
        while ([DateTime]::UtcNow -lt $readyDeadline) {
            if (Test-StartupReady) {
                if ($null -eq $stableSince) { $stableSince = [DateTime]::UtcNow }
                if (([DateTime]::UtcNow - $stableSince).TotalSeconds -ge $SettleSeconds) { $settled = $true; break }
            } else { $stableSince = $null }
            Start-Sleep -Seconds 2
        }
        if (-not $settled) { throw 'Fracto did not reach stable readiness before the benchmark deadline' }
    }
    for ($index = 0; $index -lt $SampleCount; $index++) {
        if ($ReadyPort -gt 0 -and -not (Test-StartupReady)) { throw 'Fracto readiness was lost during collection' }
        $sampleWatch = [Diagnostics.Stopwatch]::StartNew()
        $processor = @(Read-CapacityClass 'Win32_PerfFormattedData_PerfOS_Processor' "Name = '_Total'")
        $memory = @(Read-CapacityClass 'Win32_PerfFormattedData_PerfOS_Memory')
        $diskActivity = @(Read-CapacityClass 'Win32_PerfFormattedData_PerfDisk_PhysicalDisk' "Name = '_Total'")
        $cpuPercent = $null; $available = $null; $pagesInput = $null; $diskQueue = $null
        if ($processor.Count) { $cpuPercent = [double]$processor[0].PercentProcessorTime }
        if ($memory.Count) {
            $available = [math]::Round($memory[0].AvailableMBytes / 1024, 3)
            $pagesInput = [double]$memory[0].PagesInputPersec
        }
        if ($diskActivity.Count) { $diskQueue = [double]$diskActivity[0].CurrentDiskQueueLength }
        $nodeProcesses = @(Get-Process -Name node -ErrorAction SilentlyContinue)
        $nodeWorkingSet = ($nodeProcesses | Measure-Object -Property WorkingSet64 -Sum).Sum
        $requests = @($activePorts | ForEach-Object {
            Measure-LocalHealth $_ '/healthz'
            Measure-LocalHealth $_ '/readyz'
        })
        $samples.Add([ordered]@{
            timestamp_utc = [DateTime]::UtcNow.ToString('o'); cpu_percent = $cpuPercent
            available_ram_gib = $available; pages_input_per_second = $pagesInput
            disk_queue_length = $diskQueue; node_process_count = $nodeProcesses.Count
            node_working_set_sum_gib = [math]::Round($nodeWorkingSet / 1GB, 3)
            health_requests = $requests
        })
        Write-Host "Baseline sample $($index + 1)/$SampleCount collected"
        if ($index -lt ($SampleCount - 1)) {
            $remaining = ($IntervalSeconds * 1000) - $sampleWatch.ElapsedMilliseconds
            if ($remaining -gt 0) { Start-Sleep -Milliseconds $remaining }
        }
    }
    if ($ReadyPort -gt 0 -and -not (Test-StartupReady)) { throw 'Fracto readiness was lost during collection' }
    if ($CpuProbeSeconds -gt 0) {
        Write-Host "Running a $CpuProbeSeconds-second single-thread SHA-256 probe (not an LLM benchmark)..."
        $buffer = New-Object byte[] (1MB)
        $hash = [Security.Cryptography.SHA256]::Create()
        $iterations = 0
        $watch = [Diagnostics.Stopwatch]::StartNew()
        try {
            while ($watch.Elapsed.TotalSeconds -lt $CpuProbeSeconds) {
                $null = $hash.ComputeHash($buffer)
                $iterations++
            }
            $probe = [ordered]@{ algorithm = 'sha256'; threads = 1; buffer_bytes = $buffer.Length
                elapsed_seconds = [math]::Round($watch.Elapsed.TotalSeconds, 3)
                processed_mib = $iterations; mib_per_second = [math]::Round($iterations / $watch.Elapsed.TotalSeconds, 2) }
        } finally { $hash.Dispose() }
    }
} finally { $client.Dispose() }

$healthSummary = @($activePorts | ForEach-Object {
    $port = $_
    foreach ($route in @('/healthz', '/readyz')) {
        $requests = @($samples | ForEach-Object { $_.health_requests } | Where-Object { $_.port -eq $port -and $_.route -eq $route })
        [ordered]@{ port = $port; route = $route; attempted = $requests.Count
            responses = @($requests | Where-Object { $null -ne $_.status }).Count
            http_200 = @($requests | Where-Object { $_.status -eq 200 }).Count
            latency_ms = Get-Summary @($requests | ForEach-Object { $_.latency_ms }) }
    }
})
$report = [ordered]@{
    schema_version = 1; benchmark_version = 2; node_label = $NodeLabel; fracto_startup_id = $RunId
    started_at_utc = $startedAt.ToString('o'); completed_at_utc = [DateTime]::UtcNow.ToString('o')
    methodology = [ordered]@{ sample_count = $SampleCount; requested_interval_seconds = $IntervalSeconds
        cpu_probe_seconds = $CpuProbeSeconds; inference_benchmarked = $false; stable_readiness_seconds = $SettleSeconds
        response_bodies_collected = $false; workload_description = 'Observed existing host load; no application workload was started' }
    inventory = $inventory
    summary = [ordered]@{
        cpu_percent = Get-Summary @($samples | ForEach-Object { $_.cpu_percent })
        available_ram_gib = Get-Summary @($samples | ForEach-Object { $_.available_ram_gib })
        pages_input_per_second = Get-Summary @($samples | ForEach-Object { $_.pages_input_per_second })
        health = $healthSummary
    }
    discovery = $discovery; samples = @($samples.ToArray()); single_thread_cpu_probe = $probe
    unavailable_cim_classes = @($issues.ToArray())
    limitations = @('A short baseline is not peak capacity or a controlled-load comparison.',
        'Health latency is not tile rendering or application interaction latency.',
        'WMI AdapterRAM and GPU name suffixes do not establish dedicated VRAM or Ollama acceleration support.',
        'Summed Node working sets are not private or exclusively Fracto memory.',
        'The optional SHA-256 probe does not predict model tokens per second.')
}
Save-Report $reportPath $report
Write-Host "Saved baseline: $reportPath"
Write-Output ($report.summary | ConvertTo-Json -Depth 7)
