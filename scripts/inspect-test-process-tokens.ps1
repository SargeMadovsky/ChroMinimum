param([Parameter(Mandatory=$true)][uint32]$RootProcessId, [switch]$IncludeRoot)
$ErrorActionPreference = 'Stop'
# Read only our test launcher's live descendants. No SeDebugPrivilege or token mutation.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CmTestToken {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int size, out int needed);
  [DllImport("advapi32.dll")] static extern bool IsTokenRestricted(IntPtr token);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
  public sealed class Facts { public uint Pid; public int? IntegrityRid; public int? AppContainer; public bool Restricted; public int Error; }
  static int? IntegerInfo(IntPtr token, int kind) {
    IntPtr data=Marshal.AllocHGlobal(4);
    try { int needed; return GetTokenInformation(token,kind,data,4,out needed) ? (int?)Marshal.ReadInt32(data) : null; }
    finally { Marshal.FreeHGlobal(data); }
  }
  public static Facts Read(uint pid) {
    var result=new Facts {Pid=pid}; IntPtr token=IntPtr.Zero;
    IntPtr process=OpenProcess(0x1000,false,pid);
    if(process==IntPtr.Zero) {result.Error=Marshal.GetLastWin32Error();return result;}
    try {
      if(!OpenProcessToken(process,8,out token)) {result.Error=Marshal.GetLastWin32Error();return result;}
      result.Restricted=IsTokenRestricted(token);
      result.AppContainer=IntegerInfo(token,29);
      int needed; GetTokenInformation(token,25,IntPtr.Zero,0,out needed);
      if(needed<=0) {result.Error=Marshal.GetLastWin32Error();return result;}
      IntPtr data=Marshal.AllocHGlobal(needed);
      try {
        if(!GetTokenInformation(token,25,data,needed,out needed)) {result.Error=Marshal.GetLastWin32Error();return result;}
        IntPtr sid=Marshal.ReadIntPtr(data);
        byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));
        result.IntegrityRid=Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1)));
      } finally {Marshal.FreeHGlobal(data);}
      return result;
    } finally {if(token!=IntPtr.Zero)CloseHandle(token);CloseHandle(process);}
  }
}
'@
$taskProcesses = @(Get-CimInstance Win32_Process -Filter "Name='chrominimum.exe'")
$taskKnown = [System.Collections.Generic.HashSet[uint32]]::new()
[void]$taskKnown.Add($RootProcessId)
do {
    $taskAdded = $false
    foreach($taskProcess in $taskProcesses) {
        if($taskKnown.Contains([uint32]$taskProcess.ParentProcessId) -and $taskKnown.Add([uint32]$taskProcess.ProcessId)) { $taskAdded = $true }
    }
} while($taskAdded)
$taskResults = @(foreach($taskProcess in $taskProcesses) {
    if(($IncludeRoot -or $taskProcess.ProcessId -ne $RootProcessId) -and $taskKnown.Contains([uint32]$taskProcess.ProcessId)) {
        $taskRole = if($taskProcess.CommandLine -match '--type=([^ "\t]+)') { $Matches[1] } else { 'browser' }
        $taskSubtype = if($taskProcess.CommandLine -match '--utility-sub-type=([^ "\t]+)') { $Matches[1] } else { $null }
        $taskSandboxType = if($taskProcess.CommandLine -match '--service-sandbox-type=([^ "\t]+)') { $Matches[1] } else { $null }
        $taskToken = [CmTestToken]::Read([uint32]$taskProcess.ProcessId)
        [pscustomobject]@{Pid=$taskToken.Pid; Role=$taskRole; Subtype=$taskSubtype; SandboxType=$taskSandboxType; IntegrityRid=$taskToken.IntegrityRid; AppContainer=$taskToken.AppContainer; Restricted=$taskToken.Restricted; Error=$taskToken.Error}
    }
})
ConvertTo-Json -InputObject $taskResults -Depth 3 -Compress
