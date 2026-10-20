import { mkdir, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';

const endpoint = 'http://127.0.0.1:11434';
export function huggingFaceModel(repo, quant = 'Q4_K_M') {
  let value = String(repo || '').trim().replace(/^https:\/\/(?:huggingface.co|hf.co)\//, '').replace(/^hf.co\//, '').replace(/\/$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(value) || value.includes('..')) throw Error('Choose a public Hugging Face model such as bartowski/Llama-3.2-1B-Instruct-GGUF.');
  if (!/^[A-Za-z0-9_.-]{1,150}$/.test(quant) || quant.includes('..')) throw Error('Choose a model file or a size option.');
  return `hf.co/${value}:${quant}`;
}
export async function readJson(response) {
  if (!response.ok) throw Error(`The service returned HTTP ${response.status}.`);
  const text = await response.text(); if (text.length > 8 * 1024 * 1024) throw Error('The service response is too large.'); return JSON.parse(text);
}
export class LocalModels {
  constructor({ dataDir, configure, refresh, emit = () => {}, fetchImpl = fetch, spawnImpl = spawn, baseUrl = endpoint }) { const parsed=new URL(baseUrl);if(parsed.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)||parsed.username||parsed.password||parsed.search||parsed.hash||parsed.pathname!=='/')throw Error('Use a loopback address for the local runtime.');Object.assign(this, { endpoint:parsed.origin,dir: path.join(dataDir, 'local-models'), configure, refresh, emit, fetch: fetchImpl, spawn: spawnImpl }); this.progress = null; }
  async init() { await mkdir(this.dir, { recursive: true }); try { this.runtime = JSON.parse(await readFile(path.join(this.dir, 'runtime.json'), 'utf8')); } catch {} }
  notify(progress) { this.progress = progress; this.emit({ type: 'local.progress', progress }); }
  async status() {
    let version = null, models = [];
    try { version = (await readJson(await this.fetch(this.endpoint + '/api/version', { redirect: 'error', signal: AbortSignal.timeout(2000) }))).version; models = (await readJson(await this.fetch(this.endpoint + '/api/tags', { redirect: 'error', signal: AbortSignal.timeout(4000) }))).models || []; } catch {}
    const runtimeReady = !!this.runtime?.executable && this.runtime.executable.startsWith(this.dir + path.sep) && !!(await stat(this.runtime.executable).catch(() => null));
    return { running: !!version, version, installed: runtimeReady, managed: !!this.process, models: models.filter(m => !m.remote_host && !m.remote_model && !/-cloud(?::|$)/i.test(m.name)).map(m => ({ id: m.name, size: m.size, parameters: m.details?.parameter_size, quantization: m.details?.quantization_level })), memoryGB: Math.round(os.totalmem() / 1024 ** 3), progress: this.progress, modelLocation: this.process ? path.join(this.dir, 'models') : 'Your existing Ollama model folder', runtimeSize: 'About 4 GB, plus model downloads' };
  }
  async search(query = '') {
    const url = new URL('https://huggingface.co/api/models'); url.searchParams.set('filter', 'gguf'); url.searchParams.set('pipeline_tag', 'text-generation'); url.searchParams.set('limit', '18'); url.searchParams.set('sort', 'downloads'); url.searchParams.set('direction', '-1'); if (query.trim()) url.searchParams.set('search', query.trim().slice(0,160));
    const result = await readJson(await this.fetch(url, { signal: AbortSignal.timeout(15000) }));
    if (!Array.isArray(result)) throw Error('Hugging Face did not return a model list.');
    return result.map(m => ({ id: m.id, downloads: m.downloads, gated: m.gated, tags: m.tags || [] })).filter(m => m.id && !m.gated && m.tags.includes('gguf'));
  }
  async details(repo) {
    const name = huggingFaceModel(repo).slice(6).split(':')[0];
    const result = await readJson(await this.fetch('https://huggingface.co/api/models/' + name + '?blobs=true', { signal: AbortSignal.timeout(15000) }));
    if (result.gated) throw Error('This model requires Hugging Face approval or sign-in. Choose a public GGUF model.');
    return { id: name, license: result.cardData?.license || result.tags?.find(t => t.startsWith('license:'))?.slice(8) || 'See model page', files: (result.siblings || []).filter(f => /\.gguf$/i.test(f.rfilename) && !/[\\/]/.test(f.rfilename) && !/-\d{5}-of-\d{5}\.gguf$/.test(f.rfilename) && !/mmproj/i.test(f.rfilename)).map(f => ({ name: f.rfilename, size: f.size || f.lfs?.size || 0 })) };
  }
  async install() {
    if (this.controller) throw Error('A download is already running.');
    const controller = this.controller = new AbortController();
    let partial;
    try {
      this.notify({ kind: 'runtime', status: 'Finding the official Windows runtime', completed: 0 });
      const release = await readJson(await this.fetch('https://api.github.com/repos/ollama/ollama/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, signal: controller.signal }));
      const asset = release.assets?.find(a => a.name === 'ollama-windows-amd64.zip');
      if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '') || !/^https:\/\/github.com\/ollama\/ollama\/releases\/download\//.test(asset.browser_download_url)) throw Error('The official runtime did not include a verifiable Windows download. Try again later or use an existing Ollama installation.');
      if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 8 * 1024 ** 3) throw Error('Unexpected runtime download size.');
      const version = String(release.tag_name).replace(/[^a-z0-9.-]/gi, '');
      const target = path.join(this.dir, 'runtime-' + version + '-' + randomUUID()); await mkdir(target, { recursive: true });
      const archive = path.join(this.dir, version + '.zip'); partial = archive + '.part';
      const response = await this.fetch(asset.browser_download_url, { signal: controller.signal }); if (!response.ok) throw Error('The runtime download failed.');
      const stream = createWriteStream(partial, { flags: 'w' }); const hash = createHash('sha256'); let completed = 0, at = 0;
      stream.on('error', error => controller.abort(error));
      try {
        for await (const chunk of response.body) { completed += chunk.length; if (completed > asset.size) throw Error('The runtime download exceeded its expected size.'); hash.update(chunk); if (!stream.write(chunk)) await once(stream, 'drain'); if (Date.now() - at > 250) { at = Date.now(); this.notify({ kind: 'runtime', status: 'Downloading the local runtime', completed, total: asset.size }); } }
        stream.end(); await once(stream, 'finish');
      } finally { stream.destroy(); }
      if (completed !== asset.size || 'sha256:' + hash.digest('hex') !== asset.digest) throw Error('The runtime download failed its integrity check. It was not started.');
      await rename(partial, archive); partial = null;
      this.notify({ kind: 'runtime', status: 'Unpacking the verified runtime', completed: 1, total: 1 });
      const script = path.join(this.dir, 'extract-runtime.ps1');
      await writeFile(script, `$ErrorActionPreference='Stop'\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n$archivePath=$env:EXOMINA_RUNTIME_ARCHIVE\n$targetPath=[IO.Path]::GetFullPath($env:EXOMINA_RUNTIME_TARGET)\n$zip=[IO.Compression.ZipFile]::OpenRead($archivePath)\ntry { foreach ($entry in $zip.Entries) { $destination=[IO.Path]::GetFullPath([IO.Path]::Combine($targetPath,$entry.FullName)); if (-not $destination.StartsWith($targetPath+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe archive path' } }; } finally { $zip.Dispose() }\n[IO.Compression.ZipFile]::ExtractToDirectory($archivePath,$targetPath)\n`, 'utf8');
      const child = this.spawn('powershell.exe', ['-NoProfile','-NonInteractive','-File',script], { windowsHide: true, env: { ...process.env, EXOMINA_RUNTIME_ARCHIVE: archive, EXOMINA_RUNTIME_TARGET: target }, stdio: ['ignore','ignore','pipe'], signal: controller.signal });
      let errorText = ''; child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-2000); });
      const [code] = await once(child, 'exit'); if (code !== 0) throw Error('Could not unpack the runtime: ' + errorText);
      const executable = path.join(target, 'ollama.exe'); await stat(executable);
      this.runtime = { version, executable }; await writeFile(path.join(this.dir,'runtime.json'), JSON.stringify(this.runtime)); await unlink(archive).catch(() => {});
      this.notify({ kind: 'runtime', status: 'Runtime installed. Start it to download a model.', done: true }); return await this.status();
    } catch (error) { this.notify({ kind: 'runtime', status: controller.signal.aborted ? 'Download cancelled' : error.message, error: true }); throw error; }
    finally { if (partial) await unlink(partial).catch(() => {}); this.controller = null; }
  }
  async start() {
    if (this.closed) throw Error('The local-model manager has closed.');
    if (this.starting) return this.starting;
    const pending = this.starting = this.startRuntime();
    try { return await pending; } finally { if (this.starting === pending) this.starting = null; }
  }
  async startRuntime() {
    const status = await this.status(); if (status.running) return status;
    if (this.closed) throw Error('The local-model manager has closed.');
    if (!status.installed) throw Error('Install the local runtime first.');
    const runtimeHome=path.join(this.dir,'home');await mkdir(runtimeHome,{recursive:true});
    if (this.closed) throw Error('The local-model manager has closed.');
    const child = this.process = this.spawn(this.runtime.executable, ['serve'], { cwd: path.dirname(this.runtime.executable), windowsHide: true, env: { ...process.env, USERPROFILE:runtimeHome,HOME:runtimeHome,OLLAMA_HOST:new URL(this.endpoint).host, OLLAMA_MODELS: path.join(this.dir, 'models'), OLLAMA_NO_CLOUD: '1' }, stdio: ['ignore','ignore','pipe'] });
    let errorText = ''; child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-2000); }); child.on('error', error => { errorText = error.message; this.process = null; }); child.on('exit', () => { if (this.process === child) this.process = null; });
    for (let i = 0; i < 45; i++) { await new Promise(r => setTimeout(r,500)); const next = await this.status(); if (next.running) return next; if (!this.process) throw Error('The runtime could not start: ' + errorText); }
    throw Error('The runtime is still starting. Use Refresh to check again.');
  }
  async pull({ repo, quant }) {
    const model = huggingFaceModel(repo, quant);
    if (this.controller) throw Error('A download is already running.');
    if (!(await this.status()).running) throw Error('Start the local runtime first.');
    const controller = this.controller = new AbortController();
    try {
      this.notify({ kind: 'model', model, status: 'Starting model download', completed: 0 });
      const response = await this.fetch(this.endpoint + '/api/pull', { method: 'POST', redirect: 'error', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ model, stream: true }), signal: controller.signal });
      if (!response.ok) throw Error('The model download failed. Check that it is a public, supported GGUF model.');
      let buffer = '', succeeded = false; const decoder = new TextDecoder();
      const consume = line => { if (!line.trim()) return; const value = JSON.parse(line); if (value.error) throw Error(value.error); succeeded ||= value.status === 'success'; this.notify({ kind: 'model', model, status: value.status, completed: value.completed || 0, total: value.total || 0, done: value.status === 'success' }); };
      for await (const chunk of response.body) { buffer += decoder.decode(chunk,{stream:true}); if (buffer.length > 2 * 1024 * 1024) throw Error('Unexpected model progress response.'); let newline; while ((newline=buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0,newline)); buffer=buffer.slice(newline+1); } }
      buffer += decoder.decode(); consume(buffer); if (!succeeded) throw Error('The download stopped before Ollama confirmed success. Try the download again to resume.');
      await this.activate(model); return await this.status();
    } catch (error) { this.notify({ kind:'model', model, status: controller.signal.aborted ? 'Download cancelled. Retry to resume.' : error.message, error: true }); throw error; }
    finally { this.controller = null; }
  }
  async activate(model) {
    const status = await this.status(); if (!status.models.some(m => m.id === model)) throw Error('Choose an installed local model.');
    await this.configure({ provider:'ollama', baseUrl: this.endpoint+'/v1', model });
    if(this.process&&this.runtime){this.runtime.autoStart=true;await writeFile(path.join(this.dir,'runtime.json'),JSON.stringify(this.runtime));}
    await this.refresh(); return status;
  }
  async supportsTools(model) {
    try {const result=await readJson(await this.fetch(this.endpoint+'/api/show',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({model}),signal:AbortSignal.timeout(5000)}));return Array.isArray(result.capabilities)&&result.capabilities.includes('tools');}catch{return false;}
  }
  cancel() { this.controller?.abort(); }
  close() { this.closed = true; this.cancel(); this.process?.kill(); this.process = null; }
}
