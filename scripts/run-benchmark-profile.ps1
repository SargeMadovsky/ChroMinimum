param(
    [Parameter(Mandatory)]
    [ValidateSet('chrome', 'ungoogled-chromium', 'chrominimum')]
    [string]$Browser,
    [string]$Executable,
    [string]$Url = 'about:blank'
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$profileRoot = Join-Path $taskRoot 'test-profiles\comparison-2026-10-19'
$profilePath = Join-Path $profileRoot $Browser
if (-not (Test-Path -LiteralPath $profilePath -PathType Container)) {
    throw 'Prepared benchmark directory missing. Do not substitute a personal profile.'
}
if (-not $Executable) {
    $Executable = switch ($Browser) {
        'chrome' { Join-Path $profileRoot 'browsers\chrome\Chrome-bin\chrome.exe' }
        'ungoogled-chromium' { Join-Path $profileRoot 'browsers\ungoogled-chromium\ungoogled-chromium_155.0.8059.79-1.1_windows_x64\chrome.exe' }
        'chrominimum' { Join-Path $profilePath 'chrominimum.exe' }
    }
}
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
    throw "Browser executable not found: $Executable. Specify -Executable explicitly."
}
$Executable = (Resolve-Path -LiteralPath $Executable).Path
if ($Browser -eq 'chrominimum') {
    if ($Executable -ne (Join-Path $profilePath 'chrominimum.exe')) {
        throw 'Use the isolated ChroMinimum bundle to keep the profile separate.'
    }
    $previousDataDir = $env:CHROMINIMUM_DATA_DIR
    try {
        $env:CHROMINIMUM_DATA_DIR = $profilePath
        & $Executable "--url=$Url"
    } finally {
        $env:CHROMINIMUM_DATA_DIR = $previousDataDir
    }
} else {
    & $Executable "--user-data-dir=$profilePath" '--new-window' $Url
}
