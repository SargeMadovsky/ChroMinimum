param([string]$Url, [int]$ExpectedStatus = 200, [switch]$Release, [string]$BundleDirectory, [ValidateSet('ready','current','error')][string]$UpdaterExpected)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskBundle = if ($Release) { 'target\release-bundle' } else { 'target\bundle' }
if ($BundleDirectory) { $taskBundle = $BundleDirectory }
$taskExe = Join-Path $taskRoot "$taskBundle\chrominimum.exe"
$taskLog = Join-Path $taskRoot "$taskBundle\smoke.log"
if (-not (Test-Path $taskExe)) { throw 'Build first: .\scripts\build.ps1' }
if (Test-Path -LiteralPath $taskLog) { Remove-Item -LiteralPath $taskLog }
$taskFixture = -not $Url
if ($taskFixture) { $Url = ([Uri](Join-Path $taskRoot 'tests\fixtures\smoke.html')).AbsoluteUri }
# This launches the interactive browser for a bounded test. It closes itself.
$taskArguments = @('--smoke-test', "--url=$Url")
if ($UpdaterExpected) { $taskArguments += '--exercise-updater' }
$taskRun = Start-Process -FilePath $taskExe -ArgumentList $taskArguments -PassThru
if (-not $taskRun.WaitForExit($(if ($UpdaterExpected) { 180000 } else { 60000 }))) {
    throw "Smoke timed out; inspect test process $($taskRun.Id). No user process was terminated."
}
$taskRun.Refresh()
if ($taskRun.ExitCode -ne 0) { throw "Browser exit code: $($taskRun.ExitCode)" }
if (-not (Test-Path $taskLog)) { throw 'Smoke evidence file missing' }
$taskEvidence = Get-Content -LiteralPath $taskLog -Raw
$taskRequired = @('toolbar_created', 'browser_created', "main_frame_loaded; status=$ExpectedStatus", 'browser_closed', 'shutdown_complete')
if ($taskFixture) { $taskRequired += @('fixture_javascript_ok', 'navigation_controls_drawn', 'address_enter_navigated', 'back_button_navigated', 'forward_button_navigated', 'reload_button_navigated', 'window_icons_set', 'window_resized', 'window_maximized', 'window_restored', 'window_minimized', 'window_returned_to_normal') }
if ($UpdaterExpected) { $taskRequired += @('core_update_button_pressed', 'core_update_control_drawn', "core_update_status=$UpdaterExpected") }
foreach ($taskMarker in $taskRequired) {
    if (-not $taskEvidence.Contains($taskMarker)) { throw "Missing smoke evidence: $taskMarker`n$taskEvidence" }
}
if ($taskEvidence.Contains('main_frame_error;')) { throw "Page load failed:`n$taskEvidence" }
$taskPrefix = [IO.Path]::GetDirectoryName($taskExe) + [IO.Path]::DirectorySeparatorChar
$taskOthers = @(Get-Process -Name chrominimum -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($taskPrefix, [StringComparison]::OrdinalIgnoreCase) })
if ($taskOthers.Count) { throw 'ChroMinimum processes still running; close other instances before testing' }
$taskEvidence
'PASS: startup, native toolbar, main-frame load and graceful shutdown. Visual rendering/PDF interaction still needs manual verification.'
