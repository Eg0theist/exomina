import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePersonalization, personalizationContext } from '../desktop/personalization.mjs';
import { changeSoulFromSettings } from '../desktop/soul-service.mjs';
import { normalizeSoulLearning, forgetSoulLearningChat, changeSoulLearning } from '../desktop/soul-learning-state.mjs';
import { SoulLearning, soulLearningWindow, applySoulReflection, soulReflectionPrompt, chooseSoulModel } from '../desktop/soul-learning.mjs';
import { realtimeConversationContext, REALTIME_CONTEXT_LIMIT } from '../desktop/realtime-voice-context.mjs';
import { updateRestartBlockers } from '../desktop/update-restart-guard.mjs';

const models = [{ provider: 'codex', model: 'gpt-6-luna', available: true, efforts: ['low', 'high'] }];
const makeChat = (id = 'a', texts = ['I like a clear, practical answer.', 'Please keep technical updates plain.', 'A clear, practical answer helps me.']) => ({ id, provider: 'codex', messages: texts.flatMap((content, i) => [{ id: `${id}-u${i}`, role: 'user', content }, { id: `${id}-a${i}`, role: 'assistant', content: 'Here is a clear answer, with the reasoning made visible.' }]) });
const proposal = (window, ids = ['a-u0', 'a-u2'], extra = {}) => ({ observations: [{ key: 'plain-technical', text: 'Give plain technical updates that make the reasoning visible.', scope: 'technical', dimension: 'register', stance: 'support', evidence: ids.map(id => ({ messageId: id, quote: window.turns.find(turn => turn.id === id).user })), conflicts: [], ...extra }], examples: [] });
const established = window => applySoulReflection(applySoulReflection({}, proposal(window, ['a-u0']), window), proposal(window, ['a-u2']), window);
function fixture({ execute, chat = makeChat(), personalization = {}, allowed = () => true, timeout } = {}) {
  let value = normalizePersonalization(personalization), calls = 0, saves = 0;
  const service = new SoulLearning({ getPersonalization: () => value, setPersonalization: next => { value = next; }, getChat: id => chat?.id === id ? chat : null, available: () => models, execute: async request => { calls++; return execute ? execute(request) : { text: JSON.stringify({ observations: [], examples: [] }) }; }, save: async () => { saves++; }, allowed, timeout });
  return { service, chat, get value() { return value; }, set value(next) { value = next; }, get calls() { return calls; }, get saves() { return saves; } };
}

test('old Soul data migrates without losing traits, source authority or recovery', () => {
  const value = normalizePersonalization({ soul: { traits: [{ id: 'stated', text: 'Keep complex clauses in philosophical discussion.', source: 'stated', evidence: 'Direct request.' }], history: [{ id: 'old', action: 'add', before: [], afterIds: ['stated'] }] } });
  assert.equal(value.soul.traits[0].source, 'stated'); assert.equal(value.soul.history.length, 1);
  assert.equal(value.soul.learning.enabled, true); assert.equal(value.soul.learning.dailyLimit, 12);
  assert.deepEqual(normalizePersonalization(value), value);
});

test('the reflection window excludes errors, uncompleted turns, quotes, code and credentials', () => {
  const chat = makeChat('a', ['My own feedback stays visible.\n> My friend wants romantic flattery.\n```\nDo not learn this pasted code.\n```\napi_key=sk-secretkey123456789', 'I like a clear, practical answer.', 'A clear, practical answer helps me.']);
  chat.messages.push({ id: 'incomplete', role: 'user', content: 'Do not process a turn still running.' });
  const window = soulLearningWindow(chat, normalizeSoulLearning());
  assert.equal(window.lastId, 'a-u2'); assert.equal(window.turns.length, 3);
  assert.doesNotMatch(JSON.stringify(window.turns), /romantic flattery|pasted code|sk-secret|still running/);
  assert.match(window.turns[0].user, /My own feedback/);
  const invalid = proposal(window, ['a-u1']); invalid.observations[0].evidence[0].quote = 'My friend wants romantic flattery.';
  assert.throws(() => applySoulReflection({}, invalid, window), /eligible user-authored/);
});

test('one turn cannot establish a pattern; independent turns can, and tentative patterns stay out of prompts', () => {
  const window = soulLearningWindow(makeChat(), normalizeSoulLearning());
  let state = applySoulReflection({}, proposal(window, ['a-u0', 'a-u0']), window);
  assert.equal(state.observations[0].support.length, 1); assert.equal(state.observations[0].status, 'tentative');
  assert.doesNotMatch(personalizationContext({ soul: { learning: state } }, null, { request: 'Fix the bug.' }), /Give plain technical updates/);
  const onePass = applySoulReflection({}, proposal(window), window);
  assert.equal(onePass.observations[0].status, 'tentative', 'one reflection cannot establish a pattern');
  state = applySoulReflection(state, proposal(window, ['a-u2']), window);
  assert.equal(state.observations[0].status, 'learned');
  assert.match(personalizationContext({ soul: { learning: state } }, null, { request: 'Fix the bug.' }), /Give plain technical updates/);
  assert.doesNotMatch(personalizationContext({ soul: { learning: state } }, null, { request: 'Discuss a poem.' }), /Give plain technical updates/);
  assert.doesNotMatch(personalizationContext({ soul: { learning: state } }, null, { privateChat: true }), /Give plain technical updates/);
});

test('conflicting observations cannot overrule stated traits and old evidence cannot masquerade as new', () => {
  const window = soulLearningWindow(makeChat(), normalizeSoulLearning()), traits = [{ id: 'stated', source: 'stated', text: 'Keep reports detailed.' }];
  const state = applySoulReflection({}, proposal(window, ['a-u0', 'a-u2'], { conflicts: ['stated'] }), window, traits);
  assert.equal(state.observations[0].status, 'tentative');
  assert.doesNotMatch(personalizationContext({ soul: { traits, learning: state } }, null, { request: 'Fix the bug.' }), /Give plain technical updates/);
  assert.throws(() => applySoulReflection({}, proposal(window), { ...window, newIds: new Set(['missing']) }), /old evidence/);
  assert.throws(() => applySoulReflection({}, { ...proposal(window), action: 'rename' }, window), /contract/);
});

test('contradiction suspends a pattern; later independent evidence can reestablish it without rewriting wording', () => {
  const first = soulLearningWindow(makeChat(), normalizeSoulLearning());
  let state = applySoulReflection({}, proposal(first, ['a-u0']), first, [], new Date('2026-10-28T10:00:00Z'));
  state = applySoulReflection(state, proposal(first, ['a-u2']), first, [], new Date('2026-10-28T10:30:00Z'));
  state = applySoulReflection(state, proposal(first, ['a-u1'], { stance: 'contradict' }), first, [], new Date('2026-10-28T11:00:00Z'));
  assert.equal(state.observations[0].status, 'contested');
  const later = soulLearningWindow(makeChat('b'), normalizeSoulLearning());
  assert.throws(() => applySoulReflection(state, proposal(later, ['b-u0', 'b-u2'], { text: 'A different model must not replace the original guidance.' }), later), /silently change wording/);
  const newChat = makeChat('b', ['Again, clear technical reasoning is what helps me.', 'I want concrete outcomes in technical updates.', 'Keep technical reasoning concrete and clear.']);
  const newWindow = soulLearningWindow(newChat, normalizeSoulLearning());
  state = applySoulReflection(state, proposal(newWindow, ['b-u0']), newWindow, [], new Date('2026-10-28T12:00:00Z'));
  assert.equal(state.observations[0].status, 'contested');
  state = applySoulReflection(state, proposal(newWindow, ['b-u2']), newWindow, [], new Date('2026-10-28T13:00:00Z'));
  assert.equal(state.observations[0].status, 'learned'); assert.match(state.observations[0].text, /^Give plain technical/);
  assert.equal(forgetSoulLearningChat(state, 'unrelated').observations[0].status, 'learned');
});

test('examples require actual later praise; mere continuation is insufficient', () => {
  const chat = makeChat('a', ['Can you explain the reasoning?', 'I like how clear that wording is.', 'Please continue with the next topic.']);
  const window = soulLearningWindow(chat, normalizeSoulLearning());
  const example = { messageId: 'a-a0', feedbackMessageId: 'a-u1', quote: window.turns[1].user, excerpt: window.turns[0].reply, reason: 'Clear phrasing was welcomed.', scope: 'all' };
  const state = applySoulReflection({}, { observations: [], examples: [example] }, window);
  assert.equal(state.examples.length, 1);
  assert.match(personalizationContext({ soul: { learning: state } }, null), /not a script/);
  assert.throws(() => applySoulReflection({}, { observations: [], examples: [{ ...example, feedbackMessageId: 'a-u2', quote: window.turns[2].user }] }, window), /positive user feedback/);
  const negative = soulLearningWindow(makeChat('a', ['Explain the reasoning.', "I don't like how clear that wording is.", 'Another topic follows.']), normalizeSoulLearning());
  assert.throws(() => applySoulReflection({}, { observations: [], examples: [{ ...example, quote: negative.turns[1].user, excerpt: negative.turns[0].reply }] }, negative), /positive user feedback/);
});

test('Settings correction wins over later inference and forgetting removes evidence plus recovery copies', () => {
  const window = soulLearningWindow(makeChat(), normalizeSoulLearning());
  let state = applySoulReflection({}, proposal(window), window);
  const id = state.observations[0].id;
  state = changeSoulLearning(state, { action: 'learning.correct', id, text: 'Use fuller explanations when I ask for depth.' });
  state = applySoulReflection(state, proposal(window, ['a-u1'], { stance: 'contradict' }), window);
  assert.equal(state.observations[0].corrected, true); assert.equal(state.observations[0].status, 'learned');
  state = changeSoulLearning(state, { action: 'learning.forget', id });
  assert.deepEqual(state.observations, []); assert.deepEqual(state.history, []);
  assert.doesNotMatch(JSON.stringify(state), /fuller explanations|I like a clear/);
  assert.equal(applySoulReflection(state, proposal(window), window).observations.length, 0);
  const renamed = proposal(window, ['a-u0'], { key: 'renamed-technical-pattern' });
  assert.throws(() => applySoulReflection(state, renamed, window), /Forgotten evidence/);
  assert.throws(() => changeSoulFromSettings({}, { action: 'learning.patch', patch: { observations: [] } }), /Invalid automatic/);
});

test('deleting a chat removes its evidence and examples and downgrades unsupported patterns', () => {
  const first = soulLearningWindow(makeChat(), normalizeSoulLearning());
  let state = applySoulReflection({}, proposal(first, ['a-u0']), first);
  const second = soulLearningWindow(makeChat('b'), normalizeSoulLearning());
  state = applySoulReflection(state, proposal(second, ['b-u1']), second);
  assert.equal(state.observations[0].status, 'learned');
  state = forgetSoulLearningChat(state, 'a');
  assert.equal(state.observations[0].status, 'tentative'); assert.equal(state.observations[0].support.length, 1);
  assert.doesNotMatch(JSON.stringify(state), /a-u0/); assert.deepEqual(state.history, []);
});

test('cloned or resent text cannot add confidence and cadence up to twenty shows all checkpointed turns', () => {
  const first = soulLearningWindow(makeChat(), normalizeSoulLearning());
  let state = applySoulReflection({}, proposal(first, ['a-u0']), first);
  const clone = soulLearningWindow(makeChat('b'), normalizeSoulLearning());
  state = applySoulReflection(state, proposal(clone, ['b-u0']), clone);
  assert.equal(state.observations[0].support.length, 1); assert.equal(state.observations[0].status, 'tentative');
  const window = soulLearningWindow(makeChat('long', Array.from({ length: 20 }, (_, i) => `Technical preference in original user turn ${i}.`)), normalizeSoulLearning({ cadence: 20 }));
  assert.equal(window.turns.length, 20); assert.equal(window.newIds.size, 20);
  assert.ok(JSON.stringify(window.turns).length < 23000);
});

test('private, disabled, disallowed and unfinished chats never make provider requests', async () => {
  for (const options of [{ chat: { ...makeChat(), private: true } }, { chat: { ...makeChat(), background: true } }, { personalization: { soul: { enabled: false } } }, { personalization: { soul: { learning: { enabled: false } } } }, { allowed: () => false }, { chat: makeChat('a', ['Only one completed exchange.']) }]) {
    const f = fixture(options); await f.service.run('a'); assert.equal(f.calls, 0); assert.equal(f.saves, 0); f.service.close();
  }
});

test('reflection checkpoints, daily limit and verified model selection bound provider usage', async () => {
  const f = fixture({ personalization: { soul: { learning: { dailyLimit: 1 } } } });
  await f.service.run('a'); await f.service.run('a');
  assert.equal(f.calls, 1); assert.equal(f.value.soul.learning.requests, 1); assert.equal(f.value.soul.learning.reviews[0].status, 'complete');
  assert.equal(chooseSoulModel([{ ...models[0], available: false }], {}, 'codex'), null);
  assert.equal(chooseSoulModel([{ provider: 'local', model: 'local-small', available: true }, { provider: 'api', model: 'paid', available: true }], {}, ''), null);
  assert.equal(chooseSoulModel(models, { provider: 'claude' }, 'codex'), null);
  assert.match(soulReflectionPrompt(f.value.soul, soulLearningWindow(makeChat('b'), normalizeSoulLearning())), /one-off task requirement stays local/);
  f.service.close();
});

test('settings changes, cancellation and edited sources invalidate in-flight results', async () => {
  for (const mutate of [f => { f.value = changeSoulFromSettings(f.value, { action: 'learning.patch', patch: { enabled: false } }); }, f => f.service.cancel('a'), f => { f.chat.messages[0].content = 'This source was edited.'; }]) {
    let resolve, started;
    const ready = new Promise(done => { started = done; });
    const f = fixture({ execute: async () => { started(); return new Promise(done => { resolve = done; }); } });
    const running = f.service.run('a'); await ready;
    const window = soulLearningWindow(makeChat(), normalizeSoulLearning());
    mutate(f); resolve({ text: JSON.stringify(proposal(window)) }); await running;
    assert.equal(f.value.soul.learning.observations.length, 0); assert.equal(f.service.activeCount, 0); f.service.close();
  }
});

test('a stalled provider is bounded, recorded and never retried automatically', async () => {
  const f = fixture({ execute: () => new Promise(() => {}), timeout: 20 });
  // A real app has an event loop; keep this isolated test alive for the unref timeout.
  const keepAlive = setTimeout(() => {}, 500);
  await f.service.run('a'); clearTimeout(keepAlive);
  assert.equal(f.service.activeCount, 0); assert.equal(f.value.soul.learning.reviews[0].status, 'cancelled');
  await f.service.run('a'); assert.equal(f.calls, 1); f.service.close();
});

test('reflection appears as its own stoppable restart blocker', () => {
  const blockers = updateRestartBlockers({ reflections: 1 });
  assert.equal(blockers.length, 1); assert.equal(blockers[0].kind, 'reflections');
  assert.match(blockers[0].message, /pause automatic learning/);
});

test('speech retains all thirty realistic trait records while preserving current instructions and chat context', () => {
  const traits = Array.from({ length: 30 }, (_, i) => ({ id: `trait-${i}`, source: i % 2 ? 'inferred' : 'stated', text: `VOICE_PATTERN_${String(i).padStart(2, '0')} Preserve the intended meaning, prefer concrete observations, and calibrate detail to the user and purpose. Keep the scope of this preference intact.`, since: '2026-10-17' }));
  const prefs = personalizationContext({ soul: { traits } }, { instructions: 'For this chat, respond in German.' }, { voice: true });
  const context = realtimeConversationContext({ chat: makeChat(), personalization: prefs, memoryPlan: { view: { entries: Array.from({ length: 100 }, (_, i) => ({ id: i, count: 1, text: `Older decision ${i}: ` + 'x'.repeat(1000) })) } } });
  for (let i = 0; i < 30; i++) assert.match(context, new RegExp(`VOICE_PATTERN_${String(i).padStart(2, '0')}`));
  assert.match(context, /respond in German/); assert.match(context, /A clear, practical answer helps me/);
  assert.ok(context.length <= REALTIME_CONTEXT_LIMIT); assert.doesNotMatch(prefs, /routine evolution needs/);
});

test('speech applies both the current topic and voice patterns, without leaking another topic register', () => {
  const observations = ['technical','creative','voice'].map(scope => ({ id: scope, key: scope, scope, dimension: 'register', status: 'learned', corrected: true, text: `PATTERN_${scope} has a specific conversational purpose.`, support: [], opposition: [], conflicts: [] }));
  const prefs = personalizationContext({ soul: { learning: { observations } } }, null, { voice: true, request: 'Fix the startup bug.' });
  assert.match(prefs, /PATTERN_technical/); assert.match(prefs, /PATTERN_voice/); assert.doesNotMatch(prefs, /PATTERN_creative/);
  assert.match(prefs, /spoken technical/);
});
