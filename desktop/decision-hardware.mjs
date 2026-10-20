// Hardware probe and tier choice for the local decision layer. The probe only reads
// system facts (RAM, CPU, GPU memory, NPU, battery); tier choice is a pure function
// so it can be tested against simulated office laptops.
import os from 'node:os';
import {execFile} from 'node:child_process';

const GB = 1024 ** 3;

export const TIERS = {
  1: {name: 'Quick classifier', detail: 'Small trained classifiers. Runs on any PC in milliseconds.', ramMb: 20},
  2: {name: 'Statement checker', detail: 'Compact "is this true?" model for questions without training data.', ramMb: 750},
  3: {name: 'Local chat model', detail: 'Small chat model for the hardest cases. Loaded only when needed.', ramMb: 1500}
};

// One PowerShell call. AdapterRAM is a 32-bit field that caps at 4 GB, so the
// registry's qwMemorySize is preferred for dedicated memory.
const WINDOWS_PROBE = `
$ErrorActionPreference='SilentlyContinue'
$gpus=@(Get-CimInstance Win32_VideoController | ForEach-Object { [pscustomobject]@{name=$_.Name;adapterRam=[double]$_.AdapterRAM} })
$reg=@(Get-ChildItem 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' | ForEach-Object { $p=Get-ItemProperty $_.PSPath; if($p.'HardwareInformation.qwMemorySize'){ [pscustomobject]@{name=$p.DriverDesc;bytes=[double]$p.'HardwareInformation.qwMemorySize'} } })
$npu=@(Get-PnpDevice -Class ComputeAccelerator -PresentOnly | Where-Object Status -eq 'OK' | ForEach-Object FriendlyName)
$bat=Get-CimInstance Win32_Battery | Select-Object -First 1
[pscustomobject]@{gpus=$gpus;registry=$reg;npus=$npu;battery=[bool]$bat;onBattery=($bat -and $bat.BatteryStatus -eq 1)} | ConvertTo-Json -Depth 4 -Compress
`;

const defaultRun = (file, args, timeout = 8000) => new Promise(resolve => {
  execFile(file, args, {timeout, windowsHide: true, encoding: 'utf8'}, (error, stdout) => resolve(error ? '' : String(stdout || '')));
});

const INTEGRATED = /\b(uhd|iris|hd graphics|radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|adreno|arc graphics|microsoft basic)\b/i;

/** Normalises raw probe output into a hardware profile. Exported for tests. */
export function parseWindowsProbe(raw, nvidiaCsv = '') {
  let data = {};
  try { data = JSON.parse(raw || '{}') || {}; } catch {}
  const list = value => (value == null ? [] : Array.isArray(value) ? value : [value]);
  const registry = list(data.registry);
  const gpus = list(data.gpus).filter(gpu => gpu?.name).map(gpu => {
    const reg = registry.find(entry => entry?.name === gpu.name);
    const bytes = Math.max(Number(reg?.bytes) || 0, Number(gpu.adapterRam) || 0);
    return {name: String(gpu.name), vramGb: round(bytes / GB), integrated: INTEGRATED.test(gpu.name) || bytes < 1.5 * GB};
  });
  // nvidia-smi is the most reliable source for NVIDIA cards when present.
  for (const line of String(nvidiaCsv).split(/\r?\n/)) {
    const match = line.match(/^(.+?),\s*(\d+)\s*MiB/);
    if (!match) continue;
    const known = gpus.find(gpu => gpu.name === match[1].trim());
    const vramGb = round(Number(match[2]) / 1024);
    if (known) Object.assign(known, {vramGb, integrated: false});
    else gpus.push({name: match[1].trim(), vramGb, integrated: false});
  }
  return {gpus, npus: list(data.npus).filter(Boolean).map(String), battery: !!data.battery, onBattery: !!data.onBattery};
}

const round = value => Math.round(value * 10) / 10;

/** Reads this machine's hardware. `run` is injectable so tests never spawn processes. */
export async function probeHardware({run = defaultRun, platform = process.platform} = {}) {
  const cpus = os.cpus();
  const base = {
    platform,
    cpu: cpus[0]?.model?.trim() || 'Unknown CPU',
    threads: cpus.length,
    ramGb: round(os.totalmem() / GB),
    freeRamGb: round(os.freemem() / GB),
    gpus: [], npus: [], battery: false, onBattery: false
  };
  if (platform !== 'win32') return base;
  const [raw, nvidia] = await Promise.all([
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROBE]),
    run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], 4000)
  ]);
  return {...base, ...parseWindowsProbe(raw, nvidia)};
}

/**
 * Picks the highest tier the hardware handles comfortably, then limits it to what is
 * installed. `backends` says which runtimes are actually present: {tier2, tier3}.
 */
export function chooseTier(hw, backends = {}) {
  const dedicated = hw.gpus.filter(gpu => !gpu.integrated).reduce((best, gpu) => Math.max(best, gpu.vramGb), 0);
  const reasons = [];
  let capable = 1, tier3Mode = null;

  if (hw.ramGb >= 7.5 && hw.threads >= 4) capable = 2;
  else reasons.push(`Statement checker needs 8 GB RAM and 4 CPU threads (found ${hw.ramGb} GB, ${hw.threads}).`);

  if (capable === 2) {
    if (dedicated >= 6) tier3Mode = 'gpu';
    else if (hw.npus.length && hw.ramGb >= 15.5) tier3Mode = 'npu';
    else if (hw.ramGb >= 15.5 && hw.threads >= 8) tier3Mode = 'cpu';
    if (tier3Mode) capable = 3;
    else reasons.push('Local chat model needs a graphics card with 6 GB, an NPU, or 16 GB RAM with 8 CPU threads.');
  }

  // CPU-only chat models take seconds per answer: background use only, and never on battery.
  const backgroundOnly = tier3Mode === 'cpu' || (tier3Mode && hw.onBattery);
  if (tier3Mode && hw.onBattery) reasons.push('On battery: the local chat model runs only for background work.');
  // A large model must not push a busy PC into swapping; load on demand instead of keeping it resident.
  const loadOnDemand = hw.ramGb < 31.5 || hw.freeRamGb < 4;

  let active = 1;
  const missing = [];
  if (capable >= 2) { if (backends.tier2) { if(hw.freeRamGb>=1.5)active=2;else reasons.push('The statement checker waits until at least 1.5 GB RAM is free.'); } else missing.push(2); }
  if (capable >= 3) { if (backends.tier3) active = 3; else missing.push(3); }

  return {capable, active, tier3Mode, backgroundOnly: !!backgroundOnly, loadOnDemand, dedicatedVramGb: dedicated, missing, reasons};
}
