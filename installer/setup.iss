; Inno Setup 6 — Claude File Manager installer.
; Built by installer/build.mjs.

#ifndef MyAppVersion
  #define MyAppVersion "1.3.0"
#endif
#ifndef SourceDir
  #define SourceDir "build\app"
#endif
#ifndef OutputDir
  #define OutputDir "out"
#endif
#ifndef InstructionFile
  #define InstructionFile "INSTRUCTION.txt"
#endif
#ifndef IconFile
  #define IconFile "app.ico"
#endif

#define MyAppName "Claude File Manager"
#define MyAppPublisher "Claude File Manager"
#define MyAppExeName "start-ui.cmd"

[Setup]
AppId={{0A3514D8-D9CC-4CE2-A886-491E0B67DB04}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\ClaudeFileManager
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename=ClaudeFileManager-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
InfoAfterFile={#InstructionFile}
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\icon.ico
#if FileExists(IconFile)
SetupIconFile={#IconFile}
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional:"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Claude File Manager Setup"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Comment: "Choose a folder and connect the server to Claude Desktop"
Name: "{group}\Instruction"; Filename: "{app}\INSTRUCTION.txt"; IconFilename: "{app}\icon.ico"
Name: "{autodesktop}\Claude File Manager"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Tasks: desktopicon

[Run]
Filename: "{cmd}"; Parameters: "/c """"{app}\{#MyAppExeName}"""""; WorkingDir: "{app}"; Description: "Run setup now"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
