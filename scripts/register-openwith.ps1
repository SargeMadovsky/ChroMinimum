param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\ChroMinimum')
)

$ErrorActionPreference = 'Stop'
$exe = Join-Path $InstallDir 'chrominimum.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "ChroMinimum was not found at '$exe'. Pass its installation directory with -InstallDir."
}

function Set-RegString([string]$Path, [string]$Name, [string]$Value) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($Path)
    try { $key.SetValue($Name, $Value, [Microsoft.Win32.RegistryValueKind]::String) }
    finally { $key.Dispose() }
}

function Set-RegOpenWith([string]$Extension, [string]$ProgId) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Software\Classes\$Extension\OpenWithProgids")
    try { $key.SetValue($ProgId, [byte[]]::new(0), [Microsoft.Win32.RegistryValueKind]::None) }
    finally { $key.Dispose() }
}

$exeCommand = '"' + $exe + '" --open "%1"'
$appKey = 'Software\Classes\Applications\chrominimum.exe'
Set-RegString $appKey 'FriendlyAppName' 'ChroMinimum'
Set-RegString "$appKey\DefaultIcon" '' "$exe,0"
Set-RegString "$appKey\shell\open\command" '' $exeCommand
foreach ($ext in '.html', '.htm', '.pdf') { Set-RegString "$appKey\SupportedTypes" $ext '' }

Set-RegString 'Software\ChroMinimum\Capabilities' 'ApplicationName' 'ChroMinimum'
Set-RegString 'Software\ChroMinimum\Capabilities' 'ApplicationDescription' 'Minimal browser for HTML and PDF'
Set-RegString 'Software\ChroMinimum\Capabilities' 'ApplicationIcon' "$exe,0"
Set-RegString 'Software\ChroMinimum\Capabilities\FileAssociations' '.html' 'ChroMinimum.HTML'
Set-RegString 'Software\ChroMinimum\Capabilities\FileAssociations' '.htm' 'ChroMinimum.HTML'
Set-RegString 'Software\ChroMinimum\Capabilities\FileAssociations' '.pdf' 'ChroMinimum.PDF'
Set-RegString 'Software\RegisteredApplications' 'ChroMinimum' 'Software\ChroMinimum\Capabilities'

Set-RegString 'Software\Classes\ChroMinimum.HTML' '' 'ChroMinimum HTML document'
Set-RegString 'Software\Classes\ChroMinimum.HTML\DefaultIcon' '' "$exe,0"
Set-RegString 'Software\Classes\ChroMinimum.HTML\shell\open\command' '' $exeCommand
Set-RegString 'Software\Classes\ChroMinimum.PDF' '' 'ChroMinimum PDF document'
Set-RegString 'Software\Classes\ChroMinimum.PDF\DefaultIcon' '' "$exe,0"
Set-RegString 'Software\Classes\ChroMinimum.PDF\shell\open\command' '' $exeCommand
Set-RegOpenWith '.html' 'ChroMinimum.HTML'
Set-RegOpenWith '.htm' 'ChroMinimum.HTML'
Set-RegOpenWith '.pdf' 'ChroMinimum.PDF'

Add-Type -Namespace ChroMinimum -Name ShellNotify -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("shell32.dll")]
public static extern void SHChangeNotify(int eventId, uint flags, System.IntPtr item1, System.IntPtr item2);
'@
[ChroMinimum.ShellNotify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Output 'ChroMinimum is registered for Open with for .html, .htm, and .pdf. Default applications were not changed.'
