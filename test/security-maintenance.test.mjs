import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {chooseCompatibleVersion,dependencyPlan,officialNodeBytes,verifyNodeCandidate,stageNodeCandidate,promoteNodeCandidate,runtimeAdvisoryBlockers,NODE_MAINTENANCE_POLICY,maintenanceNpm,maintain,verifyPreparation,sameMaintenanceReport,stopMaintenanceProcess} from '../scripts/security-maintenance.mjs';
import {ANALYSIS_NODE_RUNTIME} from '../scripts/prepare-analysis-node.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

test('the REA dependency uses the patched Zod parser and rejects oversized arrays before validating their contents',()=>{
 const requireRea=createRequire(import.meta.resolve('rea-agents/package.json')),{z}=requireRea('zod');let parsed=0;
 const schema=z.array(z.string().refine(()=>{parsed++;return true;})).max(2);
 assert.equal(schema.safeParse(['valid']).success,true);assert.equal(parsed,1);parsed=0;
 const rejected=schema.safeParse(Array(100).fill('sample'));
 assert.equal(rejected.success,false);assert.equal(parsed,0);assert.equal(rejected.error.issues.length,1);assert.equal(rejected.error.issues[0].code,'too_big');
});
test('Windows maintenance launches npm flags without adding literal quotes',{skip:process.platform!=='win32'},async()=>{
 const result=await maintenanceNpm(['--version']);assert.equal(result.code,0,result.stdout+result.stderr);assert.match(result.stdout.trim(),/^\d+\.\d+\.\d+$/);
});
test('registry retries are bounded and never retry dependency conflicts, permissions or audit findings',async()=>{
 for(const code of ['ECONNRESET','E429','E503']){
  let calls=0;const waits=[];const result=await maintenanceNpm(['view','fixture','versions','--json'],{run:async()=>++calls<3?{code:1,stdout:'',stderr:'npm error code '+code}:{code:0,stdout:'["1.0.0"]'},wait:async ms=>waits.push(ms)});
  assert.equal(result.attempts,3);assert.equal(calls,3);assert.deepEqual(waits,[1000,2000]);
 }
 for(const code of ['ERESOLVE','EOVERRIDE','EACCES','E401','EINTEGRITY']){
  let calls=0;const result=await maintenanceNpm(['install','--package-lock-only'],{run:async()=>{calls++;return{code:1,stdout:JSON.stringify({error:{code}}),stderr:''};},wait:async()=>assert.fail('Not a transient failure')});assert.equal(calls,1);assert.equal(result.code,1);
 }
 let calls=0;const result=await maintenanceNpm(['audit','--json'],{run:async()=>{calls++;return{code:1,stdout:'{"vulnerabilities":{}}'};},wait:async()=>assert.fail('Audit findings are not network failures')});assert.equal(calls,1);assert.equal(result.code,1);
 calls=0;await maintenanceNpm(['view','fixture','versions'],{run:async()=>{calls++;return{code:1,stderr:'npm error code E503'};},wait:async()=>{}});assert.equal(calls,3);
});
test('official release metadata retries temporary service failures but never a redirect or oversized reply',async()=>{
 let calls=0;assert.equal((await officialNodeBytes('https://nodejs.org/dist/index.json',{fetchImpl:async()=>++calls<3?new Response('Unavailable',{status:503}):new Response('[]'),wait:async()=>{}})).toString(),'[]');assert.equal(calls,3);
 calls=0;await assert.rejects(officialNodeBytes('https://nodejs.org/dist/index.json',{fetchImpl:async()=>{calls++;return new Response('',{status:302});},wait:async()=>assert.fail('Redirects are not retried')}),/HTTP 302/);assert.equal(calls,1);
});
async function maintenanceFixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'exomina-maintenance-recovery-'));
 t.after(async()=>{assert.equal(path.dirname(root),tmpdir());await rm(root,{recursive:true,force:true});});
 const manifest={name:'maintenance-fixture',version:'1.0.0',dependencies:{library:'1.0.0'},optionalDependencies:{'@xai-official/grok-win32-x64':'1.0.0'}};
 await writeFile(path.join(root,'package.json'),JSON.stringify(manifest));await writeFile(path.join(root,'package-lock.json'),JSON.stringify({packages:{'':manifest,'node_modules/library':{version:'1.0.0'}}}));return root;
}
const noAdvisories={metadata:{vulnerabilities:{total:0}},vulnerabilities:{}};
const currentNode=async()=>Buffer.from(JSON.stringify([{version:'v'+ANALYSIS_NODE_RUNTIME.version}]));
test('scheduled clean preparation is a no-op despite available ordinary upgrades',async t=>{
 const root=await maintenanceFixture(t),before=await readFile(path.join(root,'package-lock.json')),calls=[];
 const report=await maintain({root,prepare:true,securityOnly:true,runNpm:async args=>{calls.push(args);assert.deepEqual(args,['audit','--json','--registry=https://registry.npmjs.org']);return{code:0,stdout:JSON.stringify(noAdvisories)};},fetchBytes:async()=>Buffer.from(JSON.stringify([{version:'v'+ANALYSIS_NODE_RUNTIME.version},{version:'v'+nodeFixture().next,security:false}]))});
 assert.equal(report.prepared,true);assert.equal(calls.length,1);assert.equal(report.mode,'security-only');assert.equal(report.npm.plan.updates.length,0);assert.equal(report.npm.plan.manual.length,1);assert.ok(before.equals(await readFile(path.join(root,'package-lock.json'))));assert.equal(report.node.securityUpdateAvailable,false);
});
test('security-only preparation fixes an advisory without querying ordinary versions',async t=>{
 const root=await maintenanceFixture(t),calls=[];let audits=0;
 const report=await maintain({root,prepare:true,securityOnly:true,runNpm:async args=>{calls.push(args);assert.equal(args[0],'audit');if(args[1]==='fix'){assert.ok(args.includes('--ignore-scripts'));assert.ok(args.includes('--package-lock-only'));assert.ok(args.includes('--json'));assert.equal(args.includes('--force'),false);return{code:0,stdout:JSON.stringify(noAdvisories)};}audits++;return{code:audits===1?1:0,stdout:JSON.stringify(audits===1?{metadata:{vulnerabilities:{high:1,total:1}},vulnerabilities:{library:{severity:'high',nodes:['node_modules/library']}}}:noAdvisories)};},fetchBytes:currentNode});
 assert.deepEqual(calls.map(args=>args.slice(0,2)),[['audit','--json'],['audit','fix'],['audit','--json']]);assert.equal(report.prepared,true);assert.deepEqual(report.npm.blockers,[]);
});
test('preparation failure preserves npm diagnostics and restores partially changed manifests',async t=>{
 const root=await maintenanceFixture(t),manifest=await readFile(path.join(root,'package.json')),lock=await readFile(path.join(root,'package-lock.json')),reportFile=path.join(root,'failure.json');
 await assert.rejects(maintain({root,prepare:true,reportFile,runNpm:async args=>{
  if(args[0]==='audit')return{code:0,stdout:JSON.stringify(noAdvisories)};
  if(args[0]==='view')return{code:0,stdout:'["1.0.0","1.0.1"]'};
  await writeFile(path.join(root,'package.json'),'PARTIAL');await writeFile(path.join(root,'package-lock.json'),'PARTIAL');return{code:1,stdout:'',stderr:'npm error code ERESOLVE\nnpm error Conflicting peer dependency: library@1.0.1'};
 },fetchBytes:currentNode}),/ERESOLVE[\s\S]*Conflicting peer dependency/);
 assert.ok(manifest.equals(await readFile(path.join(root,'package.json'))));assert.ok(lock.equals(await readFile(path.join(root,'package-lock.json'))));const report=JSON.parse(await readFile(reportFile,'utf8'));assert.equal(report.prepared,false);assert.equal(report.failure.code,'ERESOLVE');assert.match(report.failure.phase,/candidate creation/);
});
test('unresolved security findings and failed advisory requests still fail with retained evidence',async t=>{
 const root=await maintenanceFixture(t),reportFile=path.join(root,'failure.json');
 await assert.rejects(maintain({root,securityOnly:true,reportFile,runNpm:async()=>({code:1,stdout:JSON.stringify({metadata:{vulnerabilities:{high:1}},vulnerabilities:{library:{severity:'high',nodes:['node_modules/library']}}})}),fetchBytes:currentNode}),/Unresolved high/);
 assert.equal(JSON.parse(await readFile(reportFile,'utf8')).npm.blockers[0].name,'library');
 await assert.rejects(maintain({root,securityOnly:true,reportFile,runNpm:async()=>({code:1,stdout:JSON.stringify({error:{code:'E503',summary:'Registry unavailable'}})})}),/E503/);
 assert.equal(JSON.parse(await readFile(reportFile,'utf8')).failure.phase,'npm advisory check');
});
test('scheduled preparation verification uses copied manifests and leaves the checked-out candidate intact',async t=>{
 const root=await maintenanceFixture(t),before=await readFile(path.join(root,'package.json'));
 for(const name of ['scripts/prepare-analysis-node.mjs','desktop/app-analysis-node.mjs']){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),'// fixture');}
 let testedRoot;const report=await verifyPreparation({root,runNpm:async(args,{cwd})=>{testedRoot=cwd;assert.notEqual(cwd,root);assert.ok(path.resolve(cwd).startsWith(path.resolve(root,'.verification')+path.sep));assert.ok(before.equals(await readFile(path.join(cwd,'package.json'))));return{code:0,stdout:JSON.stringify(noAdvisories)};},fetchBytes:currentNode});
 assert.equal(report.prepared,true);assert.ok(before.equals(await readFile(path.join(root,'package.json'))));await assert.rejects(stat(testedRoot),{code:'ENOENT'});
});
test('identical maintenance reports ignore clock and staging paths without losing changed findings',()=>{
 const first={checkedAt:'first',prepared:true,npm:{blockers:[]},node:{candidate:{stage:'one',previousRuntime:'old',version:'24.22.2'}}};const second=structuredClone(first);second.checkedAt='second';second.node.candidate.stage='two';second.node.candidate.previousRuntime='other';assert.equal(sameMaintenanceReport(first,second),true);second.npm.blockers.push({name:'library',severity:'high'});assert.equal(sameMaintenanceReport(first,second),false);assert.equal(first.checkedAt,'first');
});
test('report comparison CLI returns equality or a distinct parse failure without running maintenance',async t=>{
 const root=await maintenanceFixture(t),first=path.join(root,'one.json'),second=path.join(root,'two.json'),script=fileURLToPath(new URL('../scripts/security-maintenance.mjs',import.meta.url));
 await writeFile(first,'{"checkedAt":"one","prepared":true}');await writeFile(second,'{"checkedAt":"two","prepared":true}');
 await promisify(execFile)(process.execPath,[script,'--same-report',first,second],{timeout:5000});
 await writeFile(second,'{"prepared":false}');await assert.rejects(promisify(execFile)(process.execPath,[script,'--same-report',first,second],{timeout:5000}),{code:1});
 await writeFile(second,'broken');await assert.rejects(promisify(execFile)(process.execPath,[script,'--same-report',first,second],{timeout:5000}),{code:2});
 for(const args of [['--same-report'],['--same-report',first],['--report'],['--unknown'],['--prepare','--check']])await assert.rejects(promisify(execFile)(process.execPath,[script,...args],{timeout:5000}),{code:2});
});
test('workflow verifies preparation before accepting PRs and keeps diagnostics without weakening release gates',async()=>{
 const require=createRequire(import.meta.url),builderRequire=createRequire(require.resolve('app-builder-lib/package.json')),{load}=builderRequire('js-yaml');
 const source=await readFile(new URL('../.github/workflows/security-maintenance.yml',import.meta.url),'utf8'),config=load(source),template=load(await readFile(new URL('../scripts/public-template/.github/workflows/security-maintenance.yml',import.meta.url),'utf8'));
 assert.deepEqual(config,template);assert.match(config.jobs.prepare.steps.find(step=>step.id==='candidate').run,/--prepare --security-only/);assert.ok(config.jobs.validate.steps.some(step=>step.run?.includes('--verify-prepare')));
 for(const job of [config.jobs.prepare,config.jobs.validate])assert.ok(job.steps.some(step=>step.if==='always()'&&step.uses?.startsWith('actions/upload-artifact@')));
 assert.match(config.jobs['candidate-merged'].if,/EXOMINA_SECURITY_AUTO_CANDIDATE == 'true'/);assert.match(config.jobs['candidate-merged'].steps[0].run,/releaseVersion -ne \$package.version/);assert.equal(config.jobs.prepare['timeout-minutes'],30);
});
test('advisory repair cannot silently move a native runtime in the lockfile',async t=>{
 const root=await maintenanceFixture(t),original=await readFile(path.join(root,'package-lock.json'));
 await assert.rejects(maintain({root,prepare:true,securityOnly:true,runNpm:async args=>{
  if(args[1]==='fix'){const lock=JSON.parse(original);lock.packages['node_modules/@xai-official/grok-win32-x64']={version:'1.0.1'};await writeFile(path.join(root,'package-lock.json'),JSON.stringify(lock));return{code:0,stdout:JSON.stringify(noAdvisories)};}
  return{code:1,stdout:JSON.stringify({metadata:{vulnerabilities:{high:1}},vulnerabilities:{library:{severity:'high',nodes:['node_modules/library']}}})};
 },fetchBytes:currentNode}),/Provider executable security fixes require reviewed runtime pins/);assert.ok(original.equals(await readFile(path.join(root,'package-lock.json'))));
});
test('stopping Windows maintenance stops its child writer before restoring files',{skip:process.platform!=='win32'},async t=>{
 const root=await maintenanceFixture(t),writer=path.join(root,'writer.cjs'),launcher=path.join(root,'launcher.cjs'),sentinel=path.join(root,'late.txt');
 await writeFile(writer,"setTimeout(()=>require('node:fs').writeFileSync(process.argv[2],'late write'),1400);\n");
 await writeFile(launcher,"const {spawn}=require('node:child_process');const child=spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:'ignore',windowsHide:true});console.log(child.pid);setInterval(()=>{},1000);\n");
 const child=spawn(process.execPath,[launcher,writer,sentinel],{stdio:['ignore','pipe','pipe'],windowsHide:true});t.after(()=>{if(child.exitCode===null&&!child.killed)child.kill();});
 await once(child.stdout,'data');await stopMaintenanceProcess(child);await sleep(1700);await assert.rejects(stat(sentinel),{code:'ENOENT'});
});
function zip(entries){const parts=[],directory=[];let offset=0;for(const[name,value]of entries){const nameBytes=Buffer.from(name),bytes=Buffer.from(value),local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(nameBytes.length,26);parts.push(local,nameBytes,bytes);const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt32LE(bytes.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(nameBytes.length,28);central.writeUInt32LE(offset,42);directory.push(central,nameBytes);offset+=local.length+nameBytes.length+bytes.length;}const central=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...parts,central,end]);}
function nodeFixture(){const pieces=ANALYSIS_NODE_RUNTIME.version.split('.').map(Number),next=[pieces[0],pieces[1],pieces[2]+1].join('.'),exe=Buffer.from('SYNTHETIC NODE, NEVER EXECUTED'),license=Buffer.from('Synthetic license'),name=`node-v${next}-win-x64.zip`,archive=zip([[`node-v${next}-win-x64/node.exe`,exe],[`node-v${next}-win-x64/LICENSE`,license]]),checksums=`${hash(archive)}  ${name}\n${hash(exe)}  win-x64/node.exe\n`,signature={status:'Valid',thumbprint:NODE_MAINTENANCE_POLICY.signerThumbprints[0],productVersion:next};return{next,exe,archive,checksums,signature};}
test('compatible candidates stay within the stable major, and pre-1.0 dependencies stay within their minor',()=>{
 assert.equal(chooseCompatibleVersion('44.9.3',['44.9.4','44.10.0','45.0.0','44.11.0-beta.1']),'44.10.0');assert.equal(chooseCompatibleVersion('^0.160.1',['0.160.2','0.161.0']),'0.160.2');assert.equal(chooseCompatibleVersion('1.2.3',['1.2.2']),null);
 const plan=dependencyPlan({dependencies:{'@xai-official/grok-win32-x64':'1.0.0','@openai/codex':'0.160.1'},devDependencies:{electron:'44.9.3'}},{'@openai/codex':['0.160.2'],electron:['44.9.4']});assert.equal(plan.updates.length,2);assert.equal(plan.manual.length,1);
});

test('Dependabot leaves every native provider target to verified runtime qualification',async()=>{
 const require=createRequire(import.meta.url),builderRequire=createRequire(require.resolve('app-builder-lib/package.json')),{load}=builderRequire('js-yaml');
 const config=load(await readFile(new URL('../.github/dependabot.yml',import.meta.url),'utf8'));
 const policy=config.updates.find(item=>item['package-ecosystem']==='npm'&&item.directory==='/');
 const patterns=policy.ignore.filter(item=>!item['update-types']).map(item=>new RegExp('^'+item['dependency-name'].replace(/[.+?^${}()|[\]\\]/g,'\\$&').replaceAll('*','.*')+'$'));
 const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
 const names=Object.keys(manifest.optionalDependencies).filter(name=>name.startsWith('@xai-official/grok-'));
 for(const platform of ['win32','darwin','linux'])for(const arch of ['x64','arm64'])names.push('@anthropic-ai/claude-code-'+platform+'-'+arch);
 for(const name of names)assert.ok(patterns.some(pattern=>pattern.test(name)),name+' must not update without matching runtime pins');
 for(const name of ['electron','@modelcontextprotocol/client','@muse-code/sdk'])assert.equal(patterns.some(pattern=>pattern.test(name)),false,name+' remains eligible for compatible maintenance');
});

test('maintenance reports optional native runtimes without querying or updating them, and retains ordinary optional updates',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'exomina-provider-maintenance-'));
 t.after(async()=>{assert.equal(path.dirname(root),tmpdir());await rm(root,{recursive:true,force:true});});
 const native={};for(const platform of ['win32','darwin','linux'])for(const arch of ['x64','arm64'])for(const provider of ['@xai-official/grok','@anthropic-ai/claude-code'])native[provider+'-'+platform+'-'+arch]='1.0.0';
 const manifest={dependencies:{library:'1.0.0'},optionalDependencies:{...native,'optional-library':'1.0.0'}};
 await writeFile(path.join(root,'package.json'),JSON.stringify(manifest));await writeFile(path.join(root,'package-lock.json'),JSON.stringify({packages:{'':manifest}}));
 const calls=[],report=await maintain({root,prepare:true,runNpm:async args=>{
  calls.push(args);
  if(args[0]==='audit')return{code:0,stdout:JSON.stringify({metadata:{vulnerabilities:{total:0}},vulnerabilities:{}})};
  if(args[0]==='view'){assert.ok(!Object.hasOwn(native,args[1]),'native versions require upstream review');return{code:0,stdout:'["1.0.0","1.0.1"]'};}
  assert.equal(args[0],'install');assert.ok(args.every(arg=>!Object.keys(native).some(name=>arg.startsWith(name+'@'))));return{code:0,stdout:''};
 },fetchBytes:async()=>Buffer.from(JSON.stringify([{version:'v'+ANALYSIS_NODE_RUNTIME.version}]))});
 assert.equal(report.npm.plan.manual.length,12);assert.equal(report.prepared,true);
 assert.deepEqual(report.npm.plan.updates.map(row=>row.name),['library','optional-library']);
 assert.ok(calls.some(args=>args[0]==='install'&&args.includes('--save-optional')&&args.includes('optional-library@1.0.1')));
});
test('Node downloader rejects alternate hosts, redirects and oversized inputs',async()=>{
 await assert.rejects(officialNodeBytes('https://nodejs.org.attacker.invalid/dist/index.json'),/exact official/);
 await assert.rejects(officialNodeBytes('https://nodejs.org/dist/index.json',{maximum:2,fetchImpl:async()=>new Response('too large')}),/size/);
});
test('Node candidate needs both official checksums, pinned Authenticode identity and exact signed version',()=>{
 const f=nodeFixture();assert.equal(verifyNodeCandidate({version:f.next,...f}).runtime.version,f.next);
 for(const signature of[{...f.signature,status:'NotSigned'},{...f.signature,thumbprint:'0'.repeat(40)},{...f.signature,productVersion:f.next+'0'}])assert.throws(()=>verifyNodeCandidate({version:f.next,...f,signature}),/publisher signature/);
 assert.throws(()=>verifyNodeCandidate({version:f.next,...f,checksums:f.checksums.replace(hash(f.exe),'0'.repeat(64))}),/executable checksum/);
 assert.throws(()=>verifyNodeCandidate({version:f.next,...f,archive:Buffer.from('wrong')}),/ZIP checksum/);
});
test('verified Node candidate stages exact module and runtime, then preserves previous runtime on promotion',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'exomina-node-maintenance-'));t.after(async()=>{assert.equal(path.dirname(root),tmpdir());await rm(root,{recursive:true,force:true});});await mkdir(path.join(root,'scripts'));await mkdir(path.join(root,'desktop'));await mkdir(path.join(root,'vendor','analysis-node'),{recursive:true});await writeFile(path.join(root,'desktop','app-analysis-node.mjs'),await readFile(new URL('../desktop/app-analysis-node.mjs',import.meta.url)));
 await writeFile(path.join(root,'scripts','prepare-analysis-node.mjs'),await readFile(new URL('../scripts/prepare-analysis-node.mjs',import.meta.url)));await writeFile(path.join(root,'vendor','analysis-node','node.exe'),'PREVIOUS SYNTHETIC NODE');const f=nodeFixture();
 const candidate=await stageNodeCandidate({next:f.next,root,fetchBytes:async url=>url.endsWith('.zip')?f.archive:Buffer.from(f.checksums),inspect:async()=>f.signature});assert.equal((await readFile(path.join(candidate.runtime,'node.exe'))).equals(f.exe),true);
 const result=await promoteNodeCandidate(candidate,{root});assert.equal(result.version,f.next);assert.equal(await readFile(path.join(root,'vendor','analysis-node','node.exe'),'utf8'),f.exe.toString());assert.equal(await readFile(path.join(result.previousRuntime,'node.exe'),'utf8'),'PREVIOUS SYNTHETIC NODE');assert.match(await readFile(candidate.modulePath,'utf8'),new RegExp(f.next.replaceAll('.','\\.')));assert.ok((await stat(path.join(candidate.stage,'verified.json'))).isFile());
 assert.match(await readFile(candidate.runtimeModulePath,'utf8'),new RegExp('ANALYSIS_NODE_VERSION='+JSON.stringify(f.next).replaceAll('.','\\.')));assert.match(await readFile(candidate.runtimeModulePath,'utf8'),new RegExp(hash(f.exe)));
 await assert.rejects(promoteNodeCandidate({...candidate,stage:tmpdir()},{root}),/escaped/);
});
test('unresolved high runtime advisories block qualification while build-only findings remain reported',()=>{
 const audit={vulnerabilities:{electron:{severity:'high',nodes:['node_modules/electron']},sprintf:{severity:'high',nodes:['node_modules/sprintf']},runtime:{severity:'critical',nodes:['node_modules/runtime']},moderate:{severity:'moderate',nodes:['node_modules/runtime']}}},lock={packages:{'node_modules/electron':{dev:true},'node_modules/sprintf':{dev:true},'node_modules/runtime':{}}};assert.deepEqual(runtimeAdvisoryBlockers(audit,lock).map(row=>row.name),['electron','runtime']);
});
