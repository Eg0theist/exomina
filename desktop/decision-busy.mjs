// "Is a demanding app running?" check for the local decision layer. Tier 3 shares the
// graphics card with games, so it pauses while one runs. Everything here is a local
// Windows query: no network, no AI request, no subscription usage. The check only runs
// when a Tier 3 question is about to be asked, never on a timer.
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const busyLibrary=fileURLToPath(new URL('./windows-interop/Busy.dll',import.meta.url)).replace(/app\.asar([\\/])/,'app.asar.unpacked$1');

// Three signals, one PowerShell call (about 2.5 s, mostly the 1 s graphics-load sample).
// The graphics load comes from the raw WMI class, whose names, unlike Get-Counter paths,
// are the same on German or any other Windows language:
//   notification  Windows' own "do not disturb" state: exclusive full-screen, presentation, busy
//   foreground    the active window covers its whole monitor without a title bar (borderless)
//   gpu           per-process load of the heavy engines: 3D (games), Compute/CUDA (GPU
//                 rendering such as Blender, AI tools) and video encoding (exports). The
//                 busiest engine counts, as in Task Manager. Video decoding is left out so
//                 watching a video never pauses anything.
export const BUSY_PROBE = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -Path '${busyLibrary.replaceAll("'","''")}'
$state=0; [void][ExoBusy.W]::SHQueryUserNotificationState([ref]$state)
$h=[ExoBusy.W]::GetForegroundWindow(); $r=New-Object ExoBusy.W+RECT; [void][ExoBusy.W]::GetWindowRect($h,[ref]$r)
$fgPid=[uint32]0; [void][ExoBusy.W]::GetWindowThreadProcessId($h,[ref]$fgPid)
$mi=New-Object ExoBusy.W+MONITORINFO; $mi.cbSize=[Runtime.InteropServices.Marshal]::SizeOf($mi); [void][ExoBusy.W]::GetMonitorInfo([ExoBusy.W]::MonitorFromWindow($h,2),[ref]$mi)
$cls=New-Object System.Text.StringBuilder 256; [void][ExoBusy.W]::GetClassName($h,$cls,256)
$m=$mi.rcMonitor
$captioned=(([ExoBusy.W]::GetWindowLong($h,-16)) -band 0x00C00000) -eq 0x00C00000
$covers=($h -ne [IntPtr]::Zero) -and -not [ExoBusy.W]::IsZoomed($h) -and -not $captioned -and $r.L -le $m.L -and $r.T -le $m.T -and $r.R -ge $m.R -and $r.B -ge $m.B
$q="SELECT Name,UtilizationPercentage,Timestamp_Sys100NS FROM Win32_PerfRawData_GPUPerformanceCounters_GPUEngine"
$heavy='engtype_(3D|High Priority 3D|Compute.*|High Priority Compute|Cuda|VideoEncode|Video Codec.*)$'
$a=@{}; Get-CimInstance -Query $q | Where-Object { $_.Name -match $heavy } | ForEach-Object { $a[$_.Name]=$_ }
Start-Sleep -Milliseconds 1000
$eng=@{}
Get-CimInstance -Query $q | Where-Object { $_.Name -match $heavy } | ForEach-Object {
  $o=$a[$_.Name]
  if($o -and $_.Name -match '^pid_(\\d+)_.*engtype_(.+)$'){
    $dt=[double]$_.Timestamp_Sys100NS-[double]$o.Timestamp_Sys100NS
    if($dt -gt 0){ $k=$Matches[1]+'|'+$Matches[2]; $eng[$k]=[double]$eng[$k]+100*([double]$_.UtilizationPercentage-[double]$o.UtilizationPercentage)/$dt }
  }
}
$gpu=@{}
foreach($k in $eng.Keys){ $p=[int]($k.Split('|')[0]); if($eng[$k] -gt [double]$gpu[$p]){ $gpu[$p]=$eng[$k] } }
$apps=@($gpu.GetEnumerator() | Where-Object { $_.Value -ge 1 } | ForEach-Object { [pscustomobject]@{pid=$_.Key;name=(Get-Process -Id $_.Key).ProcessName;load=[math]::Round([math]::Min(100,$_.Value),1)} })
[pscustomobject]@{notification=$state;foreground=[pscustomobject]@{pid=$fgPid;name=(Get-Process -Id $fgPid).ProcessName;className=$cls.ToString();coversMonitor=[bool]$covers};gpu=$apps} | ConvertTo-Json -Depth 4 -Compress
`;

// SHQueryUserNotificationState values that mean "the user is in something full-screen".
const NOTIFICATION = {2: 'a full-screen app', 3: 'a full-screen game', 4: 'presentation mode'};
// Graphics load from these never counts: Windows itself, Exomina, and the local model
// servers (otherwise Tier 3 would pause because of its own work).
const NEVER_BUSY = /^(dwm|csrss|explorer|searchhost|shellexperiencehost|startmenuexperiencehost|textinputhost|exomina|electron|ollama.*|llama.*|lm ?studio.*|lms)$/i;
const DESKTOP_CLASSES = /^(progman|workerw|shell_traywnd)$/i;
export const GPU_BUSY_PERCENT = 40;

/** Turns raw probe output into {busy, reason, signals}. Pure, exported for tests. */
export function assessBusy(raw, {ownPids = [process.pid]} = {}) {
  let data;
  try { data = JSON.parse(raw || ''); } catch { data = null; }
  if (!data || typeof data !== 'object') return {busy: false, known: false, reason: 'Could not read the Windows state.'};
  const own = new Set(ownPids.map(Number));
  const ignored = (pid, name) => own.has(Number(pid)) || NEVER_BUSY.test(String(name || ''));
  const signals = [];

  const notification = NOTIFICATION[Number(data.notification)];
  if (notification) signals.push(notification);

  const fg = data.foreground || {};
  if (fg.coversMonitor && !DESKTOP_CLASSES.test(String(fg.className || '')) && !ignored(fg.pid, fg.name))
    signals.push(`${fg.name || 'an app'} in borderless full-screen`);

  const gpu = (Array.isArray(data.gpu) ? data.gpu : data.gpu ? [data.gpu] : [])
    .filter(app => !ignored(app.pid, app.name) && Number(app.load) >= GPU_BUSY_PERCENT)
    .sort((a, b) => b.load - a.load);
  if (gpu.length) signals.push(`${gpu[0].name || 'an app'} using ${Math.round(gpu[0].load)} % of the graphics card`);

  return {busy: signals.length > 0, quiet: [1, 2, 3, 4, 6].includes(Number(data.notification)), known: true, reason: signals[0] || null, signals};
}

const defaultRun = (file, args, timeout = 10000) => new Promise(resolve => {
  execFile(file, args, {timeout, windowsHide: true, encoding: 'utf8'}, (error, stdout) => resolve(error ? '' : String(stdout || '')));
});

const BUSY_CACHE_MS = 45_000;  // a busy answer holds this long (the cool-down covers more anyway)
const QUIET_CACHE_MS = 15_000; // a quiet one expires sooner, so a game just started is noticed
const COOLDOWN_MS = 120_000; // stay paused this long after the last busy sighting (loading screens, alt-tab)

/**
 * Creates the busy check. Results are cached so a burst of background questions costs
 * one probe, and a pause outlasts short dips such as loading screens or a quick alt-tab.
 */
export function createBusyCheck({run = defaultRun, platform = process.platform, clock = Date.now, ownPids} = {}) {
  let cached = null, lastBusyAt = -Infinity, pending = null;
  const fresh = now => cached && now - cached.at < (cached.result.busy ? BUSY_CACHE_MS : QUIET_CACHE_MS);
  async function busyCheck() {
    if (platform !== 'win32') return {busy: false, known: false, reason: null};
    if (fresh(clock())) return cached.result;
    if (!pending) pending = (async () => {
      const raw = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', BUSY_PROBE]);
      const result = assessBusy(raw, ownPids ? {ownPids} : undefined);
      const at = clock();
      if (result.busy) lastBusyAt = at;
      else if (at - lastBusyAt < COOLDOWN_MS) Object.assign(result, {busy: true, reason: 'a demanding app (game, render or export) stopped less than two minutes ago'});
      cached = {at, result};
      return result;
    })().finally(() => { pending = null; });
    return pending;
  }
  // The last result without probing, for status displays. Null when stale or never checked.
  busyCheck.peek = () => (fresh(clock()) ? cached.result : null);
  return busyCheck;
}
