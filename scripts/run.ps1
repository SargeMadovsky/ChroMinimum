param(
    [string]$Url = 'about:blank',
    [string]$PdfPath
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskExe = Join-Path $taskRoot 'target\bundle\chrominimum.exe'
if (-not (Test-Path -LiteralPath $taskExe)) { throw 'Build first: .\scripts\build.ps1' }
if ($PdfPath) {
    $taskPdf = (Resolve-Path -LiteralPath $PdfPath).Path
    if ([IO.Path]::GetExtension($taskPdf) -ine '.pdf') { throw 'Choose a PDF file' }
    $Url = ([Uri]$taskPdf).AbsoluteUri
}
& $taskExe "--url=$Url"
