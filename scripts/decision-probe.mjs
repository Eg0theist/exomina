// Diagnostic: shows which decision-layer tier this PC gets and how fast Tier 1 is.
// Usage: node scripts/decision-probe.mjs [--examples 2000]
import {DecisionLayer} from '../desktop/decision-layer.mjs';
import {createBusyCheck} from '../desktop/decision-busy.mjs';

const count = Number(process.argv[process.argv.indexOf('--examples') + 1]) || 2000;
const layer = new DecisionLayer();
const started = performance.now();
const status = await layer.status();
let t0;
const probeMs = Math.round(performance.now() - started);

console.log('Hardware:', JSON.stringify(status.hardware, null, 2));
console.log(`Probe took ${probeMs} ms`);
console.log('Tier decision:', JSON.stringify(status.tier, null, 2));
for (const tier of status.tiers) console.log(`  Tier ${tier.tier} ${tier.name}: ${tier.state}`);
t0 = performance.now();
const busy = await createBusyCheck()();
console.log(`Busy check (game / full-screen): ${JSON.stringify(busy)} in ${Math.round(performance.now() - t0)} ms`);
console.log('Local chat model:', status.server ? `${status.server.name} / ${status.server.model}` : 'none running');

// Tier 1 timing with a synthetic gate of realistic message lengths.
const words = 'update install approve message team rifle memory chat model release note budget invoice meeting deadline client draft'.split(' ');
const text = i => Array.from({length: 12 + (i % 30)}, (_, j) => words[(i * 7 + j * 13) % words.length]).join(' ');
const question = {gate: 'probe.timing', kind: 'choice', options: ['act', 'ignore']};
// No file is set, so record() only fills memory.
for (let i = 0; i < count; i++) await layer.record({...question, input: text(i), answer: i % 3 ? 'ignore' : 'act'});

const memoryBefore = process.memoryUsage().rss;
let t = performance.now();
layer.model('probe.timing');
const trainMs = Math.round(performance.now() - t);
t = performance.now();
const runs = 500;
for (let i = 0; i < runs; i++) await layer.ask({...question, input: text(i + 99991), threshold: 0});
const askMs = (performance.now() - t) / runs;
console.log(`Tier 1: trained on ${count} decisions in ${trainMs} ms, ${askMs.toFixed(3)} ms per answer, RSS +${Math.round((process.memoryUsage().rss - memoryBefore) / 1048576)} MB`);
