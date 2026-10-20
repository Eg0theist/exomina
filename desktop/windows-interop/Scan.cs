using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// Read-only storage metadata scanner. Built at build time; loaded as a DLL, never compiled at runtime.
// Lists directories with NtQueryDirectoryFile (one open per folder, sizes and allocation in the listing),
// the way fast disk analyzers do. It never opens a file, never reads contents and never follows links.
// Protocol: configuration lines on stdin ending with "go"; JSON lines on stdout.
namespace ExoScan {

public static class Scanner {
  public static void Run() { new Session().Execute(); }
}

sealed class Dir { public int Parent; public string Name; public long Bytes, Alloc, Files; public byte Flags; public bool Done; public int Top; }
sealed class Job { public int Id; public string Path; public string Norm; public int Top; public Dir D; public TopStat T; }
sealed class TopStat { public string Name, Path; public long Bytes, Alloc, Files; }
sealed class Stat { public long Bytes, Alloc, Files; }
sealed class Item { public int Dir; public string Name; public long Bytes, Alloc, Mtime; public int Cat; }

sealed class TopList {
  public readonly Item[] Items; public int Count; long min; int minIndex; readonly int cap;
  public TopList(int capacity) { cap = capacity; Items = new Item[capacity]; }
  public bool Wants(long alloc) { return Count < cap || alloc > min; }
  public void Add(Item item) {
    if (Count < cap) { Items[Count++] = item; if (Count == cap) Recompute(); return; }
    Items[minIndex] = item; Recompute();
  }
  void Recompute() { min = long.MaxValue; for (int i = 0; i < Count; i++) if (Items[i].Alloc < min) { min = Items[i].Alloc; minIndex = i; } }
}

sealed class Rules {
  public Regex[] Patterns = new Regex[0]; public string[] Private = new string[0];
  public string[] DenyPrefix = new string[0]; public Regex[] DenyWild = new Regex[0];
  public bool Any { get { return DenyPrefix.Length > 0 || DenyWild.Length > 0; } }
  public bool Excluded(string norm, string raw) {
    for (int i = 0; i < Private.Length; i++) { string p = Private[i]; if (norm == p || norm.StartsWith(p + "/", StringComparison.Ordinal)) return true; }
    for (int i = 0; i < Patterns.Length; i++) if (Patterns[i].IsMatch(norm)) return true;
    if (Any) {
      string target = raw.Trim();
      for (int i = 0; i < DenyPrefix.Length; i++) if (target.StartsWith(DenyPrefix[i], StringComparison.OrdinalIgnoreCase)) return true;
      for (int i = 0; i < DenyWild.Length; i++) if (DenyWild[i].IsMatch(target)) return true;
    }
    return false;
  }
}

sealed class Worker {
  public byte[] Buffer = new byte[1 << 16]; public GCHandle Pin;
  public long Entries, Files, Dirs, Links, Private, Unreadable, Duplicates, CloudBytes;
  public volatile string Current = "";
  public Dictionary<string, Stat> Ext = new Dictionary<string, Stat>();
  public Stat[] Cat = new Stat[Session.CatNames.Length]; public Stat[] Age = new Stat[Session.AgeBuckets];
  public TopList Largest = new TopList(300), Stale = new TopList(100); public TopList[] ByCat = new TopList[Session.CatNames.Length];
  public Worker() {
    Pin = GCHandle.Alloc(Buffer, GCHandleType.Pinned);
    for (int i = 0; i < Cat.Length; i++) { Cat[i] = new Stat(); ByCat[i] = new TopList(60); }
    for (int i = 0; i < Age.Length; i++) Age[i] = new Stat();
  }
}

sealed class Session {
  [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status; public IntPtr Information; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("ntdll.dll")]
  static extern int NtQueryDirectoryFile(SafeFileHandle h, IntPtr ev, IntPtr apc, IntPtr ctx, out IoStatus io, IntPtr buffer, uint length, int cls, [MarshalAs(UnmanagedType.U1)] bool single, IntPtr mask, [MarshalAs(UnmanagedType.U1)] bool restart);

  public static readonly string[] CatNames = { "video", "audio", "images", "archives", "documents", "code", "apps", "disks", "data", "logs", "other" };
  public const int AgeBuckets = 6;
  static readonly int[] AgeDays = { 30, 90, 180, 365, 730 };
  static readonly Dictionary<string, int> Categories = BuildCategories();
  static Dictionary<string, int> BuildCategories() {
    var map = new Dictionary<string, int>();
    string[][] groups = {
      new[] { "mp4","mkv","avi","mov","wmv","flv","webm","m4v","mpg","mpeg","m2ts","vob","mts" },
      new[] { "mp3","flac","wav","aac","ogg","m4a","wma","opus","aiff","aif" },
      new[] { "jpg","jpeg","png","gif","bmp","tif","tiff","webp","heic","heif","psd","raw","cr2","cr3","nef","arw","dng","svg","ico","xcf","exr","tga","psb","ai" },
      new[] { "zip","rar","7z","tar","gz","tgz","bz2","xz","zst","cab","lz4","lzma","jar","apk" },
      new[] { "pdf","doc","docx","xls","xlsx","ppt","pptx","odt","ods","odp","txt","rtf","md","epub","csv","mobi" },
      new[] { "js","mjs","cjs","ts","tsx","jsx","py","pyc","java","class","c","cc","cpp","h","hpp","cs","go","rs","rb","php","html","htm","css","json","xml","yml","yaml","sh","ps1","bat","lua","obj","o","a","lib","pdb","ilk","exp","rlib","map","wasm" },
      new[] { "exe","dll","sys","msi","msix","appx","mui","drv","ocx","node","cpl","scr","msu","msp","efi" },
      new[] { "iso","img","vhd","vhdx","vmdk","vdi","wim","esd","bak","qcow2","ova","ovf","vmem","vmsd","nvram","dmg" },
      new[] { "db","sqlite","sqlite3","mdb","accdb","pak","bsp","vpk","dat","bin","wad","ba2","uasset","umap","bundle","assets","bank","arc","cache","idx","pck","dds","ldf","mdf","ndf","bik","usm","fsb" },
      new[] { "log","etl","dmp","mdmp","tmp","temp","evtx","old","dump","trace","wer" }
    };
    for (int g = 0; g < groups.Length; g++) foreach (string e in groups[g]) map[e] = g;
    return map;
  }
  const int OtherCat = 10;

  readonly object gate = new object(), dirLock = new object(), outLock = new object();
  readonly List<Dir> dirs = new List<Dir>();
  readonly List<TopStat> tops = new List<TopStat>();
  readonly Stack<Job> jobs = new Stack<Job>();
  readonly HashSet<long>[] seen = new HashSet<long>[64];
  readonly Rules rules = new Rules();
  readonly Stopwatch clock = Stopwatch.StartNew();
  readonly UTF8Encoding utf8 = new UTF8Encoding(false);
  Stream stdout; Worker[] workers;
  string root; int threads = 4; long maxEntries = 40000000, maxDirs = 4000000, maxMs = 30L * 60 * 1000, nowFileTime;
  bool dedupe = true, terminal; int pending; volatile bool stopRequested, aborted; volatile string limit; volatile int infoClass = 38; long seenCount; volatile bool dedupeLimited;

  void Send(string line) { byte[] bytes = utf8.GetBytes(line + "\n"); lock (outLock) { stdout.Write(bytes, 0, bytes.Length); stdout.Flush(); } }

  public void Execute() {
    stdout = Console.OpenStandardOutput();
    try { Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.BelowNormal; } catch (Exception) { }
    var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    var sources = new List<string>(); var patterns = new List<Regex>(); var priv = new List<string>(); var prefixes = new List<string>(); var wild = new List<Regex>();
    long now = 0; string line;
    while ((line = reader.ReadLine()) != null && line != "go") {
      int eq = line.IndexOf('='); if (eq < 0) continue; string key = line.Substring(0, eq), value = line.Substring(eq + 1);
      switch (key) {
        case "root": root = value; break;
        case "threads": threads = Math.Max(1, Math.Min(32, int.Parse(value))); break;
        case "maxEntries": maxEntries = long.Parse(value); break;
        case "maxDirs": maxDirs = long.Parse(value); break;
        case "maxMs": maxMs = long.Parse(value); break;
        case "now": now = long.Parse(value); break;
        case "dedupe": dedupe = value == "1"; break;
        case "private": priv.Add(Normalize(value)); break;
        case "exclude": sources.Add("(?:" + value + ")"); new Regex(value); break;
        case "deny":
          if (value.IndexOf('*') >= 0) { string[] parts = value.Split('*'); for (int i = 0; i < parts.Length; i++) parts[i] = Regex.Escape(parts[i]); wild.Add(new Regex("^" + string.Join(".*", parts) + "$", RegexOptions.Singleline | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)); }
          else prefixes.Add(value);
          break;
      }
    }
    if (line == null || string.IsNullOrEmpty(root)) { Send("{\"t\":\"error\",\"message\":\"Scanner configuration was incomplete.\"}"); return; }
    if (sources.Count > 0) patterns.Add(new Regex(string.Join("|", sources.ToArray()), RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled));
    rules.Patterns = patterns.ToArray(); rules.Private = priv.ToArray(); rules.DenyPrefix = prefixes.ToArray(); rules.DenyWild = wild.ToArray();
    nowFileTime = now * 10000L + 116444736000000000L;
    var watcher = new Thread(() => {
      try { string next; while ((next = reader.ReadLine()) != null) { if (next == "stop") { stopRequested = true; lock (gate) Monitor.PulseAll(gate); } } }
      catch (Exception) { }
      // The parent went away (closed stdin without asking to stop): exit immediately.
      if (!stopRequested) Environment.Exit(3);
    });
    watcher.IsBackground = true; watcher.Start();

    string rootPath = root.Length > 3 ? root.TrimEnd('\\') : root;
    if (rootPath.Length == 2 && rootPath[1] == ':') rootPath += "\\";
    if (rules.Excluded(Normalize(rootPath), rootPath)) { Send("{\"t\":\"error\",\"message\":\"Private account and app data cannot be scanned.\"}"); return; }
    var rootDir = new Dir { Parent = -1, Name = rootPath, Top = -1 }; dirs.Add(rootDir);
    for (int i = 0; i < seen.Length; i++) seen[i] = new HashSet<long>();
    workers = new Worker[threads];
    for (int i = 0; i < threads; i++) workers[i] = new Worker();
    jobs.Push(new Job { Id = 0, Path = rootPath, Norm = Normalize(rootPath), Top = -1, D = rootDir }); pending = 1;
    var pool = new Thread[threads];
    for (int i = 0; i < threads; i++) { int index = i; pool[i] = new Thread(() => Work(workers[index])); pool[i].IsBackground = true; pool[i].Priority = ThreadPriority.BelowNormal; pool[i].Start(); }
    var reporter = new Thread(Report); reporter.IsBackground = true; reporter.Start();
    for (int i = 0; i < threads; i++) pool[i].Join();
    aborted = true;
    Finish();
  }

  static string Normalize(string path) { string n = path.Replace('\\', '/').ToLowerInvariant(); while (n.Length > 1 && n[n.Length - 1] == '/') n = n.Substring(0, n.Length - 1); return n; }
  static string Join(string dir, string name) { return dir[dir.Length - 1] == '\\' ? dir + name : dir + "\\" + name; }
  static string Clean(string value) {
    StringBuilder sb = null;
    for (int i = 0; i < value.Length; i++) {
      char c = value[i]; bool bad = c < 32 || c == 127 || (c >= '\u202a' && c <= '\u202e') || (c >= '\u2066' && c <= '\u2069');
      if (!bad && char.IsHighSurrogate(c) && (i + 1 >= value.Length || !char.IsLowSurrogate(value[i + 1]))) bad = true;
      if (!bad && char.IsLowSurrogate(c) && (i == 0 || !char.IsHighSurrogate(value[i - 1]))) bad = true;
      if (bad) { if (sb == null) { sb = new StringBuilder(value.Length); sb.Append(value, 0, i); } sb.Append('\ufffd'); } else if (sb != null) sb.Append(c);
    }
    return sb == null ? value : sb.ToString();
  }
  static bool IsCloudTag(uint tag) { return (tag & 0xFFFF0FFFu) == 0x9000001Au; }

  bool OverLimit() {
    if (limit != null) return true;
    long entries = 0; for (int i = 0; i < workers.Length; i++) entries += workers[i].Entries;
    if (entries >= maxEntries) limit = "The entry limit was reached.";
    else if (dirs.Count >= maxDirs) limit = "The folder limit was reached.";
    else if (clock.ElapsedMilliseconds >= maxMs) limit = "The time limit was reached.";
    return limit != null;
  }

  void Work(Worker w) {
    try {
      while (true) {
        Job job;
        lock (gate) {
          while (jobs.Count == 0) { if (pending <= 0 || aborted) return; Monitor.Wait(gate, 200); }
          if (stopRequested || aborted || OverLimit()) { terminal = true; pending -= jobs.Count; jobs.Clear(); Monitor.PulseAll(gate); return; }
          job = jobs.Pop();
        }
        List<Job> children = null;
        try { children = ScanFolder(w, job); }
        catch (Exception) { job.D.Flags |= 1; w.Unreadable++; }
        lock (gate) {
          if (children != null && children.Count > 0 && !terminal && !stopRequested) { for (int i = 0; i < children.Count; i++) jobs.Push(children[i]); pending += children.Count; }
          pending--; Monitor.PulseAll(gate);
        }
      }
    } finally { w.Pin.Free(); }
  }

  List<Job> ScanFolder(Worker w, Job job) {
    w.Current = job.Path; Dir self = job.D;
    List<Job> children = new List<Job>();
    long bytes = 0, alloc = 0, files = 0;
    using (SafeFileHandle h = CreateFileW(@"\\?\" + job.Path, 1u, 7u, IntPtr.Zero, 3u, 0x02000000u | 0x00200000u, IntPtr.Zero)) {
      if (h.IsInvalid) { self.Flags |= 1; w.Unreadable++; self.Done = true; return children; }
      IntPtr buffer = w.Pin.AddrOfPinnedObject(); byte[] buf = w.Buffer; bool restart = true; int cls = infoClass;
      while (true) {
        IoStatus io; int status = NtQueryDirectoryFile(h, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out io, buffer, (uint)buf.Length, cls, false, IntPtr.Zero, restart);
        if (status == unchecked((int)0x80000006) || status == unchecked((int)0xC000000F)) break;
        if (status != 0) {
          uint code = unchecked((uint)status);
          if (restart && cls == 38 && (code == 0xC0000003u || code == 0xC00000BBu || code == 0xC000000Du)) { cls = 2; infoClass = 2; continue; }
          self.Flags |= 1; w.Unreadable++; self.Done = true; Commit(self, bytes, alloc, files, job); return children;
        }
        restart = false; int offset = 0;
        if (stopRequested || OverLimit()) { self.Flags |= 2; break; }
        int valid = (int)Math.Min((long)buf.Length, io.Information.ToInt64());
        while (true) {
          if (offset + 68 > valid) { self.Flags |= 1; break; }
          int next = BitConverter.ToInt32(buf, offset);
          int nameLength = BitConverter.ToInt32(buf, offset + 60), nameOffset = cls == 38 ? 80 : 68;
          if (nameLength < 2 || (nameLength & 1) != 0 || offset + nameOffset + nameLength > valid) { self.Flags |= 1; break; }
          if (!(nameLength == 2 && buf[offset + nameOffset] == (byte)'.' && buf[offset + nameOffset + 1] == 0) && !(nameLength == 4 && buf[offset + nameOffset] == (byte)'.' && buf[offset + nameOffset + 2] == (byte)'.' && buf[offset + nameOffset + 1] == 0 && buf[offset + nameOffset + 3] == 0)) {
            w.Entries++;
            uint attributes = (uint)BitConverter.ToInt32(buf, offset + 56);
            bool isDirectory = (attributes & 0x10u) != 0;
            uint tag = (uint)BitConverter.ToInt32(buf, offset + 64);
            bool skip = false;
            if ((attributes & 0x400u) != 0 && (tag == 0xA000000Cu || tag == 0xA0000003u || (isDirectory && !IsCloudTag(tag)))) { w.Links++; skip = true; }
            if (!skip) {
              string name = Encoding.Unicode.GetString(buf, offset + nameOffset, nameLength);
              string norm = job.Norm + "/" + name.ToLowerInvariant();
              string raw = rules.Any ? Join(job.Path, name) : null;
              if (rules.Excluded(norm, raw)) { w.Private++; }
              else if (isDirectory) {
                if (limit != null) self.Flags |= 2;
                else {
                  int id; string full = Join(job.Path, name); int top = job.Top; TopStat ts = job.T; Dir child = new Dir { Parent = job.Id, Name = Clean(name), Top = top };
                  lock (dirLock) {
                    id = dirs.Count;
                    if (job.Id == 0) { top = tops.Count; ts = new TopStat { Name = Clean(name), Path = full }; tops.Add(ts); child.Top = top; }
                    dirs.Add(child);
                  }
                  w.Dirs++; children.Add(new Job { Id = id, Path = full, Norm = norm, Top = top, D = child, T = ts });
                }
              } else {
                long fileId = cls == 38 ? BitConverter.ToInt64(buf, offset + 72) : 0;
                bool duplicate = false;
                if (dedupe && fileId != 0 && fileId != -1 && !dedupeLimited) {
                  HashSet<long> shard = seen[(int)((ulong)fileId * 11400714819323198485UL >> 58)];
                  lock (shard) { if (!shard.Add(fileId)) duplicate = true; }
                  if (!duplicate && Interlocked.Increment(ref seenCount) > 12000000) dedupeLimited = true;
                }
                if (duplicate) w.Duplicates++;
                else {
                  long size = BitConverter.ToInt64(buf, offset + 40), allocated = BitConverter.ToInt64(buf, offset + 48), written = BitConverter.ToInt64(buf, offset + 24);
                  if (size < 0) size = 0; if (allocated < 0) allocated = 0;
                  bytes += size; alloc += allocated; files++; w.Files++;
                  if (allocated == 0 && size > 0 && (attributes & 0x00441000u) != 0) w.CloudBytes += size;
                  int dot = name.LastIndexOf('.'); string ext = dot >= 0 && name.Length - dot <= 13 && dot < name.Length - 1 ? name.Substring(dot + 1).ToLowerInvariant() : "";
                  int cat; if (ext.Length == 0 || !Categories.TryGetValue(ext, out cat)) cat = OtherCat;
                  Stat es; if (!w.Ext.TryGetValue(ext, out es)) { es = new Stat(); w.Ext[ext] = es; }
                  es.Bytes += size; es.Alloc += allocated; es.Files++;
                  Stat cs = w.Cat[cat]; cs.Bytes += size; cs.Alloc += allocated; cs.Files++;
                  int bucket = 0;
                  if (written > 0 && nowFileTime > written) { long days = (nowFileTime - written) / 864000000000L; while (bucket < AgeDays.Length && days >= AgeDays[bucket]) bucket++; }
                  Stat ag = w.Age[bucket]; ag.Bytes += size; ag.Alloc += allocated; ag.Files++;
                  bool wantLargest = w.Largest.Wants(allocated), wantCat = w.ByCat[cat].Wants(allocated), wantStale = bucket >= 3 && w.Stale.Wants(allocated);
                  if (allocated > 0 && (wantLargest || wantCat || wantStale)) {
                    long mtime = written > 0 ? (written - 116444736000000000L) / 10000L : 0;
                    var item = new Item { Dir = job.Id, Name = Clean(name), Bytes = size, Alloc = allocated, Mtime = mtime, Cat = cat };
                    if (wantLargest) w.Largest.Add(item); if (wantCat) w.ByCat[cat].Add(item); if (wantStale) w.Stale.Add(item);
                  }
                }
              }
            }
          }
          if (next == 0) break; offset += next;
        }
      }
    }
    Commit(self, bytes, alloc, files, job);
    if (job.T != null) { Interlocked.Add(ref job.T.Bytes, bytes); Interlocked.Add(ref job.T.Alloc, alloc); Interlocked.Add(ref job.T.Files, files); }
    return children;
  }

  void Commit(Dir self, long bytes, long alloc, long files, Job job) { self.Bytes = bytes; self.Alloc = alloc; self.Files = files; self.Done = true; }

  void Report() {
    while (!aborted) {
      Thread.Sleep(350); if (aborted) break;
      try { Send(Progress("p")); } catch (Exception) { }
    }
  }

  string Progress(string type) {
    long entries = 0, files = 0, dcount = 0, links = 0, priv = 0, unreadable = 0, dup = 0, cloud = 0; string current = "";
    for (int i = 0; i < workers.Length; i++) { Worker w = workers[i]; entries += w.Entries; files += w.Files; dcount += w.Dirs; links += w.Links; priv += w.Private; unreadable += w.Unreadable; dup += w.Duplicates; cloud += w.CloudBytes; if (i == 0) current = w.Current; }
    TopStat[] snapshot; lock (dirLock) snapshot = tops.ToArray();
    long bytes = 0, alloc = 0; foreach (TopStat t in snapshot) { bytes += Interlocked.Read(ref t.Bytes); alloc += Interlocked.Read(ref t.Alloc); }
    Array.Sort(snapshot, (a, b) => Interlocked.Read(ref b.Alloc).CompareTo(Interlocked.Read(ref a.Alloc)));
    var sb = new StringBuilder(2048);
    sb.Append("{\"t\":\"").Append(type).Append("\",\"entries\":").Append(entries).Append(",\"files\":").Append(files).Append(",\"directories\":").Append(dcount + 1).Append(",\"links\":").Append(links).Append(",\"private\":").Append(priv).Append(",\"unreadable\":").Append(unreadable).Append(",\"duplicates\":").Append(dup).Append(",\"cloudBytes\":").Append(cloud)
      .Append(",\"topBytes\":").Append(bytes).Append(",\"topAlloc\":").Append(alloc).Append(",\"elapsedMs\":").Append(clock.ElapsedMilliseconds).Append(",\"current\":");
    Str(sb, Clean(current)); sb.Append(",\"top\":[");
    for (int i = 0; i < snapshot.Length && i < 30; i++) { if (i > 0) sb.Append(','); TopStat t = snapshot[i]; sb.Append("{\"name\":"); Str(sb, t.Name); sb.Append(",\"path\":"); Str(sb, t.Path); sb.Append(",\"bytes\":").Append(Interlocked.Read(ref t.Bytes)).Append(",\"alloc\":").Append(Interlocked.Read(ref t.Alloc)).Append(",\"files\":").Append(Interlocked.Read(ref t.Files)).Append('}'); }
    sb.Append("]}"); return sb.ToString();
  }

  static void Str(StringBuilder sb, string s) {
    sb.Append('"');
    for (int i = 0; i < s.Length; i++) {
      char c = s[i];
      if (c == '"') sb.Append("\\\""); else if (c == '\\') sb.Append("\\\\");
      else if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
      else sb.Append(c);
    }
    sb.Append('"');
  }

  void Finish() {
    int n = dirs.Count; long[] tb = new long[n], ta = new long[n], tf = new long[n]; bool[] bad = new bool[n];
    for (int i = 0; i < n; i++) { Dir d = dirs[i]; tb[i] = d.Bytes; ta[i] = d.Alloc; tf[i] = d.Files; if (!d.Done) d.Flags |= 2; }
    for (int i = n - 1; i > 0; i--) { Dir d = dirs[i]; int p = d.Parent; tb[p] += tb[i]; ta[p] += ta[i]; tf[p] += tf[i]; if (d.Flags != 0 || bad[i]) bad[p] = true; }
    if (dirs[0].Flags != 0) bad[0] = true;
    var sb = new StringBuilder(1 << 20);
    for (int from = 0; from < n; from += 4000) {
      sb.Clear(); sb.Append("{\"t\":\"nodes\",\"from\":").Append(from).Append(",\"rows\":[");
      int to = Math.Min(n, from + 4000);
      for (int i = from; i < to; i++) {
        Dir d = dirs[i]; if (i > from) sb.Append(',');
        sb.Append('[').Append(d.Parent).Append(',');
        Str(sb, d.Name); sb.Append(',').Append(tb[i]).Append(',').Append(ta[i]).Append(',').Append(tf[i]).Append(',').Append(d.Bytes).Append(',').Append(d.Alloc).Append(',').Append(d.Files).Append(',').Append(d.Flags | (bad[i] ? 4 : 0)).Append(']');
      }
      sb.Append("]}"); Send(sb.ToString());
    }
    // Merge per-thread statistics.
    var ext = new Dictionary<string, Stat>(); Stat[] cat = new Stat[CatNames.Length], age = new Stat[AgeBuckets];
    for (int i = 0; i < cat.Length; i++) cat[i] = new Stat(); for (int i = 0; i < age.Length; i++) age[i] = new Stat();
    TopList largest = new TopList(300), stale = new TopList(100); TopList[] byCat = new TopList[CatNames.Length]; for (int i = 0; i < byCat.Length; i++) byCat[i] = new TopList(60);
    long entries = 0, files = 0, links = 0, priv = 0, unreadable = 0, dup = 0, cloud = 0;
    foreach (Worker w in workers) {
      entries += w.Entries; files += w.Files; links += w.Links; priv += w.Private; unreadable += w.Unreadable; dup += w.Duplicates; cloud += w.CloudBytes;
      foreach (KeyValuePair<string, Stat> pair in w.Ext) { Stat s; if (!ext.TryGetValue(pair.Key, out s)) { s = new Stat(); ext[pair.Key] = s; } s.Bytes += pair.Value.Bytes; s.Alloc += pair.Value.Alloc; s.Files += pair.Value.Files; }
      for (int i = 0; i < cat.Length; i++) { cat[i].Bytes += w.Cat[i].Bytes; cat[i].Alloc += w.Cat[i].Alloc; cat[i].Files += w.Cat[i].Files; }
      for (int i = 0; i < age.Length; i++) { age[i].Bytes += w.Age[i].Bytes; age[i].Alloc += w.Age[i].Alloc; age[i].Files += w.Age[i].Files; }
      for (int i = 0; i < w.Largest.Count; i++) if (largest.Wants(w.Largest.Items[i].Alloc)) largest.Add(w.Largest.Items[i]);
      for (int i = 0; i < w.Stale.Count; i++) if (stale.Wants(w.Stale.Items[i].Alloc)) stale.Add(w.Stale.Items[i]);
      for (int c = 0; c < byCat.Length; c++) for (int i = 0; i < w.ByCat[c].Count; i++) if (byCat[c].Wants(w.ByCat[c].Items[i].Alloc)) byCat[c].Add(w.ByCat[c].Items[i]);
    }
    sb.Clear(); sb.Append("{\"t\":\"summary\",\"stopped\":").Append(stopRequested ? "true" : "false").Append(",\"limit\":");
    if (limit == null) sb.Append("null"); else Str(sb, limit);
    sb.Append(",\"dedupeLimited\":").Append(dedupeLimited ? "true" : "false").Append(",\"entries\":").Append(entries).Append(",\"files\":").Append(files).Append(",\"directories\":").Append(n).Append(",\"links\":").Append(links).Append(",\"private\":").Append(priv).Append(",\"unreadable\":").Append(unreadable).Append(",\"duplicates\":").Append(dup).Append(",\"cloudBytes\":").Append(cloud).Append(",\"elapsedMs\":").Append(clock.ElapsedMilliseconds).Append(",\"cat\":{");
    for (int i = 0; i < cat.Length; i++) { if (i > 0) sb.Append(','); Str(sb, CatNames[i]); sb.Append(":[").Append(cat[i].Bytes).Append(',').Append(cat[i].Alloc).Append(',').Append(cat[i].Files).Append(']'); }
    sb.Append("},\"age\":[");
    for (int i = 0; i < age.Length; i++) { if (i > 0) sb.Append(','); sb.Append('[').Append(age[i].Bytes).Append(',').Append(age[i].Alloc).Append(',').Append(age[i].Files).Append(']'); }
    sb.Append("],\"ext\":[");
    var rows = new List<KeyValuePair<string, Stat>>(ext); rows.Sort((a, b) => b.Value.Alloc.CompareTo(a.Value.Alloc)); bool first = true;
    for (int i = 0; i < rows.Count && i < 150; i++) { if (rows[i].Value.Alloc == 0 && rows[i].Value.Bytes == 0) continue; if (!first) sb.Append(','); first = false; sb.Append('['); Str(sb, rows[i].Key); sb.Append(',').Append(rows[i].Value.Bytes).Append(',').Append(rows[i].Value.Alloc).Append(',').Append(rows[i].Value.Files).Append(']'); }
    sb.Append("],\"largest\":"); Items(sb, largest); sb.Append(",\"stale\":"); Items(sb, stale); sb.Append(",\"byCat\":{");
    for (int i = 0; i < byCat.Length; i++) { if (i > 0) sb.Append(','); Str(sb, CatNames[i]); sb.Append(':'); Items(sb, byCat[i]); }
    sb.Append("}}"); Send(sb.ToString());
    Send("{\"t\":\"end\"}");
  }

  static void Items(StringBuilder sb, TopList list) {
    var items = new List<Item>(); for (int i = 0; i < list.Count; i++) items.Add(list.Items[i]);
    items.Sort((a, b) => b.Alloc.CompareTo(a.Alloc)); sb.Append('[');
    for (int i = 0; i < items.Count; i++) { if (i > 0) sb.Append(','); Item it = items[i]; sb.Append('[').Append(it.Dir).Append(','); Str(sb, it.Name); sb.Append(',').Append(it.Bytes).Append(',').Append(it.Alloc).Append(',').Append(it.Mtime).Append(',').Append(it.Cat).Append(']'); }
    sb.Append(']');
  }
}
}
