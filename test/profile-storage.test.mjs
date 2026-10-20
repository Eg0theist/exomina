import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,chmod,lstat,symlink,readlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProfileStorage,initializeProfileStorage} from '../desktop/profile-storage.mjs';
import {prepareUnixProfile} from '../desktop/profile-access.mjs';
import {privateGate} from '../desktop/private-gate.mjs';

async function fixture(t,{platform='win32',encrypted=false,efsAvailable=false,vaultFailure=false}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'exomina-profile-policy-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const dataDir=path.join(root,'private','data'),accountsDir=path.join(root,'private','accounts'),workspace=path.join(root,'workspace');
  await mkdir(dataDir,{recursive:true});await mkdir(accountsDir,{recursive:true});
  const state=path.join(dataDir,'state.json'),stateBytes='{"conversations":[{"title":"Synthetic existing chat"}]}';await writeFile(state,stateBytes);
  const calls=[],accessCalls=[];
  const access={async inspect(directory){accessCalls.push(['inspect',directory]);return {restrictedAccess:true,rootEncrypted:encrypted,anyEncrypted:encrypted&&directory!==dataDir+'.setup',efsAvailable};},async prepare(directory){accessCalls.push(['prepare',directory]);return {restrictedAccess:true,rootEncrypted:false,anyEncrypted:false,efsAvailable};},async verify(directory){accessCalls.push(['verify',directory]);return {restrictedAccess:true,anyEncrypted:encrypted};},close(){}};
  const vault={async verifyStartup(directory,input){calls.push(['startup',directory,input]);if(vaultFailure)throw Error('Synthetic existing EFS key unavailable.');return {encrypted:true,restrictedAccess:true};},async preflight(directory){calls.push(['preflight',directory]);return {encrypted,restrictedAccess:true};},async verify(directory){calls.push(['verify',directory]);return {encrypted:true,restrictedAccess:true};},async prepareRecoveryProbe(directory){calls.push(['probe',directory]);return {encrypted:true,restrictedAccess:true};}};
  const options={dataDir,accountsDir,workspace,platform,access,vault},profile=new ProfileStorage(options);
  async function recovery(text=JSON.stringify({thumbprint:'A'.repeat(40),savedAt:'2026-01-01T00:00:00Z'})){await mkdir(profile.setupDir,{recursive:true});await writeFile(profile.recoveryFile,text);return text;}
  return {root,profile,options,state,stateBytes,calls,accessCalls,recovery};
}

test('fresh standard profiles open without EFS or recovery and preserve existing chat bytes',async t=>{
  const f=await fixture(t),status=await f.profile.initialize();
  assert.equal(status.ready,true);assert.equal(status.mode,'standard');assert.equal(status.folderEncrypted,false);assert.equal(status.protected,false);assert.equal(status.encryptionAvailable,false);assert.equal(status.needsRecovery,false);
  assert.deepEqual(f.calls,[]);assert.equal(await readFile(f.state,'utf8'),f.stateBytes);
  assert.deepEqual(JSON.parse(await readFile(f.profile.policyFile,'utf8')),{version:1,mode:'standard'});
  assert.equal((await f.profile.verifyPrivate(f.options.accountsDir)).mode,'standard');
  assert.equal((await f.profile.verifyWorkspace()).projectDirectory,true);
  assert.ok(!f.accessCalls.some(([action,directory])=>action==='prepare'&&directory===f.options.workspace),'project files are not recursively restricted');
  await assert.rejects(f.profile.selectEncrypted({confirm:true}),/unavailable/);
});

test('a recovery-backed existing EFS profile never changes data, records or selected locations',async t=>{
  const f=await fixture(t,{encrypted:true,efsAvailable:true}),record=await f.recovery();
  const status=await f.profile.initialize();assert.equal(status.ready,true);assert.equal(status.mode,'efs');assert.equal(status.folderEncrypted,true);
  assert.equal(await readFile(f.state,'utf8'),f.stateBytes);assert.equal(await readFile(f.profile.recoveryFile,'utf8'),record);
  assert.ok(f.calls.filter(([action])=>action==='startup').length>=2);assert.equal(f.accessCalls.some(([action])=>action==='prepare'),false);
  await assert.rejects(f.profile.selectStandard(),/cannot be downgraded/);
  await assert.rejects(readFile(f.profile.policyFile),{code:'ENOENT'});
});

test('encrypted roots without recovery and broken existing recovery metadata remain blocked',async t=>{
  const encrypted=await fixture(t,{encrypted:true,efsAvailable:true});
  assert.equal((await encrypted.profile.initialize()).ready,false);assert.equal(encrypted.profile.status.mode,'efs');assert.equal(encrypted.profile.status.canUseStandard,false);
  await assert.rejects(encrypted.profile.selectStandard(),/cannot be downgraded/);assert.equal(await readFile(encrypted.state,'utf8'),encrypted.stateBytes);
  const broken=await fixture(t),record=await broken.recovery('{invalid synthetic recovery metadata');
  assert.equal((await broken.profile.initialize()).ready,false);assert.equal(broken.profile.status.mode,'efs');assert.deepEqual(broken.calls,[]);
  assert.equal(broken.profile.status.needsRecovery,true);
  assert.equal(await readFile(broken.profile.recoveryFile,'utf8'),record);assert.equal(await readFile(broken.state,'utf8'),broken.stateBytes);
  await assert.rejects(readFile(broken.profile.policyFile),{code:'ENOENT'});
});

test('an unavailable old EFS key fails closed without replacing the profile',async t=>{
  const f=await fixture(t,{encrypted:true,vaultFailure:true}),record=await f.recovery();
  assert.equal((await f.profile.initialize()).ready,false);assert.match(f.profile.status.message,/key unavailable/);
  assert.equal(f.profile.status.needsRecovery,true);
  await assert.rejects(f.profile.verifyPrivate(f.options.accountsDir),/key unavailable/);
  assert.equal(await readFile(f.profile.recoveryFile,'utf8'),record);assert.equal(await readFile(f.state,'utf8'),f.stateBytes);
});

test('optional EFS requires explicit confirmation and can be cancelled only before data encryption or a recovery record',async t=>{
  const f=await fixture(t,{efsAvailable:true});await f.profile.initialize();
  const standard=await readFile(f.profile.policyFile,'utf8');await assert.rejects(f.profile.selectEncrypted(),/Confirm/);assert.equal(await readFile(f.profile.policyFile,'utf8'),standard);
  await f.profile.selectEncrypted({confirm:true});assert.deepEqual(JSON.parse(await readFile(f.profile.policyFile,'utf8')),{version:1,mode:'efs',pending:true});
  let next=await initializeProfileStorage(f.options);assert.equal(next.status.mode,'efs');assert.equal(next.status.ready,false);assert.equal(next.status.canUseStandard,true);
  await next.selectStandard();next=await initializeProfileStorage(f.options);assert.equal(next.status.ready,true);assert.equal(next.status.mode,'standard');assert.equal(await readFile(f.state,'utf8'),f.stateBytes);
  await next.selectEncrypted({confirm:true});next=await initializeProfileStorage(f.options);await next.saveRecovery({thumbprint:'B'.repeat(40),savedAt:'2026-01-02T00:00:00Z'});
  assert.equal(next.status.canUseStandard,false);await assert.rejects(next.selectStandard(),/cannot be downgraded/);
});

test('malformed storage policy blocks all modes and an EFS profile on Unix is preserved',async t=>{
  const broken=await fixture(t);await mkdir(broken.profile.setupDir,{recursive:true});await writeFile(broken.profile.policyFile,'{"version":1,"mode":"invented"}');
  assert.equal((await broken.profile.initialize()).ready,false);assert.equal(await readFile(broken.state,'utf8'),broken.stateBytes);assert.deepEqual(broken.calls,[]);
  const unix=await fixture(t,{platform:'linux'}),record=await unix.recovery();
  assert.equal((await unix.profile.initialize()).ready,false);assert.equal(unix.profile.status.mode,'efs');assert.match(unix.profile.status.message,/requires Windows/);assert.deepEqual(unix.calls,[]);assert.equal(await readFile(unix.profile.recoveryFile,'utf8'),record);
});

test('present falsey and non-object storage policies are preserved and block startup',async t=>{
  for(const record of ['null','false','0','""','[]','"synthetic invalid policy"']){
    const f=await fixture(t);await mkdir(f.profile.setupDir,{recursive:true});await writeFile(f.profile.policyFile,record);
    assert.equal((await f.profile.initialize()).ready,false,record);assert.match(f.profile.status.message,/metadata is invalid/,record);
    assert.equal(await readFile(f.profile.policyFile,'utf8'),record);assert.equal(await readFile(f.state,'utf8'),f.stateBytes);assert.deepEqual(f.calls,[]);
    assert.equal(f.accessCalls.some(([action])=>action==='prepare'),false,'Invalid policy files are never replaced or opened as an ordinary profile.');
  }
});

test('present invalid recovery values remain EFS recovery records and are never treated as absent',async t=>{
  for(const record of ['null','false','0','""','[]','{}','{"thumbprint":null}']){
    const f=await fixture(t);await f.recovery(record);
    assert.equal((await f.profile.initialize()).ready,false,record);assert.equal(f.profile.status.mode,'efs');assert.equal(f.profile.status.needsRecovery,true);assert.equal(f.profile.status.canUseStandard,false);
    assert.match(f.profile.status.message,/metadata is invalid|recovery record is invalid/,record);
    assert.equal(await readFile(f.profile.recoveryFile,'utf8'),record);assert.equal(await readFile(f.state,'utf8'),f.stateBytes);assert.deepEqual(f.calls,[]);
    await assert.rejects(readFile(f.profile.policyFile),{code:'ENOENT'});await assert.rejects(f.profile.selectStandard(),/cannot be downgraded/);
  }
});

test('standard readiness never claims whole-folder encryption and the EFS gate remains strict',async()=>{
  const standard={ready:true,mode:'standard',folderEncrypted:false,restrictedAccess:true};
  assert.equal(await privateGate({mode:'standard',verify:async()=>standard})(),standard);
  for(const value of [{...standard,ready:false},{...standard,restrictedAccess:false},{...standard,mode:'efs'}])await assert.rejects(privateGate({mode:'standard',verify:async()=>value})(),/protection/);
  await assert.rejects(privateGate({verify:async()=>standard})(),/protection/);
  await assert.rejects(privateGate({mode:'unknown',verify:async()=>({encrypted:true,restrictedAccess:true})})(),/protection/);
});

test('native Unix permissions preserve executable runtimes and reject links before changing existing files',{skip:process.platform==='win32'},async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'exomina-unix-profile-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const data=path.join(root,'data');await mkdir(data);const runtime=path.join(data,'runtime'),state=path.join(data,'state.json');await writeFile(runtime,'synthetic executable');await writeFile(state,'synthetic chat');await chmod(data,0o755);await chmod(runtime,0o755);await chmod(state,0o644);
  assert.equal((await prepareUnixProfile(data)).restrictedAccess,true);assert.equal((await lstat(data)).mode&0o777,0o700);assert.equal((await lstat(runtime)).mode&0o777,0o700);assert.equal((await lstat(state)).mode&0o777,0o600);assert.equal(await readFile(state,'utf8'),'synthetic chat');
  await chmod(data,0o755);await chmod(state,0o644);await symlink(state,path.join(data,'linked'));
  await assert.rejects(prepareUnixProfile(data),/symbolic link/);assert.equal((await lstat(data)).mode&0o777,0o755);assert.equal((await lstat(state)).mode&0o777,0o644);
});

test('native Unix Chromium lock links are owner-checked and never followed or changed',{skip:process.platform==='win32'},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'exomina-chromium-lock-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const data=path.join(root,'data'),outside=path.join(root,'outside.txt');await mkdir(data);await writeFile(outside,'synthetic outside file');await chmod(outside,0o644);
 const lock=path.join(data,'SingletonLock');await symlink(outside,lock);
 await assert.rejects(prepareUnixProfile(data),/symbolic link/);
 assert.equal((await prepareUnixProfile(data,{allowedLinks:[lock]})).restrictedAccess,true);
 assert.equal(await readlink(lock),outside);assert.equal((await lstat(outside)).mode&0o777,0o644);assert.equal(await readFile(outside,'utf8'),'synthetic outside file');
});
