param([Parameter(Mandatory=$true)][string]$RuntimeDirectory,
      [Parameter(Mandatory=$true)][string]$StopPath)
$ErrorActionPreference = 'Stop'
$runtimeRoot = [IO.Path]::GetFullPath($RuntimeDirectory).TrimEnd('\') + '\'
$names = @(Get-ChildItem -LiteralPath $RuntimeDirectory -Filter *.exe -Recurse -File | ForEach-Object BaseName | Sort-Object -Unique)
$session = (Get-Process -Id $PID).SessionId
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BrowserCpuHandles {
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
    public static double Cpu(IntPtr handle) {
        long created, exited, kernel, user;
        if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new System.ComponentModel.Win32Exception();
        return (kernel + user) / 10000000.0;
    }
}
'@
$clockStartUtc = [DateTime]::UtcNow
$clock = [Diagnostics.Stopwatch]::StartNew()
$handles = @{}
[Console]::WriteLine('{"ready":true}')
try {
while (-not (Test-Path -LiteralPath $StopPath)) {
    $begin = $clock.Elapsed.TotalMilliseconds
    $rows = @()
    foreach ($proc in @(Get-Process -Name $names -ErrorAction SilentlyContinue)) {
        try {
            if ($proc.SessionId -ne $session) { continue }
            $image = $proc.Path
            if (-not $image) { throw "Cannot read executable path for candidate PID $($proc.Id)" }
            if (-not $image.StartsWith($runtimeRoot, [StringComparison]::OrdinalIgnoreCase)) { continue }
            $proc.Refresh()
            $birth = $proc.StartTime.ToUniversalTime()
            $created = $birth.Ticks.ToString()
            $key = "$($proc.Id):$created"
            if (-not $handles.ContainsKey($key)) {
                $handle = [BrowserCpuHandles]::OpenProcess(0x1000, $false, $proc.Id)
                if ($handle -eq [IntPtr]::Zero) { throw "Cannot retain CPU query handle for PID $($proc.Id)" }
                $handles[$key] = @{handle=$handle; pid=$proc.Id; created=$created; bornElapsedMs=($birth-$clockStartUtc).TotalMilliseconds}
            }
            $rows += @{pid=$proc.Id; created=$created;
                privateBytes=$proc.PrivateMemorySize64; workingSetBytes=$proc.WorkingSet64;
                cpuSeconds=$proc.TotalProcessorTime.TotalSeconds; image=$image}
        } catch {
            # A process may naturally disappear between enumeration and reading.
            if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
                [Console]::WriteLine((@{error=$_.Exception.Message} | ConvertTo-Json -Compress))
            }
        } finally { $proc.Dispose() }
    }
    $ledger = @()
    foreach ($entry in $handles.Values) {
        try { $ledger += @{pid=$entry.pid; created=$entry.created; bornElapsedMs=$entry.bornElapsedMs; cpuSeconds=[BrowserCpuHandles]::Cpu($entry.handle)} }
        catch { [Console]::WriteLine((@{error=$_.Exception.Message} | ConvertTo-Json -Compress)) }
    }
    $own = Get-Process -Id $PID
    $result = @{elapsedMs=$clock.Elapsed.TotalMilliseconds; sampleCostMs=($clock.Elapsed.TotalMilliseconds-$begin);
        samplerCpuSeconds=$own.TotalProcessorTime.TotalSeconds; samplerPrivateBytes=$own.PrivateMemorySize64;
        logicalProcessors=[Environment]::ProcessorCount; rows=@($rows); cpuLedger=@($ledger)}
    $own.Dispose()
    [Console]::WriteLine(($result | ConvertTo-Json -Depth 5 -Compress))
    # A per-attempt stop marker ends this short-lived observer; no service installed.
    Start-Sleep -Milliseconds ([Math]::Max(1, 1000-[int]($clock.Elapsed.TotalMilliseconds-$begin)))
}
} finally { foreach ($entry in $handles.Values) { [void][BrowserCpuHandles]::CloseHandle($entry.handle) } }
