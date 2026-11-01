param([string[]]$Extensions = @('.html', '.htm', '.pdf'))
$ErrorActionPreference = 'Stop'
# Read-only Windows shell enumeration; never calls MakeDefault or Invoke.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class CmAssociations {
  [ComImport, Guid("973810AE-9599-4B88-9E4D-6EE98C9552DA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface Enumerator { [PreserveSig] int Next(uint count, out Handler handler, out uint fetched); }
  [ComImport, Guid("F04061AC-1659-4A3F-A954-775AA57FC083"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface Handler {
    void GetName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetUIName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetIconLocation([MarshalAs(UnmanagedType.LPWStr)] out string path, out int index);
    [PreserveSig] int IsRecommended();
  }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=true)]
  static extern int SHAssocEnumHandlers(string extension, uint filter, out Enumerator result);
  public sealed class Row { public string Extension; public string Name; public string DisplayName; public bool Recommended; }
  public static Row[] Read(string extension) {
    Enumerator enumerator;
    Marshal.ThrowExceptionForHR(SHAssocEnumHandlers(extension,0,out enumerator));
    var rows=new List<Row>();
    try {
      while(true) {
        Handler handler; uint fetched;
        int code=enumerator.Next(1,out handler,out fetched);
        Marshal.ThrowExceptionForHR(code);
        if(fetched==0) break;
        try {
          string name, uiName; handler.GetName(out name); handler.GetUIName(out uiName);
          rows.Add(new Row {Extension=extension,Name=name,DisplayName=uiName,Recommended=handler.IsRecommended()==0});
        } finally { Marshal.ReleaseComObject(handler); }
      }
    } finally { Marshal.ReleaseComObject(enumerator); }
    return rows.ToArray();
  }
}
'@
@(foreach($taskExtension in $Extensions) {
    if ($taskExtension -notin @('.html','.htm','.pdf')) { throw 'Only the supported browser file types are inspected' }
    [CmAssociations]::Read($taskExtension)
}) | ConvertTo-Json -Depth 4
