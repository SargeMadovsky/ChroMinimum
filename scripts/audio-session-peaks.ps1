# Test helper: peak output level of every audio session on the default render
# device, per process, sampled for -DurationMs. Read-only (Core Audio meters);
# changes no volume or device. Prints a JSON array [{pid, state, peak}].
param([int]$DurationMs = 1500)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace ChroMinimumTest {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints();
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object result);
  }
  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    int GetAudioSessionControl();
    int GetSimpleAudioVolume();
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  }
  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
  }
  [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    int GetDisplayName(); int SetDisplayName(); int GetIconPath(); int SetIconPath();
    int GetGroupingParam(); int SetGroupingParam();
    int RegisterAudioSessionNotification(); int UnregisterAudioSessionNotification();
    int GetSessionIdentifier(); int GetSessionInstanceIdentifier();
    [PreserveSig] int GetProcessId(out uint pid);
  }
  [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioMeterInformation {
    [PreserveSig] int GetPeakValue(out float peak);
  }
  public class Sample { public uint pid; public int state; public float peak; }
  public static class Peaks {
    public static List<Sample> Measure(int durationMs) {
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice device;
      // eRender, eMultimedia; no default device means no measurement.
      if (enumerator.GetDefaultAudioEndpoint(0, 1, out device) != 0) return null;
      var iid = typeof(IAudioSessionManager2).GUID;
      object manager;
      Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out manager));
      var result = new Dictionary<uint, Sample>();
      for (int elapsed = 0; elapsed <= durationMs; elapsed += 50) {
        // Re-enumerate: a stream that starts during sampling adds a session.
        IAudioSessionEnumerator sessions;
        Marshal.ThrowExceptionForHR(((IAudioSessionManager2)manager).GetSessionEnumerator(out sessions));
        int count; sessions.GetCount(out count);
        for (int i = 0; i < count; i++) {
          IAudioSessionControl2 session; if (sessions.GetSession(i, out session) != 0) continue;
          uint pid; int state; float peak;
          session.GetProcessId(out pid); session.GetState(out state);
          ((IAudioMeterInformation)session).GetPeakValue(out peak);
          Sample s;
          if (!result.TryGetValue(pid, out s)) { s = new Sample { pid = pid }; result[pid] = s; }
          s.state = Math.Max(s.state, state); s.peak = Math.Max(s.peak, peak);
        }
        System.Threading.Thread.Sleep(50);
      }
      return new List<Sample>(result.Values);
    }
  }
}
'@
$samples = [ChroMinimumTest.Peaks]::Measure($DurationMs)
if ($null -eq $samples) { '"no-device"' } else { ConvertTo-Json -Compress -InputObject @($samples) }
