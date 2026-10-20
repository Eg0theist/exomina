import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledPythonPath } from './runtime-targets.mjs';

const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replace(/([\\/])app\.asar([\\/]|$)/, '$1app.asar.unpacked$2');
const readerPath = path.join(runtimeRoot, 'desktop', 'read-export.py');
export const EXPORT_LIMITS = Object.freeze({
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntries: 100000,
  maxCentralDirectoryBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 200,
  ratioCheckMinBytes: 1024 * 1024,
  maxNestedZipBytes: 512 * 1024 * 1024,
});

function readerLimits(options) {
  return Object.fromEntries(Object.entries(EXPORT_LIMITS).map(([key, maximum]) => {
    const requested = options[key] ?? maximum;
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > maximum) throw new Error(`Invalid export reader limit: ${key}.`);
    return [key, requested];
  }));
}

async function readPlain(filePath, limits) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const chunks = [];
  let bytes = 0;
  try {
    // Read at most the permitted size plus one byte, even if the file grows
    // between stat and open. No unbounded readFile allocation is used.
    for await (const chunk of createReadStream(filePath, { end: Math.min(limits.maxFileBytes, limits.maxTotalBytes), highWaterMark: 65536 })) {
      bytes += chunk.length;
      if (bytes > limits.maxFileBytes || bytes > limits.maxTotalBytes) throw new Error('Export text exceeds the permitted size limit.');
      chunks.push(decoder.decode(chunk, { stream: true }));
    }
    chunks.push(decoder.decode());
  } catch (error) {
    if (error.message === 'Export text exceeds the permitted size limit.') throw error;
    if (error instanceof TypeError) throw new Error('The export must contain valid UTF-8 text.');
    throw new Error('The selected export file could not be read.');
  }
  return { inputs: [{ source: path.basename(filePath), text: chunks.join('') }], bytes, warnings: [] };
}

function readZip(filePath, options, limits) {
  return new Promise((resolve, reject) => {
    const python = options.python ?? bundledPythonPath(runtimeRoot);
    const timeoutMs = options.timeoutMs ?? 120000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) return reject(new Error('Invalid export reader timeout.'));
    const child = spawn(python, ['-I', readerPath, filePath, JSON.stringify(limits)], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false, stderr = '', outputBytes = 0, acceptedBytes = 0;
    let mode = 'header', headerParts = [], headerBytes = 0, current = null, done = null;
    const inputs = [];
    const timer = setTimeout(() => finish(new Error('Reading this export took too long. Try importing its conversation JSON files individually.')), timeoutMs);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(result);
    }
    function completeFile() {
      current.parts.push(current.decoder.decode());
      inputs.push({ source: current.source, text: current.parts.join('') });
      current = null;
      mode = 'separator';
    }
    function consume(data) {
      outputBytes += data.length;
      if (outputBytes > limits.maxTotalBytes + 16 * 1024 * 1024) throw new Error('The export reader output exceeded its size limit.');
      let offset = 0;
      while (offset < data.length) {
        if (mode === 'separator') {
          if (data[offset++] !== 10) throw new Error('The export reader returned an invalid data boundary.');
          mode = 'header';
        } else if (mode === 'file') {
          const take = Math.min(current.remaining, data.length - offset);
          current.parts.push(current.decoder.decode(data.subarray(offset, offset + take), { stream: true }));
          current.remaining -= take;
          offset += take;
          if (current.remaining === 0) completeFile();
        } else {
          if (done) throw new Error('The export reader returned unexpected trailing data.');
          const end = data.indexOf(10, offset);
          const part = data.subarray(offset, end < 0 ? data.length : end);
          headerParts.push(part);
          headerBytes += part.length;
          if (headerBytes > 65536) throw new Error('The export reader returned excessive metadata.');
          offset = end < 0 ? data.length : end + 1;
          if (end < 0) continue;
          let header;
          try { header = JSON.parse(Buffer.concat(headerParts, headerBytes).toString('utf8')); }
          catch { throw new Error('The export reader returned invalid metadata.'); }
          headerParts = []; headerBytes = 0;
          if (header.type === 'file') {
            if (typeof header.source !== 'string' || header.source.length > 4096 || !Number.isSafeInteger(header.bytes) || header.bytes < 0 || header.bytes > limits.maxFileBytes) throw new Error('The export reader returned an invalid file descriptor.');
            acceptedBytes += header.bytes;
            if (acceptedBytes > limits.maxTotalBytes) throw new Error('Combined export text exceeds the permitted size limit.');
            current = { source: header.source, remaining: header.bytes, decoder: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }), parts: [] };
            mode = 'file';
            if (!current.remaining) completeFile();
          } else if (header.type === 'done') {
            if (header.bytes !== acceptedBytes || header.inputCount !== inputs.length || !Array.isArray(header.warnings) || header.warnings.some(warning => typeof warning !== 'string')) throw new Error('The export reader returned inconsistent totals.');
            done = header;
          } else throw new Error('The export reader returned an unknown record.');
        }
      }
    }
    child.stdout.on('data', data => {
      if (settled) return;
      try { consume(data); }
      catch (error) { finish(error instanceof TypeError ? new Error('The export must contain valid UTF-8 text.') : error); }
    });
    child.stderr.on('data', data => { stderr = (stderr + data.toString('utf8')).slice(0, 4000); });
    child.on('error', () => finish(new Error('The bundled export reader could not start. Keep the app’s vendor and desktop folders together.')));
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) {
        // The helper emits only fixed, non-content error messages. Never include
        // a traceback, an export fragment, or arbitrary child output in errors.
        const match = /^EXPORT_ERROR: ([^\r\n]{1,500})\r?\n?$/.exec(stderr);
        return finish(new Error(match?.[1] ?? 'The ZIP export could not be read safely.'));
      }
      if (!done || mode !== 'header' || headerBytes || !inputs.length) return finish(new Error('The export reader stopped before completing the ZIP.'));
      finish(null, { inputs, bytes: acceptedBytes, warnings: done.warnings });
    });
  });
}

/** Read explicit user-selected exports without extracting archive contents. */
export async function readExportFile(filePath, options = {}) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) throw new Error('Choose a JSON, text, Markdown, or ZIP export file.');
  const limits = readerLimits(options);
  const extension = path.extname(filePath).toLowerCase();
  if (!['.json', '.txt', '.md', '.zip', '.html', '.htm'].includes(extension)) throw new Error('Choose a ZIP, JSON, HTML, TXT or MD export file.');
  if (extension === '.json' && /^(?:users?|accounts?|profiles?|user_profile|user_data)$/i.test(path.basename(filePath, path.extname(filePath)))) throw new Error('Account/profile JSON is not conversation or memory context. Choose the conversation, memory, or instruction export instead.');
  let info;
  try { info = await stat(filePath); } catch { throw new Error('The selected export file is no longer available.'); }
  if (!info.isFile()) throw new Error('Choose an export file, not a folder.');
  if (extension === '.zip') return readZip(path.resolve(filePath), options, limits);
  if (info.size > limits.maxFileBytes || info.size > limits.maxTotalBytes) throw new Error('Export text exceeds the permitted size limit (256 MiB per file, 512 MiB total).');
  return readPlain(filePath, limits);
}
