; Offline per-user installer. Never writes UserChoice or takes file defaults.
#ifndef PayloadDir
  #error PayloadDir is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif
#ifdef TestInstall
  #define ProductName "ChroMinimum Installer Test"
  #define ProductKey "ChroMinimumInstallerTest"
  #define ApplicationKey "chrominimum-installer-test.exe"
  #define ProductId "{A2E35663-B679-48AC-B955-93675043DB12}"
  #define OutputName "ChroMinimum-0.0.1-alpha.8-test-setup-x64"
#else
  #define ProductName "ChroMinimum"
  #define ProductKey "ChroMinimum"
  #define ApplicationKey "chrominimum.exe"
  #define ProductId "{50721CF3-BB5E-4C4A-97F2-960DE6E8AE01}"
  #define OutputName "ChroMinimum-0.0.1-alpha.8-setup-x64"
#endif

[Setup]
AppId={{#ProductId}
AppName={#ProductName}
AppVersion=0.0.1-alpha.8
VersionInfoVersion=0.0.1.8
AppPublisher=ChroMinimum contributors
AppPublisherURL=https://github.com/SargeMadovsky/ChroMinimum
DefaultDirName={localappdata}\Programs\{#ProductKey}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
DisableProgramGroupPage=yes
DisableDirPage=no
LicenseFile={#PayloadDir}\LICENSE
OutputDir={#OutputDir}
OutputBaseFilename={#OutputName}
SetupIconFile=..\assets\chrominimum.ico
UninstallDisplayIcon={app}\{#ApplicationKey}
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
ChangesAssociations=yes
CloseApplications=no
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Types]
Name: "standard"; Description: "Core + English + Russian / Ядро + английский + русский"
Name: "minimal"; Description: "Core + English / Ядро + английский"
Name: "custom"; Description: "Custom / Выбор компонентов"; Flags: iscustom

[Components]
Name: "core"; Description: "Browser core and PDF / Ядро браузера и PDF"; Types: standard minimal custom; Flags: fixed
Name: "english"; Description: "English (required fallback) / Английский (обязательный)"; Types: standard minimal custom; Flags: fixed
Name: "russian"; Description: "Russian CEF interface / Русский интерфейс CEF"; Types: standard

[Tasks]
Name: "desktopicon"; Description: "Desktop shortcut / Ярлык на рабочем столе"; Flags: unchecked

[Files]
Source: "{#PayloadDir}\chrominimum.exe"; DestDir: "{tmp}"; DestName: "cm-installer.exe"; Flags: dontcopy
Source: "{#PayloadDir}\core\seed\installer-seed.json"; DestDir: "{tmp}"; DestName: "installer-seed.json"; Flags: dontcopy
Source: "{#PayloadDir}\chrominimum.exe"; DestDir: "{app}"; DestName: "{#ApplicationKey}"; Flags: ignoreversion
Source: "{#PayloadDir}\core\seed\*"; Excludes: "locales\*"; DestDir: "{app}\core\seed"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadDir}\core\seed\locales\en-US*.pak"; DestDir: "{app}\core\seed\locales"; Components: english; Flags: ignoreversion
Source: "{#PayloadDir}\core\seed\locales\ru*.pak"; DestDir: "{app}\core\seed\locales"; Components: russian; Flags: ignoreversion
Source: "{#PayloadDir}\LICENSE*"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\THIRD_PARTY.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\third_party\*"; DestDir: "{app}\third_party"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadDir}\install-en-US.json"; DestDir: "{app}"; DestName: "installation.json"; Check: not WizardIsComponentSelected('russian'); Flags: ignoreversion
Source: "{#PayloadDir}\install-ru.json"; DestDir: "{app}"; DestName: "installation.json"; Components: russian; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#ProductName}"; Filename: "{app}\{#ApplicationKey}"
Name: "{autodesktop}\{#ProductName}"; Filename: "{app}\{#ApplicationKey}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\{#ProductKey}\Capabilities"; ValueType: string; ValueName: "ApplicationName"; ValueData: "{#ProductName}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\{#ProductKey}\Capabilities"; ValueType: string; ValueName: "ApplicationDescription"; ValueData: "Minimal browser for HTML and PDF"
Root: HKCU; Subkey: "Software\{#ProductKey}\Capabilities"; ValueType: string; ValueName: "ApplicationIcon"; ValueData: "{app}\{#ApplicationKey},0"
Root: HKCU; Subkey: "Software\RegisteredApplications"; ValueType: string; ValueName: "{#ProductKey}"; ValueData: "Software\{#ProductKey}\Capabilities"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\{#ProductKey}\Capabilities\FileAssociations"; ValueType: string; ValueName: ".html"; ValueData: "{#ProductKey}.HTML"
Root: HKCU; Subkey: "Software\{#ProductKey}\Capabilities\FileAssociations"; ValueType: string; ValueName: ".htm"; ValueData: "{#ProductKey}.HTML"
Root: HKCU; Subkey: "Software\{#ProductKey}\Capabilities\FileAssociations"; ValueType: string; ValueName: ".pdf"; ValueData: "{#ProductKey}.PDF"
Root: HKCU; Subkey: "Software\Classes\{#ProductKey}.HTML"; ValueType: string; ValueData: "ChroMinimum HTML document"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\{#ProductKey}.HTML\DefaultIcon"; ValueType: string; ValueData: "{app}\{#ApplicationKey},0"
Root: HKCU; Subkey: "Software\Classes\{#ProductKey}.HTML\shell\open\command"; ValueType: string; ValueData: """{app}\{#ApplicationKey}"" --open ""%1"""
Root: HKCU; Subkey: "Software\Classes\{#ProductKey}.PDF"; ValueType: string; ValueData: "ChroMinimum PDF document"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\{#ProductKey}.PDF\DefaultIcon"; ValueType: string; ValueData: "{app}\{#ApplicationKey},0"
Root: HKCU; Subkey: "Software\Classes\{#ProductKey}.PDF\shell\open\command"; ValueType: string; ValueData: """{app}\{#ApplicationKey}"" --open ""%1"""
Root: HKCU; Subkey: "Software\Classes\Applications\{#ApplicationKey}"; ValueType: string; ValueName: "FriendlyAppName"; ValueData: "{#ProductName}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\Applications\{#ApplicationKey}"; ValueType: none; ValueName: ""; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\Applications\{#ApplicationKey}\DefaultIcon"; ValueType: string; ValueData: "{app}\{#ApplicationKey},0"
Root: HKCU; Subkey: "Software\Classes\Applications\{#ApplicationKey}\shell\open\command"; ValueType: string; ValueData: """{app}\{#ApplicationKey}"" --open ""%1"""
Root: HKCU; Subkey: "Software\Classes\Applications\{#ApplicationKey}\SupportedTypes"; ValueType: string; ValueName: ".html"; ValueData: ""; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\Applications\{#ApplicationKey}\SupportedTypes"; ValueType: string; ValueName: ".htm"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\Applications\{#ApplicationKey}\SupportedTypes"; ValueType: string; ValueName: ".pdf"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\.html\OpenWithProgids"; ValueType: none; ValueName: "{#ProductKey}.HTML"; Flags: uninsdeletevalue uninsdeletekeyifempty
Root: HKCU; Subkey: "Software\Classes\.htm\OpenWithProgids"; ValueType: none; ValueName: "{#ProductKey}.HTML"; Flags: uninsdeletevalue uninsdeletekeyifempty
Root: HKCU; Subkey: "Software\Classes\.pdf\OpenWithProgids"; ValueType: none; ValueName: "{#ProductKey}.PDF"; Flags: uninsdeletevalue uninsdeletekeyifempty

[Run]
Filename: "{app}\{#ApplicationKey}"; Description: "Launch ChroMinimum / Запустить ChroMinimum"; Flags: postinstall nowait skipifsilent unchecked
Filename: "ms-settings:defaultapps?registeredAppUser={#ProductKey}"; Description: "Choose default apps in Windows / Выбрать приложения по умолчанию"; Flags: shellexec postinstall nowait skipifsilent unchecked

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  ExtractTemporaryFile('cm-installer.exe');
  ExtractTemporaryFile('installer-seed.json');
  if not Exec(ExpandConstant('{tmp}\cm-installer.exe'), '--installer-preflight "' + ExpandConstant('{app}') + '" "' + ExpandConstant('{tmp}\installer-seed.json') + '"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
    Result := 'Cannot safely upgrade this installation. Close ChroMinimum; a newer security baseline may be required.';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then begin
    { AppContainer reads executable/runtime only. The profile is in a separate directory. }
    if not Exec(ExpandConstant('{sys}\icacls.exe'), '"' + ExpandConstant('{app}\core') + '" /grant "*S-1-15-2-1:(OI)(CI)(RX)"',
        '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
      RaiseException('Could not grant read/execute access required by the network sandbox.');
    if not Exec(ExpandConstant('{app}\{#ApplicationKey}'), '--migrate-installation "' + ExpandConstant('{app}') + '"',
        '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
      RaiseException('Could not migrate the core security state. Close ChroMinimum and rerun the installer.');
  end;
  if (CurStep = ssPostInstall) and not WizardIsComponentSelected('russian') then begin
    DeleteFile(ExpandConstant('{app}\core\seed\locales\ru.pak'));
    DeleteFile(ExpandConstant('{app}\core\seed\locales\ru_FEMININE.pak'));
    DeleteFile(ExpandConstant('{app}\core\seed\locales\ru_MASCULINE.pak'));
    DeleteFile(ExpandConstant('{app}\core\seed\locales\ru_NEUTER.pak'));
  end;
end;
