import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ToolUpdates,driverRelease,newerVersion} from '../desktop/tool-updates.mjs';
import {driverLaunchSignature} from '../desktop/computer-connection.mjs';
import {CUA_SIGNING_AUTHORITY_KEY,inspectDriverPackage} from '../desktop/tool-update-trust.mjs';
const trusted={status:'Valid',subject:'CN="Cua AI, Inc.", O="Cua AI, Inc.", L=San Francisco, S=California, C=US',authorityKeySha256:CUA_SIGNING_AUTHORITY_KEY,codeSigning:true};
const bytes=Buffer.from('synthetic signed archive'),sha=createHash('sha256').update(bytes).digest('hex');
function release(version='0.36.0',extra={}){return{tag_name:'cua-driver-rs-v'+version,draft:false,prerelease:true,assets:[{name:`cua-driver-rs-${version}-windows-x86_64-binary.zip`,browser_download_url:`https://github.com/trycua/cua/releases/download/cua-driver-rs-v${version}/cua-driver-rs-${version}-windows-x86_64-binary.zip`,size:bytes.length,digest:'sha256:'+sha}],...extra};}
test('upstream stable tags qualify even when GitHub labels them prerelease; nightlies and unsigned downloads do not',()=>{
 assert.equal(driverRelease([release('0.33.4'),release(),release('99.0.0-rc.1'),release('100.0.0',{draft:true})]).version,'0.36.0');
 const unsafe=release();unsafe.assets[0].browser_download_url='https://attacker.invalid/file.zip';assert.throws(()=>driverRelease([unsafe]),/verifiable/);
 const unsigned=release();delete unsigned.assets[0].digest;assert.throws(()=>driverRelease([unsigned]),/verifiable/);
 for(const [a,b,result]of [['0.36.0','0.33.4',true],['0.9.0','0.10.0',false],['1.0.0-rc.1','0.3.0',false],['1.0.0','1.0.0',false]])assert.equal(newerVersion(a,b),result);
});
async function fixture(t,options={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'exomina-tool-update-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const runtime=path.join(root,'runtime');await mkdir(path.join(runtime,'vendor/cua-driver'),{recursive:true});await mkdir(path.join(runtime,'desktop'));await writeFile(path.join(runtime,'package.json'),JSON.stringify({dependencies:{'@openai/codex':'0.160.1'}}));await writeFile(path.join(runtime,'vendor/cua-driver/provenance.json'),JSON.stringify({version:'0.33.4'}));
 const command=path.join(runtime,'vendor/cua-driver/cua-driver.exe');await writeFile(command,'synthetic previous driver');
 const config={id:'cua',command,args:['mcp'],enabled:true},settings={externalMcpServers:[config],cuaDriverPath:command,cuaDriverBundled:true,cuaDriverApproval:{signature:driverLaunchSignature(config),bundled:true},toolUpdates:{automatic:true,checkAutomatically:true}};
 const calls=[],external={status:[{id:'cua',connected:true}],async disconnect(id){calls.push(['disconnect',id]);this.status=[];},async refresh(_id,args){calls.push(['refresh',args]);this.status=[{id:'cua',connected:!options.failConnect||settings.cuaDriverPath===command}];}},requests=[];
 const fetcher=async url=>{requests.push(url);await options.onFetch?.({url,settings});return new Response(url.includes('/releases?')?JSON.stringify([release()]):url.includes('registry.npmjs.org')?JSON.stringify({version:'0.161.0'}):options.corrupt?Buffer.from('corrupt'):bytes);};
 let idle=true,signer='CN=trusted-publisher',probeCount=0,failSave=!!options.failSave;
 const service=await new ToolUpdates({root:path.join(root,'managed'),runtimeRoot:runtime,getSettings:()=>settings,saveSettings:async patch=>{Object.assign(settings,patch);if(failSave&&patch.managedCua){failSave=false;throw Error('synthetic durable write failure');}},external,idle:()=>idle,fetcher,platform:'win32',arch:'x64',verifySignature:async file=>{await options.onSignature?.({file,settings});return file===command||signer==='CN=trusted-publisher'?trusted:{...trusted,authorityKeySha256:'unapproved'};},run:async(_command,args)=>{const dir=args[args.indexOf('-Destination')+1];await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'cua-driver.exe'),'synthetic verified driver');if(options.sidecar)await writeFile(path.join(dir,options.sidecar),'synthetic sidecar');},probe:async()=>{probeCount++;await options.onProbe?.({setIdle:value=>idle=value,settings});return {version:'0.36.0',toolCount:60};}}).init();t.after(()=>service.close());
 return {root,service,settings,calls,requests,command,setIdle:value=>idle=value,setSigner:value=>signer=value,probes:()=>probeCount};
}
test('verified driver update reconnects only its process and retains a usable previous version',async t=>{
 const f=await fixture(t);await f.service.check();assert.equal(f.service.view().tools[0].available,true);assert.equal(f.service.view().tools[1].live,false);await f.service.install();assert.equal(f.settings.managedCua.version,'0.36.0');assert.equal(f.settings.managedCua.previous.config.command,f.command);assert.equal(await readFile(f.command,'utf8'),'synthetic previous driver');assert.equal(f.probes(),1);assert.deepEqual(f.calls[0],['disconnect','cua']);assert.equal(f.settings.cuaDriverApproval.signature,driverLaunchSignature(f.settings.externalMcpServers[0]));await f.service.rollback();assert.equal(f.settings.cuaDriverPath,f.command);assert.equal(f.service.view().tools[0].installed,'0.33.4');
});
test('connection update checks distinguish upstream releases from separately installable updates',async t=>{
 const f=await fixture(t);await f.service.check();const tool=f.service.view().tools.find(tool=>tool.id==='codex');
 assert.equal(tool.installed,'0.160.1');assert.equal(tool.latest,'0.161.0');assert.equal(tool.available,true);assert.equal(tool.live,false);assert.equal(tool.updateMethod,'app-release');assert.match(tool.reason,/cannot be installed separately/);assert.equal(f.calls.length,0);
});

test('busy work prevents installation before any download',async t=>{const f=await fixture(t);await f.service.check();const requests=f.requests.length;f.setIdle(false);await assert.rejects(f.service.install(),/idle/);assert.equal(f.requests.length,requests);assert.equal(f.settings.cuaDriverPath,f.command);});
test('packaged runtime can read the manifest from its separate application archive path',async t=>{const f=await fixture(t),service=await new ToolUpdates({root:path.join(f.root,'separate-managed'),runtimeRoot:path.join(f.root,'unpacked'),packagePath:path.join(f.root,'runtime/package.json'),getSettings:()=>f.settings,saveSettings:async()=>{},external:f.service.external,idle:()=>true}).init();t.after(()=>service.close());assert.equal(service.package.dependencies['@openai/codex'],'0.160.1');});
test('turning automatic installation off during a check prevents subsequent staging',async t=>{const f=await fixture(t,{onFetch:({settings})=>{settings.toolUpdates={...settings.toolUpdates,automatic:false};}});await f.service.tick();assert.equal(f.probes(),0);assert.equal(f.calls.length,0);assert(f.requests.every(url=>!url.endsWith('.zip')));});
for(const kind of ['checksum','publisher','connection','durable-save'])test(`${kind} failure keeps or restores the previous driver without repeated automatic attempts`,async t=>{
 const f=await fixture(t,{corrupt:kind==='checksum',failConnect:kind==='connection',failSave:kind==='durable-save',onProbe:kind==='new-work'?({setIdle})=>setIdle(false):undefined});await f.service.check();if(kind==='publisher')f.setSigner('CN=unexpected-publisher');await assert.rejects(f.service.install());assert.equal(f.settings.cuaDriverPath,f.command);assert.equal(f.service.view().failedVersion,'0.36.0');const count=f.requests.length;f.setIdle(true);await f.service.tick();assert.equal(f.requests.length,count,'failed version must not retry every minute');
});

for(const change of ['new-work','revoke','custom'])test(`${change} during staging prevents activation and preserves the user change`,async t=>{
 const f=await fixture(t,{onProbe:({settings,setIdle})=>{if(change==='new-work')setIdle(false);if(change==='revoke')delete settings.cuaDriverApproval;if(change==='custom'){settings.externalMcpServers[0].command=path.join(f.root,'custom.exe');settings.cuaDriverBundled=false;}}});await f.service.check();await assert.rejects(f.service.install(),/settings changed/);assert.equal(f.service.view().failedVersion,undefined);assert.equal(f.calls.length,0);assert.equal(f.settings.managedCua,undefined);if(change==='revoke')assert.equal(f.settings.cuaDriverApproval,undefined);if(change==='custom')assert.match(f.settings.externalMcpServers[0].command,/custom\.exe$/);
});
test('unrelated connection changes survive staging and rollback',async t=>{
 const other={id:'other',command:'unrelated.exe',enabled:false,args:[]},f=await fixture(t,{onProbe:({settings})=>settings.externalMcpServers.push(other)});await f.service.check();await f.service.install();assert.deepEqual(f.settings.externalMcpServers[1],other);await f.service.rollback();assert.deepEqual(f.settings.externalMcpServers[1],other);
});
test('unknown sidecar code is refused before starting the downloaded process',async t=>{const f=await fixture(t,{sidecar:'version.dll'});await f.service.check();await assert.rejects(f.service.install(),/Unexpected file/);assert.equal(f.probes(),0);assert.equal(f.settings.cuaDriverPath,f.command);});
test('every allowed library needs the pinned publisher key',async t=>{
 const f=await fixture(t),dir=path.join(f.root,'program');await mkdir(dir);await writeFile(path.join(dir,'cua-driver.exe'),'exe');await writeFile(path.join(dir,'cua_driver_sdk.dll'),'dll');await assert.rejects(inspectDriverPackage(dir,async file=>file.endsWith('.dll')?{...trusted,authorityKeySha256:'other'}:trusted),/publisher key/);
});
test('rollback holds its busy lock before signature verification yields',async t=>{
 let block=false,entered,release;const ready=new Promise(resolve=>entered=resolve),f=await fixture(t,{onSignature:async()=>{if(block){entered();await new Promise(resolve=>release=resolve);}}});await f.service.check();await f.service.install();block=true;const restoring=f.service.rollback();await ready;await assert.rejects(f.service.check(),/already in progress/);await assert.rejects(f.service.install(),/already in progress/);release();await restoring;
});
