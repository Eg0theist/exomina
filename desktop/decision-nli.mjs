// Tier 2 of the local decision layer: a compact "is this statement true?" (NLI) model
// run by ONNX Runtime on the CPU. It answers questions without per-gate training data:
// the input is the premise, each option becomes a hypothesis such as "This message needs
// a reply." Nothing is bundled; the user downloads one model from Settings. Files come
// from pinned revisions and are checked against their SHA-256 before use.
import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {cpus} from 'node:os';
import path from 'node:path';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const FILE = (name, sha256, size) => ({name, sha256, size});
export const NLI_MODELS = {
  multilingual: {
    id: 'multilingual', name: 'Multilingual (German, English and 100 more)', license: 'MIT',
    repo: 'Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7', revision: '0864ced79bf1ef851bfaf9dd9de0aa54d735d9d0',
    files: [
      FILE('config.json', '6fa26b4513097fd276f824ee3eedb695eff1f96b992d2df5fcff85b6a33990a0', 1061),
      FILE('tokenizer_config.json', '64c74bfe22b045501100885982d45e3280d33fd17e8ea576cdca4988e10a6ad9', 492),
      FILE('tokenizer.json', 'e23095eb61ba944c7be3a5d3e8ec19e37ce7ced0daa03550bde03e83c21b3f8a', 16316151),
      FILE('onnx/model_quantized.onnx', 'ccb655bf617edf1d3b0ccdc5b4576a4322e28cee5ce9ab8cd21af4b1f13e6836', 338679132)
    ]
  },
  english: {
    id: 'english', name: 'English only, smaller', license: 'MIT',
    repo: 'Xenova/DeBERTa-v3-xsmall-mnli-fever-anli-ling-binary', revision: '42dedb84d69d3a3b4ad75ce1c1475f7c9f3a8b61',
    files: [
      FILE('config.json', 'ff5307f4c1df55a9e684aaf652347dd1f9cf55a02d261c25b09bb5e59611b87f', 1025),
      FILE('tokenizer_config.json', 'd8d3bb123b99317634d5ee3d1d2d8b2ddb01510a0654687fc2639a5347a7291f', 384),
      FILE('tokenizer.json', 'a86f883318afa11c8c10466f1bf4efaeb6ded28a52cbe57217a8fa0d0a2a87df', 8656551),
      FILE('onnx/model_quantized.onnx', 'dbe3c623b9e8e860cc6fd60acd8bbe3a50b08501b40fb958400144624efc54c2', 87246194)
    ]
  }
};
for (const model of Object.values(NLI_MODELS)) model.sizeMb = Math.round(model.files.reduce((sum, file) => sum + file.size, 0) / 1e6);

const MAX_TOKENS = 512;
const IDLE_UNLOAD_MS = 5 * 60_000;  // frees the ~0.5 GB of RAM when no question came for a while
const MARKER = 'installed.json';
const local = (dir, file) => path.join(dir, ...file.name.split('/'));

/** The installed model in `root`, or null. Only a completed, verified download writes the marker. */
export async function installedNliModel(root) {
  const installed = [];
  for (const model of Object.values(NLI_MODELS)) {
    try {
      const marker = JSON.parse(await readFile(path.join(root, model.id, MARKER), 'utf8'));
      const dir = path.join(root, model.id);
      if (marker.revision === model.revision && (await Promise.all(model.files.map(async file => (await stat(local(dir, file))).size === file.size))).every(Boolean))
        installed.push({...model, dir, installedAt: marker.installedAt});
    } catch {}
  }
  return installed.sort((a,b) => String(b.installedAt).localeCompare(String(a.installedAt)))[0] || null;
}

const sha256File = async file => { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); };

/**
 * Downloads and verifies one model, replacing any other installed one. Resumable only in
 * the sense that already verified files are kept. `fetchImpl` is injectable for tests.
 */
export async function downloadNliModel({root, id, fetchImpl = fetch, onProgress = () => {}, signal}) {
  const model = NLI_MODELS[id];
  if (!model) throw Error('Unknown Tier 2 model.');
  const dir = path.join(root, model.id);
  await mkdir(dir, {recursive: true});
  const total = model.files.reduce((sum, file) => sum + file.size, 0);
  let done = 0;
  for (const file of model.files) {
    const target = local(dir, file);
    await mkdir(path.dirname(target), {recursive: true});
    const existing = await stat(target).catch(() => null);
    if (existing?.size === file.size && await sha256File(target) === file.sha256) { done += file.size; onProgress({done, total}); continue; }
    const response = await fetchImpl(`https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.name}`, {signal, redirect: 'follow'});
    if (!response.ok || !response.body) throw Error(`Download failed (${response.status}) for ${file.name}.`);
    const hash = createHash('sha256');
    let received = 0;
    const meter = new Transform({transform(chunk, _encoding, callback) {
      received += chunk.length; hash.update(chunk);
      if (received > file.size) return callback(Error(`${file.name} is larger than expected.`));
      onProgress({done: done + received, total}); callback(null, chunk);
    }});
    const partial = target + '.part';
    const body = typeof response.body.getReader === 'function' ? Readable.fromWeb(response.body) : response.body;
    await pipeline(body, meter, createWriteStream(partial), {signal});
    if (received !== file.size || hash.digest('hex') !== file.sha256) { await rm(partial, {force: true}); throw Error(`${file.name} failed its integrity check. Nothing was installed.`); }
    await rename(partial, target);
    done += file.size;
  }
  await writeFile(path.join(dir, MARKER), JSON.stringify({id: model.id, revision: model.revision, installedAt: new Date().toISOString()}), 'utf8');
  // Keep earlier files until explicit removal: a loaded native session may still own them.
  return {...model, dir};
}

export async function removeNliModels(root) {
  for (const model of Object.values(NLI_MODELS)) await rm(path.join(root, model.id), {recursive: true, force: true});
}

const softmax = values => { const top = Math.max(...values); const exp = values.map(v => Math.exp(v - top)); const sum = exp.reduce((a, b) => a + b, 0); return exp.map(v => v / sum); };

/**
 * Turns raw NLI logits into per-hypothesis scores. `entail` is the entailment logit;
 * Scores include neutral evidence. A neutral result must never become a confident
 * false answer merely because entailment is even smaller. Pure.
 */
export function nliScores(logits, id2label) {
  const labels = Object.entries(id2label || {}).sort((a, b) => Number(a[0]) - Number(b[0])).map(([, label]) => String(label).toLowerCase());
  const entail = labels.indexOf('entailment');
  const against = labels.includes('contradiction') ? labels.indexOf('contradiction') : labels.findIndex(label => label !== 'entailment');
  if (entail < 0 || against < 0) throw Error('This model does not report entailment.');
  const probabilities = softmax(logits);
  const neutral = labels.indexOf('neutral');
  return {entail: logits[entail], truth: probabilities[entail], falsehood: probabilities[against], neutral: neutral < 0 ? 0 : probabilities[neutral]};
}

/** Lazily loaded NLI runtime. `loadRuntime` is injectable so tests never load native code. */
export class NliRuntime {
  constructor({root, loadRuntime = defaultRuntime, setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
    Object.assign(this, {root, loadRuntime, setTimer, clearTimer});
    this.session = null; this.loading = null; this.idle = null; this.model = undefined;
    this.queue = Promise.resolve();
  }

  async installed() { return installedNliModel(this.root); }

  async ensure() {
    if (this.session) return this.session;
    this.loading ||= (async () => {
      const model = await this.installed();
      if (!model) throw Error('No Tier 2 model is installed.');
      for (const file of model.files) if (await sha256File(local(model.dir, file)) !== file.sha256) throw Error('The Tier 2 files changed. Download the model again.');
      const {ort, Tokenizer} = await this.loadRuntime();
      const [tokenizerJson, tokenizerConfig, config] = await Promise.all(['tokenizer.json', 'tokenizer_config.json', 'config.json'].map(name => readFile(path.join(model.dir, name), 'utf8').then(JSON.parse)));
      const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
      // A quarter of the threads, at most four: a decision must never make the PC feel slow.
      const threads = Math.max(1, Math.min(4, Math.floor(cpus().length / 4)));
      const session = await ort.InferenceSession.create(local(model.dir, model.files.at(-1)), {executionProviders:['cpu'], intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: 'all'});
      this.session = {ort, tokenizer, session, id2label: config.id2label, model};
      return this.session;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  touch() {
    if (this.idle) this.clearTimer(this.idle);
    this.idle = this.setTimer(() => this.release().catch(() => {}), IDLE_UNLOAD_MS);
    this.idle?.unref?.();
  }

  release() {
    if (this.idle) this.clearTimer(this.idle);
    this.idle = null;
    return this.queue = this.queue.catch(() => {}).then(async () => {
      await this.loading?.catch(() => {});
      const current = this.session; this.session = null;
      await current?.session.release?.();
    });
  }

  encode({tokenizer}, premise, hypothesis) {
    if (String(hypothesis).length > 1000) throw Error('The Tier 2 statement is too long.');
    let text = String(premise || '');
    for (let attempt = 0; attempt < 4; attempt++) {
      const encoded = tokenizer.encode(text, {text_pair: hypothesis, return_token_type_ids:true});
      if (encoded.ids.length <= MAX_TOKENS) return {...encoded, truncated: attempt > 0};
      if (text.length < 40) throw Error('The Tier 2 statement exceeds its token limit.');
      // Keep the end of the text: in a chat, the latest part matters most.
      text = text.slice(-Math.floor(text.length * MAX_TOKENS / encoded.ids.length * 0.9));
    }
    throw Error('The Tier 2 question exceeds its token limit.');
  }

  /** Scores each hypothesis against the premise: [{entail, truth}]. */
  score(premise, hypotheses) {
    return this.queue = this.queue.catch(() => {}).then(() => this.scoreNow(premise, hypotheses));
  }

  async scoreNow(premise, hypotheses) {
    const runtime = await this.ensure();
    this.touch();
    const {ort, session, id2label} = runtime;
    const out = [];
    for (const hypothesis of hypotheses) {
      const encoded = this.encode(runtime, premise, hypothesis), ids = encoded.ids;
      const shape = [1, ids.length];
      const feeds = {input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), shape), attention_mask: new ort.Tensor('int64', new BigInt64Array(ids.length).fill(1n), shape)};
      if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new ort.Tensor('int64', BigInt64Array.from(encoded.token_type_ids || new Array(ids.length).fill(0), BigInt), shape);
      const result = await session.run(feeds);
      out.push({...nliScores([...result.logits.data], id2label), truncated:encoded.truncated});
    }
    this.touch();
    return out;
  }
}

async function defaultRuntime() {
  const [{default: ort}, {Tokenizer}] = await Promise.all([import('onnxruntime-node'), import('@huggingface/tokenizers')]);
  return {ort, Tokenizer};
}

/**
 * Turns a typed question into Tier 2 probabilities. noul: the statement itself is the
 * hypothesis. choice: `hypothesis` is a template with {} for each option ("This message
 * is about {}."), options compete through their entailment scores. Score questions are
 * left to the other tiers. Returns null when the question does not fit Tier 2.
 */
export async function nliProbabilities(runtime, {kind, input, question, hypothesis, labels}) {
  if (kind === 'noul') {
    const statement = String(hypothesis || question || '').trim();
    if (!statement) return null;
    const [result] = await runtime.score(input, [statement]);
    if (result.truncated || result.neutral > 0.1 || Math.max(result.truth,result.falsehood) < 0.9) return null;
    const total = result.truth + result.falsehood;
    return [result.falsehood / total, result.truth / total];
  }
  if (kind === 'choice') {
    const template = String(hypothesis || '').includes('{}') ? hypothesis : 'This is about {}.';
    const results = await runtime.score(input, labels.map(label => template.replace('{}', label)));
    if (results.some(result => result.truncated) || !results.some(result => result.truth >= 0.9 && result.neutral <= 0.1)) return null;
    return softmax(results.map(result => result.entail));
  }
  return null;
}
