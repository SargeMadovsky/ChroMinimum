param(
    [Parameter(Mandatory=$true)][string]$Iscc,
    [string]$Runtime,
    [string]$Baseline,
    [string]$Launcher,
    [string]$OutputDirectory,
    [switch]$TestInstall
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskWork = Join-Path $taskRoot ('.local/installer-build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskWork | Out-Null
Push-Location $taskRoot
try {
    if (-not $Runtime) {
        throw 'Alpha.8 requires a validated media CEF runtime. Pass -Runtime explicitly; stock CEF is not a compatible substitute.'
    }
    $taskPayload = "$taskWork/payload"
    if (-not $Launcher) { $Launcher = "$taskRoot/updater/target/release/cm-update.exe" }
    if (-not $OutputDirectory) { $OutputDirectory = "$taskRoot/dist" }
    $taskStageArgs = @("$PSScriptRoot/stage-installer.py", '--runtime', $Runtime, '--launcher', $Launcher, '--output', $taskPayload)
    if ($Baseline) { $taskStageArgs += @('--baseline', $Baseline) }
    python @taskStageArgs
    if ($LASTEXITCODE -ne 0) { throw 'Installer staging failed' }
    $taskCompilerArgs = @("/DPayloadDir=$taskPayload", "/DOutputDir=$OutputDirectory")
    if ($TestInstall) { $taskCompilerArgs += '/DTestInstall=1' }
    & $Iscc @taskCompilerArgs "$taskRoot/installer/windows.iss"
    if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed' }
    Write-Output "Payload audit: $taskPayload/payload-inspection.json"
} finally { Pop-Location }
