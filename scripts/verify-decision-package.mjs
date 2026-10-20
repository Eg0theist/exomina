import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';
import {extractFile} from '@electron/asar';
const root=process.cwd(),build=path.join(root,'release/win-unpacked'),unpacked=path.join(build,'resources/app.asar.unpacked'),archive=path.join(build,'resources/app.asar');
const output=path.resolve(root,'../Workspace/decision-bundle-20261015'),report={checks:[],passed:false};
const files=['desktop/main.mjs','desktop/decision-layer.mjs','desktop/decision-hardware.mjs','desktop/decision-busy.mjs','desktop/decision-nli.mjs','desktop/decision-settings.mjs','desktop/next-prompt-gate.mjs','desktop/agent-triggers.mjs','desktop/attention-notify.mjs','desktop/workbench.mjs','desktop/note-store.mjs','desktop/delete-conversation.mjs'];
try{
 report.build=JSON.parse(await readFile(path.join(build,'exomina.build.json'),'utf8'));assert.equal(report.build.version,'0.5.0-beta.49');
 for(const file of files){const source=await readFile(path.join(root,file)),shipped=await readFile(path.join(unpacked,file));assert.ok(source.equals(shipped),file+' differs');report.checks.push({file,sha256:createHash('sha256').update(shipped).digest('hex')});}
 const html=await readFile(path.join(root,'dist/index.html'));assert.ok(html.equals(extractFile(archive,path.normalize('dist/index.html'))));
 for(const [,asset] of html.toString('utf8').matchAll(/(?:src|href)="\.\/([^"?#]+\.(?:js|css))"/g))assert.ok((await readFile(path.join(root,'dist',asset))).equals(extractFile(archive,path.normalize(path.join('dist',asset)))));
 report.rendererMatches=true;
 const result=await promisify(execFile)(path.join(build,'Exomina.exe'),[path.join(root,'scripts/decision-nli-probe.mjs'),path.join(output,'tier2')],{cwd:root,windowsHide:true,timeout:60000,maxBuffer:1024*1024,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',EXOMINA_QA_RUNTIME_ROOT:unpacked}});
 const jsonAt=result.stdout.indexOf('{');report.nativeInference=JSON.parse(result.stdout.slice(jsonAt));assert.equal(report.nativeInference.passed,true);
 report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
await writeFile(path.join(output,'packaged-report.json'),JSON.stringify(report,null,2),'utf8');
console.log(JSON.stringify({build:report.build,filesVerified:report.checks.length,rendererMatches:report.rendererMatches,packagedCpuInference:report.nativeInference?.passed,peakRssMb:report.nativeInference?.peakRssMb,passed:report.passed,error:report.error},null,2));
