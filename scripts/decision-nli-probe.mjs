// Isolated, real Tier 2 inference. This does not open provider accounts or send chat data.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir, writeFile} from 'node:fs/promises';
const runtimeRoot=path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT||process.cwd());
const {NliRuntime, downloadNliModel}=await import(pathToFileURL(path.join(runtimeRoot,'desktop','decision-nli.mjs')).href);

const output = path.resolve(process.argv[2] || '../Workspace/decision-bundle-20261015/tier2');
await mkdir(output, {recursive:true});
let previous = -1;
await downloadNliModel({root:path.join(output,'models'), id:'multilingual', onProgress:({done,total}) => {
  const step = Math.floor(done / total * 4); if (step !== previous) { previous = step; console.log('Model download: ' + Math.min(100,step * 25) + '%'); }
}});
const runtime = new NliRuntime({root:path.join(output,'models')});
const samples = [
  ['The invoice is overdue. Please send a reminder.', 'An invoice needs attention.'],
  ['The invoice is overdue. Please send a reminder.', 'The invoice has already been paid.'],
  ['Die Rechnung ist überfällig. Bitte sende eine Erinnerung.', 'Eine Rechnung benötigt Aufmerksamkeit.'],
  ['Die Rechnung ist überfällig. Bitte sende eine Erinnerung.', 'Die Rechnung wurde bereits bezahlt.'],
  ['The invoice is overdue.', 'The invoice is overdue.'],
  ['The invoice is overdue.', 'The invoice is not overdue.'],
  ['Die Rechnung ist überfällig.', 'Die Rechnung ist überfällig.'],
  ['Die Rechnung ist überfällig.', 'Die Rechnung ist nicht überfällig.'],
];
const report = {model:'multilingual', samples:[], peakRssMb:0};
try {
  for (const [premise,hypothesis] of samples) {
    const at = performance.now(), [score] = await runtime.score(premise,[hypothesis]);
    report.samples.push({premise,hypothesis,...score,ms:Math.round(performance.now()-at)});
    report.peakRssMb = Math.max(report.peakRssMb, Math.round(process.memoryUsage().rss/2**20));
  }
  report.passed = report.samples[0].truth > report.samples[1].truth && report.samples[2].truth > report.samples[3].truth;
  if (!report.passed) process.exitCode=1;
} finally { await runtime.release(); }
await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),'utf8');
console.log(JSON.stringify(report,null,2));
