import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fetchRuntimeBytes} from '../scripts/runtime-download.mjs';
import {prepareElectron} from '../scripts/prepare-electron.mjs';
const url='https://example.test/pinned/runtime.zip',quiet={wait:async()=>{},log:()=>{}};

test('transient HTTP reads retry at most three times and release failed bodies',async()=>{
 let calls=0,cancelled=0;const messages=[],delays=[];
 const result=await fetchRuntimeBytes(url,{fetchImpl:async()=>{calls++;return calls<3?{ok:false,status:calls===1?503:429,body:{cancel:async()=>{cancelled++;}}}:new Response('verified bytes');},wait:async ms=>delays.push(ms),log:message=>messages.push(message)});
 assert.equal(result.toString(),'verified bytes');assert.equal(calls,3);assert.equal(cancelled,2);assert.deepEqual(delays,[500,1500]);assert.ok(messages.every(message=>message.includes('/3')&&message.includes('runtime.zip')));
});
test('terminal transient error retains exact final cause, context and attempt count',async()=>{
 let calls=0;await assert.rejects(fetchRuntimeBytes(url,{...quiet,fetchImpl:async()=>{calls++;return new Response('',{status:503});}}),error=>error.attempts===3&&error.status===503&&error.cause.message==='HTTP 503'&&error.asset===url);assert.equal(calls,3);
});
test('fetch and partial-body transport failures discard partial bytes before retry',async()=>{
 for(const phase of ['fetch','body']){let calls=0;const failure=Object.assign(Error('other side closed'),{code:'UND_ERR_SOCKET'});
  const result=await fetchRuntimeBytes(url,{...quiet,fetchImpl:async()=>{if(++calls===1){if(phase==='fetch')throw TypeError('fetch failed',{cause:failure});return {ok:true,body:(async function*(){yield Buffer.from('partial wrong bytes');throw failure;})()};}return new Response('complete');}});
  assert.equal(result.toString(),'complete');assert.equal(calls,2);
 }
});
test('transport exhaustion stops after three requests and retains the final socket error',async()=>{
 let calls=0;const failure=Object.assign(Error('other side closed'),{code:'UND_ERR_SOCKET'});
 await assert.rejects(fetchRuntimeBytes(url,{...quiet,fetchImpl:async()=>{calls++;throw TypeError('fetch failed',{cause:failure});}}),error=>error.attempts===3&&error.code==='UND_ERR_SOCKET'&&error.cause.cause===failure);assert.equal(calls,3);
});
test('auth, missing artifacts, invalid input and oversized bytes are never retried',async()=>{
 for(const status of [400,401,403,404]){let calls=0;await assert.rejects(fetchRuntimeBytes(url,{...quiet,fetchImpl:async()=>{calls++;return new Response('',{status});}}),error=>error.attempts===1&&error.status===status);assert.equal(calls,1);}
 let calls=0;await assert.rejects(fetchRuntimeBytes(url,{...quiet,maximumBytes:4,fetchImpl:async()=>{calls++;return new Response('12345');}}),/exceeds the download limit/);assert.equal(calls,1);
 await assert.rejects(fetchRuntimeBytes('https://owner:secret@example.test/file',{...quiet,fetchImpl:()=>{throw Error('must not fetch');}}),/without credentials/);
});
test('programmer errors are not disguised as transient transport',async()=>{
 let calls=0;await assert.rejects(fetchRuntimeBytes(url,{...quiet,fetchImpl:async()=>{calls++;throw TypeError('invalid local downloader argument');}}),error=>error.attempts===1);assert.equal(calls,1);
});

async function fixture(t){const project=await mkdtemp(path.join(os.tmpdir(),'electron-acquisition-'));await mkdir(path.join(project,'node_modules/electron'),{recursive:true});await writeFile(path.join(project,'package.json'),JSON.stringify({devDependencies:{electron:'44.10.1'}}),'utf8');await writeFile(path.join(project,'node_modules/electron/package.json'),JSON.stringify({version:'44.10.1'}),'utf8');await writeFile(path.join(project,'node_modules/electron/checksums.json'),JSON.stringify({'electron-v44.10.1-linux-arm64.zip':'a'.repeat(64)}),'utf8');t.after(()=>rm(project,{recursive:true,force:true}));return project;}
test('Electron acquisition retains pinned validator then invokes installer once with the same cache',async t=>{
 const project=await fixture(t);let calls=0,installs=0,request;
 const result=await prepareElectron({project,env:{ELECTRON_INSTALL_PLATFORM:'linux',ELECTRON_INSTALL_ARCH:'arm64'},...quiet,fetchImpl:async()=>{calls++;return calls===1?new Response('',{status:503}):new Response('archive bytes');},downloadArtifactImpl:async options=>{request=options;assert.equal(options.version,'44.10.1');assert.equal(options.unsafelyDisableChecksums,undefined);assert.equal(options.checksums['electron-v44.10.1-linux-arm64.zip'],'a'.repeat(64));const target=path.join(project,'archive.zip');await options.downloader.download(url,target);assert.equal(await readFile(target,'utf8'),'archive bytes');return target;},installImpl:async({env,script})=>{installs++;assert.equal(env.electron_config_cache,request.cacheRoot);assert.equal(env.ELECTRON_INSTALL_ARCH,'arm64');assert.equal(env.electron_use_remote_checksums,'');assert.ok(script.endsWith('install.js'));}});
 assert.equal(installs,1);assert.equal(calls,2);assert.equal(result.installerInvocations,1);
});
test('Electron checksum failure never retries the validator or invokes installation',async t=>{
 const project=await fixture(t);let downloads=0,fetches=0,installs=0;
 await assert.rejects(prepareElectron({project,...quiet,fetchImpl:async()=>{fetches++;return new Response('wrong archive');},downloadArtifactImpl:async options=>{downloads++;await options.downloader.download(url,path.join(project,'archive.zip'));throw Error('checksum mismatch');},installImpl:async()=>{installs++;}}),/checksum mismatch/);
 assert.equal(downloads,1);assert.equal(fetches,1);assert.equal(installs,0);
});
test('Electron extraction failure is never replayed after effects',async t=>{
 const project=await fixture(t);let installs=0;
 await assert.rejects(prepareElectron({project,...quiet,downloadArtifactImpl:async()=>'/verified/cache.zip',installImpl:async()=>{installs++;throw Error('extraction failed');}}),/extraction failed/);assert.equal(installs,1);
});
test('Electron skip-download control refuses before any fetch or install',async()=>{
 let downloads=0,fetches=0,installs=0;
 await assert.rejects(prepareElectron({project:'SYNTHETIC_NOT_OPENED',env:{ELECTRON_SKIP_BINARY_DOWNLOAD:'1'},downloadArtifactImpl:async()=>{downloads++;},fetchImpl:async()=>{fetches++;},installImpl:async()=>{installs++;}}),/ELECTRON_SKIP_BINARY_DOWNLOAD is set/);
 assert.deepEqual([downloads,fetches,installs],[0,0,0]);
});
