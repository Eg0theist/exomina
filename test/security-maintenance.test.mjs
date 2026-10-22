import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {chooseCompatibleVersion,dependencyPlan,officialNodeBytes,verifyNodeCandidate,stageNodeCandidate,promoteNodeCandidate,runtimeAdvisoryBlockers,NODE_MAINTENANCE_POLICY} from '../scripts/security-maintenance.mjs';
import {ANALYSIS_NODE_RUNTIME} from '../scripts/prepare-analysis-node.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function zip(entries){const parts=[],directory=[];let offset=0;for(const[name,value]of entries){const nameBytes=Buffer.from(name),bytes=Buffer.from(value),local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(nameBytes.length,26);parts.push(local,nameBytes,bytes);const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt32LE(bytes.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(nameBytes.length,28);central.writeUInt32LE(offset,42);directory.push(central,nameBytes);offset+=local.length+nameBytes.length+bytes.length;}const central=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...parts,central,end]);}
function nodeFixture(){const pieces=ANALYSIS_NODE_RUNTIME.version.split('.').map(Number),next=[pieces[0],pieces[1],pieces[2]+1].join('.'),exe=Buffer.from('SYNTHETIC NODE, NEVER EXECUTED'),license=Buffer.from('Synthetic license'),name=`node-v${next}-win-x64.zip`,archive=zip([[`node-v${next}-win-x64/node.exe`,exe],[`node-v${next}-win-x64/LICENSE`,license]]),checksums=`${hash(archive)}  ${name}\n${hash(exe)}  win-x64/node.exe\n`,signature={status:'Valid',thumbprint:NODE_MAINTENANCE_POLICY.signerThumbprints[0],productVersion:next};return{next,exe,archive,checksums,signature};}
test('compatible candidates stay within the stable major, and pre-1.0 dependencies stay within their minor',()=>{
 assert.equal(chooseCompatibleVersion('44.9.3',['44.9.4','44.10.0','45.0.0','44.11.0-beta.1']),'44.10.0');assert.equal(chooseCompatibleVersion('^0.160.1',['0.160.2','0.161.0']),'0.160.2');assert.equal(chooseCompatibleVersion('1.2.3',['1.2.2']),null);
 const plan=dependencyPlan({dependencies:{'@xai-official/grok-win32-x64':'1.0.0','@openai/codex':'0.160.1'},devDependencies:{electron:'44.9.3'}},{'@openai/codex':['0.160.2'],electron:['44.9.4']});assert.equal(plan.updates.length,2);assert.equal(plan.manual.length,1);
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
