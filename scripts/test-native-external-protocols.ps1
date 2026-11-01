param(
 [Parameter(Mandatory=$true)][string]$Executable,
 [Parameter(Mandatory=$true)][string]$OutputDirectory,
 [string]$Case='all'
)
$ErrorActionPreference='Stop'
$taskExe=(Resolve-Path -LiteralPath $Executable).Path
if(Test-Path -LiteralPath $OutputDirectory){throw 'Use a new output directory'}
$taskOutput=(New-Item -ItemType Directory -Path $OutputDirectory).FullName
$taskFixture=(New-Item -ItemType Directory -Path (Join-Path $taskOutput 'fixture')).FullName
$taskHandler=Join-Path $taskFixture 'capture.exe'
& rustc --edition 2024 (Join-Path $PSScriptRoot '../tests/native/external_protocol_capture.rs') -o $taskHandler
if($LASTEXITCODE -ne 0){throw 'Capture helper compilation failed'}
$taskScheme='chrominimum-probe-'+[guid]::NewGuid().ToString('N')
$taskKey='Software\Classes\'+$taskScheme
$taskCapture=Join-Path $taskFixture 'captured.txt'
foreach($taskProbeScheme in @($taskScheme,($taskScheme+'-missing'))){
 $taskCollision=[Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey($taskProbeScheme)
 if($taskCollision){$taskCollision.Dispose();throw 'Refusing an existing OS association'}
}
$taskExisting=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($taskKey)
if($taskExisting){$taskExisting.Dispose();throw 'Refusing existing protocol key'}
try {
 $taskReg=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($taskKey)
 $taskReg.SetValue('', 'URL:ChroMinimum disposable protocol test')
 $taskReg.SetValue('URL Protocol','')
 $taskReg.SetValue('FriendlyAppName','ChroMinimum protocol fixture')
 $taskCommand=$taskReg.CreateSubKey('shell\open\command')
 $taskCommand.SetValue('', '"'+$taskHandler+'" "'+$taskCapture+'" "%1"')
 $taskCommand.Dispose();$taskReg.Dispose()
 $taskArgs=@((Join-Path $PSScriptRoot 'test-external-protocols.cjs'),$taskExe,(Join-Path $taskOutput 'results'),$taskScheme,$taskCapture)
 if($Case -ne 'all'){$taskArgs+=$Case}
 & node @taskArgs
 $taskResult=$LASTEXITCODE
} finally {
 [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($taskKey,$false)
 $taskRemaining=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($taskKey)
 if($taskRemaining){$taskRemaining.Dispose();throw 'Temporary protocol cleanup failed'}
 @{scheme=$taskScheme;registry_removed=$true} | ConvertTo-Json | Set-Content (Join-Path $taskFixture 'cleanup.json')
}
exit $taskResult
