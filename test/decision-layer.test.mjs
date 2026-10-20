import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chooseTier, parseWindowsProbe, probeHardware} from '../desktop/decision-hardware.mjs';
import {DecisionLayer, GateClassifier, questionLabels, shapeAnswer, calibrationReport} from '../desktop/decision-layer.mjs';
import {askLocalModel, findLocalServer, releaseLocalModel} from '../desktop/decision-local-llm.mjs';
import {assessBusy, createBusyCheck} from '../desktop/decision-busy.mjs';
import {createNextPromptGate, nextPromptGateInput, suggestionOutcome, NEXT_PROMPT_GATE} from '../desktop/next-prompt-gate.mjs';

// Tests never run the real Windows busy check or contact a model server.
const quiet = {busy: async () => ({busy: false}), releaseServer: async () => false};
const machine = overrides => ({platform: 'win32', cpu: 'x', threads: 8, ramGb: 16, freeRamGb: 8, gpus: [], npus: [], battery: false, onBattery: false, ...overrides});

test('tier choice scales from a netbook to a gaming PC', () => {
  const netbook = chooseTier(machine({ramGb: 4, threads: 2, gpus: [{name: 'Intel UHD', vramGb: 0.1, integrated: true}]}));
  assert.equal(netbook.capable, 1);
  assert.equal(netbook.active, 1);

  const office = chooseTier(machine({ramGb: 8, threads: 4, gpus: [{name: 'Intel Iris Xe', vramGb: 0.1, integrated: true}]}));
  assert.equal(office.capable, 2);
  assert.deepEqual(office.missing, [2]);
  assert.equal(office.loadOnDemand, true);

  const desktop = chooseTier(machine({ramGb: 64, threads: 32, gpus: [{name: 'NVIDIA GeForce RTX 4090', vramGb: 24, integrated: false}]}), {tier3: true});
  assert.equal(desktop.capable, 3);
  assert.equal(desktop.active, 3);
  assert.equal(desktop.tier3Mode, 'gpu');
  assert.equal(desktop.backgroundOnly, false);
});

test('CPU-only and battery-powered machines keep the chat model in the background', () => {
  const cpuOnly = chooseTier(machine({ramGb: 16, threads: 8}));
  assert.equal(cpuOnly.tier3Mode, 'cpu');
  assert.equal(cpuOnly.backgroundOnly, true);

  const laptop = chooseTier(machine({ramGb: 32, threads: 16, onBattery: true, gpus: [{name: 'RTX 4060 Laptop', vramGb: 8, integrated: false}]}));
  assert.equal(laptop.tier3Mode, 'gpu');
  assert.equal(laptop.backgroundOnly, true);

  const npu = chooseTier(machine({ramGb: 16, threads: 4, npus: ['Intel(R) AI Boost']}));
  assert.equal(npu.tier3Mode, 'npu');
});

test('probe parsing prefers registry and nvidia-smi over the capped AdapterRAM field', () => {
  const raw = JSON.stringify({
    gpus: {name: 'NVIDIA GeForce RTX 4090', adapterRam: 4293918720},
    registry: [{name: 'NVIDIA GeForce RTX 4090', bytes: 25757220864}],
    npus: null, battery: false, onBattery: false
  });
  const parsed = parseWindowsProbe(raw, 'NVIDIA GeForce RTX 4090, 24564 MiB\n');
  assert.equal(parsed.gpus.length, 1);
  assert.equal(parsed.gpus[0].vramGb, 24);
  assert.equal(parsed.gpus[0].integrated, false);

  const igpu = parseWindowsProbe(JSON.stringify({gpus: [{name: 'Intel(R) UHD Graphics 620', adapterRam: 1073741824}]}));
  assert.equal(igpu.gpus[0].integrated, true);
  assert.deepEqual(parseWindowsProbe('not json').gpus, []);
});

test('probeHardware never spawns processes when given a runner', async () => {
  const calls = [];
  const hw = await probeHardware({platform: 'win32', run: async (file, args) => { calls.push(file); return file === 'nvidia-smi' ? '' : '{"gpus":[]}'; }});
  assert.deepEqual(calls.sort(), ['nvidia-smi', 'powershell.exe']);
  assert.ok(hw.ramGb > 0 && hw.threads > 0);
});

test('question kinds validate and shape their answers', () => {
  assert.deepEqual(questionLabels({kind: 'noul'}), ['false', 'true']);
  assert.deepEqual(questionLabels({kind: 'score', scale: [1, 3]}), ['1', '2', '3']);
  assert.throws(() => questionLabels({kind: 'choice', options: ['a']}), /2 to 26/);
  assert.throws(() => questionLabels({kind: 'score', scale: [0, 20]}), /at most/);
  assert.throws(() => questionLabels({kind: 'vibes'}), /Unknown/);

  assert.deepEqual(shapeAnswer('noul', ['false', 'true'], [0.2, 0.8]).probability, 0.8);
  const score = shapeAnswer('score', ['1', '2', '3', '4', '5'], [0, 0.5, 0.5, 0, 0]);
  assert.equal(score.score, 2.5);
  assert.equal(score.confidence, 1, 'split between neighbouring steps is still a confident score');
  assert.equal(shapeAnswer('score', ['1', '2', '3', '4', '5'], [0.5, 0, 0, 0, 0.5]).confidence, 0);
  assert.equal(shapeAnswer('choice', ['a', 'b'], [0.9, 0.1]).answer, 'a');
});

test('calibration report measures accuracy and expected calibration error', () => {
  const report = calibrationReport([
    {probabilities: [0.9, 0.1], label: 0},
    {probabilities: [0.9, 0.1], label: 1}
  ]);
  assert.equal(report.accuracy, 0.5);
  assert.equal(report.calibrationError, 0.4);
});

// Synthetic "worth remembering?" gate: durable preferences and decisions versus chit-chat.
const keep = ['prefers dark mode in every app', 'decided to use Matrix for team chat', 'always wants German typography', 'lives in Example City and works at an agency', 'never wants em-dashes in replies', 'chose beta channel for updates', 'uses a 4090 for local models', 'prefers short status updates', 'decided Highcrest is the district name', 'wants the update installed only after approval'];
const skip = ['thanks, looks good', 'ok go ahead', 'what time is it', 'lol nice', 'hmm let me think', 'can you repeat that', 'cool', 'sounds fine to me', 'one sec', 'never mind that'];
const people = ['Alex', 'The user', 'He', 'They'];
const sample = (list, i) => list[i % list.length];
const examples = Array.from({length: 120}, (_, i) => i % 2
  ? {input: `${sample(people, i)} ${sample(keep, i * 7)}`, answer: 'remember'}
  : {input: `${sample(skip, i * 3)}${i % 4 ? '!' : ''}`, answer: 'skip'});

test('a gate abstains until trained, then answers fast and confidently', async () => {
  const layer = new DecisionLayer({...quiet, probe: async () => machine({ramGb: 8, threads: 4}), findServer: async () => null});
  const question = {gate: 'memory.worth', kind: 'choice', options: ['remember', 'skip']};

  const untrained = await layer.ask({...question, input: 'Alex prefers dark mode'});
  assert.equal(untrained.abstained, true);
  assert.match(untrained.attempts[0].skipped, /no recorded decisions/);

  for (const example of examples) await layer.record({...question, ...example});
  const keepIt = await layer.ask({...question, input: 'They decided to use Matrix for team chat', threshold: 0.6});
  const dropIt = await layer.ask({...question, input: 'ok sounds good, thanks', threshold: 0.6});
  assert.equal(keepIt.answer, 'remember');
  assert.equal(dropIt.answer, 'skip');
  assert.equal(keepIt.tier, 1);

  const status = await layer.status();
  assert.equal(status.gates[0].trained, true);
  assert.ok(status.gates[0].accuracy >= 0.9, JSON.stringify(status.gates[0]));
  assert.equal(status.tiers.find(t => t.tier === 2).state, 'not-installed');
  assert.equal(status.tiers.find(t => t.tier === 3).state, 'too-demanding');
});

test('unsure answers escalate to a running local chat model, and only calibrated ones count', async () => {
  const server = {name: 'Ollama', url: 'http://local', model: 'qwen'};
  let reply = {probabilities: [0.1, 0.9], calibrated: true};
  const layer = new DecisionLayer({...quiet, probe: async () => machine({ramGb: 64, threads: 32, gpus: [{name: 'RTX', vramGb: 24, integrated: false}]}), findServer: async () => server, askServer: async () => reply});
  const result = await layer.ask({gate: 'team.needs-me', kind: 'noul', question: 'Does this message need Alex?', input: '@Alex can you approve the invoice today?'});
  assert.equal(result.tier, 3);
  assert.equal(result.answer, true);
  assert.equal(result.probability, 0.9);

  reply = {probabilities: [0, 1], calibrated: false};
  const guess = await layer.ask({gate: 'team.needs-me', kind: 'noul', input: 'lunch?'});
  assert.equal(guess.abstained, true);
});

test('CPU-only chat models are skipped for interactive questions', async () => {
  let asked = 0;
  const layer = new DecisionLayer({...quiet, probe: async () => machine({ramGb: 16, threads: 8}), findServer: async () => ({name: 'Ollama', url: 'x', model: 'm'}), askServer: async () => { asked++; return {probabilities: [0, 1], calibrated: true}; }});
  const interactive = await layer.ask({gate: 'g', kind: 'noul', input: 'x'});
  assert.equal(interactive.abstained, true);
  assert.equal(asked, 0);
  const background = await layer.ask({gate: 'g', kind: 'noul', input: 'x', background: true});
  assert.equal(background.tier, 3);
});

test('recorded decisions persist and conflicting gate definitions are refused', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'exomina-decision-'));
  try {
    const file = path.join(dir, 'decisions.json');
    const first = new DecisionLayer({...quiet, file, probe: async () => machine(), findServer: async () => null});
    await first.record({gate: 'risk', kind: 'score', scale: [1, 3], input: 'delete folder', answer: 3});
    await assert.rejects(first.record({gate: 'risk', kind: 'score', scale: [1, 5], input: 'x', answer: 1}), /different options/);
    await assert.rejects(first.record({gate: 'risk', kind: 'score', scale: [1, 3], input: 'x', answer: 9}), /not one of the options/);
    await assert.rejects(first.record({gate: '../evil', kind: 'noul', input: 'x', answer: true}), /Gate names/);

    const second = new DecisionLayer({...quiet, file, probe: async () => machine(), findServer: async () => null});
    const status = await second.status();
    assert.deepEqual(status.gates.map(g => [g.name, g.examples]), [['risk', 1]]);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 2);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

const jsonResponse = body => ({ok: true, status: 200, json: async () => body});

test('local model answers are read from option-letter probabilities', async () => {
  const reply = (b, a, other) => async () => jsonResponse({choices: [{message: {content: 'B'}, logprobs: {content: [{top_logprobs: [
    {token: 'B', logprob: Math.log(b)}, {token: ' A', logprob: Math.log(a)}, {token: 'Sure', logprob: Math.log(other)}
  ]}]}}]});
  const result = await askLocalModel({url: 'http://x', model: 'm'}, {question: 'Pick', options: ['one', 'two']}, {fetchImpl: reply(0.7, 0.25, 0.05)});
  assert.equal(result.calibrated, true);
  assert.deepEqual(result.probabilities.map(p => Math.round(p * 100)), [26, 74]);

  // Most probability outside the option letters: renormalising would invent confidence.
  const vague = await askLocalModel({url: 'http://x', model: 'm'}, {question: 'Pick', options: ['one', 'two']}, {fetchImpl: reply(0.2, 0.01, 0.79)});
  assert.equal(vague.calibrated, false);

  const plain = await askLocalModel({url: 'http://x', model: 'm'}, {question: 'Pick', options: ['one', 'two']}, {fetchImpl: async () => jsonResponse({choices: [{message: {content: 'A'}}]})});
  assert.deepEqual(plain, {probabilities: [1, 0], calibrated: false});
});

test('local server discovery skips silent servers and embedding-only models', async () => {
  const fetchImpl = async url => {
    if (url.includes('11434')) throw Error('ECONNREFUSED');
    return jsonResponse({data: [{id: 'nomic-embed-text'}, {id: 'qwen2.5-1.5b-instruct'}]});
  };
  const server = await findLocalServer({fetchImpl});
  assert.equal(server.name, 'LM Studio');
  assert.equal(server.model, 'qwen2.5-1.5b-instruct');
  assert.equal(await findLocalServer({fetchImpl: async () => { throw Error('down'); }}), null);
});

test('a gate retrains only after enough new decisions', async () => {
  const layer = new DecisionLayer({...quiet, probe: async () => machine(), findServer: async () => null});
  const question = {gate: 'throttle', kind: 'choice', options: ['remember', 'skip']};
  for (const example of examples.slice(0, 40)) await layer.record({...question, ...example});
  const first = layer.model('throttle');
  await layer.record({...question, ...examples[40]});
  assert.equal(layer.model('throttle'), first);
  for (const example of examples.slice(41, 51)) await layer.record({...question, ...example});
  assert.notEqual(layer.model('throttle'), first);
});

test('a local server started later is found after the re-check interval', async () => {
  let time = 0, server = null;
  const layer = new DecisionLayer({...quiet, clock: () => time, probe: async () => machine({ramGb: 64, threads: 32, gpus: [{name: 'RTX', vramGb: 24, integrated: false}]}), findServer: async () => server});
  assert.equal((await layer.detect()).server, null);
  server = {name: 'Ollama', url: 'x', model: 'm'};
  time = 30_000;
  assert.equal((await layer.detect()).server, null);
  time = 61_000;
  assert.equal((await layer.detect()).server.name, 'Ollama');
  assert.equal(layer.environment.tier.active, 3);
});

test('a local model that answers slowly is demoted to background work', async () => {
  let ticks = 0;
  const layer = new DecisionLayer({...quiet,
    now: () => (ticks += 2000),
    probe: async () => machine({ramGb: 64, threads: 32, gpus: [{name: 'RTX', vramGb: 24, integrated: false}]}),
    findServer: async () => ({name: 'Ollama', url: 'x', model: 'm'}),
    askServer: async () => ({probabilities: [0, 1], calibrated: true})
  });
  const first = await layer.ask({gate: 'g', kind: 'noul', input: 'x'});
  assert.equal(first.tier, 3);
  assert.equal(layer.environment.tier.backgroundOnly, true);
  const second = await layer.ask({gate: 'g', kind: 'noul', input: 'x'});
  assert.equal(second.abstained, true);
  assert.equal((await layer.ask({gate: 'g', kind: 'noul', input: 'x', background: true})).tier, 3);
});

test('the classifier stays small enough for weak hardware', () => {
  const model = new GateClassifier(['a', 'b']);
  assert.ok(model.weights.byteLength <= 2 * 1024 * 1024);
});

// ---------- Busy check (games, full-screen apps) ----------

const probe = state => JSON.stringify({notification: 5, foreground: {pid: 10, name: 'firefox', className: 'MozillaWindowClass', coversMonitor: false}, gpu: [{pid: 3208, name: 'dwm', load: 2}], ...state});

test('busy check recognises exclusive, borderless and windowed games', () => {
  assert.equal(assessBusy(probe({}), {ownPids: [1]}).busy, false);
  assert.match(assessBusy(probe({notification: 3}), {ownPids: [1]}).reason, /full-screen game/);
  assert.match(assessBusy(probe({notification: 4}), {ownPids: [1]}).reason, /presentation/);
  const borderless = assessBusy(probe({foreground: {pid: 20, name: 'eldenring', className: 'ELDEN RING', coversMonitor: true}}), {ownPids: [1]});
  assert.match(borderless.reason, /eldenring in borderless/);
  const windowed = assessBusy(probe({gpu: [{pid: 30, name: 'dota2', load: 78}, {pid: 31, name: 'chrome', load: 12}]}), {ownPids: [1]});
  assert.match(windowed.reason, /dota2 using 78 %/);
  // A browser playing video stays below the threshold.
  assert.equal(assessBusy(probe({gpu: [{pid: 31, name: 'chrome', load: 25}]}), {ownPids: [1]}).busy, false);
});

test('busy check ignores Exomina, the model servers and the desktop itself', () => {
  const state = probe({
    foreground: {pid: 1, name: 'Exomina', className: 'Chrome_WidgetWin_1', coversMonitor: true},
    gpu: [{pid: 40, name: 'ollama_llama_server', load: 95}, {pid: 41, name: 'LM Studio', load: 90}, {pid: 1, name: 'whatever', load: 80}]
  });
  assert.equal(assessBusy(state, {ownPids: [1]}).busy, false);
  assert.equal(assessBusy(probe({foreground: {pid: 50, name: 'explorer', className: 'WorkerW', coversMonitor: true}}), {ownPids: [1]}).busy, false);
  const unreadable = assessBusy('', {ownPids: [1]});
  assert.deepEqual([unreadable.busy, unreadable.known], [false, false]);
});

test('busy check probes at most once per interval and stays paused briefly after a game', async () => {
  let time = 0, runs = 0, state = probe({notification: 3});
  const check = createBusyCheck({platform: 'win32', clock: () => time, ownPids: [1], run: async () => { runs++; return state; }});
  assert.equal((await check()).busy, true);
  time = 30_000;
  await Promise.all([check(), check(), check()]);
  assert.equal(runs, 1);
  state = probe({});
  time = 50_000;
  const after = await check();
  assert.equal(runs, 2);
  assert.equal(after.busy, true, 'cool-down after the game closed');
  time = 200_000;
  assert.equal((await check()).busy, false);
  assert.equal(runs, 3);
  // Quiet results expire after 15 s, so a game started now is noticed quickly.
  state = probe({notification: 3});
  time = 210_000;
  assert.equal((await check()).busy, false);
  time = 216_000;
  assert.equal(check.peek(), null, 'peek never probes');
  assert.equal(runs, 3);
  assert.equal((await check()).busy, true);
  assert.equal(check.peek().busy, true);
  const other = createBusyCheck({platform: 'linux', run: async () => { throw Error('must not run'); }});
  assert.equal((await other()).busy, false);
});

test('Tier 3 pauses while busy, and PCs without a local model never run the check', async () => {
  let checks = 0, busy = true, asked = 0, released = 0;
  const gamingPc = machine({ramGb: 64, threads: 32, gpus: [{name: 'RTX', vramGb: 24, integrated: false}]});
  const options = server => ({
    ...quiet, probe: async () => gamingPc, findServer: async () => server, releaseServer: async () => { released++; return true; },
    askServer: async () => { asked++; return {probabilities: [0, 1], calibrated: true}; },
    busy: async () => { checks++; return {busy, reason: 'dota2 using 90 % of the graphics card'}; }
  });

  const without = new DecisionLayer(options(null));
  await without.ask({gate: 'g', kind: 'noul', input: 'x'});
  assert.equal(checks, 0);

  const layer = new DecisionLayer(options({name: 'Ollama', url: 'x', model: 'm'}));
  const quick = await layer.ask({gate: 'g', kind: 'noul', input: 'x', maxTier: 1});
  assert.equal(quick.abstained, true);
  assert.equal(checks, 0, 'Tier 1-only questions never check');

  const paused = await layer.ask({gate: 'g', kind: 'noul', input: 'x', background: true});
  assert.equal(paused.abstained, true);
  assert.match(paused.attempts.at(-1).skipped, /paused while dota2/);
  assert.equal(asked, 0);
  assert.equal(released, 1, 'a resident model is unloaded when a game is detected');
  const before = checks;
  await layer.status();
  assert.equal(checks, before, 'status never launches the Windows check');

  busy = false;
  assert.equal((await layer.ask({gate: 'g', kind: 'noul', input: 'x'})).tier, 3);
  layer.pause(10);
  assert.match((await layer.ask({gate: 'g', kind: 'noul', input: 'x'})).attempts.at(-1).skipped, /paused by the user/);
  layer.resume();
  assert.equal((await layer.ask({gate: 'g', kind: 'noul', input: 'x'})).tier, 3);
});

test('the chat model is unloaded after each answer only on machines with little memory', async () => {
  const run = async hardware => {
    let released = 0;
    const layer = new DecisionLayer({...quiet, probe: async () => hardware, findServer: async () => ({name: 'Ollama', url: 'x', model: 'm'}),
      askServer: async () => ({probabilities: [0, 1], calibrated: true}), releaseServer: async () => { released++; return true; }});
    await layer.ask({gate: 'g', kind: 'noul', input: 'x', background: true});
    return released;
  };
  assert.equal(await run(machine({ramGb: 64, threads: 32, gpus: [{name: 'RTX 4090', vramGb: 24, integrated: false}]})), 0);
  assert.equal(await run(machine({ramGb: 16, threads: 8, gpus: [{name: 'RTX 3060', vramGb: 8, integrated: false}]})), 1);
});

test('unloading asks Ollama for keep_alive 0 and leaves LM Studio alone', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push([url, JSON.parse(init.body)]); return jsonResponse({}); };
  assert.equal(await releaseLocalModel({name: 'Ollama', url: 'http://127.0.0.1:11434/v1', model: 'qwen'}, {fetchImpl}), true);
  assert.deepEqual(calls, [['http://127.0.0.1:11434/api/generate', {model: 'qwen', keep_alive: 0}]]);
  assert.equal(await releaseLocalModel({name: 'LM Studio', url: 'x', model: 'm'}, {fetchImpl}), false);
  assert.equal(calls.length, 1);
});

// ---------- Next-prompt gate ----------

test('next-prompt suggestions are labelled by what the user sends next', async () => {
  const layer = new DecisionLayer({...quiet, probe: async () => machine(), findServer: async () => null});
  const gate = createNextPromptGate(layer);
  const messages = [
    {role: 'user', content: 'Build the prototype'},
    {role: 'assistant', content: 'Built it.', nextPrompt: 'Package this as beta.41 and install it'}
  ];
  assert.equal(await gate.record(messages, 'Package this as beta.41 and install it please'), 'used');
  assert.equal(messages[1].nextPromptRecorded, true);
  assert.equal(await gate.record(messages, 'again'), null, 'each suggestion is labelled once');

  messages.push({role: 'user', content: 'x'}, {role: 'assistant', content: 'Done.', nextPromptHidden: 'Apply the update now'});
  assert.equal(await gate.record(messages, 'What is the next step?'), null, 'an unseen suggestion teaches nothing when ignored');
  messages.push({role: 'user', content: 'y'}, {role: 'assistant', content: 'Done.', nextPromptHidden: 'Apply the update now'});
  assert.equal(await gate.record(messages, 'apply the update now'), 'used', 'typing a hidden suggestion corrects the gate');
  messages.push({role: 'user', content: 'z'}, {role: 'assistant', content: 'Done.', nextPrompt: 'Write the summary'});
  assert.equal(await gate.record(messages, 'What is the next step?'), 'ignored');
  assert.equal(await gate.record([{role: 'assistant', content: 'no suggestion'}], 'hi'), null);
  assert.equal(suggestionOutcome('Go on', 'go on!'), 'used');
  assert.equal(suggestionOutcome('Go on', 'stop'), 'ignored');
  const [stored] = (await layer.status()).gates;
  assert.deepEqual([stored.name, stored.examples], ['next-prompt.useful', 3]);
});

test('the next-prompt gate hides only suggestions it is very sure will be ignored', async () => {
  let checks = 0;
  const layer = new DecisionLayer({...quiet, probe: async () => machine(), findServer: async () => ({name: 'Ollama', url: 'x', model: 'm'}),
    askServer: async () => { throw Error('must stay on Tier 1'); }, busy: async () => { checks++; return {busy: false}; }});
  const gate = createNextPromptGate(layer);
  const shown = {suggestion: 'Apply the update now', request: 'Package this and install it', reply: 'Installed and verified.'};
  assert.equal(await gate.shouldHide(shown), false, 'untrained gates never hide');

  for (let i = 0; i < 60; i++) {
    const ignored = i % 2 === 0;
    await layer.record({...NEXT_PROMPT_GATE, answer: ignored ? 'ignored' : 'used',
      input: nextPromptGateInput(ignored
        ? {suggestion: `Apply the update now ${i}`, request: 'Package this and install it', reply: 'Installed and verified.'}
        : {suggestion: `Write the chapter ${i} summary`, request: 'Edit chapter', reply: 'Edited the chapter text.'})});
  }
  assert.equal(await gate.shouldHide(shown), true);
  assert.equal(await gate.shouldHide({suggestion: 'Write the chapter 99 summary', request: 'Edit chapter', reply: 'Edited the chapter text.'}), false);
  assert.equal(checks, 0);
});
