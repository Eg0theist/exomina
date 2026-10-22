// Trusted-branch maintenance creates candidates. It never publishes or installs.
import {readFile,writeFile,mkdir,rename,lstat} from 'node:fs/promises';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ANALYSIS_NODE_RUNTIME,analysisNodeArchiveMembers} from './prepare-analysis-node.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export const NODE_MAINTENANCE_POLICY=Object.freeze({major:24,signerThumbprints:['6018A47185244F3B175DAFC18D0D8EB47E3F84CF'],origin:'https://nodejs.org'});
const providerBinary=name=>/@(?:anthropic-ai|xai-official)\/.*win32/.test(name);
function version(value){const match=/^(\d+)\.(\d+)\.(\d+)$/.exec(String(value).replace(/^[~^]/,''));return match?match.slice(1).map(Number):null;}
const compare=(a,b)=>{const x=version(a),y=version(b);if(!x||!y)throw Error('Choose stable semantic versions.');for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;};
async function plainAncestors(target){let cursor=path.resolve(target);while(true){const info=await lstat(cursor).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(info?.isSymbolicLink()||info?.isFile()&&info.nlink!==1)throw Error('Linked maintenance paths are not allowed.');const parent=path.dirname(cursor);if(parent===cursor)return;cursor=parent;}}
export function runtimeAdvisoryBlockers(audit,lock){return Object.entries(audit.vulnerabilities||{}).filter(([name,item])=>['high','critical'].includes(item.severity)&&(name==='electron'||Object.hasOwn(lock.packages?.['']?.dependencies||{},name)||(item.nodes||[]).some(node=>lock.packages?.[node]?.dev!==true))).map(([name,item])=>({name,severity:item.severity}));}
export function chooseCompatibleVersion(current,available){const base=version(current);if(!base)return null;return available.filter(value=>{const next=version(value);return next&&next[0]===base[0]&&(base[0]!==0||next[1]===base[1])&&compare(value,current)>0;}).sort(compare).at(-1)||null;}
export function dependencyPlan(manifest,available){
 const updates=[],manual=[];for(const section of['dependencies','devDependencies'])for(const[name,current]of Object.entries(manifest[section]||{})){
  if(!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name))throw Error('Invalid npm dependency name.');
  if(providerBinary(name)){manual.push({name,current,reason:'Provider executable updates require separately verified upstream provenance; registry latest is not publisher authentication.'});continue;}
  const selected=chooseCompatibleVersion(current,available[name]||[]);if(selected)updates.push({section,name,current,version:selected});
 }return{updates,manual};
}
async function npm(args,{cwd=project}={}){
 if(args.some(arg=>/[&|<>^%!"\r\n]/.test(arg)))throw Error('Unsafe npm maintenance argument.');
 const windows=process.platform==='win32',command=windows?path.join(process.env.SystemRoot||'C:\\Windows','System32','cmd.exe'):'npm',argv=windows?['/d','/s','/c','npm.cmd '+args.map(arg=>'"'+arg+'"').join(' ')]:args;
 return new Promise((resolve,reject)=>{const child=spawn(command,argv,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(Error('npm maintenance request timed out.'));},180000);child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>8*1024**2)child.kill();});child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});});
}
export async function officialNodeBytes(url,{maximum=64*1024**2,fetchImpl=fetch}={}){
 const address=new URL(url);if(address.origin!==NODE_MAINTENANCE_POLICY.origin||!/^\/dist\/(?:index\.json|v\d+\.\d+\.\d+\/(?:SHASUMS256\.txt|node-v\d+\.\d+\.\d+-win-x64\.zip))$/.test(address.pathname)||address.search||address.hash)throw Error('Node maintenance only accepts exact official distribution URLs.');
 const response=await fetchImpl(address.href,{redirect:'error',signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error('Official Node metadata request failed.');let length=0;const chunks=[];for await(const chunk of response.body){length+=chunk.length;if(length>maximum)throw Error('Official Node input exceeds its size limit.');chunks.push(chunk);}return Buffer.concat(chunks,length);
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
 const{stdout}=await promisify(execFile)(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',script],{windowsHide:true,encoding:'utf8',env:{...process.env,EXOMINA_NODE_CANDIDATE:exe},timeout:30000});return JSON.parse(stdout);
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
export async function maintain({root=project,prepare=false,reportFile=path.join(root,'.verification','security-maintenance-report.json'),runNpm=npm,fetchBytes=officialNodeBytes}={}){
 const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')),lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8')),available={};
 const audit=await runNpm(['audit','--json','--registry=https://registry.npmjs.org'],{cwd:root});let auditReport;try{auditReport=JSON.parse(audit.stdout);}catch{throw Error('npm audit did not return a usable report.');}if(audit.code>1||auditReport.error)throw Error('npm advisory check failed.');
 for(const name of Object.keys({...manifest.dependencies,...manifest.devDependencies})){if(providerBinary(name))continue;const result=await runNpm(['view',name,'versions','--json','--registry=https://registry.npmjs.org'],{cwd:root});if(result.code!==0)throw Error('Registry version check failed for '+name);const versions=JSON.parse(result.stdout);available[name]=Array.isArray(versions)?versions:[versions];}
 const plan=dependencyPlan(manifest,available),index=JSON.parse((await fetchBytes('https://nodejs.org/dist/index.json',{maximum:2*1024**2})).toString('utf8')),nextNode=nodeCandidateVersion(index);
 const nodeSecurityAvailable=index.some(row=>row.security===true&&version(String(row.version).replace(/^v/,''))?.[0]===NODE_MAINTENANCE_POLICY.major&&compare(String(row.version).replace(/^v/,''),ANALYSIS_NODE_RUNTIME.version)>0);
 const report={format:1,checkedAt:new Date().toISOString(),npm:{vulnerabilities:auditReport.metadata?.vulnerabilities||{},blockers:runtimeAdvisoryBlockers(auditReport,lock),plan},node:{installed:ANALYSIS_NODE_RUNTIME.version,available:nextNode,securityUpdateAvailable:nodeSecurityAvailable,signaturePins:NODE_MAINTENANCE_POLICY.signerThumbprints},hostedProviders:'Provider-hosted services are patched by their operators; no local version change can establish their security.',prepared:false};
 if(prepare){
  for(const section of['dependencies','devDependencies']){const updates=plan.updates.filter(row=>row.section===section);if(updates.length){const result=await runNpm(['install','--package-lock-only','--ignore-scripts','--save-exact',...(section==='devDependencies'?['--save-dev']:[]),...updates.map(row=>row.name+'@'+row.version),'--registry=https://registry.npmjs.org'],{cwd:root});if(result.code!==0)throw Error('Compatible dependency candidate creation failed.');}}
  const fix=await runNpm(['audit','fix','--package-lock-only','--ignore-scripts','--registry=https://registry.npmjs.org'],{cwd:root});if(fix.code>1)throw Error('Transitive advisory candidate creation failed.');
  const remaining=await runNpm(['audit','--json','--registry=https://registry.npmjs.org'],{cwd:root});let remainingAudit;try{remainingAudit=JSON.parse(remaining.stdout);}catch{throw Error('Candidate advisory check failed.');}if(remaining.code>1||remainingAudit.error)throw Error('Candidate advisory check failed.');report.npm.remaining=remainingAudit.metadata?.vulnerabilities||{};report.npm.blockers=runtimeAdvisoryBlockers(remainingAudit,JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8')));
  if(nextNode){const candidate=await stageNodeCandidate({next:nextNode,root,fetchBytes});report.node.candidate=await promoteNodeCandidate(candidate,{root});report.node.securityUpdateAvailable=false;}
  report.prepared=true;
 }
 await mkdir(path.dirname(reportFile),{recursive:true});await writeFile(reportFile,JSON.stringify(report,null,2)+'\n','utf8');if(report.npm.blockers.length||report.node.securityUpdateAvailable)throw Error('Unresolved high/critical runtime advisories or an official Node security update block qualification. See the maintenance report.');return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(args.includes('--help'))console.log('node scripts/security-maintenance.mjs [--check | --prepare] [--report FILE]\nCheck npm advisories, compatible direct versions and official Node24. Prepare creates candidates only; signing and publication belong to separately gated trusted-branch CI.');else{const at=args.indexOf('--report');maintain({prepare:args.includes('--prepare'),reportFile:at<0?undefined:path.resolve(args[at+1])}).then(report=>console.log(JSON.stringify(report,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});}
}
