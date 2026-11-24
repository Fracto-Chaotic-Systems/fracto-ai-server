function Set-FractoOllamaAccelerationEnvironment([string]$Runtime) {
    $configuration = Join-Path $Runtime 'acceleration.json'
    if (-not (Test-Path -LiteralPath $configuration)) { return }
    $settings = Get-Content -LiteralPath $configuration -Raw | ConvertFrom-Json
    if ($settings.schema_version -ne 1 -or $settings.integrated_gpu -isnot [bool]) {
        throw 'Invalid managed Ollama acceleration configuration'
    }
    if ($settings.integrated_gpu) {
        $env:OLLAMA_IGPU_ENABLE = '1'
        $env:OLLAMA_VULKAN = '1'
    } else {
        $env:OLLAMA_IGPU_ENABLE = '0'
    }
}
