// Trusted-branch maintenance creates candidates. It never publishes or installs.
import {readFile,writeFile,mkdir,rename,lstat,mkdtemp,copyFile,rm} from 'node:fs/promises';
import {spawn,execFile} from 'node:child_process';
import {promisify,isDeepStrictEqual} from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ANALYSIS_NODE_RUNTIME,analysisNodeArchiveMembers} from './prepare-analysis-node.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),digest=bytes=>createHash('sha256').update(bytes).digest('hex');
// Reviewed against the official 24.22.2 ZIP/checksums and its valid, timestamped
// OpenJS Foundation Authenticode signature on 2026-11-03. Unknown keys still fail.
export const NODE_MAINTENANCE_POLICY=Object.freeze({major:24,signerThumbprints:['6018A47185244F3B175DAFC18D0D8EB47E3F84CF','F026E9D2F6BF94760DD86FFEECD888F28842DE73'],origin:'https://nodejs.org'});
const providerBinary=name=>/^@(?:anthropic-ai\/claude-code|xai-official\/grok)-(?:win32|darwin|linux)-/.test(name);
const dependencySections=['dependencies','devDependencies','optionalDependencies'];
function version(value){const match=/^(\d+)\.(\d+)\.(\d+)$/.exec(String(value).replace(/^[~^]/,''));return match?match.slice(1).map(Number):null;}
const compare=(a,b)=>{const x=version(a),y=version(b);if(!x||!y)throw Error('Choose stable semantic versions.');for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;};
async function plainAncestors(target){let cursor=path.resolve(target);while(true){const info=await lstat(cursor).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(info?.isSymbolicLink()||info?.isFile()&&info.nlink!==1)throw Error('Linked maintenance paths are not allowed.');const parent=path.dirname(cursor);if(parent===cursor)return;cursor=parent;}}
export function runtimeAdvisoryBlockers(audit,lock){return Object.entries(audit.vulnerabilities||{}).filter(([name,item])=>['high','critical'].includes(item.severity)&&(name==='electron'||Object.hasOwn(lock.packages?.['']?.dependencies||{},name)||(item.nodes||[]).some(node=>lock.packages?.[node]?.dev!==true))).map(([name,item])=>({name,severity:item.severity}));}
export function chooseCompatibleVersion(current,available){const base=version(current);if(!base)return null;return available.filter(value=>{const next=version(value);return next&&next[0]===base[0]&&(base[0]!==0||next[1]===base[1])&&compare(value,current)>0;}).sort(compare).at(-1)||null;}
export function dependencyPlan(manifest,available){
 const updates=[],manual=[];for(const section of dependencySections)for(const[name,current]of Object.entries(manifest[section]||{})){
  if(!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name))throw Error('Invalid npm dependency name.');
  if(providerBinary(name)){manual.push({name,current,reason:'Provider executable updates require separately verified upstream provenance; registry latest is not publisher authentication.'});continue;}
  const selected=chooseCompatibleVersion(current,available[name]||[]);if(selected)updates.push({section,name,current,version:selected});
 }return{updates,manual};
}
export async function stopMaintenanceProcess(child){
 if(process.platform==='win32')await promisify(execFile)(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:10000});
 else if(!child.kill('SIGKILL')&&child.exitCode===null)throw Error('npm process could not be stopped.');
}
async function npmOnce(args,{cwd=project}={}){
 if(args.some(arg=>/[&|<>^%!"\r\n]/.test(arg)))throw Error('Unsafe npm maintenance argument.');
 const windows=process.platform==='win32',command=windows?path.join(process.env.SystemRoot||'C:\\Windows','System32','cmd.exe'):'npm',argv=windows?['/d','/s','/c','npm.cmd '+args.map(arg=>'"'+arg+'"').join(' ')]:args;
 return new Promise((resolve,reject)=>{
  const child=spawn(command,argv,{cwd,windowsHide:true,windowsVerbatimArguments:windows,stdio:['ignore','pipe','pipe']});let stdout='',head='',tail='',codeBuffer='',errorCode=null,failure,stopping;
  const stop=message=>{if(stopping)return;failure=Error(message);stopping=stopMaintenanceProcess(child);stopping.catch(error=>{clearTimeout(timer);const failed=Error(message+' npm shutdown could not be confirmed: '+error.message);failed.stopUnconfirmed=true;reject(failed);});};
  const timer=setTimeout(()=>stop('npm maintenance request timed out.'),180000);
  child.stdout.on('data',chunk=>{if(stdout.length+chunk.length>8*1024**2)stop('npm maintenance output exceeded its limit.');else stdout+=chunk;});
  child.stderr.on('data',chunk=>{const text=String(chunk),scan=codeBuffer+text;head=(head+text).slice(0,6000);tail=(tail+text).slice(-10000);errorCode??=/npm (?:ERR!|error) code ([A-Z][A-Z0-9_]+)/.exec(scan)?.[1]||null;codeBuffer=scan.slice(-2048);});
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('close',async code=>{clearTimeout(timer);try{if(stopping)await stopping;if(failure)throw failure;resolve({code,stdout,stderr:head===tail?head:head+'\n'+tail,errorCode});}catch(error){reject(error);}});
 });
}
function npmErrorCode(result){
 if(result.errorCode)return result.errorCode;
 try{const code=JSON.parse(result.stdout).error?.code;if(typeof code==='string')return code;}catch{}
 return /npm (?:ERR!|error) code ([A-Z][A-Z0-9_]+)/.exec(result.stderr||'')?.[1]||null;
}
const transientCodes=new Set(['EAI_AGAIN','ECONNRESET','ECONNREFUSED','ETIMEDOUT','ESOCKETTIMEDOUT','ENETUNREACH','EHOSTUNREACH','EPIPE','E408','E429','E500','E502','E503','E504']);
export async function maintenanceNpm(args,{cwd=project,run=npmOnce,wait=sleep}={}){
 for(let attempt=1;attempt<=3;attempt++){
  const result=await run(args,{cwd});
  if(result.code===0||!transientCodes.has(npmErrorCode(result))||attempt===3)return{...result,attempts:attempt};
  await wait(attempt*1000);
 }
}
function npmFailure(message,result){
 let detail=String(result.stderr||result.stdout||'No npm diagnostic was returned.').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');if(detail.length>12000)detail=detail.slice(0,6000)+'\n[diagnostic truncated]\n'+detail.slice(-6000);
 const error=Error(`${message} (npm ${npmErrorCode(result)||'exit '+result.code}).\n${detail}`);error.code=npmErrorCode(result)||'NPM_FAILED';return error;
}
export async function officialNodeBytes(url,{maximum=64*1024**2,fetchImpl=fetch,wait=sleep}={}){
 const address=new URL(url);if(address.origin!==NODE_MAINTENANCE_POLICY.origin||!/^\/dist\/(?:index\.json|v\d+\.\d+\.\d+\/(?:SHASUMS256\.txt|node-v\d+\.\d+\.\d+-win-x64\.zip))$/.test(address.pathname)||address.search||address.hash)throw Error('Node maintenance only accepts exact official distribution URLs.');
 for(let attempt=1;attempt<=3;attempt++){
  let response;try{response=await fetchImpl(address.href,{redirect:'error',signal:AbortSignal.timeout(120000)});}catch(error){if(attempt===3||!['TimeoutError','AbortError'].includes(error.name)&&!transientCodes.has(error.cause?.code))throw error;await wait(attempt*1000);continue;}
  if([408,429,500,502,503,504].includes(response.status)&&attempt<3){await response.body?.cancel();await wait(attempt*1000);continue;}
  if(!response.ok)throw Error('Official Node metadata request failed (HTTP '+response.status+').');let length=0;const chunks=[];for await(const chunk of response.body){length+=chunk.length;if(length>maximum)throw Error('Official Node input exceeds its size limit.');chunks.push(chunk);}return Buffer.concat(chunks,length);
 }
}
export function nodeCandidateVersion(index,current=ANALYSIS_NODE_RUNTIME.version){return chooseCompatibleVersion(current,index.filter(row=>typeof row.version==='string'&&row.version.startsWith('v')).map(row=>row.version.slice(1)));}
export function verifyNodeCandidate({version:next,archive,checksums,current=ANALYSIS_NODE_RUNTIME,signature,policy=NODE_MAINTENANCE_POLICY}){
 const parts=version(next);if(!parts||parts[0]!==policy.major||compare(next,current.version)<=0)throw Error('Node maintenance only advances the pinned major release line.');
 const expected=new Map();for(const line of checksums.split(/\r?\n/)){const match=/^([a-f0-9]{64})\s+\*?(.+)$/.exec(line);if(match){if(expected.has(match[2]))throw Error('Duplicate official Node checksum entry.');expected.set(match[2],match[1]);}}
 const name=`node-v${next}-win-x64.zip`;if(expected.get(name)!==digest(archive))throw Error('Official Node ZIP checksum mismatch.');
 const members=analysisNodeArchiveMembers(archive,{version:next}),exeHash=digest(members.get('node.exe'));if(expected.get('win-x64/node.exe')!==exeHash)throw Error('Official Node executable checksum mismatch.');
 if(signature?.status!=='Valid'||!policy.signerThumbprints.includes(String(signature.thumbprint||'').toUpperCase())||String(signature.productVersion||'').replace(/^v/,'').split(/[ +]/)[0]!==next)throw Error('Official Node publisher signature or signed product version is not trusted. Certificate rotation requires review.');
 const runtime={...current,version:next,sha256:exeHash,executableSha256:exeHash,licenseSha256:digest(members.get('LICENSE')),archive:name,archiveSha256:digest(archive),source:`https://nodejs.org/dist/v${next}/${name}`,checksums:`https://nodejs.org/dist/v${next}/SHASUMS256.txt`};return{runtime,members};
}
async function inspectSignature(exe,folder){
 const script=path.join(folder,'inspect-node-signature.ps1');await writeFile(script,"$ErrorActionPreference='Stop'\n$s=Get-AuthenticodeSignature -LiteralPath $env:EXOMINA_NODE_CANDIDATE\n@{status=[string]$s.Status;thumbprint=[string]$s.SignerCertificate.Thumbprint;productVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:EXOMINA_NODE_CANDIDATE).ProductVersion}|ConvertTo-Json -Compress\n",{flag:'wx'});
 const env={...process.env,EXOMINA_NODE_CANDIDATE:exe};delete env.PSModulePath;
 const{stdout}=await promisify(execFile)(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',script],{windowsHide:true,encoding:'utf8',env,timeout:30000});return JSON.parse(stdout);
}
/** Verifies in a fresh candidate folder before any pin or vendor promotion. */
export async function stageNodeCandidate({next,root=project,fetchBytes=officialNodeBytes,inspect=inspectSignature}={}){
 if(process.platform!=='win32'&&inspect===inspectSignature)throw Error('Node candidates need Windows Authenticode verification.');
 const stage=path.join(root,'.verification','security-maintenance',randomUUID());await plainAncestors(stage);await mkdir(stage,{recursive:true});
 const archive=await fetchBytes(`https://nodejs.org/dist/v${next}/node-v${next}-win-x64.zip`),checksums=(await fetchBytes(`https://nodejs.org/dist/v${next}/SHASUMS256.txt`,{maximum:2*1024**2})).toString('utf8');
 // Extract only the two named members. The EXE is inspected, never executed.
 const members=analysisNodeArchiveMembers(archive,{version:next}),exe=path.join(stage,'node.exe');await writeFile(exe,members.get('node.exe'),{flag:'wx'});
 const signature=await inspect(exe,stage),verified=verifyNodeCandidate({version:next,archive,checksums,signature});
 const modulePath=path.join(root,'scripts','prepare-analysis-node.mjs'),source=await readFile(modulePath,'utf8'),pattern=/export const ANALYSIS_NODE_RUNTIME = Object\.freeze\(\{[\s\S]*?\n\}\);/;
 if(!pattern.test(source))throw Error('The pinned Node module needs review before automatic maintenance.');
 const module=source.replace(pattern,'export const ANALYSIS_NODE_RUNTIME = Object.freeze('+JSON.stringify(verified.runtime,null,2)+');'),candidateModule=path.join(stage,'prepare-analysis-node.mjs');await writeFile(candidateModule,module,{flag:'wx'});
 const runtimeModulePath=path.join(root,'desktop','app-analysis-node.mjs');let runtimeSource=await readFile(runtimeModulePath,'utf8');
 for(const[name,value]of Object.entries({ANALYSIS_NODE_VERSION:verified.runtime.version,ANALYSIS_NODE_SHA256:verified.runtime.sha256,ANALYSIS_NODE_LICENSE_SHA256:verified.runtime.licenseSha256})){const pattern=new RegExp('export const '+name+'=[^;]+;');if(!pattern.test(runtimeSource))throw Error('The runtime Node pins need review before maintenance.');runtimeSource=runtimeSource.replace(pattern,'export const '+name+'='+JSON.stringify(value)+';');}
 const candidateRuntimeModule=path.join(stage,'app-analysis-node.mjs');await writeFile(candidateRuntimeModule,runtimeSource,{flag:'wx'});
 const archiveFile=path.join(stage,verified.runtime.archive);await writeFile(archiveFile,archive,{flag:'wx'});
 const candidate=await import(pathToFileURL(candidateModule).href),runtime=path.join(stage,'runtime');await candidate.prepareAnalysisNode({target:runtime,archiveFile});
 await writeFile(path.join(stage,'verified.json'),JSON.stringify({runtime:verified.runtime,signature,verifiedAt:new Date().toISOString()},null,2),{flag:'wx'});
 return{stage,modulePath,candidateModule,runtimeModulePath,candidateRuntimeModule,runtime,manifest:verified.runtime,signature};
}
export async function promoteNodeCandidate(candidate,{root=project}={}){
 const expected=path.resolve(root,'vendor','analysis-node'),stageRoot=path.resolve(root,'.verification','security-maintenance'),stage=path.resolve(candidate.stage);
 if(!stage.startsWith(stageRoot+path.sep)||path.resolve(candidate.modulePath)!==path.resolve(root,'scripts','prepare-analysis-node.mjs')||path.resolve(candidate.runtimeModulePath)!==path.resolve(root,'desktop','app-analysis-node.mjs')||path.resolve(candidate.runtime)!==path.join(stage,'runtime')||path.resolve(candidate.candidateModule)!==path.join(stage,'prepare-analysis-node.mjs')||path.resolve(candidate.candidateRuntimeModule)!==path.join(stage,'app-analysis-node.mjs'))throw Error('Node candidate escaped its staging workspace.');
 for(const target of[expected,candidate.modulePath,candidate.runtimeModulePath,stage])await plainAncestors(target);
 for(const target of[expected,candidate.modulePath,stage]){const info=await lstat(target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(info?.isSymbolicLink())throw Error('Linked Node promotion targets are not allowed.');}
 const old=path.join(stage,'previous-runtime'),before=await readFile(candidate.modulePath),updated=await readFile(candidate.candidateModule),temporary=candidate.modulePath+'.'+randomUUID()+'.tmp';
 await writeFile(path.join(stage,'previous-module.mjs'),before,{flag:'wx'});await writeFile(temporary,updated,{flag:'wx'});
 const runtimeBefore=await readFile(candidate.runtimeModulePath),runtimeTemporary=candidate.runtimeModulePath+'.'+randomUUID()+'.tmp';await writeFile(path.join(stage,'previous-runtime-module.mjs'),runtimeBefore,{flag:'wx'});await writeFile(runtimeTemporary,await readFile(candidate.candidateRuntimeModule),{flag:'wx'});
 let moved=false,activated=false,moduleChanged=false;try{if(await lstat(expected).catch(()=>null)){await rename(expected,old);moved=true;}await rename(candidate.runtime,expected);activated=true;await rename(temporary,candidate.modulePath);moduleChanged=true;await rename(runtimeTemporary,candidate.runtimeModulePath);}catch(error){if(moduleChanged){const restore=candidate.modulePath+'.'+randomUUID()+'.restore';await writeFile(restore,before,{flag:'wx'});await rename(restore,candidate.modulePath);}if(activated)await rename(expected,candidate.runtime);if(moved)await rename(old,expected);throw error;}
 return{version:candidate.manifest.version,stage,previousRuntime:moved?old:null};
}
export async function maintain({root=project,prepare=false,securityOnly=false,reportFile=path.join(root,'.verification','security-maintenance-report.json'),runNpm=maintenanceNpm,fetchBytes=officialNodeBytes}={}){
 const report={format:1,checkedAt:new Date().toISOString(),mode:securityOnly?'security-only':'compatible-updates',npm:{},node:{},prepared:false};
 let phase='read manifests';
 const npm=async(args,accepted=[0])=>{const result=await runNpm(args,{cwd:root});if(!accepted.includes(result.code))throw npmFailure(phase+' failed',result);return result;};
 const auditJson=result=>{let value;try{value=JSON.parse(result.stdout);}catch{throw npmFailure(phase+' did not return a usable report',result);}if(value.error)throw npmFailure(phase+' failed',result);return value;};
 try{
  const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')),lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8')),available={};
  phase='npm advisory check';const auditReport=auditJson(await npm(['audit','--json','--registry=https://registry.npmjs.org'],[0,1]));
  // Dependabot owns ordinary version updates. Scheduled maintenance only repairs
  // actual advisories, so a new optional version cannot break a clean audit.
  if(!securityOnly)for(const name of new Set(dependencySections.flatMap(section=>Object.keys(manifest[section]||{})))){if(providerBinary(name))continue;phase='registry version check for '+name;const result=await npm(['view',name,'versions','--json','--registry=https://registry.npmjs.org']);const versions=JSON.parse(result.stdout);available[name]=Array.isArray(versions)?versions:[versions];}
  const plan=dependencyPlan(manifest,available);report.npm={vulnerabilities:auditReport.metadata?.vulnerabilities||{},blockers:runtimeAdvisoryBlockers(auditReport,lock),plan};
  phase='official Node release check';const index=JSON.parse((await fetchBytes('https://nodejs.org/dist/index.json',{maximum:2*1024**2})).toString('utf8'));
  const securityNode=nodeCandidateVersion(index.filter(row=>row.security===true)),nextNode=securityOnly?securityNode:nodeCandidateVersion(index);
  report.node={installed:ANALYSIS_NODE_RUNTIME.version,available:nodeCandidateVersion(index),securityUpdateAvailable:Boolean(securityNode),signaturePins:NODE_MAINTENANCE_POLICY.signerThumbprints};
  report.hostedProviders='Provider-hosted services are patched by their operators; no local version change can establish their security.';
  if(prepare){
   const before=new Map(await Promise.all(['package.json','package-lock.json'].map(async name=>[name,await readFile(path.join(root,name))])));
   try{
    for(const section of dependencySections){const updates=plan.updates.filter(row=>row.section===section);if(updates.length){phase='compatible '+section+' candidate creation';await npm(['install','--package-lock-only','--ignore-scripts','--save-exact',...(section==='devDependencies'?['--save-dev']:section==='optionalDependencies'?['--save-optional']:[]),...updates.map(row=>row.name+'@'+row.version),'--registry=https://registry.npmjs.org']);}}
    if(!securityOnly||Object.keys(auditReport.vulnerabilities||{}).length){
     phase='transitive advisory candidate creation';const fixed=await npm(['audit','fix','--package-lock-only','--ignore-scripts','--json','--registry=https://registry.npmjs.org'],[0,1]);auditJson(fixed);
     phase='candidate advisory check';const remaining=auditJson(await npm(['audit','--json','--registry=https://registry.npmjs.org'],[0,1]));report.npm.remaining=remaining.metadata?.vulnerabilities||{};report.npm.blockers=runtimeAdvisoryBlockers(remaining,JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8')));
    }
    const candidate=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')),candidateLock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));
    for(const section of dependencySections)for(const[name,pin]of Object.entries(manifest[section]||{}))if(providerBinary(name)&&(candidate[section]?.[name]!==pin||!isDeepStrictEqual(candidateLock.packages?.['node_modules/'+name],lock.packages?.['node_modules/'+name])))throw Error('Provider executable security fixes require reviewed runtime pins: '+name);
   }catch(error){if(error.stopUnconfirmed)report.npm.shutdownUnconfirmed=true;else for(const[name,bytes]of before)await writeFile(path.join(root,name),bytes);throw error;}
   if(nextNode){phase='verified Node candidate';const candidate=await stageNodeCandidate({next:nextNode,root,fetchBytes});report.node.candidate=await promoteNodeCandidate(candidate,{root});report.node.securityUpdateAvailable=false;}
   report.prepared=true;
  }
  phase='security qualification';if(report.npm.blockers.length||report.node.securityUpdateAvailable)throw Error('Unresolved high/critical runtime advisories or an official Node security update block qualification. See the maintenance report.');
  return report;
 }catch(error){report.failure={phase,code:error.code||null,message:error.message};throw error;}
 finally{await mkdir(path.dirname(reportFile),{recursive:true});await writeFile(reportFile,JSON.stringify(report,null,2)+'\n','utf8');}
}
export async function verifyPreparation({root=project,...options}={}){
 const parent=path.resolve(root,'.verification');await plainAncestors(parent);await mkdir(parent,{recursive:true});const scratch=await mkdtemp(path.join(parent,'maintenance-prepare-'));
 try{for(const name of ['package.json','package-lock.json','scripts/prepare-analysis-node.mjs','desktop/app-analysis-node.mjs']){const target=path.join(scratch,name);await mkdir(path.dirname(target),{recursive:true});await copyFile(path.join(root,name),target);}
  return await maintain({...options,root:scratch,prepare:true,securityOnly:true});
 }finally{if(path.dirname(path.resolve(scratch))!==parent)throw Error('Preparation cleanup escaped its scratch parent.');await rm(scratch,{recursive:true,force:true});}
}
export function sameMaintenanceReport(first,second){
 const clean=report=>{const copy=structuredClone(report);delete copy.checkedAt;if(copy.node?.candidate){delete copy.node.candidate.stage;delete copy.node.candidate.previousRuntime;}return copy;};
 return isDeepStrictEqual(clean(first),clean(second));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),usage='node scripts/security-maintenance.mjs [--check | --prepare | --verify-prepare] [--security-only] [--report FILE]';
 if(args.length===1&&args[0]==='--help')console.log(usage+'\nScheduled preparation repairs advisories only; Dependabot owns ordinary version updates. Preparation verification uses copied manifests. Signing and publication remain separately gated.');
 else if(args.includes('--same-report')){
  if(args[0]!=='--same-report'||args.length!==3){console.error('Use --same-report FIRST SECOND');process.exitCode=2;}
  else try{const reports=await Promise.all(args.slice(1).map(file=>readFile(file,'utf8').then(text=>JSON.parse(text.replace(/^\uFEFF/,'')))));process.exitCode=sameMaintenanceReport(...reports)?0:1;}catch(error){console.error(error.message);process.exitCode=2;}
 }else{
  let mode=null,securityOnly=false,reportFile,valid=true;
  for(let i=0;i<args.length;i++){const arg=args[i];if(['--check','--prepare','--verify-prepare'].includes(arg)){if(mode)valid=false;mode=arg;}else if(arg==='--security-only')securityOnly=true;else if(arg==='--report'&&args[i+1]&&!args[i+1].startsWith('--')&&reportFile===undefined)reportFile=path.resolve(args[++i]);else valid=false;}
  if(!valid){console.error(usage);process.exitCode=2;}
  else{const run=mode==='--verify-prepare'?verifyPreparation:maintain;run({prepare:mode==='--prepare',securityOnly:securityOnly||mode==='--check'||!mode,reportFile}).then(report=>console.log(JSON.stringify(report,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});}
 }
}
