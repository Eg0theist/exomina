using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.ComponentModel;
public static class ExominaVaultNative {
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint low, high; }
  [StructLayout(LayoutKind.Sequential)] struct FileInfo { public uint attributes; public FileTime creation, access, write; public uint serial, sizeHigh, sizeLow, links, indexHigh, indexLow; }
  [StructLayout(LayoutKind.Sequential)] struct HashList { public uint count; public IntPtr entries; }
  [StructLayout(LayoutKind.Sequential)] struct Entry { public uint length; public IntPtr sid, hash, display; }
  [StructLayout(LayoutKind.Sequential)] struct Blob { public uint count; public IntPtr data; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string p, uint a, uint s, IntPtr sa, uint c, uint f, IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out FileInfo i);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint QueryUsersOnEncryptedFile(string p, out IntPtr users);
  [DllImport("advapi32.dll")] static extern void FreeEncryptionCertificateHashList(IntPtr users);
  static string Extended(string path) { return path.StartsWith(@"\\?\") ? path : @"\\?\" + path; }
  public static uint Links(string path) {
    using (var handle=CreateFile(Extended(path),0x80,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero)) {
      FileInfo info; if (handle.IsInvalid || !GetFileInformationByHandle(handle,out info)) throw new Win32Exception(); return info.links;
    }
  }
  public static string[] Recipients(string path) {
    IntPtr pointer; uint status=QueryUsersOnEncryptedFile(Extended(path),out pointer);
    if(status==2)throw new System.IO.FileNotFoundException("A vault entry disappeared during verification.");
    if(status==3)throw new System.IO.DirectoryNotFoundException("A vault directory disappeared during verification.");
    if(status!=0)throw new Win32Exception((int)status);
    try {
      var list=(HashList)Marshal.PtrToStructure(pointer,typeof(HashList)); if(list.count>500)throw new InvalidOperationException();
      var values=new string[list.count];
      for(int i=0;i<list.count;i++) {
        var entry=(Entry)Marshal.PtrToStructure(Marshal.ReadIntPtr(list.entries,i*IntPtr.Size),typeof(Entry));
        var blob=(Blob)Marshal.PtrToStructure(entry.hash,typeof(Blob));if(blob.count>64)throw new InvalidOperationException();
        var bytes=new byte[blob.count];Marshal.Copy(blob.data,bytes,0,bytes.Length);values[i]=BitConverter.ToString(bytes).Replace("-","");
      }
      return values;
    }finally{FreeEncryptionCertificateHashList(pointer);}
  }
}
public static class ExominaFastAudit {
  const uint Reparse=0x400, DirectoryFlag=0x10, Encrypted=0x4000;
  const string NetworkSid="S-1-15-3-1024-395641907-2340533657-1796656376-1949871151-3167452726-3934347287-2361051074-3061173417";
  static readonly System.Text.RegularExpressions.Regex NetworkPath=new System.Text.RegularExpressions.Regex(@"^(?:(?:browser-data|setup-profile)\\)?(?:Partitions\\[^\\]+\\)?(?:Network|Cache|Shared Dictionary)(?:\\|$)",System.Text.RegularExpressions.RegexOptions.IgnoreCase|System.Text.RegularExpressions.RegexOptions.CultureInvariant);
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] struct Time { public uint low,high; }
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] struct Info { public uint attributes;public Time creation,access,write;public uint serial,sizeHigh,sizeLow,links,indexHigh,indexLow; }
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential,CharSet=System.Runtime.InteropServices.CharSet.Unicode)] struct StreamInfo { public long size;[System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.ByValTStr,SizeConst=296)]public string name; }
  [System.Runtime.InteropServices.DllImport("kernel32.dll",CharSet=System.Runtime.InteropServices.CharSet.Unicode,SetLastError=true)]static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string p,uint access,uint share,System.IntPtr security,uint disposition,uint flags,System.IntPtr template);
  [System.Runtime.InteropServices.DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle handle,out Info info);
  [System.Runtime.InteropServices.DllImport("advapi32.dll",SetLastError=true)]static extern uint GetSecurityInfo(Microsoft.Win32.SafeHandles.SafeFileHandle handle,uint type,uint flags,out System.IntPtr owner,out System.IntPtr group,out System.IntPtr dacl,out System.IntPtr sacl,out System.IntPtr descriptor);
  [System.Runtime.InteropServices.DllImport("advapi32.dll")]static extern uint GetSecurityDescriptorLength(System.IntPtr descriptor);
  [System.Runtime.InteropServices.DllImport("kernel32.dll")]static extern System.IntPtr LocalFree(System.IntPtr pointer);
  [System.Runtime.InteropServices.DllImport("kernel32.dll",CharSet=System.Runtime.InteropServices.CharSet.Unicode,SetLastError=true)]static extern System.IntPtr FindFirstStreamW(string file,int level,out StreamInfo info,uint flags);
  [System.Runtime.InteropServices.DllImport("kernel32.dll",CharSet=System.Runtime.InteropServices.CharSet.Unicode,SetLastError=true)]static extern bool FindNextStreamW(System.IntPtr find,out StreamInfo info);
  [System.Runtime.InteropServices.DllImport("kernel32.dll",SetLastError=true)]static extern bool FindClose(System.IntPtr find);
  public sealed class Result { public int Files,Directories,Unencrypted,EmptyUnencrypted,UnsafeAccess;public double ElapsedMs; }
  sealed class Item { public string Path,Relative;public bool ParentEncrypted,ExpectedDirectory; }
  static string Extended(string path){return path.StartsWith(@"\\?\",System.StringComparison.Ordinal)?path:@"\\?\"+path;}
  static void NativeFailure(int code){if(code==2)throw new System.IO.FileNotFoundException("A vault entry disappeared during verification.");if(code==3)throw new System.IO.DirectoryNotFoundException("A vault directory disappeared during verification.");throw new System.ComponentModel.Win32Exception(code);}
  static Microsoft.Win32.SafeHandles.SafeFileHandle Open(string path){var handle=CreateFile(Extended(path),0x20080,7,System.IntPtr.Zero,3,0x02200000,System.IntPtr.Zero);if(handle.IsInvalid){int code=System.Runtime.InteropServices.Marshal.GetLastWin32Error();handle.Dispose();NativeFailure(code);}return handle;}
  static Info ReadInfo(Microsoft.Win32.SafeHandles.SafeFileHandle handle){Info info;if(!GetFileInformationByHandle(handle,out info))NativeFailure(System.Runtime.InteropServices.Marshal.GetLastWin32Error());if((info.attributes&Reparse)!=0)throw new System.InvalidOperationException("The vault contains a symbolic link, junction, or cloud placeholder.");return info;}
  static bool EmptyStreams(string path){StreamInfo stream;var find=FindFirstStreamW(Extended(path),0,out stream,0);if(find==new System.IntPtr(-1)){int code=System.Runtime.InteropServices.Marshal.GetLastWin32Error();if(code==38)return true;NativeFailure(code);}try{int count=0;do{if(++count>10000)throw new System.InvalidOperationException("The vault entry exceeds its stream verification limit.");if(stream.size>0)return false;}while(FindNextStreamW(find,out stream));int error=System.Runtime.InteropServices.Marshal.GetLastWin32Error();if(error!=38)NativeFailure(error);return true;}finally{FindClose(find);}}
  static bool SafeAcl(Microsoft.Win32.SafeHandles.SafeFileHandle handle,string relative,string userSid){
    System.IntPtr owner,group,dacl,sacl,pointer;uint status=GetSecurityInfo(handle,1,5,out owner,out group,out dacl,out sacl,out pointer);if(status!=0)NativeFailure((int)status);
    try{if(pointer==System.IntPtr.Zero||dacl==System.IntPtr.Zero)return false;uint length=GetSecurityDescriptorLength(pointer);if(length==0||length>1048576)throw new System.InvalidOperationException("The vault security descriptor has an unsupported size.");var bytes=new byte[length];System.Runtime.InteropServices.Marshal.Copy(pointer,bytes,0,(int)length);var descriptor=new System.Security.AccessControl.RawSecurityDescriptor(bytes,0);
      if(descriptor.Owner==null||descriptor.Owner.Value!=userSid||descriptor.DiscretionaryAcl==null||(descriptor.ControlFlags&System.Security.AccessControl.ControlFlags.DiscretionaryAclPresent)==0)return false;
      bool networkPath=NetworkPath.IsMatch(relative);
      foreach(System.Security.AccessControl.GenericAce raw in descriptor.DiscretionaryAcl){var ace=raw as System.Security.AccessControl.QualifiedAce;if(ace==null)return false;if(ace.AceQualifier==System.Security.AccessControl.AceQualifier.AccessDenied)continue;if(ace.AceQualifier!=System.Security.AccessControl.AceQualifier.AccessAllowed)return false;var known=raw as System.Security.AccessControl.KnownAce;if(known==null||known.SecurityIdentifier==null)return false;string sid=known.SecurityIdentifier.Value;uint rights=unchecked((uint)known.AccessMask);
        if(sid==userSid||sid=="S-1-5-18")continue;if(networkPath&&sid==NetworkSid&&(rights==0x1301bf||rights==0xe0010000))continue;
        // Only workspace operations initialize this list, from protected Codex
        // metadata bound to this exact workspace. Never allow ACL/owner changes.
        if(System.Array.IndexOf(WorkspaceSids,sid)>=0&&(rights&~0x1301bfu)==0)continue;return false;
      }return true;
    }finally{if(pointer!=System.IntPtr.Zero)LocalFree(pointer);}
  }
  static void InspectItem(Item item,string userSid,string thumbprint,Result result){
    using(var handle=Open(item.Path)){Info info=ReadInfo(handle);bool directory=(info.attributes&DirectoryFlag)!=0;if(directory!=item.ExpectedDirectory)throw new System.InvalidOperationException("A vault entry changed type during verification. Retry the complete audit.");if(directory)System.Threading.Interlocked.Increment(ref result.Directories);else{System.Threading.Interlocked.Increment(ref result.Files);if(info.links!=1)throw new System.InvalidOperationException("The vault contains a hard-linked file. Use an independent app data copy.");}
      if((info.attributes&Encrypted)==0){if(!directory&&info.sizeHigh==0&&info.sizeLow==0&&item.ParentEncrypted&&EmptyStreams(item.Path))System.Threading.Interlocked.Increment(ref result.EmptyUnencrypted);else System.Threading.Interlocked.Increment(ref result.Unencrypted);}
      if(!SafeAcl(handle,item.Relative,userSid))System.Threading.Interlocked.Increment(ref result.UnsafeAccess);
      if(!directory&&(info.attributes&Encrypted)!=0&&!System.String.IsNullOrEmpty(thumbprint)){bool match=false;foreach(string recipient in ExominaVaultNative.Recipients(item.Path))if(System.String.Equals(recipient,thumbprint,System.StringComparison.OrdinalIgnoreCase)){match=true;break;}if(!match)throw new System.InvalidOperationException("An encrypted file uses a different recovery certificate. Back up its existing certificate before continuing.");}
    }
  }
  public static Result Inspect(string root,string userSid,string thumbprint,int workers){
    if(workers<1||workers>16)throw new System.InvalidOperationException("Invalid vault verification worker limit.");var clock=System.Diagnostics.Stopwatch.StartNew();root=System.IO.Path.GetFullPath(root).TrimEnd('\\');var items=new System.Collections.Generic.List<Item>();var pending=new System.Collections.Generic.Stack<string>();pending.Push(root);items.Add(new Item{Path=root,Relative="",ParentEncrypted=false,ExpectedDirectory=true});
    // Enumerate once. Every directory is opened without following a final
    // reparse point before enumerating its children; no files are read.
    while(pending.Count>0){string directory=pending.Pop();bool parentEncrypted;using(var handle=Open(directory)){Info info=ReadInfo(handle);if((info.attributes&DirectoryFlag)==0)throw new System.InvalidOperationException("A vault directory changed during verification.");parentEncrypted=(info.attributes&Encrypted)!=0;}
      foreach(var entry in new System.IO.DirectoryInfo(directory).EnumerateFileSystemInfos()){if(entry.FullName.Length>32000)throw new System.InvalidOperationException("A vault file path exceeds the supported Windows extended-path limit.");if(items.Count>200000)throw new System.InvalidOperationException("The vault exceeds its file verification limit.");if((entry.Attributes&System.IO.FileAttributes.ReparsePoint)!=0)throw new System.InvalidOperationException("The vault contains a symbolic link, junction, or cloud placeholder.");if(!entry.FullName.StartsWith(root+"\\",System.StringComparison.OrdinalIgnoreCase))throw new System.InvalidOperationException("The vault entry is outside its protected root.");bool isDirectory=(entry.Attributes&System.IO.FileAttributes.Directory)!=0;items.Add(new Item{Path=entry.FullName,Relative=entry.FullName.Substring(root.Length+1),ParentEncrypted=parentEncrypted,ExpectedDirectory=isDirectory});if(isDirectory)pending.Push(entry.FullName);}
    }
    var result=new Result();try{System.Threading.Tasks.Parallel.ForEach(items,new System.Threading.Tasks.ParallelOptions{MaxDegreeOfParallelism=workers},item=>InspectItem(item,userSid,thumbprint,result));}catch(System.AggregateException error){var failure=error.Flatten().InnerExceptions[0];throw failure;}
    result.ElapsedMs=clock.Elapsed.TotalMilliseconds;return result;
  }
  public static Result InspectRoot(string root,string userSid){
    var result=new Result();
    InspectItem(new Item{Path=System.IO.Path.GetFullPath(root).TrimEnd('\\'),Relative="",ParentEncrypted=false,ExpectedDirectory=true},userSid,"",result);
    return result;
  }
  public static string[] WorkspaceSids = new string[0];
  public static Result InspectCapabilityFile(string file,string userSid,string thumbprint){
    var result=new Result();
    InspectItem(new Item{Path=System.IO.Path.GetFullPath(file),Relative="",ParentEncrypted=false,ExpectedDirectory=false},userSid,thumbprint,result);
    return result;
  }
  public sealed class NamedStream { public string relative,name;public long bytes;public bool directory; }
  public sealed class FingerprintResult { public string sha256;public long bytes;public int files,directories,streams;public System.Collections.Generic.List<NamedStream> namedStreams=new System.Collections.Generic.List<NamedStream>(); }
  // Read-only copy verification includes all data streams, empty directories,
  // and exact relative names. It never returns file contents or credentials.
  public static FingerprintResult Fingerprint(string root,string[] excludeNames){
    root=System.IO.Path.GetFullPath(root).TrimEnd('\\');
    var excludes=new System.Collections.Generic.HashSet<string>(excludeNames,System.StringComparer.OrdinalIgnoreCase);
    foreach(string name in excludes)if(name=="."||name==".."||!System.Text.RegularExpressions.Regex.IsMatch(name,@"^[a-zA-Z0-9_.-]+$"))throw new System.InvalidOperationException("Invalid copy verification exclusions.");
    if(excludes.Count>16)throw new System.InvalidOperationException("Too many copy verification exclusions.");
    var pending=new System.Collections.Generic.Stack<Item>();pending.Push(new Item{Path=root,Relative="",ExpectedDirectory=true});
    var records=new System.Collections.Generic.List<string>();var result=new FingerprintResult();
    while(pending.Count>0){var item=pending.Pop();
      using(var handle=Open(item.Path)){Info info=ReadInfo(handle);bool directory=(info.attributes&DirectoryFlag)!=0;
        if(directory!=item.ExpectedDirectory)throw new System.InvalidOperationException("A copy source changed type during verification.");
        if(directory)result.directories++;else{result.files++;if(info.links!=1)throw new System.InvalidOperationException("Copy verification rejects hard-linked files.");}
        if(result.files+result.directories>200000)throw new System.InvalidOperationException("Copy verification exceeds the entry limit.");
        records.Add((directory?"D":"F")+"\0"+item.Relative);
        StreamInfo stream;var find=FindFirstStreamW(Extended(item.Path),0,out stream,0);
        if(find==new System.IntPtr(-1)){int code=System.Runtime.InteropServices.Marshal.GetLastWin32Error();if(code!=38)NativeFailure(code);}
        else try{int count=0;do{
          if(++count>10000||result.streams>=200000)throw new System.InvalidOperationException("Copy verification exceeds the stream limit.");
          if(!stream.name.StartsWith(":",System.StringComparison.Ordinal)||!stream.name.EndsWith(":$DATA",System.StringComparison.Ordinal)||stream.name.IndexOfAny(new char[]{'\\','/','\0'})>=0)throw new System.InvalidOperationException("An unsupported file stream was found.");
          string digest;long length;
          using(var readerHandle=CreateFile(Extended(item.Path)+stream.name,0x80000000,1,System.IntPtr.Zero,3,0x02200000,System.IntPtr.Zero)){
            if(readerHandle.IsInvalid)NativeFailure(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
            using(var input=new System.IO.FileStream(readerHandle,System.IO.FileAccess.Read))using(var sha=System.Security.Cryptography.SHA256.Create()){length=input.Length;if(length!=stream.size)throw new System.InvalidOperationException("A copy source stream changed during verification.");digest=System.BitConverter.ToString(sha.ComputeHash(input)).Replace("-","").ToLowerInvariant();if(input.Length!=length)throw new System.InvalidOperationException("A copy source stream changed during verification.");}
          }
          result.bytes+=length;result.streams++;records.Add("S\0"+item.Relative+"\0"+stream.name+"\0"+length.ToString(System.Globalization.CultureInfo.InvariantCulture)+"\0"+digest);
          if(stream.name!="::$DATA")result.namedStreams.Add(new NamedStream{relative=item.Relative,name=stream.name,bytes=length,directory=directory});
        }while(FindNextStreamW(find,out stream));int code=System.Runtime.InteropServices.Marshal.GetLastWin32Error();if(code!=38)NativeFailure(code);}finally{FindClose(find);}
        if(directory)foreach(var entry in new System.IO.DirectoryInfo(item.Path).EnumerateFileSystemInfos()){
          if(item.Relative==""&&excludes.Contains(entry.Name))continue;
          if((entry.Attributes&System.IO.FileAttributes.ReparsePoint)!=0)throw new System.InvalidOperationException("Copy verification rejects links and cloud placeholders.");
          if(entry.FullName.Length>32000||!entry.FullName.StartsWith(root+"\\",System.StringComparison.OrdinalIgnoreCase))throw new System.InvalidOperationException("Invalid copy source path.");
          pending.Push(new Item{Path=entry.FullName,Relative=entry.FullName.Substring(root.Length+1),ExpectedDirectory=(entry.Attributes&System.IO.FileAttributes.Directory)!=0});
        }
      }
    }
    records.Sort(System.StringComparer.Ordinal);
    using(var sha=System.Security.Cryptography.SHA256.Create()){foreach(string record in records){byte[] bytes=System.Text.Encoding.UTF8.GetBytes(record);byte[] length=System.BitConverter.GetBytes(bytes.Length);sha.TransformBlock(length,0,length.Length,length,0);sha.TransformBlock(bytes,0,bytes.Length,bytes,0);}sha.TransformFinalBlock(new byte[0],0,0);result.sha256=System.BitConverter.ToString(sha.Hash).Replace("-","").ToLowerInvariant();}
    return result;
  }
}

