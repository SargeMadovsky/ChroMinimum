param([string]$Url, [int]$ExpectedStatus = 200, [switch]$Release)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskBundle = if ($Release) { 'target\release-bundle' } else { 'target\bundle' }
$taskExe = Join-Path $taskRoot "$taskBundle\chrominimum.exe"
$taskLog = Join-Path $taskRoot "$taskBundle\smoke.log"
if (-not (Test-Path $taskExe)) { throw 'Build first: .\scripts\build.ps1' }
$taskFixture = -not $Url
if ($taskFixture) { $Url = ([Uri](Join-Path $taskRoot 'tests\fixtures\smoke.html')).AbsoluteUri }
# This launches the interactive browser for a bounded test. It closes itself.
$taskRun = Start-Process -FilePath $taskExe -ArgumentList @('--smoke-test', "--url=$Url") -PassThru
if (-not $taskRun.WaitForExit(60000)) {
    throw "Smoke timed out; inspect test process $($taskRun.Id). No user process was terminated."
}
$taskRun.Refresh()
if ($taskRun.ExitCode -ne 0) { throw "Browser exit code: $($taskRun.ExitCode)" }
if (-not (Test-Path $taskLog)) { throw 'Smoke evidence file missing' }
$taskEvidence = Get-Content -LiteralPath $taskLog -Raw
$taskRequired = @('toolbar_created', 'browser_created', "main_frame_loaded; status=$ExpectedStatus", 'browser_closed', 'shutdown_complete')
if ($taskFixture) { $taskRequired += @('fixture_javascript_ok', 'navigation_controls_drawn', 'address_enter_navigated', 'back_button_navigated', 'forward_button_navigated', 'reload_button_navigated', 'window_icons_set', 'window_resized', 'window_maximized', 'window_restored', 'window_minimized', 'window_returned_to_normal') }
foreach ($taskMarker in $taskRequired) {
    if (-not $taskEvidence.Contains($taskMarker)) { throw "Missing smoke evidence: $taskMarker`n$taskEvidence" }
}
if ($taskEvidence.Contains('main_frame_error;')) { throw "Page load failed:`n$taskEvidence" }
$taskOthers = @(Get-Process -Name chrominimum -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $taskExe })
if ($taskOthers.Count) { throw 'ChroMinimum processes still running; close other instances before testing' }
$taskEvidence
'PASS: startup, native toolbar, main-frame load and graceful shutdown. Visual rendering/PDF interaction still needs manual verification.'
