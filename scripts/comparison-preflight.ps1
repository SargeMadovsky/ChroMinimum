param([Parameter(Mandatory)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
# Read-only snapshot. Do not collect process command lines or profile contents.
$machine = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor
$os = Get-CimInstance Win32_OperatingSystem
$loads = @(1..3 | ForEach-Object {
    (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor | Where-Object Name -eq '_Total').PercentProcessorTime
    if ($_ -lt 3) { Start-Sleep -Seconds 1 }
})
$power = (& powercfg.exe /getactivescheme | Out-String).Trim()
$snapshot = [ordered]@{
    collectedUtc = [DateTime]::UtcNow.ToString('o')
    os = $os.Caption
    osVersion = $os.Version
    cpu = @($cpu | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors)
    ramBytes = $machine.TotalPhysicalMemory
    freeMemoryKiB = $os.FreePhysicalMemory
    cpuLoadSamplesPercent = $loads
    display = @(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, CurrentHorizontalResolution, CurrentVerticalResolution, CurrentRefreshRate)
    powerPlan = $power
    processNames = @(Get-Process | Select-Object -ExpandProperty ProcessName -Unique | Sort-Object)
    limitations = @('Snapshot does not prove absence of background activity', 'Display mode is OS-reported, not measured presentation timing')
}
$snapshot | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
