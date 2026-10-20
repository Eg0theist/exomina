# Hidden native Windows job regression. No provider/account/model is used.
param([string]$Output='')
$ErrorActionPreference='Stop'
if(-not $Output){$Output=Join-Path (Split-Path -Parent $PSScriptRoot) ('.verification\app-lifetime-'+[Guid]::NewGuid().ToString('N'))}
$Output=[IO.Path]::GetFullPath($Output)
$null=New-Item -ItemType Directory -Path $Output -Force
$native=Join-Path $Output 'ExominaLifetimeFixture.exe'
$source=@'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public class ExominaLifetimeFixture {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {public long processTime,jobTime;public uint flags;public UIntPtr min,max;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
  [StructLayout(LayoutKind.Sequential)] struct Io {public ulong read,write,other,readBytes,writeBytes,otherBytes;}
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {public BasicLimits basic;public Io io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref ExtendedLimits limits,int size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static string Quote(string value){var s=new StringBuilder("\"");int n=0;foreach(char c in value){if(c=='\\'){n++;continue;}s.Append('\\',c=='"'?n*2+1:n);s.Append(c);n=0;}s.Append('\\',n*2);return s.Append('"').ToString();}
  static Process Start(string exe,params string[] args){var s=new ProcessStartInfo(exe);s.UseShellExecute=false;s.CreateNoWindow=true;var b=new StringBuilder();foreach(string arg in args){if(b.Length>0)b.Append(' ');b.Append(Quote(arg));}s.Arguments=b.ToString();return Process.Start(s);}
  static void Until(string file){DateTime deadline=DateTime.UtcNow.AddSeconds(20);while(!File.Exists(file)){if(DateTime.UtcNow>deadline)throw new Exception("Fixture timed out.");Thread.Sleep(50);}}
  static string Json(string value){return "\""+value.Replace("\\","\\\\").Replace("\"","\\\"")+"\"";}
  public static int Main(string[] args){try{
    if(args[0]=="sentinel"){
      bool job;if(!IsProcessInJob(Process.GetCurrentProcess().Handle,IntPtr.Zero,out job))throw new Win32Exception();
      var b=new StringBuilder("{\"pid\":").Append(Process.GetCurrentProcess().Id).Append(",\"inJob\":").Append(job?"true":"false").Append(",\"profile\":").Append(Json(Environment.GetEnvironmentVariable("EXOMINA_DATA_DIR")??"")).Append(",\"relay\":").Append(Json(Environment.GetEnvironmentVariable("EXOMINA_WINDOWS_INDEPENDENT")??"")).Append(",\"args\":[");for(int i=2;i<args.Length;i++){if(i>2)b.Append(',');b.Append(Json(args[i]));}b.Append("]}");File.WriteAllText(args[1],b.ToString());Thread.Sleep(60000);return 0;
    }
    string mode=args[1],directory=args[2],exe=Process.GetCurrentProcess().MainModule.FileName,ready=Path.Combine(directory,mode+"-ready.json"),report=Path.Combine(directory,mode+"-sentinel.json");
    IntPtr jobHandle=CreateJobObject(IntPtr.Zero,null);var limits=new ExtendedLimits();limits.basic.flags=(uint)(0x2000|(mode=="denied"?0:0x800));
    if(!SetInformationJobObject(jobHandle,9,ref limits,Marshal.SizeOf(limits))||!AssignProcessToJobObject(jobHandle,Process.GetCurrentProcess().Handle))throw new Win32Exception();
    if(mode=="baseline"){Process child=Start(exe,"sentinel",report);Until(report);File.WriteAllText(ready,"{\"pid\":"+child.Id+",\"inheritedJob\":true}");}
    else{Start(args[3],args[4],exe,args[5],report,ready);Until(ready);if(mode=="isolated")Until(report);}
    File.WriteAllText(Path.Combine(directory,mode+"-parent-closed.json"),"{\"closingKillOnCloseJob\":true}");CloseHandle(jobHandle);return 0;
  }catch(Exception e){if(args.Length>2)File.WriteAllText(Path.Combine(args[2],"fixture-error.txt"),e.ToString());return 1;}}
}
'@
$null=Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $native -OutputType WindowsApplication
$node=(Get-Command node.exe).Source
$child=Join-Path $PSScriptRoot 'qa-app-lifetime-child.mjs'
$relay=Join-Path (Split-Path -Parent $PSScriptRoot) 'desktop\app-lifetime.ps1'
$results=@()
foreach($mode in @('baseline','isolated','denied')){
  $arguments=@('supervisor',$mode,$Output,$node,$child,$relay)|ForEach-Object {'"'+$_.Replace('"','\"')+'"'}
  $process=Start-Process -FilePath $native -ArgumentList ($arguments -join ' ') -WindowStyle Hidden -PassThru
  $deadline=(Get-Date).AddSeconds(25)
  while(-not(Test-Path -LiteralPath (Join-Path $Output ($mode+'-parent-closed.json')))){
    if(Test-Path -LiteralPath (Join-Path $Output 'fixture-error.txt')){throw (Get-Content -LiteralPath (Join-Path $Output 'fixture-error.txt') -Raw)}
    if((Get-Date)-gt$deadline){throw 'Fixture parent did not close.'};Start-Sleep -Milliseconds 100
  }
  $ready=Get-Content -LiteralPath (Join-Path $Output ($mode+'-ready.json')) -Raw|ConvertFrom-Json
  Start-Sleep -Milliseconds 500
  if($mode -eq 'baseline'){$alive=$null-ne(Get-Process -Id $ready.pid -ErrorAction SilentlyContinue);if($alive){throw 'Baseline unexpectedly survived its parent job.'};$results+=@{case=$mode;terminatedWithParent=$true};continue}
  if($mode -eq 'denied'){if($ready.handedOff){throw 'Denied job incorrectly handed off.'};if($ready.status-ne'failed'){throw 'Denied job did not report its limit.'};$results+=@{case=$mode;keptOriginalUntilParentClosed=$true;status=$ready.status};continue}
  $sentinel=Get-Content -LiteralPath (Join-Path $Output ($mode+'-sentinel.json')) -Raw|ConvertFrom-Json
  $alive=$null-ne(Get-Process -Id $sentinel.pid -ErrorAction SilentlyContinue)
  try{
    if(-not$ready.handedOff-or-not$alive-or$sentinel.inJob){throw 'The independent replacement did not survive the parent job.'}
    if($sentinel.profile-ne'C:\Synthetic Exomina Lifetime Profile'){throw 'The profile environment changed.'}
    $expected=@('A "quoted" argument','C:\folder with space\','literal $() & >')
    for($i=0;$i-lt$expected.Count;$i++){if($sentinel.args[$i]-ne$expected[$i]){throw 'Argument escaping changed a synthetic argument.'}}
    if($sentinel.relay-notmatch'^[a-f0-9-]{36}$'){throw 'The replacement is missing the loop guard.'}
    $results+=@{case=$mode;survivedParent=$alive;outsideParentJob=(-not$sentinel.inJob);profileAndArgumentsPreserved=$true}
  }finally{if($alive){Stop-Process -Id $sentinel.pid -Force}}
}
$report=@{passed=$true;syntheticOnly=$true;hiddenGuiFixture=$true;cases=$results;output=$Output}
[IO.File]::WriteAllText((Join-Path $Output 'result.json'),($report|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
$report|ConvertTo-Json -Depth 5
