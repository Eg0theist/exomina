# Only the dedicated Node QA parent process may adjust its default object owner.
# No user, group, privilege, integrity level or machine policy is changed.
$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.processId -le 0 -or $request.parentProcessId -le 0) { throw 'Invalid dedicated QA process identifiers.' }
  $helper = Get-CimInstance Win32_Process -Filter "ProcessId = $PID"
  if ($helper.ParentProcessId -ne $request.processId) { throw 'The owner helper must be a direct child of its Node QA process.' }
  $process = Get-Process -Id $request.processId
  if (-not $process.MainModule.FileName.Equals([string]$request.executable,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($request.executable) -ne 'node.exe') { throw 'The owner helper is restricted to its exact Node QA executable.' }
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
public static class ExominaQaDefaultOwner {
  const uint QueryProcess=0x1000,QueryToken=0x0008,AdjustDefault=0x0080;
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,uint size,out uint needed);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int kind,IntPtr data,uint size);
  [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct FirstGroup { public uint Count; public SidAndAttributes First; }
  static Exception NativeError(){ return new Win32Exception(Marshal.GetLastWin32Error()); }
  static IntPtr Token(int pid,uint access){
    IntPtr process=OpenProcess(QueryProcess,false,pid);if(process==IntPtr.Zero)throw NativeError();
    try { IntPtr token;if(!OpenProcessToken(process,access,out token))throw NativeError();return token; }
    finally { CloseHandle(process); }
  }
  static IntPtr Information(IntPtr token,int kind,out uint size){
    GetTokenInformation(token,kind,IntPtr.Zero,0,out size);if(size==0)throw NativeError();
    IntPtr data=Marshal.AllocHGlobal((int)size);
    if(!GetTokenInformation(token,kind,data,size,out size)){Marshal.FreeHGlobal(data);throw NativeError();}return data;
  }
  static string Sid(IntPtr token,int kind){uint size;IntPtr data=Information(token,kind,out size);try{return new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value;}finally{Marshal.FreeHGlobal(data);}}
  static string Bytes(IntPtr token,int kind){uint size;IntPtr data=Information(token,kind,out size);try{byte[] bytes=new byte[size];Marshal.Copy(data,bytes,0,bytes.Length);return Convert.ToBase64String(bytes);}finally{Marshal.FreeHGlobal(data);}}
  static string Groups(IntPtr token,out bool administratorsCanOwn){
    uint size;IntPtr data=Information(token,2,out size);administratorsCanOwn=false;
    try {
      uint count=(uint)Marshal.ReadInt32(data);int offset=Marshal.OffsetOf(typeof(FirstGroup),"First").ToInt32(),step=Marshal.SizeOf(typeof(SidAndAttributes));
      StringBuilder result=new StringBuilder();
      for(int index=0;index<count;index++){
        SidAndAttributes group=(SidAndAttributes)Marshal.PtrToStructure(IntPtr.Add(data,offset+index*step),typeof(SidAndAttributes));
        string sid=new SecurityIdentifier(group.Sid).Value;result.Append(sid).Append(':').Append(group.Attributes).Append(';');
        if(sid=="S-1-5-32-544"&&(group.Attributes&8)!=0&&(group.Attributes&16)==0)administratorsCanOwn=true;
      }return result.ToString();
    }finally{Marshal.FreeHGlobal(data);}
  }
  static string Identity(IntPtr token){bool eligible;return Sid(token,1)+"|"+Groups(token,out eligible)+"|"+Bytes(token,3)+"|"+Bytes(token,18)+"|"+Sid(token,25);}
  static void SetOwner(IntPtr token,string sid){
    SecurityIdentifier value=new SecurityIdentifier(sid);byte[] bytes=new byte[value.BinaryLength];value.GetBinaryForm(bytes,0);
    IntPtr sidBuffer=Marshal.AllocHGlobal(bytes.Length),ownerBuffer=Marshal.AllocHGlobal(IntPtr.Size);
    try { Marshal.Copy(bytes,0,sidBuffer,bytes.Length);Marshal.WriteIntPtr(ownerBuffer,sidBuffer);if(!SetTokenInformation(token,4,ownerBuffer,(uint)IntPtr.Size))throw NativeError(); }
    finally { Marshal.FreeHGlobal(ownerBuffer);Marshal.FreeHGlobal(sidBuffer); }
  }
  public sealed class Receipt { public int processId;public string ownerBefore;public string ownerAfter;public string parentOwnerBefore;public string parentOwnerAfter;public bool changed;public bool identityUnchanged;public bool parentOwnerUnchanged;public bool administratorsCanOwn; }
  public static Receipt Prepare(int pid,int parentPid){
    IntPtr token=IntPtr.Zero,parent=IntPtr.Zero;string before=null;
    try {
      token=Token(pid,QueryToken|AdjustDefault);parent=Token(parentPid,QueryToken);
      string user=Sid(token,1),helperUser=WindowsIdentity.GetCurrent().User.Value;
      if(user!=helperUser)throw new InvalidOperationException("The QA process has a different user identity.");
      before=Sid(token,4);string parentBefore=Sid(parent,4),identityBefore=Identity(token);
      bool eligible;Groups(token,out eligible);
      if(before!=user&&before!="S-1-5-32-544")throw new InvalidOperationException("The QA process has an unexpected default owner.");
      bool changed=false,identityUnchanged,parentUnchanged;
      try {
        if(before!=user){SetOwner(token,user);changed=true;}
        identityUnchanged=Identity(token)==identityBefore;parentUnchanged=Sid(parent,4)==parentBefore;
        if(!parentUnchanged||!identityUnchanged||Sid(token,4)!=user)throw new InvalidOperationException("QA owner isolation or identity verification failed.");
      }catch {if(changed)SetOwner(token,before);throw;}
      string parentOwner=parentBefore==user?"current-user":parentBefore=="S-1-5-32-544"?"administrators":"other";
      return new Receipt {processId=pid,ownerBefore=before==user?"current-user":"administrators",ownerAfter="current-user",parentOwnerBefore=parentOwner,parentOwnerAfter=parentOwner,changed=before!=user,identityUnchanged=identityUnchanged,parentOwnerUnchanged=parentUnchanged,administratorsCanOwn=eligible};
    }finally{if(parent!=IntPtr.Zero)CloseHandle(parent);if(token!=IntPtr.Zero)CloseHandle(token);}
  }
}
'@
  [ExominaQaDefaultOwner]::Prepare([int]$request.processId,[int]$request.parentProcessId) | ConvertTo-Json -Compress
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
