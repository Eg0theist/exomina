import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {publicReadiness,validCandidate,verifyCandidateArtifacts,verifyQualificationReports} from '../scripts/public-readiness.mjs';
import {signReleaseEnvelope} from '../desktop/update-auth.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const keys=generateKeyPairSync('ed25519');
const channel={format:2,feedUrl:'https://github.com/example/exomina/releases/latest/download/latest.json',channel:'stable',trustedKeys:{publisher:keys.publicKey.export({format:'pem',type:'spki'})}};
function candidate(){return {format:1,platform:'windows',arch:'x64',sourceRevision:'a'.repeat(40),releaseTag:'v0.6.0',buildId:'qualified-build-id',version:'0.6.0',inventorySha256:'b'.repeat(64),artifacts:{installer:{file:'Exomina-0.6.0-windows-x64-Setup.exe',sha256:'c'.repeat(64),size:3},archive:{file:'Exomina-0.6.0-build-windows-x64.zip',sha256:'d'.repeat(64),size:4},metadata:{file:'latest.json',sha256:'e'.repeat(64),size:5}}};}
function evidence(value){return {format:1,sourceRevision:value.sourceRevision,buildId:value.buildId,inventorySha256:value.inventorySha256,...Object.fromEntries(Object.entries(value.artifacts).map(([kind,item])=>[kind+'Sha256',item.sha256])),signaturesVerified:true,cleanUpdate:true,customizedUpdate:true,recovery:true,stockAntivirus:true};}
function inputs(){const value=candidate();return {feedUrl:channel.feedUrl,channel,signing:{ready:true},licensePublished:true,candidate:value,evidence:evidence(value),buildId:value.buildId,sourceRevision:value.sourceRevision,artifactsVerified:true,evidenceReportsVerified:true};}
async function temporary(t){const directory=await mkdtemp(path.join(tmpdir(),'exomina-release-gate-'));t.after(async()=>{assert.equal(path.dirname(directory),path.resolve(tmpdir()));assert.ok(path.basename(directory).startsWith('exomina-release-gate-'));await rm(directory,{recursive:true,force:true});});return directory;}

test('publication requires all qualification checks and exact source and artifact identities',()=>{
 const value=inputs();assert.equal(publicReadiness(value).ready,true);
 for(const field of ['sourceRevision','buildId','inventorySha256','installerSha256','archiveSha256','metadataSha256'])assert.equal(publicReadiness({...value,evidence:{...value.evidence,[field]:'unrelated'}}).ready,false,field);
 for(const field of ['signaturesVerified','cleanUpdate','customizedUpdate','recovery','stockAntivirus'])assert.equal(publicReadiness({...value,evidence:{...value.evidence,[field]:false}}).ready,false,field);
 for(const field of ['artifactsVerified','evidenceReportsVerified','licensePublished'])assert.equal(publicReadiness({...value,[field]:false}).ready,false,field);
 assert.equal(publicReadiness({...value,sourceRevision:'f'.repeat(40)}).ready,false);
 assert.equal(publicReadiness({...value,channel:{...channel,trustedKeys:{}}}).ready,false);
 assert.equal(publicReadiness({...value,feedUrl:'http://example.com/latest.json'}).ready,false);
 assert.equal(publicReadiness().ready,false);
 assert.equal(publicReadiness({...value,evidence:{buildId:value.buildId,signaturesVerified:true,cleanUpdate:true,customizedUpdate:true,recovery:true,stockAntivirus:true}}).ready,false);
});

test('candidate schema rejects substituted targets, paths and ambiguous artifact sets',()=>{
 assert.equal(validCandidate(candidate()),true);
 for(const changes of [{platform:'linux'},{releaseTag:'v0.5.0'},{sourceRevision:'main'},{inventorySha256:'invalid'}])assert.equal(validCandidate({...candidate(),...changes}),false);
 const escaped=candidate();escaped.artifacts.installer.file='../Setup.exe';assert.equal(validCandidate(escaped),false);
 const extra=candidate();extra.artifacts.other={file:'extra.exe'};assert.equal(validCandidate(extra),false);
});

test('qualification reports must be present, dated and byte-identical within the repository',async t=>{
 const directory=await temporary(t),file='qualification.txt',text='Synthetic clean-machine report used only for gate regression testing.';
 await writeFile(path.join(directory,file),text,'utf8');
 const report={path:file,sha256:hash(text),testedAt:new Date().toISOString()},value={reports:Object.fromEntries(['cleanUpdate','customizedUpdate','recovery','stockAntivirus'].map(name=>[name,{...report}]))};
 assert.equal(await verifyQualificationReports(value,directory),true);
 const traversal=structuredClone(value);traversal.reports.recovery.path='../qualification.txt';await assert.rejects(verifyQualificationReports(traversal,directory),/contained/);
 const missing=structuredClone(value);delete missing.reports.stockAntivirus;await assert.rejects(verifyQualificationReports(missing,directory),/dated, hashed/);
 const future=structuredClone(value);future.reports.cleanUpdate.testedAt='2999-01-01T00:00:00.000Z';await assert.rejects(verifyQualificationReports(future,directory),/dated, hashed/);
 await writeFile(path.join(directory,file),'changed','utf8');await assert.rejects(verifyQualificationReports(value,directory),/hash differs/);
});

test('retained artifact verification checks signed metadata, exact bytes and immutable repository address',async t=>{
 const directory=await temporary(t),value=candidate(),archive=Buffer.from('synthetic archive'),installer=Buffer.from('synthetic installer'),now=Date.now();
 await writeFile(path.join(directory,value.artifacts.archive.file),archive);await writeFile(path.join(directory,value.artifacts.installer.file),installer);
 value.artifacts.archive={...value.artifacts.archive,sha256:hash(archive),size:archive.length};value.artifacts.installer={...value.artifacts.installer,sha256:hash(installer),size:installer.length};
 const payload={format:2,channel:'stable',id:value.buildId,version:value.version,builtAt:new Date(now-1000).toISOString(),publishedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+86400000).toISOString(),windows:{x64:{url:'https://github.com/example/exomina/releases/download/'+value.releaseTag+'/'+value.artifacts.archive.file,sha256:value.artifacts.archive.sha256,size:value.artifacts.archive.size,inventorySha256:value.inventorySha256}}};
 const metadata=JSON.stringify(signReleaseEnvelope(payload,{keyId:'publisher',privateKey:keys.privateKey}));await writeFile(path.join(directory,'latest.json'),metadata,'utf8');value.artifacts.metadata={file:'latest.json',sha256:hash(metadata),size:Buffer.byteLength(metadata)};
 assert.equal((await verifyCandidateArtifacts(directory,value,channel,'https://github.com/example/exomina')).id,value.buildId);
 await assert.rejects(verifyCandidateArtifacts(directory,value,channel,'https://github.com/another/exomina'),/does not bind/);
 await assert.rejects(verifyCandidateArtifacts(directory,value,{...channel,trustedKeys:{}},'https://github.com/example/exomina'),/authentication keys/);
 const changed=candidate();Object.assign(changed,value);changed.artifacts=structuredClone(value.artifacts);changed.artifacts.archive.sha256=hash('changed archive');changed.artifacts.archive.size=Buffer.byteLength('changed archive');await writeFile(path.join(directory,changed.artifacts.archive.file),'changed archive');
 await assert.rejects(verifyCandidateArtifacts(directory,changed,channel,'https://github.com/example/exomina'),/does not bind/);
});

test('Windows release publication is separate from candidate creation and requires the strict gate',async()=>{
 const workflow=await readFile(new URL('../.github/workflows/release.yml',import.meta.url),'utf8'),split=workflow.indexOf('\n  publish:');assert.ok(split>0);
 assert.doesNotMatch(workflow.slice(0,split),/gh release create/);const publication=workflow.slice(split);
 assert.match(publication,/inputs\.candidate_run_id/);assert.match(publication,/github\.ref_name == github\.event\.repository\.default_branch/);
 assert.ok(publication.indexOf('public-readiness.mjs --strict')<publication.indexOf('gh release create'));
 assert.match(publication,/git ls-files --error-unmatch/);assert.match(publication,/conclusion -ne 'success'/);
});
