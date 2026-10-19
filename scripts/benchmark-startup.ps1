param(
    [string]$Baseline = 'target\verified-loader-bundle\chrominimum.exe',
    [string]$Candidate = 'target\core-updater-bundle\chrominimum.exe',
    [int]$Runs = 10
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskResults = @()
$taskOldData = $env:CHROMINIMUM_DATA_DIR
try {
    for ($taskIteration = 1; $taskIteration -le $Runs; $taskIteration++) {
        # Interleave variants to reduce changes in machine load/cache bias.
        foreach ($taskVariant in @('baseline', 'candidate')) {
            $taskExecutable = Join-Path $taskRoot $(if ($taskVariant -eq 'baseline') { $Baseline } else { $Candidate })
            $taskData = Join-Path $taskRoot ".local\benchmark-$taskVariant"
            New-Item -ItemType Directory -Path $taskData -Force | Out-Null
            $taskLog = Join-Path $taskData 'smoke.log'
            if (Test-Path -LiteralPath $taskLog) { Remove-Item -LiteralPath $taskLog }
            $env:CHROMINIMUM_DATA_DIR = $taskData
            $taskWatch = [Diagnostics.Stopwatch]::StartNew()
            $taskProcess = Start-Process -FilePath $taskExecutable -ArgumentList @('--smoke-test', '--launcher-no-wait', '--url=about:blank') -PassThru -WindowStyle Hidden
            $taskReady = $false
            while ($taskWatch.Elapsed.TotalSeconds -lt 30) {
                if ((Test-Path $taskLog) -and (Get-Content -LiteralPath $taskLog -Raw).Contains('toolbar_created')) { $taskReady = $true; break }
                Start-Sleep -Milliseconds 10
            }
            $taskMilliseconds = $taskWatch.Elapsed.TotalMilliseconds
            if (-not $taskReady) { throw "Toolbar not ready for $taskVariant" }
            $taskResults += [pscustomobject]@{ variant=$taskVariant; iteration=$taskIteration; toolbar_ms=[math]::Round($taskMilliseconds, 1) }
            Write-Output "$taskVariant $taskIteration : $([math]::Round($taskMilliseconds)) ms"
            # Let this disposable browser complete its own bounded shutdown.
            while ($taskWatch.Elapsed.TotalSeconds -lt 65) {
                if ((Get-Content -LiteralPath $taskLog -Raw).Contains('shutdown_complete')) { break }
                Start-Sleep -Milliseconds 100
            }
            if (-not (Get-Content -LiteralPath $taskLog -Raw).Contains('shutdown_complete')) { throw 'Benchmark browser did not shut down' }
            Start-Sleep -Milliseconds 200
        }
    }
    $taskResults | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $taskRoot '.local\startup-benchmark.json')
} finally { $env:CHROMINIMUM_DATA_DIR = $taskOldData }
