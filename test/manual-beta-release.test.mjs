import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {qualifyManualBeta} from '../scripts/publish-manual-beta.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),'exomina-beta-publication-'));
 t.after(async()=>{assert.equal(path.dirname(directory),path.resolve(tmpdir()));assert.ok(path.basename(directory).startsWith('exomina-beta-publication-'));await rm(directory,{recursive:true,force:true});});
 const version='0.6.0',targets=[['windows','x64','windows-x64-Setup.exe'],['darwin','arm64','macos-arm64.dmg'],['darwin','x64','macos-x64.dmg'],['linux','x64','linux-amd64.deb'],['linux','arm64','linux-arm64.deb']];
 const files=[];
 for(const [platform,arch,suffix]of targets){
  const name=`Exomina-Beta-${version}-${suffix}`,bytes=Buffer.from('INERT SYNTHETIC INSTALLER '+suffix),file=path.join(directory,name);await writeFile(file,bytes);files.push(file);
  if(platform!=='windows'){const reportDir=path.join(directory,platform+'-'+arch);await mkdir(reportDir);await writeFile(path.join(reportDir,'native-install-report.json'),JSON.stringify({platform,arch,installer:name,sha256:sha(bytes),passed:true}));}
 }
 const windowsHash=sha(await readFile(files[0]));
 await writeFile(path.join(directory,'windows-install.json'),JSON.stringify({ok:true,installerSha256:windowsHash,build:{version}}));
 await writeFile(path.join(directory,'windows-startup.json'),JSON.stringify({ok:true,installerSha256:windowsHash,buildStamp:{version}}));
 await writeFile(path.join(directory,'windows-connector.json'),JSON.stringify({passed:true,installerSha256:windowsHash,version}));
 return {directory,version,files};
}
test('manual beta qualification requires every exact Windows and native installer',async t=>{
 const {directory,version}=await fixture(t),result=await qualifyManualBeta(directory,version);
 assert.equal(result.installers.length,5);assert.equal(result.distribution.manualUpdates,true);assert.equal(result.distribution.automaticDelivery,false);
 await assert.rejects(qualifyManualBeta(directory,'0.6.1'),/exactly one/);
});
test('tampering after qualification cannot substitute another installer',async t=>{
 const {directory,version,files}=await fixture(t);await writeFile(files[3],'ALTERED INERT FILE');await assert.rejects(qualifyManualBeta(directory,version),/Native qualification/);
});
test('failed Windows install or startup checks block the manual beta',async t=>{
 const {directory,version}=await fixture(t);await writeFile(path.join(directory,'windows-startup.json'),JSON.stringify({ok:false}));await assert.rejects(qualifyManualBeta(directory,version),/Windows qualification/);
});

test('a failed connector check for the exact installer is published as a known issue',async t=>{
 const {directory,version}=await fixture(t),windowsHash=sha(await readFile(path.join(directory,`Exomina-Beta-${version}-windows-x64-Setup.exe`)));
 await writeFile(path.join(directory,'windows-connector.json'),JSON.stringify({passed:false,installerSha256:windowsHash,version}));
 const result=await qualifyManualBeta(directory,version);
 assert.equal(result.qualification.windowsConnectorInput,false);assert.equal(result.knownIssues.length,1);
 await writeFile(path.join(directory,'windows-connector.json'),JSON.stringify({passed:false}));await assert.rejects(qualifyManualBeta(directory,version),/Windows qualification/);
});

test('a connector pass for another installer cannot qualify the release',async t=>{
 const {directory,version}=await fixture(t);await writeFile(path.join(directory,'windows-connector.json'),JSON.stringify({passed:true,installerSha256:'0'.repeat(64),version}));await assert.rejects(qualifyManualBeta(directory,version),/Windows qualification/);
});
