# Sandbox runner: executes a command inside a Windows AppContainer.
#
# Called by src/win-sandbox.js:
#   powershell -File win-sandbox.ps1 -UserCommand <cmd> -WorkingDir <dir> -TimeoutMs <ms>
#
# Prints exactly one JSON line on stdout:
#   { "ok": true,  "exitCode": n, "timedOut": bool, "durationMs": n,
#     "outPath": "...", "errPath": "...", "codePath": "...", "pid": n }
#   { "ok": false, "stage": "...", "error": "..." }
#
# The user command's output is redirected to files inside the AppContainer's
# own storage folder, so the parent (unsandboxed) server can read them, while
# the sandboxed shell has no console and no other write access.

param(
  [Parameter(Mandatory = $true)][string]$UserCommand,
  [Parameter(Mandatory = $true)][string]$WorkingDir,
  [int]$TimeoutMs = 30000,
  [string]$ContainerName = "ClaudeFileManagerSandbox"
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class AppContainer {
  [StructLayout(LayoutKind.Sequential)]
  public struct STARTUPINFO {
    public int cb;
    public IntPtr lpReserved;
    public IntPtr lpDesktop;
    public IntPtr lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct STARTUPINFOEX {
    public STARTUPINFO StartupInfo;
    public IntPtr lpAttributeList;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct SECURITY_CAPABILITIES {
    public IntPtr AppContainerSid;
    public IntPtr Capabilities;
    public uint CapabilityCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
  }

  [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int CreateAppContainerProfile(
    string pszAppContainerName, string pszDisplayName, string pszDescription,
    IntPtr pCapabilities, uint dwCapabilityCount, out IntPtr ppSid);

  [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int DeriveAppContainerSidFromAppContainerName(
    string pszAppContainerName, out IntPtr ppSid);

  [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int GetAppContainerFolderPath(string pszAppContainerSid, out IntPtr ppszPath);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool ConvertSidToStringSid(IntPtr Sid, out IntPtr StringSid);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool InitializeProcThreadAttributeList(
    IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool UpdateProcThreadAttribute(
    IntPtr lpAttributeList, uint dwFlags, IntPtr Attribute, ref SECURITY_CAPABILITIES lpValue,
    IntPtr cbSize, IntPtr lpPrevValue, IntPtr lpReturnSize);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool DeleteProcThreadAttributeList(IntPtr lpAttributeList);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcessW(
    string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes,
    IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags,
    IntPtr lpEnvironment, string lpCurrentDirectory,
    ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr hObject);

  public const uint PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
  public const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  public const uint WAIT_OBJECT_0 = 0x00000000;
  public const uint WAIT_TIMEOUT = 0x00000102;

  // Launches powershell.exe inside the AppContainer and waits for it.
  // `sid` must be a valid AppContainer SID pointer. Returns a small JSON
  // object with the pid, exit code and whether the wait timed out.
  public static string Launch(string exe, string arguments, string workingDir,
                              IntPtr sid, int timeoutMs) {
    IntPtr attrList = IntPtr.Zero;
    IntPtr procHandle = IntPtr.Zero;
    IntPtr threadHandle = IntPtr.Zero;
    try {
      SECURITY_CAPABILITIES caps = new SECURITY_CAPABILITIES();
      caps.AppContainerSid = sid;
      caps.Capabilities = IntPtr.Zero;
      caps.CapabilityCount = 0;

      IntPtr attrSize = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
      attrList = Marshal.AllocHGlobal(attrSize);
      if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref attrSize)) {
        throw new Exception("InitializeProcThreadAttributeList failed: " + Marshal.GetLastWin32Error());
      }
      if (!UpdateProcThreadAttribute(attrList, 0,
            (IntPtr)PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, ref caps,
            (IntPtr)Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)), IntPtr.Zero, IntPtr.Zero)) {
        throw new Exception("UpdateProcThreadAttribute failed: " + Marshal.GetLastWin32Error());
      }

      STARTUPINFOEX si = new STARTUPINFOEX();
      si.lpAttributeList = attrList;
      si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));

      PROCESS_INFORMATION pi;
      string cmdLine = "\"" + exe + "\"" + arguments;
      uint flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT;
      if (!CreateProcessW(exe, cmdLine, IntPtr.Zero, IntPtr.Zero, false, flags,
                          IntPtr.Zero, workingDir, ref si, out pi)) {
        throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
      }
      procHandle = pi.hProcess;
      threadHandle = pi.hThread;

      uint waited = WaitForSingleObject(procHandle, (uint)timeoutMs);
      bool timedOut = waited == WAIT_TIMEOUT;
      if (timedOut) return "{\"pid\":" + pi.dwProcessId + ",\"timedOut\":true,\"exitCode\":null}";
      uint code;
      if (!GetExitCodeProcess(procHandle, out code)) {
        throw new Exception("GetExitCodeProcess failed: " + Marshal.GetLastWin32Error());
      }
      return "{\"pid\":" + pi.dwProcessId + ",\"timedOut\":false,\"exitCode\":" + (int)code + "}";
    } finally {
      if (threadHandle != IntPtr.Zero) CloseHandle(threadHandle);
      if (procHandle != IntPtr.Zero) CloseHandle(procHandle);
      if (attrList != IntPtr.Zero) DeleteProcThreadAttributeList(attrList);
      if (attrList != IntPtr.Zero) Marshal.FreeHGlobal(attrList);
    }
  }
}
"@

function Out-Result([hashtable]$data) {
  $data | ConvertTo-Json -Compress
  exit
}

function Fail([string]$stage, [string]$message) {
  Out-Result @{ ok = $false; stage = $stage; error = $message }
}

try {
  # Test hook: makes the sandbox fail on purpose so the fallback dialog
  # path can be exercised without breaking a real profile.
  if ($env:CFM_SANDBOX_TEST_FAIL) {
    Fail "test" "intentional sandbox failure (CFM_SANDBOX_TEST_FAIL)"
  }

  if (-not (Test-Path -LiteralPath $WorkingDir)) {
    Fail "workingdir" "Working directory does not exist: $WorkingDir"
  }

  # 1. Profile: create it (idempotent — returns success when it already
  #    exists and also repairs a half-registered one), then derive the SID.
  $sidPtr = [IntPtr]::Zero
  $created = [AppContainer]::CreateAppContainerProfile(
    $ContainerName, "Claude File Manager Sandbox", "Runs commands for Claude File Manager",
    [IntPtr]::Zero, 0, [ref]$sidPtr)
  if ($created -ne 0) {
    $derived = [AppContainer]::DeriveAppContainerSidFromAppContainerName($ContainerName, [ref]$sidPtr)
    if ($derived -ne 0) {
      Fail "profile" ("CreateAppContainerProfile failed: 0x{0:X8}" -f $created)
    }
  }

  # 2. SID as a string (for icacls) and the container's own storage folder.
  $sidStrPtr = [IntPtr]::Zero
  if (-not [AppContainer]::ConvertSidToStringSid($sidPtr, [ref]$sidStrPtr)) {
    Fail "sid" ("ConvertSidToStringSid failed: " + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
  $sidString = [Runtime.InteropServices.Marshal]::PtrToStringUni($sidStrPtr)

  # The profile storage folder is not created automatically — every
  # CreateAppContainerProfile container keeps it at
  # %LOCALAPPDATA%\Packages\<name>. Create it, then ask for the canonical
  # path (falls back to the constructed one).
  $containerFolder = Join-Path $env:LOCALAPPDATA "Packages\$ContainerName"
  New-Item -ItemType Directory -Path $containerFolder -Force | Out-Null

  $folderPtr = [IntPtr]::Zero
  $folderHr = [AppContainer]::GetAppContainerFolderPath($sidString, [ref]$folderPtr)
  if ($folderHr -eq 0) {
    $canonical = [Runtime.InteropServices.Marshal]::PtrToStringUni($folderPtr)
    if ($canonical) { $containerFolder = $canonical }
  }
  $scratch = Join-Path $containerFolder "scratch"
  New-Item -ItemType Directory -Path $scratch -Force | Out-Null

  $outFile = Join-Path $scratch "out.txt"
  $errFile = Join-Path $scratch "err.txt"
  $codeFile = Join-Path $scratch "code.txt"
  Remove-Item -LiteralPath $outFile, $errFile, $codeFile -Force -ErrorAction SilentlyContinue

  # 3. Grant modify rights inside the working folder itself. Its PARENTS
  #    stay untouched: changing ACLs there needs elevation (and hangs
  #    icacls on profile folders). Instead the folder is mapped to its own
  #    drive letter with `subst` (step 5), so the container reaches it
  #    without traversing the user profile at all.
  #    The grant is cached: a marker per folder skips the (potentially slow,
  #    recursive) icacls pass on every subsequent run. For drive roots the
  #    recursion is skipped entirely — new files inherit the rights, and
  #    modifying pre-existing ones would need the dialog anyway.
  $grantDir = Join-Path $containerFolder "grants"
  New-Item -ItemType Directory -Path $grantDir -Force | Out-Null
  $grantMarker = Join-Path $grantDir (($WorkingDir -replace '[^A-Za-z0-9]', '-') + ".done")
  if (Test-Path -LiteralPath $grantMarker) {
    # already granted for this folder in a previous run
  } elseif ([IO.Path]::GetPathRoot($WorkingDir) -eq $WorkingDir) {
    & icacls "$WorkingDir" /grant "*${sidString}:(OI)(CI)M" /C /Q | Out-Null
    New-Item -ItemType File -Path $grantMarker -Force | Out-Null
  } else {
    & icacls "$WorkingDir" /grant "*${sidString}:(OI)(CI)M" /T /C /Q | Out-Null
    New-Item -ItemType File -Path $grantMarker -Force | Out-Null
  }

  # 4. Map the working folder to a free drive letter for this session.
  $substDrive = $null
  $usedLetters = @([IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name.Substring(0, 2) })
  foreach ($letterChar in "ZYXWVUTSRQPONMLKJIHGFEDCBA".ToCharArray()) {
    $candidate = "${letterChar}:"
    if ($usedLetters -notcontains $candidate) { $substDrive = $candidate; break }
  }
  if (-not $substDrive) {
    Fail "subst" "no free drive letter to map the working folder"
  }
  & subst $substDrive "$WorkingDir"
  if ($LASTEXITCODE -ne 0) {
    Fail "subst" "could not map $substDrive to $WorkingDir"
  }
  $containerCwd = "$substDrive\"

  # 4. Inner script: the same UTF-8 preamble the unsandboxed path uses, the
  #    user command, output redirected into the container scratch files.
  $psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  if (-not (Test-Path -LiteralPath $psExe)) {
    Fail "exe" "powershell.exe not found at $psExe"
  }
  $inner = @(
    "`$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "`$OutputEncoding = [System.Text.Encoding]::UTF8",
    "`$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'",
    "`$PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'",
    "`$global:LASTEXITCODE = 0",
    "& {",
    $UserCommand,
    "} 1> '$outFile' 2> '$errFile'",
    "`$code = 0",
    "if (`$LASTEXITCODE -ne `$null -and `$LASTEXITCODE -ne 0) { `$code = `$LASTEXITCODE }",
    "elseif (`$Error.Count -gt 0) { `$code = 1 }",
    "Set-Content -LiteralPath '$codeFile' -Value `$code"
  ) -join "`r`n"
  $innerEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))

  # 5. Launch and wait, then drop the drive mapping.
  try {
    $startedAt = Get-Date
    $launchJson = [AppContainer]::Launch($psExe, " -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand $innerEncoded", $containerCwd, $sidPtr, $TimeoutMs)
    $durationMs = [int]((Get-Date) - $startedAt).TotalMilliseconds
    $launch = $launchJson | ConvertFrom-Json
  } finally {
    & subst $substDrive /d 2>$null
  }

  if ($launch.timedOut) {
    & taskkill /pid $launch.pid /t /f | Out-Null
    Out-Result @{
      ok = $true; timedOut = $true; exitCode = $null; durationMs = $durationMs
      outPath = $outFile; errPath = $errFile; codePath = $codeFile; pid = $launch.pid
    }
  }

  $exitCode = 0
  if ($launch.exitCode -ne $null -and $launch.exitCode -ne 0) {
    # The shell itself exited with a code (`exit 7` in the command) — trust
    # it over the bookkeeping file, which the exit would have skipped.
    $exitCode = [int]$launch.exitCode
  } elseif (Test-Path -LiteralPath $codeFile) {
    $raw = (Get-Content -LiteralPath $codeFile -Raw -ErrorAction SilentlyContinue)
    if ($null -ne $raw) { [void][int]::TryParse($raw.Trim(), [ref]$exitCode) }
  }
  Out-Result @{
    ok = $true; timedOut = $false; exitCode = $exitCode; durationMs = $durationMs
    outPath = $outFile; errPath = $errFile; codePath = $codeFile; pid = $launch.pid
  }
} catch {
  Fail "exception" $_.Exception.Message
}
