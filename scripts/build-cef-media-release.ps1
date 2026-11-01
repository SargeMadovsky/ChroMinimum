param([string]$BuildRoot = 'C:\cm-media154', [ValidateRange(1,8)][int]$Jobs = 4)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path $PSScriptRoot -Parent
$taskEvidence = Join-Path $taskProject '.local/media-release-20261022'
New-Item -ItemType Directory -Force $taskEvidence | Out-Null
$taskSrc = Join-Path $BuildRoot 'chromium/src'
$taskOut = Join-Path $taskSrc 'out/Release_Media_Official_x64'
function Set-BuildState([string]$stage) {
    @{stage=$stage; pid=$PID; output=$taskOut; timestamp=[DateTimeOffset]::Now.ToString('o'); runtime_validated=$false} |
        ConvertTo-Json | Set-Content (Join-Path $taskEvidence 'state.json')
}
Start-Transcript -Path (Join-Path $taskEvidence 'build.log') -Append
try {
    $taskPolicy = Get-Content (Join-Path $taskProject 'patches/chromium/source-build.json') -Raw | ConvertFrom-Json
    foreach ($taskPair in @(@($taskSrc,$taskPolicy.chromium_commit), @((Join-Path $taskSrc 'cef'),$taskPolicy.cef_commit), @((Join-Path $BuildRoot 'depot_tools'),$taskPolicy.depot_tools_commit))) {
        $taskCommit = & git -C $taskPair[0] rev-parse HEAD
        if ($LASTEXITCODE -ne 0 -or $taskCommit -ne $taskPair[1]) { throw 'Pinned checkout mismatch' }
    }
    $env:DEPOT_TOOLS_WIN_TOOLCHAIN='0'
    $env:DEPOT_TOOLS_UPDATE='0'
    $env:PATH="$(Join-Path $BuildRoot 'depot_tools');$env:PATH"
    $taskVswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    $taskVs = & $taskVswhere -latest -version '[18.0,19.0)' -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 Microsoft.VisualStudio.Component.VC.ATLMFC -property installationPath
    if (-not $taskVs) { throw 'Pinned VS generation unavailable' }
    $env:vs2026_install=$taskVs
    $env:GYP_MSVS_VERSION='2026'
    Import-Module (Join-Path $taskVs 'Common7/Tools/Microsoft.VisualStudio.DevShell.dll')
    Enter-VsDevShell -VsInstallPath $taskVs -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64 -winsdk=10.0.28000.0'
    foreach ($taskMode in @('--verify-unpatched','--build-fixes','--runtime-fixes')) {
        & python (Join-Path $PSScriptRoot 'apply-cef-patches.py') --chromium-src $taskSrc $taskMode
        if ($LASTEXITCODE -ne 0) { throw "Source verification failed: $taskMode" }
    }
    Set-BuildState 'generating'
    # Let pinned CEF select its official Windows defaults. Keep PGO disabled:
    # no external profile download or unreviewed profile revision is introduced.
    $env:GN_OUT_CONFIGS='Release_GN_x64'
    $env:GN_DEFINES='is_official_build=true is_component_build=false symbol_level=1 chrome_pgo_phase=0 proprietary_codecs=true ffmpeg_branding=Chrome'
    $taskGenerator = @'
import pathlib, sys
src = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(src / 'cef/tools'))
import gn_args
config = gn_args.GetAllPlatformConfigs({}, quiet=True)['Release_GN_x64']
assert config['is_official_build'] and config['proprietary_codecs']
assert not config.get('enable_backup_ref_ptr_instance_tracer', False)
out = src / 'out/Release_Media_Official_x64'
out.mkdir(exist_ok=True)
(out / 'args.gn').write_text(gn_args.GetConfigFileContents(config) + '\n', encoding='utf-8')
'@
    $taskGenerator | & python - $taskSrc
    if ($LASTEXITCODE -ne 0) { throw 'Official configuration generation failed' }
    Copy-Item -LiteralPath (Join-Path $taskOut 'args.gn') -Destination (Join-Path $taskEvidence 'args.gn')
    Push-Location $taskSrc
    try {
        & gn.bat gen out/Release_Media_Official_x64
        if ($LASTEXITCODE -ne 0) { throw 'GN generation failed' }
        & gn.bat args out/Release_Media_Official_x64 --list --short | Set-Content (Join-Path $taskEvidence 'effective-args.txt')
        if ($LASTEXITCODE -ne 0) { throw 'Effective argument inspection failed' }
        $taskEffective = Get-Content (Join-Path $taskEvidence 'effective-args.txt') -Raw
        foreach ($taskRequired in @('enable_backup_ref_ptr_support = true','enable_backup_ref_ptr_instance_tracer = false','enable_gwp_asan_malloc = true','enable_gwp_asan_partitionalloc = true')) {
            if (-not $taskEffective.Contains($taskRequired)) { throw "Review required: $taskRequired" }
        }
        foreach ($taskProtocolPatch in @('0012', '0013')) {
            & python (Join-Path $PSScriptRoot 'apply-native-external-protocols.py') --chromium-src $taskSrc --patch $taskProtocolPatch
            if ($LASTEXITCODE -ne 0) { throw "Required external protocol patch failed: $taskProtocolPatch" }
        }
        Set-BuildState 'compiling'
        & autoninja.bat -C out/Release_Media_Official_x64 "-j$Jobs" libcef bootstrap bootstrapc
        if ($LASTEXITCODE -ne 0) { throw 'Compilation failed' }
        Set-BuildState 'compiled_not_validated'
    } finally { Pop-Location }
} catch {
    Set-BuildState ('failed: ' + $_.Exception.Message)
    throw
} finally { Stop-Transcript }
