param([switch]$Release)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskVswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $taskVswhere)) { throw 'Install Visual Studio Build Tools; see docs/SETUP_WINDOWS.md' }
$taskVsRoot = & $taskVswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $taskVsRoot) { throw 'MSVC x64 tools not found' }
Import-Module (Join-Path $taskVsRoot 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll')
Enter-VsDevShell -VsInstallPath $taskVsRoot -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64'
Push-Location $taskRoot
try {
    $taskArgs = @('build', '--locked', '--lib', '--bin', 'bundle')
    if ($Release) { $taskArgs += '--release' }
    cargo @taskArgs
    if ($LASTEXITCODE -ne 0) { throw "Build failed: $LASTEXITCODE" }
    $taskProfile = if ($Release) { 'release' } else { 'debug' }
    & (Join-Path $taskRoot "target\$taskProfile\bundle.exe")
    if ($LASTEXITCODE -ne 0) { throw "Packaging failed: $LASTEXITCODE" }
} finally { Pop-Location }
