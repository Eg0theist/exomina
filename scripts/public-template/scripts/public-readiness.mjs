import {readFile,writeFile,lstat,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {signingPreflight,verifyPublicSignatures} from './release-windows.mjs';
import {normalizeUpdateTrust,verifyReleaseEnvelope} from '../desktop/update-auth.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const revision=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const requirements=['cleanUpdate','customizedUpdate','recovery','stockAntivirus'];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const plainName=value=>typeof value==='string'&&value.length<=200&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);

export function validCandidate(candidate){
 return candidate?.format===1&&candidate.platform==='windows'&&candidate.arch==='x64'&&revision(candidate.sourceRevision)&&
  typeof candidate.buildId==='string'&&/^[\w-]{8,64}$/.test(candidate.buildId)&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(candidate.version||'')&&
  candidate.releaseTag==='v'+candidate.version&&sha(candidate.inventorySha256)&&Object.keys(candidate.artifacts||{}).length===3&&
  Object.entries({installer:'.exe',archive:'.zip',metadata:'.json'}).every(([kind,ext])=>{
   const artifact=candidate.artifacts?.[kind];return plainName(artifact?.file)&&artifact.file.endsWith(ext)&&sha(artifact.sha256)&&Number.isSafeInteger(artifact.size)&&artifact.size>0;
  })&&candidate.artifacts.metadata.file==='latest.json'&&new Set(Object.values(candidate.artifacts).map(item=>item.file)).size===3;
}

/** Source checks never stand in for clean-machine evidence for these exact bytes. */
export function publicReadiness({feedUrl='',channel,signing={},licensePublished=false,evidence={},candidate={},buildId,sourceRevision,artifactsVerified=false,evidenceReportsVerified=false}={}){
 let feed=false;try{const u=new URL(feedUrl);feed=u.protocol==='https:'&&!u.username&&!u.password&&!u.hash&&!u.hostname.endsWith('.invalid');}catch{}
 const exact=validCandidate(candidate)&&candidate.buildId===buildId&&candidate.sourceRevision===sourceRevision;
 const bound=exact&&evidence.format===1&&evidence.buildId===buildId&&evidence.sourceRevision===sourceRevision&&
  evidence.inventorySha256===candidate.inventorySha256&&['installer','archive','metadata'].every(kind=>evidence[kind+'Sha256']===candidate.artifacts[kind].sha256);
 const checks={publicFeedConfigured:feed,bundledPublisherKeysConfigured:channel?.format===2&&!!normalizeUpdateTrust(channel),publisherSigningConfigured:signing.ready===true,openSourceLicensePublished:licensePublished===true,
  exactCandidateArtifacts:exact&&artifactsVerified,exactBuildSignatures:bound&&artifactsVerified&&evidence.signaturesVerified===true,qualificationReports:bound&&evidenceReportsVerified,
  cleanInstallAndUpdate:bound&&evidence.cleanUpdate===true,customizedMergeAndUpdate:bound&&evidence.customizedUpdate===true,rollbackAndDataRecovery:bound&&evidence.recovery===true,stockAntivirusQualification:bound&&evidence.stockAntivirus===true};
 return {ready:Object.values(checks).every(Boolean),checks,blockers:Object.entries(checks).filter(([,value])=>!value).map(([name])=>name),buildId:buildId||null,sourceRevision:sourceRevision||null,
  notice:'Readiness applies only to the named source revision and exact candidate hashes. Source tests and synthetic fixtures do not establish signed clean-machine compatibility.'};
}

async function regularFile(file,maximum=8*1024**3){
 const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>maximum)throw Error('Release evidence and artifacts must be bounded independent regular files.');return info;
}
async function json(file){await regularFile(file,256*1024);return JSON.parse(await readFile(file,'utf8'));}
async function artifact(directory,file){
 if(!plainName(file))throw Error('Invalid candidate artifact name.');
 const full=path.join(directory,file),info=await regularFile(full),hash=createHash('sha256');for await(const chunk of createReadStream(full))hash.update(chunk);
 return {file,size:info.size,sha256:hash.digest('hex')};
}
export async function verifyQualificationReports(evidence,project=root){
 for(const name of requirements){
  const report=evidence?.reports?.[name];
  if(!report||typeof report.path!=='string'||!sha(report.sha256)||!Number.isFinite(Date.parse(report.testedAt))||Date.parse(report.testedAt)>Date.now()+300000)throw Error('Qualification needs a dated, hashed report for '+name+'.');
  if(path.isAbsolute(report.path)||/[\\:\x00-\x1f]/.test(report.path)||report.path.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Qualification reports must use contained repository paths.');
  const target=path.resolve(project,report.path);if(!target.startsWith(path.resolve(project)+path.sep))throw Error('Qualification report escaped the repository.');
  let parent=target;while(parent!==path.resolve(project)){const info=await lstat(parent);if(info.isSymbolicLink())throw Error('Linked qualification reports are not accepted.');parent=path.dirname(parent);}
  await regularFile(target,16*1024**2);if(digest(await readFile(target))!==report.sha256)throw Error('Qualification report hash differs for '+name+'.');
 }
 return true;
}
export async function verifyCandidateArtifacts(directory,candidate,channel,repository){
 if(!validCandidate(candidate))throw Error('Invalid signed candidate receipt.');
 for(const item of Object.values(candidate.artifacts)){const observed=await artifact(directory,item.file);if(observed.sha256!==item.sha256||observed.size!==item.size)throw Error('Candidate artifact bytes differ: '+item.file);}
 const payload=verifyReleaseEnvelope(await json(path.join(directory,candidate.artifacts.metadata.file)),channel);
 const archive=candidate.artifacts.archive,expected=new URL(repository);
 if(expected.protocol!=='https:'||expected.hostname!=='github.com'||expected.username||expected.password||expected.search||expected.hash||!/^\/[\w.-]+\/[\w.-]+\/?$/.test(expected.pathname))throw Error('Choose the expected plain GitHub repository.');
 const url=expected.href.replace(/\/$/,'')+'/releases/download/'+candidate.releaseTag+'/'+archive.file;
 if(payload.id!==candidate.buildId||payload.version!==candidate.version||payload.windows?.x64?.sha256!==archive.sha256||payload.windows.x64.size!==archive.size||payload.windows.x64.inventorySha256!==candidate.inventorySha256||payload.windows.x64.url!==url)throw Error('Signed metadata does not bind the exact candidate and repository.');
 return payload;
}
async function verifyInstaller(directory,candidate){
 const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 await promisify(execFile)(powershell,['-NoProfile','-NonInteractive','-File',path.join(root,'scripts/verify-windows-signatures.ps1'),'-SingleFile',path.join(directory,candidate.artifacts.installer.file)],{windowsHide:true,encoding:'utf8',timeout:60000});
}
export async function main(args=process.argv.slice(2)){
 const option=name=>{const index=args.indexOf(name);return index<0?null:args[index+1];};
 const channel=await json(path.join(root,'build/update-channel.json')),license=await readFile(path.join(root,'LICENSE'),'utf8');
 const repository=option('--repository')||JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).homepage;
 const directory=path.resolve(option('--artifact-dir')||'release/publish');
 if(args.includes('--create-candidate')){
  if(!option('--build')||!option('--output')||!revision(option('--source-revision')))throw Error('Choose the packaged build, candidate output and exact source revision.');
  const build=path.resolve(option('--build')),stamp=await json(path.join(build,'exomina.build.json'));
  if(stamp.customized||stamp.officialId)throw Error('Customized builds cannot become public candidates.');
  const files=await readdir(directory),installers=files.filter(name=>name.endsWith('-Setup.exe')),archives=files.filter(name=>name.endsWith('.zip'));
  if(installers.length!==1||archives.length!==1)throw Error('Expected one exact installer and update archive.');
  const candidate={format:1,platform:'windows',arch:'x64',sourceRevision:option('--source-revision'),releaseTag:option('--release-tag'),buildId:stamp.id,version:stamp.version,
   inventorySha256:digest(await readFile(path.join(build,'exomina.release-integrity.json'))),artifacts:{installer:await artifact(directory,installers[0]),archive:await artifact(directory,archives[0]),metadata:await artifact(directory,'latest.json')}};
  await verifyPublicSignatures(build,path.join(directory,installers[0]));await verifyCandidateArtifacts(directory,candidate,channel,repository);
  await writeFile(path.resolve(option('--output')),JSON.stringify(candidate,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  console.log(JSON.stringify({candidate,qualification:'Pending clean-machine, customized update, recovery and stock antivirus evidence. No public release was created.'},null,2));return;
 }
 const candidate=option('--candidate')?await json(path.resolve(option('--candidate'))):{};
 const evidence=option('--evidence')?await json(path.resolve(option('--evidence'))):{};
 let artifactsVerified=false,evidenceReportsVerified=false,signing=signingPreflight();
 if(option('--candidate')){await verifyCandidateArtifacts(directory,candidate,channel,repository);await verifyInstaller(directory,candidate);artifactsVerified=true;signing={ready:true};}
 if(option('--evidence'))evidenceReportsVerified=await verifyQualificationReports(evidence);
 const result=publicReadiness({feedUrl:channel.feedUrl,channel,signing,licensePublished:/Apache License[\s\S]*Version 2\.0/.test(license),evidence,candidate,buildId:option('--build-id')||candidate.buildId,sourceRevision:option('--source-revision')||candidate.sourceRevision,artifactsVerified,evidenceReportsVerified});
 console.log(JSON.stringify(result,null,2));if(args.includes('--strict')&&!result.ready)process.exitCode=1;return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
