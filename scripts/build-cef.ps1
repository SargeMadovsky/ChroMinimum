param(
    [Parameter(Mandatory)][string]$BuildRoot,
    [ValidateSet('Download', 'Build')][string]$Stage = 'Download',
    [string]$Python = 'python',
    [ValidateRange(1, 32)][int]$Jobs = 8,
    [switch]$MediaCodecs
)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path $PSScriptRoot -Parent
$taskPolicy = Get-Content (Join-Path $taskProject 'patches/chromium/source-build.json') -Raw | ConvertFrom-Json
$taskRoot = [IO.Path]::GetFullPath($BuildRoot)
if ($taskRoot -match '\s') { throw 'CEF build root must not contain spaces' }
if ($taskRoot -eq [IO.Path]::GetPathRoot($taskRoot)) { throw 'Use a dedicated build directory' }
# Process-scoped Git configuration also covers dependency checkouts created by
# gclient. It does not change global Git settings or Windows filesystem policy.
$taskGitConfigCount = 0
if ($env:GIT_CONFIG_COUNT -and (-not [int]::TryParse($env:GIT_CONFIG_COUNT, [ref]$taskGitConfigCount) -or $taskGitConfigCount -lt 0)) {
    throw 'Invalid inherited GIT_CONFIG_COUNT'
}
Set-Item -LiteralPath "Env:GIT_CONFIG_KEY_$taskGitConfigCount" -Value 'core.longpaths'
Set-Item -LiteralPath "Env:GIT_CONFIG_VALUE_$taskGitConfigCount" -Value 'true'
$env:GIT_CONFIG_COUNT = [string]($taskGitConfigCount + 1)
New-Item -ItemType Directory -Path $taskRoot -Force | Out-Null
$taskTools = Join-Path $taskRoot 'depot_tools'
if (-not (Test-Path (Join-Path $taskTools '.git'))) {
    if ($Stage -ne 'Download') { throw 'Run Download first' }
    & git init $taskTools
    if ($LASTEXITCODE -ne 0) { throw 'depot_tools init failed' }
    & git -C $taskTools remote add origin https://chromium.googlesource.com/chromium/tools/depot_tools.git
    if ($LASTEXITCODE -ne 0) { throw 'depot_tools remote failed' }
    & git -C $taskTools fetch --depth 1 origin $taskPolicy.depot_tools_commit
    if ($LASTEXITCODE -ne 0) { throw 'Pinned depot_tools fetch failed' }
    & git -C $taskTools checkout --detach FETCH_HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Pinned depot_tools checkout failed' }
}
$taskToolsCommit = & git -C $taskTools rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify depot_tools' }
if ($taskToolsCommit -ne $taskPolicy.depot_tools_commit) {
    throw 'depot_tools revision differs from source-build.json; review and pin it explicitly'
}
$env:DEPOT_TOOLS_UPDATE = '0'
$env:DEPOT_TOOLS_WIN_TOOLCHAIN = '0'
$env:PYTHONUNBUFFERED = '1'
$env:PATH = "$taskTools;$env:PATH"
# gclient/vpython can work before the plain python-bin launcher is initialized.
# GN also uses that launcher, so bootstrap the pinned Windows tools explicitly.
if (-not (Test-Path (Join-Path $taskTools 'python3_bin_reldir.txt'))) {
    & (Join-Path $taskTools 'bootstrap/win_tools.bat')
    if ($LASTEXITCODE -ne 0) { throw 'Pinned depot_tools Windows bootstrap failed' }
}
$taskVswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$taskVs = & $taskVswhere -latest -version '[18.0,19.0)' -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 Microsoft.VisualStudio.Component.VC.ATLMFC -property installationPath
if (-not $taskVs) { throw 'Build Tools 2026 with C++/ATL/MFC required' }
$env:vs2026_install = $taskVs
$env:GYP_MSVS_VERSION = '2026'
# Local copy only. Never opt the toolchain into usage metrics.
'{"is-googler":false,"countdown":0,"opt-in":false,"version":3}' |
    Set-Content (Join-Path $taskTools 'metrics.cfg') -Encoding utf8
$taskAutomate = Join-Path $taskRoot 'automate-git.py'
if (-not (Test-Path $taskAutomate)) {
    & curl.exe -fL -o $taskAutomate "https://raw.githubusercontent.com/chromiumembedded/cef/$($taskPolicy.cef_commit)/tools/automate/automate-git.py"
    if ($LASTEXITCODE -ne 0) { throw 'automate-git download failed' }
}
if ((Get-FileHash $taskAutomate -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskPolicy.automate_git_sha256) {
    throw 'automate-git hash mismatch'
}
if ($Stage -eq 'Download') {
    $taskCheckout = Join-Path $taskRoot 'chromium/src'
    if (-not (Test-Path (Join-Path $taskCheckout '.git'))) {
        New-Item -ItemType Directory -Path (Join-Path $taskRoot 'chromium') -Force | Out-Null
        & git clone --config core.longpaths=true --depth 1 --single-branch --branch $taskPolicy.chromium https://chromium.googlesource.com/chromium/src.git $taskCheckout
        if ($LASTEXITCODE -ne 0) { throw 'Pinned Chromium clone failed' }
    }
    & $Python (Join-Path $PSScriptRoot 'configure-cef-checkout.py') --build-root $taskRoot
    if ($LASTEXITCODE -ne 0) { throw 'CEF checkout configuration failed' }
    # Always resume dependencies: an interrupted initial sync may leave a valid
    # Chromium HEAD while some CIPD packages are still missing.
    Push-Location (Join-Path $taskRoot 'chromium')
    try {
        & gclient.bat sync --nohooks --no-history
        if ($LASTEXITCODE -ne 0) { throw 'Chromium dependencies failed' }
    } finally { Pop-Location }
    $taskCefCheckout = Join-Path $taskRoot 'cef'
    if (-not (Test-Path (Join-Path $taskCefCheckout '.git'))) {
        & git init $taskCefCheckout
        if ($LASTEXITCODE -ne 0) { throw 'CEF init failed' }
        & git -C $taskCefCheckout remote add origin https://github.com/chromiumembedded/cef.git
        if ($LASTEXITCODE -ne 0) { throw 'CEF remote failed' }
        & git -C $taskCefCheckout fetch --depth 1 origin $taskPolicy.cef_commit
        if ($LASTEXITCODE -ne 0) { throw 'Pinned CEF fetch failed' }
        & git -C $taskCefCheckout checkout --detach FETCH_HEAD
        if ($LASTEXITCODE -ne 0) { throw 'Pinned CEF checkout failed' }
    }
    $taskPinnedCef = & git -C $taskCefCheckout rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $taskPinnedCef -ne $taskPolicy.cef_commit) { throw 'Unexpected CEF source revision; preserve and review it' }
    & $Python $taskAutomate "--download-dir=$taskRoot" "--depot-tools-dir=$taskTools" "--branch=$($taskPolicy.cef_branch)" "--checkout=$($taskPolicy.cef_commit)" --no-cef-update --no-depot-tools-update --no-chromium-history --no-build --no-distrib
    if ($LASTEXITCODE -ne 0) { throw 'CEF source download failed' }
    # automate-git skips runhooks for an already existing shallow checkout.
    $taskSourceRoot = Join-Path $taskRoot 'chromium/src'
    & $Python (Join-Path $taskSourceRoot 'cef/tools/patcher.py') --patch-file runhooks --patch-dir $taskSourceRoot
    if ($LASTEXITCODE -ne 0) { throw 'CEF runhooks patch failed' }
    Push-Location (Join-Path $taskRoot 'chromium')
    try {
        & gclient.bat runhooks
        if ($LASTEXITCODE -ne 0) { throw 'Chromium toolchain hooks failed' }
    } finally { Pop-Location }
    return
}
$taskSrc = Join-Path $taskRoot 'chromium/src'
$taskCef = Join-Path $taskSrc 'cef'
$taskChromiumCommit = & git -C $taskSrc rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $taskChromiumCommit -ne $taskPolicy.chromium_commit) { throw 'Wrong Chromium checkout' }
$taskCefCommit = & git -C $taskCef rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $taskCefCommit -ne $taskPolicy.cef_commit) { throw 'Wrong CEF checkout' }
Import-Module (Join-Path $taskVs 'Common7/Tools/Microsoft.VisualStudio.DevShell.dll')
Enter-VsDevShell -VsInstallPath $taskVs -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64 -winsdk=10.0.28000.0'
$env:GN_OUT_CONFIGS = 'Release_GN_x64'
# First validation build; final shipping performance has not been measured.
$env:GN_DEFINES = 'is_official_build=false is_component_build=false symbol_level=1 chrome_pgo_phase=0'
if ($MediaCodecs) {
    # Separate D032 experiment: upstream CEF with media codecs, no ListAccounts patch.
    & $Python (Join-Path $PSScriptRoot 'apply-cef-patches.py') --chromium-src $taskSrc --verify-unpatched
    if ($LASTEXITCODE -ne 0) { throw 'Media experiment source verification failed' }
    & $Python (Join-Path $PSScriptRoot 'apply-cef-patches.py') --chromium-src $taskSrc --build-fixes
    if ($LASTEXITCODE -ne 0) { throw 'Pinned MIDL build fix failed' }
    $env:GN_DEFINES += ' proprietary_codecs=true ffmpeg_branding=Chrome'
} else {
    & $Python (Join-Path $PSScriptRoot 'apply-cef-patches.py') --chromium-src $taskSrc
    if ($LASTEXITCODE -ne 0) { throw 'Required source patch failed' }
}
$taskBuildFixHash = if ($MediaCodecs) {
    (Get-Content (Join-Path $taskProject 'patches/chromium/0002-deterministic-midl-name-hash.json') -Raw | ConvertFrom-Json).after_sha256
} else { '' }
@{
    generated_at = [DateTimeOffset]::Now.ToString('o')
    cef_commit = $taskCefCommit
    chromium_commit = $taskChromiumCommit
    depot_tools_commit = $taskToolsCommit
    gn_defines = $env:GN_DEFINES
    media_codecs = [bool]$MediaCodecs
    midl_locale_normalization = [bool]$MediaCodecs
    midl_build_fix_sha256 = $taskBuildFixHash
    instance_tracer_fix_sha256 = $(if ($MediaCodecs) {
        (Get-Content (Join-Path $PSScriptRoot '../patches/chromium/0003-instance-tracer-untrace-reentrancy.json') -Raw | ConvertFrom-Json).after_sha256
    } else { $null })
    listaccounts_patch = -not [bool]$MediaCodecs
    external_protocol_patches = @('0012-cef-native-external-protocols', '0013-cef-explicit-numeric-protocol')
    configuration = $env:GN_OUT_CONFIGS
    jobs = $Jobs
    visual_studio = $taskVs
    windows_sdk = '10.0.28000.0'
    runtime_validated = $false
} | ConvertTo-Json | Set-Content (Join-Path $taskRoot 'build-recipe.json') -Encoding utf8
Push-Location $taskCef
try {
    & $Python tools/gclient_hook.py
    if ($LASTEXITCODE -ne 0) { throw 'CEF generation failed' }
    if (-not $MediaCodecs) {
        & $Python (Join-Path $PSScriptRoot 'apply-cef-patches.py') --chromium-src $taskSrc
        if ($LASTEXITCODE -ne 0) { throw 'Source patch lost during generation' }
    } else {
        & $Python (Join-Path $PSScriptRoot 'apply-cef-patches.py') --chromium-src $taskSrc --verify-unpatched
        if ($LASTEXITCODE -ne 0) { throw 'Media experiment source changed during generation' }
        & $Python (Join-Path $PSScriptRoot 'apply-cef-patches.py') --chromium-src $taskSrc --build-fixes
        if ($LASTEXITCODE -ne 0) { throw 'Pinned MIDL build fix lost during generation' }
        & $Python (Join-Path $PSScriptRoot 'apply-cef-patches.py') --chromium-src $taskSrc --runtime-fixes
        if ($LASTEXITCODE -ne 0) { throw 'Pinned instance tracer runtime fix failed' }
    }
    foreach ($taskProtocolPatch in @('0012', '0013')) {
        & $Python (Join-Path $PSScriptRoot 'apply-native-external-protocols.py') --chromium-src $taskSrc --patch $taskProtocolPatch
        if ($LASTEXITCODE -ne 0) { throw "Required external protocol patch failed: $taskProtocolPatch" }
    }
    if ($MediaCodecs) {
        # Validate every non-test MIDL action before the expensive C++ build.
        $taskLabels = @(& gn.bat ls ../out/Release_GN_x64 --testonly=false --default-toolchain)
        if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate MIDL targets' }
        $taskMidlTargets = @($taskLabels | Where-Object { $_ -match '^//.+_idl_action$' } |
            ForEach-Object { 'phony/' + $_.Substring(2).Replace(':', '/') })
        if (-not $taskMidlTargets.Count) { throw 'No MIDL targets found; inspect generated graph' }
        $taskMidlTargets | ConvertTo-Json | Set-Content (Join-Path $taskRoot 'midl-preflight-targets.json') -Encoding utf8
        Write-Host "Validating $($taskMidlTargets.Count) MIDL targets before libcef compilation"
        & autoninja.bat -C ../out/Release_GN_x64 "-j$Jobs" @taskMidlTargets
        if ($LASTEXITCODE -ne 0) { throw 'MIDL preflight failed; inspect generated output before retrying' }
    }
    & autoninja.bat -C ../out/Release_GN_x64 "-j$Jobs" libcef bootstrap bootstrapc
    if ($LASTEXITCODE -ne 0) { throw 'CEF compilation failed' }
} finally { Pop-Location }
Write-Output 'Experimental CEF compiled. Runtime acceptance and packaging are still required.'
