param(
  [string]$Output = (Join-Path $PSScriptRoot '..\..\Workspace\qa-taskbar-icons'),
  [string]$ExePath = 'C:\Program Files\Exomina\App\Exomina.exe',
  [long]$WindowHandle = 0,
  [int]$WindowProcessId = 0,
  [string]$ShortcutList = ''
)
$ErrorActionPreference = 'Stop'
$null = New-Item -ItemType Directory -Force -Path $Output
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class ExominaShellIconProbe {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct FileInfo { public IntPtr icon; public int index; public uint attributes; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string displayName; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=80)] public string typeName; }
  [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern IntPtr SHGetFileInfo(string path,uint attributes,out FileInfo info,uint size,uint flags);
  [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern uint ExtractIconEx(string path,int index,IntPtr[] large,IntPtr[] small,uint count);
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
  delegate bool WindowCallback(IntPtr window,IntPtr argument);
  [DllImport("user32.dll")]static extern bool EnumWindows(WindowCallback callback,IntPtr argument);
  [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr window,out uint processId);
  [StructLayout(LayoutKind.Sequential)] struct Key { public Guid format; public uint id; public Key(uint value) { format=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");id=value; } }
  [StructLayout(LayoutKind.Explicit,Size=24)] struct Value { [FieldOffset(0)] public ushort type; [FieldOffset(8)] public IntPtr pointer; }
  [ComImport,Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface Store {
    [PreserveSig]int GetCount(out uint count);[PreserveSig]int GetAt(uint index,out Key key);[PreserveSig]int GetValue(ref Key key,out Value value);[PreserveSig]int SetValue(ref Key key,ref Value value);[PreserveSig]int Commit();
  }
  [DllImport("shell32.dll")]static extern int SHGetPropertyStoreForWindow(IntPtr window,ref Guid iid,[MarshalAs(UnmanagedType.Interface)]out Store store);
  [DllImport("ole32.dll")]static extern int PropVariantClear(ref Value value);
  public static string Property(IntPtr window,uint id) { var iid=new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");Store store;Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(window,ref iid,out store));try{var key=new Key(id);Value value;Marshal.ThrowExceptionForHR(store.GetValue(ref key,out value));try{return value.type==31?Marshal.PtrToStringUni(value.pointer):null;}finally{PropVariantClear(ref value);}}finally{Marshal.ReleaseComObject(store);} }
  public static IntPtr FindWindow(uint processId) { IntPtr found=IntPtr.Zero;EnumWindows((window,arg)=>{uint owner;GetWindowThreadProcessId(window,out owner);if(owner==processId){try{if(Property(window,5)=="local.exomina.desktop"){found=window;return false;}}catch{}}return true;},IntPtr.Zero);return found; }
  static void Save(IntPtr handle,string destination) { if(handle==IntPtr.Zero) throw new Exception("No icon handle for "+destination); using(var icon=(Icon)Icon.FromHandle(handle).Clone()) using(var bitmap=icon.ToBitmap()) bitmap.Save(destination,ImageFormat.Png); }
  public static void Shell(string path,string destination) { FileInfo info; SHGetFileInfo(path,0,out info,(uint)Marshal.SizeOf(typeof(FileInfo)),0x100); try { Save(info.icon,destination); } finally { if(info.icon!=IntPtr.Zero)DestroyIcon(info.icon); } }
  public static void Resource(string path,string destination) { var large=new IntPtr[1]; var small=new IntPtr[1]; ExtractIconEx(path,0,large,small,1); try { Save(large[0],destination); } finally { if(large[0]!=IntPtr.Zero)DestroyIcon(large[0]);if(small[0]!=IntPtr.Zero)DestroyIcon(small[0]); } }
  public static bool Window(IntPtr window,string destination) { var icon=SendMessage(window,0x7f,(IntPtr)1,IntPtr.Zero); if(icon==IntPtr.Zero)return false;Save(icon,destination);return true; }
}
'@ -ReferencedAssemblies System.Drawing
function Palette([string]$file) {
  $bitmap = [Drawing.Bitmap]::FromFile($file)
  try {
    $purple = 0; $mint = 0
    for ($y=0;$y -lt $bitmap.Height;$y++) { for ($x=0;$x -lt $bitmap.Width;$x++) {
      $pixel = $bitmap.GetPixel($x,$y)
      if ($pixel.A -lt 128) { continue }
      if ($pixel.B -gt 120 -and $pixel.R -gt 100 -and $pixel.B -gt $pixel.G*1.08 -and $pixel.R -gt $pixel.G*1.05) { $purple++ }
      if ($pixel.G -gt 110 -and $pixel.G -gt $pixel.R*1.1 -and $pixel.B -gt $pixel.R*1.05) { $mint++ }
    } }
    return [pscustomobject]@{width=$bitmap.Width;height=$bitmap.Height;purple=$purple;mint=$mint}
  } finally { $bitmap.Dispose() }
}
$exe = $ExePath
$records = @()
$resource = Join-Path $Output 'installed-resource.png'
[ExominaShellIconProbe]::Resource($exe,$resource)
$records += [pscustomobject]@{kind='installed-resource';path=$exe;image=$resource;palette=(Palette $resource)}
$shell = New-Object -ComObject WScript.Shell
$shellFolder = New-Object -ComObject Shell.Application
$shortcuts = if ($ShortcutList) { @(Get-Content -LiteralPath $ShortcutList -Raw | ConvertFrom-Json) } else { @((Join-Path ([Environment]::GetFolderPath('Programs')) 'Exomina.lnk'),(Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Exomina.lnk')) }
for ($i=0;$i -lt $shortcuts.Count;$i++) {
  $shortcut = $shortcuts[$i]
  if (-not (Test-Path -LiteralPath $shortcut)) { continue }
  $link = $shell.CreateShortcut($shortcut)
  $item = $shellFolder.NameSpace((Split-Path -Parent $shortcut)).ParseName((Split-Path -Leaf $shortcut))
  $image = Join-Path $Output "shell-shortcut-$i.png"
  [ExominaShellIconProbe]::Shell($shortcut,$image)
  $records += [pscustomobject]@{kind='shell-shortcut';path=$shortcut;target=$link.TargetPath;icon=$link.IconLocation;appId=$item.ExtendedProperty('System.AppUserModel.ID');image=$image;palette=(Palette $image)}
}
$windows = if ($WindowHandle) { @([pscustomobject]@{Id='fixture';MainWindowHandle=[IntPtr]$WindowHandle}) } elseif ($WindowProcessId) { $taskHandle=[ExominaShellIconProbe]::FindWindow($WindowProcessId);if($taskHandle -eq [IntPtr]::Zero){throw "No Exomina window for process $WindowProcessId"};@([pscustomobject]@{Id=$WindowProcessId;MainWindowHandle=$taskHandle}) } else { @(Get-Process -Name Exomina -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }) }
foreach ($process in $windows) {
  $image = Join-Path $Output "window-$($process.Id).png"
  $properties = [pscustomobject]@{appId=[ExominaShellIconProbe]::Property($process.MainWindowHandle,5);relaunchIcon=[ExominaShellIconProbe]::Property($process.MainWindowHandle,3);relaunchCommand=[ExominaShellIconProbe]::Property($process.MainWindowHandle,2);displayName=[ExominaShellIconProbe]::Property($process.MainWindowHandle,4)}
  if ([ExominaShellIconProbe]::Window($process.MainWindowHandle,$image)) { $records += [pscustomobject]@{kind='window';pid=$process.Id;image=$image;properties=$properties;palette=(Palette $image)} }
}
ConvertTo-Json -InputObject @($records) -Depth 5
