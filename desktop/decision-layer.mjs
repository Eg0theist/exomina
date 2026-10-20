// Local decision layer prototype: Jev-style typed questions answered on this PC.
//   choice: pick one of a list of options
//   score:  rate on an integer scale
//   noul:   probability that a statement is true
// Every gate learns from decisions recorded while the expensive model still makes
// them. A gate that is untrained or unsure abstains, so the caller falls back to the
// expensive model or the user. Calibration matters more than raw accuracy here.
import {readFile, writeFile, rename, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {probeHardware, chooseTier, TIERS} from './decision-hardware.mjs';
import {findLocalServer, askLocalModel, releaseLocalModel} from './decision-local-llm.mjs';
import {createBusyCheck} from './decision-busy.mjs';
import {nliProbabilities} from './decision-nli.mjs';

const DIM = 1 << 15;
const MIN_EXAMPLES = 40;
const HARDWARE_TTL = 5 * 60_000;  // power state and free RAM change; re-probe now and then
const SERVER_TTL = 60_000;        // a local model server may be started or stopped at any time
const SLOW_SERVER_MS = 1500;      // slower than this means CPU inference: background work only
const MAX_EXAMPLES = 5000;
const MAX_SCALE = 11;
const LEAN_VRAM_GB = 12;          // below this the chat model leaves graphics memory after every answer
const TIER2_MIN_CONFIDENCE = 0.9; // zero-shot answers are not calibrated on Exomina's data, so they need a wide margin
const FILE_VERSION = 2;           // 2: every decision carries the chat it came from

// ---------- Features ----------

function hash(text) {
  // FNV-1a, 32 bit.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Sparse hashed features: words, word pairs and character trigrams, L2-normalised. */
export function features(text) {
  const value = String(text || '').toLowerCase().slice(0, 4000);
  const words = value.match(/[\p{L}\p{N}]+/gu) || [];
  const counts = new Map();
  const add = key => { const index = hash(key) % DIM; counts.set(index, (counts.get(index) || 0) + 1); };
  words.forEach((word, i) => { add('w:' + word); if (i) add('b:' + words[i - 1] + ' ' + word); });
  const squeezed = ' ' + words.join(' ') + ' ';
  for (let i = 0; i + 3 <= squeezed.length; i++) add('c:' + squeezed.slice(i, i + 3));
  const norm = Math.sqrt([...counts.values()].reduce((sum, c) => sum + c * c, 0)) || 1;
  return [...counts].map(([index, count]) => [index, count / norm]);
}

// ---------- Tier 1 classifier ----------

const softmax = (logits, temperature = 1) => {
  const scaled = logits.map(v => v / temperature);
  const top = Math.max(...scaled);
  const exp = scaled.map(v => Math.exp(v - top));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map(v => v / sum);
};

function seededShuffle(items, seed = 7) {
  const out = items.slice();
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Multinomial logistic regression over hashed features, with temperature calibration. */
export class GateClassifier {
  constructor(labels) {
    this.labels = labels;
    this.weights = new Float32Array(labels.length * DIM);
    this.bias = new Float32Array(labels.length);
    this.temperature = 1;
    this.stats = null;
  }

  logits(vector) {
    return this.labels.map((_, k) => {
      let sum = this.bias[k];
      const offset = k * DIM;
      for (const [index, value] of vector) sum += this.weights[offset + index] * value;
      return sum;
    });
  }

  predict(text) { return softmax(this.logits(features(text)), this.temperature); }

  fit(rows, {epochs = 25, rate = 0.5, l2 = 1e-5} = {}) {
    this.weights.fill(0); this.bias.fill(0);
    for (let epoch = 0; epoch < epochs; epoch++) {
      const step = rate / Math.sqrt(epoch + 1);
      for (const {vector, label} of seededShuffle(rows, epoch + 1)) {
        const probabilities = softmax(this.logits(vector));
        for (let k = 0; k < this.labels.length; k++) {
          const gradient = probabilities[k] - (k === label ? 1 : 0);
          this.bias[k] -= step * gradient;
          const offset = k * DIM;
          for (const [index, value] of vector) {
            const at = offset + index;
            this.weights[at] -= step * (gradient * value + l2 * this.weights[at]);
          }
        }
      }
    }
  }

  /**
   * Trains on 80 % of each answer, then fits the temperature and measures accuracy and
   * calibration error on the held-out 20 %. The deployed model is exactly the one that
   * was calibrated: refitting on everything would invalidate the temperature.
   */
  train(examples) {
    const train = [], held = [];
    const byLabel = new Map();
    for (const {text, label} of examples) {
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push({vector: features(text), label});
    }
    for (const rows of byLabel.values()) {
      const shuffled = seededShuffle(rows);
      const cut = Math.max(1, Math.ceil(shuffled.length * 0.8));
      train.push(...shuffled.slice(0, cut)); held.push(...shuffled.slice(cut));
    }
    this.fit(train);
    const heldLogits = held.map(row => this.logits(row.vector));
    let best = {temperature: 1, loss: Infinity};
    for (let t = 0.25; t <= 6; t += 0.25) {
      const loss = held.reduce((sum, row, i) => sum - Math.log(Math.max(1e-9, softmax(heldLogits[i], t)[row.label])), 0);
      if (loss < best.loss) best = {temperature: t, loss};
    }
    this.temperature = best.temperature;
    const predictions = held.map((row, i) => ({probabilities: softmax(heldLogits[i], this.temperature), label: row.label}));
    this.stats = {examples: examples.length, heldOut: held.length, ...calibrationReport(predictions)};
    return this.stats;
  }
}

/** Accuracy and expected calibration error (10 bins) of held-out predictions. */
export function calibrationReport(predictions) {
  if (!predictions.length) return {accuracy: null, calibrationError: null};
  const bins = Array.from({length: 10}, () => ({count: 0, confidence: 0, correct: 0}));
  let correct = 0;
  for (const {probabilities, label} of predictions) {
    const confidence = Math.max(...probabilities);
    const hit = probabilities.indexOf(confidence) === label;
    correct += hit;
    const bin = bins[Math.min(9, Math.floor(confidence * 10))];
    bin.count++; bin.confidence += confidence; bin.correct += hit;
  }
  const ece = bins.reduce((sum, bin) => sum + (bin.count ? Math.abs(bin.confidence - bin.correct) : 0), 0) / predictions.length;
  return {accuracy: round(correct / predictions.length), calibrationError: round(ece)};
}

const round = value => Math.round(value * 1000) / 1000;

// ---------- Questions ----------

/** Turns a typed question into the label list its classifier predicts over. */
export function questionLabels(question) {
  const kind = question?.kind;
  if (kind === 'noul') return ['false', 'true'];
  if (kind === 'choice') {
    const options = (question.options || []).map(option => String(option).trim()).filter(Boolean);
    if (options.length < 2 || options.length > 26 || new Set(options).size !== options.length) throw Error('A choice needs 2 to 26 distinct options.');
    return options;
  }
  if (kind === 'score') {
    const [min, max] = question.scale || [1, 5];
    if (!Number.isInteger(min) || !Number.isInteger(max) || max <= min || max - min + 1 > MAX_SCALE) throw Error(`A score needs an integer scale of at most ${MAX_SCALE} steps.`);
    return Array.from({length: max - min + 1}, (_, i) => String(min + i));
  }
  throw Error('Unknown question kind. Use choice, score or noul.');
}

/** Shapes label probabilities into the answer format of each question kind. */
export function shapeAnswer(kind, labels, probabilities) {
  const confidence = Math.max(...probabilities);
  const best = labels[probabilities.indexOf(confidence)];
  const distribution = Object.fromEntries(labels.map((label, i) => [label, round(probabilities[i])]));
  if (kind === 'noul') return {probability: round(probabilities[1]), answer: best === 'true', confidence: round(confidence), distribution};
  if (kind === 'score') {
    const expected = labels.reduce((sum, label, i) => sum + Number(label) * probabilities[i], 0);
    // Confidence of a score: probability that the true value lies within one step of the estimate.
    const near = labels.reduce((sum, label, i) => sum + (Math.abs(Number(label) - expected) < 1 ? probabilities[i] : 0), 0);
    return {score: Math.round(expected * 10) / 10, answer: Math.round(expected), confidence: round(near), distribution};
  }
  return {answer: best, confidence: round(confidence), distribution};
}

const sameLabels = (a, b) => a.length === b.length && a.every((label, i) => label === b[i]);
const gateName = value => {
  const name = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) throw Error('Gate names use letters, digits, dot, dash or underscore (max 64).');
  return name;
};

// ---------- Router ----------

export class DecisionLayer {
  /**
   * @param {object} options
   * @param {string} options.file JSON file holding the recorded decisions.
   * @param {Function} [options.probe] Hardware probe, injectable for tests.
   * @param {Function} [options.findServer] Local chat-model discovery, injectable for tests.
   * @param {Function} [options.askServer] Local chat-model question, injectable for tests.
   * @param {Function} [options.releaseServer] Unloads the local chat model, injectable for tests.
   * @param {Function} [options.busy] "Is a game or full-screen app running?" check, injectable for tests.
   * @param {boolean} [options.pauseWhileBusy] Make way for demanding apps: pause Tier 3 while one runs (default on).
   * @param {object} [options.nli] Tier 2 runtime (NliRuntime), or null when Tier 2 is unavailable.
   */
  constructor({file, probe = probeHardware, findServer = findLocalServer, askServer = askLocalModel, releaseServer = releaseLocalModel, busy = createBusyCheck(), pauseWhileBusy = true, nli = null, now = () => performance.now(), clock = Date.now} = {}) {
    this.file = file;
    this.probe = probe; this.findServer = findServer; this.askServer = askServer; this.releaseServer = releaseServer; this.now = now; this.clock = clock; this.nli = nli;
    this.busy = busy; this.pauseWhileBusy = pauseWhileBusy; this.pausedUntil = 0;
    this.gates = new Map();   // name -> {kind, labels, examples: [{text, label}], model, added, trainedAt}
    this.loaded = null; this.environment = null; this.saving = Promise.resolve();
  }

  async load() {
    if (this.loaded) return this.loaded;
    this.loaded = (async () => {
      if (!this.file) return;
      try {
        const data = JSON.parse(await readFile(this.file, 'utf8'));
        // Version 1 decisions do not say which chat they came from, so deleting a chat could
        // not remove them. They are dropped once; a few lost labels are worth that guarantee.
        const legacy = (data.version || 1) < FILE_VERSION;
        for (const [name, gate] of Object.entries(data.gates || {}))
          this.gates.set(name, {kind: gate.kind, labels: gate.labels, examples: legacy ? [] : (gate.examples || []), model: null});
        if (legacy) await this.save();
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    })();
    return this.loaded;
  }

  /**
   * Measures the hardware and looks for installed backends. Hardware is re-probed every
   * few minutes (battery, free RAM), the local server every minute. `refresh` forces both.
   */
  async detect({refresh = false} = {}) {
    const now = this.clock();
    const env = this.environment;
    const hardwareStale = refresh || !env || now - env.hardwareAt > HARDWARE_TTL;
    const serverStale = refresh || !env || now - env.serverAt > SERVER_TTL;
    if (!hardwareStale && !serverStale) return env;
    const [hardware, server, nliModel] = await Promise.all([
      hardwareStale ? this.probe() : env.hardware,
      serverStale ? this.findServer().catch(() => null) : env.server,
      serverStale ? (this.nli ? this.nli.installed().catch(() => null) : null) : env.nliModel
    ]);
    // Keep the measured slowness of the same server and model across re-checks.
    const slow = !!(server && env?.server && env.slow && server.url === env.server.url && server.model === env.server.model);
    this.environment = {
      hardware, server, slow, nliModel,
      hardwareAt: hardwareStale ? now : env.hardwareAt,
      serverAt: serverStale ? now : env.serverAt,
      checkedAt: new Date(now).toISOString()
    };
    this.environment.tier = this.tierFor(this.environment);
    return this.environment;
  }

  tierFor({hardware, server, slow, nliModel}) {
    const tier = chooseTier(hardware, {tier2: !!nliModel, tier3: !!server});
    // Hardware capability does not prove the server uses the GPU or NPU; measured speed does.
    if (slow && tier.tier3Mode) {
      tier.backgroundOnly = true;
      tier.reasons.push(`The local chat model answered slower than ${SLOW_SERVER_MS / 1000} s, so it runs only for background work.`);
    }
    return tier;
  }

  async status() {
    await this.load();
    const {hardware, tier, server, nliModel} = await this.detect();
    const gates = [...this.gates].map(([name, gate]) => {
      const model = this.model(name);
      return {name, kind: gate.kind, examples: gate.examples.length, trained: !!model, ...(model?.stats || {})};
    });
    // Status never launches the Windows check; it shows the last result, if still fresh.
    const paused = server ? await this.tier3Pause({probe: false}) : null;
    const tiers = Object.entries(TIERS).map(([level, info]) => {
      const n = Number(level);
      const state = n === 1 ? 'active'
        : n > tier.capable ? 'too-demanding'
        : n === 2 ? (nliModel ? hardware.freeRamGb < 1.5 ? 'low-memory' : 'active' : 'not-installed')
        : !server ? 'not-installed' : paused ? 'paused' : tier.backgroundOnly ? 'background-only' : 'active';
      return {tier: n, ...info, state};
    });
    return {hardware, tier, tiers, paused, manualPause: this.clock() < this.pausedUntil ? (this.pausedUntil === Infinity ? 'until-resumed' : new Date(this.pausedUntil).toISOString()) : null,
      pauseWhileBusy: this.pauseWhileBusy, tier2Model: nliModel && {id: nliModel.id, name: nliModel.name, sizeMb: nliModel.sizeMb, installedAt: nliModel.installedAt},
      server: server && {name: server.name, model: server.model}, gates};
  }

  /** Forgets the cached Tier 2 and server state, e.g. after a model download or removal. */
  invalidate() { if (this.environment) this.environment.serverAt = -Infinity; }

  /** Manual switch for heavy apps the automatic check misses: pauses Tier 3 for `minutes` (Infinity = until resumed). */
  pause(minutes = Infinity) { this.pausedUntil = minutes === Infinity ? Infinity : this.clock() + minutes * 60_000; }
  resume() { this.pausedUntil = 0; }

  /**
   * Why Tier 3 must wait right now, or null. The Windows check only runs here, i.e. when a
   * Tier 3 question is about to be asked: no timer, no network, no AI request.
   */
  async tier3Pause({probe = true} = {}) {
    if (this.clock() < this.pausedUntil) return 'paused by the user';
    if (!this.pauseWhileBusy || !this.busy) return null;
    try {
      const state = probe ? await this.busy() : this.busy.peek?.();
      return state?.busy ? `paused while ${state.reason || 'a demanding app is running'}` : null;
    } catch { return null; }
  }

  model(name) {
    const gate = this.gates.get(name);
    if (!gate || gate.examples.length < MIN_EXAMPLES) return null;
    if (new Set(gate.examples.map(example => example.label)).size < 2) return null;
    // Training blocks for about 0.35 ms per decision, so retrain only after 10 %
    // (at least 10) new decisions rather than after every single one. `added` keeps
    // counting after the oldest decisions are dropped at the cap.
    const fresh = (gate.added || 0) - (gate.trainedAt || 0);
    if (!gate.model || fresh >= Math.max(10, gate.examples.length * 0.1)) {
      gate.model = new GateClassifier(gate.labels);
      gate.model.train(gate.examples);
      gate.trainedAt = gate.added || 0;
    }
    return gate.model;
  }

  /**
   * Answers a typed question. Tries the quick classifier first, escalates to a local
   * chat model when the classifier is untrained or unsure, and abstains otherwise.
   * `threshold` is the confidence an answer needs; `background` allows slow tiers;
   * `maxTier` keeps a question on light tiers (1 = quick classifier only, 2 = also the
   * statement checker; neither touches the graphics card). `hypothesis` phrases the
   * question for Tier 2: the statement for noul, a template with {} for choice.
   */
  async ask({gate, kind, question = '', input = '', options, scale, hypothesis = '', threshold = 0.8, background = false, maxTier = 3}) {
    await this.load();
    const name = gateName(gate);
    const labels = questionLabels({kind, options, scale});
    const started = this.now();
    const attempts = [];

    const stored = this.gates.get(name);
    if (stored && (stored.kind !== kind || !sameLabels(stored.labels, labels))) throw Error(`Gate "${name}" was trained with different options.`);
    const model = this.model(name);
    if (model) {
      const answer = shapeAnswer(kind, labels, model.predict(input));
      attempts.push({tier: 1, confidence: answer.confidence});
      if (answer.confidence >= threshold) return {...answer, tier: 1, abstained: false, attempts, ms: this.elapsed(started)};
    } else attempts.push({tier: 1, skipped: stored ? `needs ${MIN_EXAMPLES} recorded decisions with two different answers` : 'no recorded decisions yet'});

    if (maxTier < 2) {
      attempts.push({tier: 2, skipped: 'this question stays on the quick classifier'});
      return {answer: null, abstained: true, reason: 'The quick classifier was not confident enough. Ask the main model or the user.', attempts, ms: this.elapsed(started)};
    }
    const {tier, server, nliModel, hardware} = await this.detect();
    if (!nliModel || !this.nli) attempts.push({tier: 2, skipped: 'no statement checker installed'});
    else if (tier.capable < 2) attempts.push({tier: 2, skipped: 'this PC is below the statement checker requirements'});
    else if (hardware.freeRamGb < 1.5) { await this.nli.release(); attempts.push({tier: 2, skipped: 'less than 1.5 GB RAM is free'}); }
    else if (kind === 'score' || !(hypothesis || question)) attempts.push({tier: 2, skipped: 'the question has no statement to check'});
    else {
      try {
        const probabilities = await nliProbabilities(this.nli, {kind, input, question, hypothesis, labels});
        if (!probabilities) attempts.push({tier: 2, skipped: 'inconclusive or incomplete evidence'});
        else {
          const answer = shapeAnswer(kind, labels, probabilities);
          attempts.push({tier: 2, confidence: answer.confidence});
          if (answer.confidence >= Math.max(threshold, TIER2_MIN_CONFIDENCE)) return {...answer, tier: 2, abstained: false, attempts, ms: this.elapsed(started)};
        }
      } catch (error) { attempts.push({tier: 2, error: error.message}); }
    }
    if (maxTier < 3) {
      attempts.push({tier: 3, skipped: 'this question stays on the processor tiers'});
      return {answer: null, abstained: true, reason: 'No processor tier was confident enough. Ask the main model or the user.', attempts, ms: this.elapsed(started)};
    }
    // Checked only when Tier 3 would otherwise run, so PCs without a local model never probe.
    const paused = server && (!tier.backgroundOnly || background) ? await this.tier3Pause() : null;
    if (paused) {
      attempts.push({tier: 3, skipped: paused});
      // A model still resident from earlier work leaves the graphics card to the game.
      this.releaseServer(server).catch(() => {});
    }
    else if (server && (!tier.backgroundOnly || background)) {
      try {
        const asked = this.now();
        const reply = await this.askServer(server, {question: question || `Decide for gate ${name}.`, input, options: kind === 'noul' ? ['False', 'True'] : labels});
        if (this.now() - asked > SLOW_SERVER_MS && !this.environment.slow) {
          this.environment.slow = true;
          this.environment.tier = this.tierFor(this.environment);
        }
        // On lean machines the model leaves graphics memory right away instead of after
        // the server's idle timeout, so a game started later has the memory to itself.
        if (tier.loadOnDemand || tier.dedicatedVramGb < LEAN_VRAM_GB) this.releaseServer(server).catch(() => {});
        const answer = shapeAnswer(kind, labels, reply.probabilities);
        attempts.push({tier: 3, confidence: answer.confidence, calibrated: reply.calibrated});
        // An answer without probabilities is a guess with unknown reliability.
        if (reply.calibrated && answer.confidence >= threshold) return {...answer, tier: 3, abstained: false, attempts, ms: this.elapsed(started)};
      } catch (error) { attempts.push({tier: 3, error: error.message}); }
    } else attempts.push({tier: 3, skipped: !server ? 'no local chat model running' : 'background work only on this PC'});

    return {answer: null, abstained: true, reason: 'No local tier was confident enough. Ask the main model or the user.', attempts, ms: this.elapsed(started)};
  }

  /**
   * Records the decision the main model or the user actually made; this is the training data.
   * `source` is the chat it came from, so deleting that chat deletes the decision too.
   */
  async record({gate, kind, input, answer, options, scale, source = null, key = null}) {
    await this.load();
    const name = gateName(gate);
    const labels = questionLabels({kind, options, scale});
    const answerKey = kind === 'noul' ? String(answer === true || answer === 'true') : String(answer);
    const label = labels.indexOf(answerKey);
    if (label < 0) throw Error('The recorded answer is not one of the options.');
    let stored = this.gates.get(name);
    if (!stored) this.gates.set(name, stored = {kind, labels, examples: [], model: null});
    else if (stored.kind !== kind || !sameLabels(stored.labels, labels)) throw Error(`Gate "${name}" was trained with different options.`);
    const example = {text: String(input || '').slice(0, 4000), label, ...(source ? {source: String(source)} : {}), ...(key ? {key:String(key)} : {})};
    const previous = key ? stored.examples.findIndex(row => row.source === example.source && row.key === example.key) : -1;
    if (previous < 0) stored.examples.push(example);
    else {stored.examples[previous]=example;stored.model=null;}
    if (stored.examples.length > MAX_EXAMPLES) stored.examples.splice(0, stored.examples.length - MAX_EXAMPLES);
    stored.added = (stored.added || 0) + 1;
    return this.save();
  }

  /** Deletes every decision recorded from one chat (or agent trigger). Returns how many were removed. */
  forgetSource(source) { return this.prune(value => value !== source); }

  /**
   * Keeps only decisions whose source passes `keep`. At startup this removes decisions of
   * chats deleted while Exomina could not clean up (crash, power loss).
   */
  async prune(keep) {
    await this.load();
    let removed = 0;
    for (const gate of this.gates.values()) {
      const kept = gate.examples.filter(example => !example.source || keep(example.source));
      if (kept.length === gate.examples.length) continue;
      removed += gate.examples.length - kept.length;
      // Force a retrain: the old model still carries what it learned from those decisions.
      gate.examples = kept; gate.model = null; gate.trainedAt = 0; gate.added = kept.length;
    }
    // Also persist on retry after a failed write: memory may already have been pruned.
    await this.save();
    return removed;
  }

  /** Deletes all recorded decisions and trained models. */
  async clear() {
    await this.load();
    this.gates.clear();
    await this.save();
  }

  save() {
    if (!this.file) return Promise.resolve();
    const data = {version: FILE_VERSION, gates: Object.fromEntries([...this.gates].map(([name, gate]) => [name, {kind: gate.kind, labels: gate.labels, examples: gate.examples}]))};
    // A failed earlier write must not block every later one.
    this.saving = this.saving.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.file), {recursive: true});
      const temporary = this.file + '.tmp';
      await writeFile(temporary, JSON.stringify(data), {encoding: 'utf8', mode: 0o600});
      await rename(temporary, this.file);
    });
    return this.saving;
  }

  elapsed(started) { return Math.round((this.now() - started) * 10) / 10; }
}
