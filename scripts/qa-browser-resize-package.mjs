import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {extractFile} from '@electron/asar';

// Read-only verification of the combined staged/published package. The native
// runtime and all desktop modules must match the previously verified repair.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const work=path.resolve(root,'../Workspace/browser-resize-20261010');
const baseline=path.resolve(root,'../Workspace/codex-full-access-20261010');
const build=path.resolve(process.argv[2]||path.join(work,'stage/win-unpacked'));
const archive=path.join(build,'resources/app.asar'),unpacked=archive+'.unpacked';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const isPublished=build===path.resolve(root,'release/win-unpacked');
const verifiedStage=isPublished?JSON.parse(await readFile(path.join(work,'stage-package-verification.json'),'utf8')):null;
const report={build:JSON.parse(await readFile(path.join(build,'exomina.build.json'),'utf8')),buildPath:build,files:[],checks:{},limitations:[]};
await mkdir(work,{recursive:true});
async function filesIn(directory,relative=''){
  const rows=[];
  for(const item of await readdir(path.join(directory,relative),{withFileTypes:true})){
    assert.equal(item.isSymbolicLink(),false,'Artifact verification must not follow links.');
    const name=path.join(relative,item.name);
    if(item.isDirectory())rows.push(...await filesIn(directory,name));
    else if(item.isFile())rows.push(name);
  }
  return rows;
}
for(const directory of ['desktop','dist']){
  for(const file of await filesIn(path.join(root,directory))){
    if(directory==='desktop'&&(file.split(path.sep).includes('__pycache__')||file.endsWith('.pyc')))continue;
    const relative=path.join(directory,file),source=await readFile(path.join(root,relative));
    const packaged=directory==='desktop'?await readFile(path.join(unpacked,relative)):extractFile(archive,relative);
    assert.ok(source.equals(packaged),`${relative} differs from source.`);
    if(directory==='desktop')assert.ok(packaged.equals(await readFile(path.join(baseline,'stage/win-unpacked/resources/app.asar.unpacked',relative))),`${relative} changed after native policy verification.`);
    report.files.push({file:relative.replaceAll('\\','/'),sha256:hash(source),bytes:source.length});
  }
}
report.checks.desktopMatchesVerifiedFullAccessRepair=true;
for(const file of ['README.md','package.json','scripts/install-windows.ps1']){
  const bytes=await readFile(path.join(root,file)),packaged=extractFile(archive,path.normalize(file));
  if(file==='package.json'){
    const source=JSON.parse(bytes),runtime=JSON.parse(packaged);
    for(const field of ['name','version','private','description','author','type','main','dependencies'])assert.deepEqual(runtime[field],source[field]);
  }else assert.ok(bytes.equals(packaged),`${file} differs from source.`);
  report.files.push({file,sha256:hash(packaged),bytes:packaged.length});
}
for(const file of ['scripts/install-windows.ps1','desktop/updates.mjs','desktop/update-runner.ps1','desktop/update-launcher.cjs','desktop/app-paths.mjs'])assert.ok((await readFile(path.resolve(root,'../App/resources/app.asar.unpacked',file))).equals(await readFile(path.join(unpacked,file))),`${file} changed from installed updater.`);
report.checks.updaterMatchesInstalledBaseline=true;
const {codexPolicy}=await import(pathToFileURL(path.join(unpacked,'desktop/permissions.mjs')).href);
assert.equal(codexPolicy('full').sandbox,'danger-full-access');assert.equal(codexPolicy('full').approvalPolicy,'on-request');assert.equal(codexPolicy('read-only').approvalPolicy,'never');
report.checks.fullAndReadOnlyPolicies=true;
const nativeFile='resources/app.asar.unpacked/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe';
const nativeHash=hash(await readFile(path.join(build,nativeFile)));
assert.equal(nativeHash,hash(await readFile(path.join(baseline,'stage/win-unpacked',nativeFile))));
const nativeReport=JSON.parse(await readFile(path.join(baseline,'native-packaged-result.json'),'utf8'));assert.equal(nativeReport.passed,true);
report.checks.nativeRuntime={sha256:nativeHash,unchangedSinceVerifiedBuild:nativeReport.build.id,report:path.join(baseline,'native-packaged-result.json')};
for(const [file,key] of [
  [path.join(work,'packaged-native-approvals-qa.json'),'nativeApprovalHostAndUi'],
  [path.resolve(root,'../Workspace/browser-resize-verification/packaged-browser-resize-qa.json'),'browserResizeHostAndUi']
]){
  const evidenceBytes=await readFile(file),evidence=JSON.parse(evidenceBytes);assert.equal(evidence.passed,true,`${key} has not passed.`);
  const archiveSha256=hash(await readFile(archive)),evidenceSha256=hash(evidenceBytes);
  if(isPublished){
    assert.equal(evidenceSha256,verifiedStage.checks[key].evidenceSha256,`${key} evidence changed after staging.`);
    assert.equal(archiveSha256,verifiedStage.checks[key].archiveSha256,`${key} verified another archive.`);
  }else assert.equal(hash(await readFile(evidence.runtimeRoot)),archiveSha256,`${key} verified another archive.`);
  report.checks[key]={report:file,checkCount:Object.keys(evidence.checks).length,passed:true,archiveSha256,evidenceSha256};
}
const logBytes=await readFile(path.join(work,'tests-final.log')),log=logBytes.toString(logBytes[0]===255&&logBytes[1]===254?'utf16le':'utf8');
const counts={};for(const field of ['tests','pass','fail'])counts[field]=Number(log.match(new RegExp(`\\b${field} (\\d+)`))?.[1]);
assert.ok(counts.tests>=785);assert.equal(counts.pass,counts.tests);assert.equal(counts.fail,0);report.checks.nodeTests=counts;
for(const file of ['Exomina.exe','resources/app.asar',nativeFile]){
  const bytes=await readFile(path.join(build,file));
  report.files.push({file,sha256:hash(bytes),bytes:bytes.length});
}
if(isPublished){
  assert.deepEqual(report.build,verifiedStage.build);
  for(const file of report.files){const previous=verifiedStage.files.find(row=>row.file===file.file);assert.ok(previous,`Unverified published file ${file.file}`);assert.equal(file.sha256,previous.sha256);}
  report.checks.publishedMatchesVerifiedStage=true;
}
report.limitations=[
  'Hidden production-browser checks use loopback fixtures; connected mode checks its information pane without accessing a personal browser.',
  'Native approval requests in the production host/UI are synthetic. The unchanged unmodified runtime was verified locally without a model turn.',
  'The running old build and native turn retain approvals never. Installation and a subsequent turn are required before approved cleanup can run.'
];
report.passed=true;report.completedAt=new Date().toISOString();
const output=path.join(work,isPublished?'published-package-verification.json':'stage-package-verification.json');await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:true,build:report.build,filesVerified:report.files.length,checks:report.checks,output}));
