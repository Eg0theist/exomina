import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {exploreProtocol,PROTOCOL_MODELS} from '../desktop/protocol-explorer.mjs';

// Offline CI/development check only. These fixed finite models have no ability
// to invoke target applications or external services.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourceFiles=['desktop/protocol-explorer.mjs','desktop/workflow-journal.mjs','desktop/update-completion.mjs','test/protocol-explorer.test.mjs'];
const sources={};
for(const file of sourceFiles)sources[file]=createHash('sha256').update(await readFile(path.join(root,file))).digest('hex');
const results=Object.keys(PROTOCOL_MODELS).map(id=>exploreProtocol(id));
const refutations=[['delivery','skip-final-authorization'],['delivery','replay-unknown'],['installation','trust-staged-mark']].map(([id,broken])=>({...exploreProtocol(id,{broken}),deliberateFault:broken}));
const unchanged=await Promise.all(sourceFiles.map(async file=>sources[file]===createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')));
const passed=results.every(r=>r.status==='satisfied_in_model')&&refutations.every(r=>r.status==='counterexample')&&unchanged.every(Boolean);
const report={at:new Date().toISOString(),passed,scope:'Fixed finite model exploration only. No network, personal profile, target process or live connector. Production replay tests must be run separately.',sources,sourceBytesUnchanged:unchanged.every(Boolean),models:PROTOCOL_MODELS,results,refutations,
  limitations:['Finite assumptions are listed per model; successful exploration is not a proof of the implementation.','A source fingerprint records synchronization evidence, not semantic fidelity.','No general liveness, timing, arbitrary multipart count or arbitrary permission topology is established.','TLA-TS/TLC cross-comparison remains a separate optional tooling evaluation.']};
if(process.argv[2]){const output=path.resolve(process.argv[2]);await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n','utf8');}
process.stdout.write(JSON.stringify(report)+'\n');
if(!passed)process.exitCode=1;
