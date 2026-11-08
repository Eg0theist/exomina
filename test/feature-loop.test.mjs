import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {FeaturePackages} from '../desktop/feature-packages.mjs';
import {ExternalMcpTools} from '../desktop/external-mcp.mjs';
import {hostAction} from '../desktop/permissions.mjs';
import {StdioMcpClient} from '../desktop/external-mcp.mjs';
import {EventEmitter} from 'node:events';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function fixture(){
  const root=await mkdtemp(path.join(tmpdir(),'exomina-feature-loop-'));let servers=[],manager;
  const events=[],approvals=[];
  const external=new ExternalMcpTools({approve:async()=>true,getSettings:()=>({externalMcpServers:servers}),launchApproved:config=>manager.verify(config),prepareCall:config=>manager.verify(config)});
  manager=await new FeaturePackages({root,approve:async request=>{approvals.push(request);return true;},getServers:()=>servers,saveServers:async value=>{servers=value;},external,changed:event=>events.push(event)}).init();
  return {root,manager,external,events,approvals,async close(){await external.close();await rm(root,{recursive:true,force:true});}};
}
function files(version='1.0.0',{worker=false,broken=false,moreSettings=false}={}){
  const manifest={id:'release-checklist',name:'Release checklist',description:'Keep release checks visible while working.',version,apiVersion:1,dataVersion:1,panel:'panel.html',settings:[{key:'tests',label:'Tests reviewed',type:'boolean'},...(moreSettings?[{key:'notes',label:'Release notes reviewed',type:'boolean'}]:[])],...(worker?{worker:'worker.mjs',trust:'trusted-node'}:{})};
  return [{name:'exomina-feature.json',text:JSON.stringify(manifest)},{name:'panel.html',text:`<h2>Release checklist ${version}</h2><p>Review before sharing.</p><script>parent.PREVIEW_EXECUTED=true</script><input value="not-live"><img src="https://must-not-request.invalid">`},...(worker?[{name:'worker.mjs',text:broken?'process.exit(7);':`import {createInterface} from 'node:readline';
import {writeFileSync,readFileSync} from 'node:fs';
import path from 'node:path';
createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);if(!request.id)return;let result={};
 if(request.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}}};
 if(request.method==='tools/list')result={tools:[{name:'mark',description:'Synthetic delayed write',inputSchema:{type:'object'}}]};
 if(request.method==='tools/call'){
  const folder=process.env.EXOMINA_FEATURE_DATA;
  if(request.params.arguments.delay){writeFileSync(path.join(folder,'started.txt'),'started');setTimeout(()=>{writeFileSync(path.join(folder,'late.txt'),'must not exist');console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:'late'}]}}));},900);return;}
  let count=0;try{count=Number(readFileSync(path.join(folder,'counter.txt'),'utf8'));}catch{}writeFileSync(path.join(folder,'counter.txt'),String(++count));result={content:[{type:'text',text:'${version}:'+count}]};
 }
 console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
});`}]:[])];
}
const text=result=>JSON.parse(result.content[0].text);

test('chat prepare shows an inert, owner-bound preview; declining does not write, enable or lose it',async()=>{
  const f=await fixture();try{
    const input=files(),preview=text(await f.manager.call({action:'prepare',files:input},'one'));
    input[1].text='Changed after prepare';
    assert.equal(preview.status,'ready');assert.equal(f.external.clients.size,0);assert.deepEqual(await readdir(f.root),[]);
    assert.equal(f.manager.previewsFor('two').length,0);assert.equal(f.manager.previewsFor(undefined).length,0);
    assert.doesNotMatch(f.manager.previewsFor('one')[0].panel,/PREVIEW_EXECUTED|must-not-request|<input/);
    assert.equal(f.events.at(-1).type,'feature.preview');assert.equal(f.events.at(-1).conversationId,'one');
    await assert.rejects(f.manager.source({previewId:preview.previewId},'two'),/belongs/);
    await assert.rejects(f.manager.activate(preview.previewId,'two'),/belongs/);
    f.manager.approve=async()=>false;await assert.rejects(f.manager.activate(preview.previewId,'one'),/declined/);
    assert.deepEqual(await readdir(f.root),[]);assert.equal(f.manager.previewsFor('one').length,1);
    f.manager.approve=async()=>true;await f.manager.activate(preview.previewId,'one');
    assert.match((await f.manager.view())[0].panel,/Release checklist 1.0.0/);assert.equal(f.manager.previewsFor('one').length,0);
  }finally{await f.close();}
});

test('complete worker+panel loop preserves settings and worker data through update, rollback and failed update',async()=>{
  const f=await fixture();try{
    const preview=f.manager.prepare(files('1.0.0',{worker:true}),'chat');await f.manager.activate(preview.previewId,'chat');
    const alias=f.external.definitions[0].name,pid=f.external.clients.get('pkg_release-checklist').client.child.pid;
    assert.equal((await f.external.call(alias,{},'chat')).content[0].text,'1.0.0:1');await f.manager.settings('release-checklist',{tests:true});
    const source=text(await f.manager.call({action:'source',id:'release-checklist'},'chat'));
    assert.deepEqual(source.files.map(file=>file.name),['exomina-feature.json','panel.html','worker.mjs']);
    await f.manager.activate(f.manager.prepare(files('1.1.0',{worker:true,moreSettings:true}),'chat').previewId,'chat');
    assert.notEqual(f.external.clients.get('pkg_release-checklist').client.child.pid,pid);
    assert.equal((await f.external.call(alias,{},'chat')).content[0].text,'1.1.0:2');await f.manager.settings('release-checklist',{notes:true});
    await f.manager.change('release-checklist','rollback','chat');assert.equal((await f.external.call(alias,{},'chat')).content[0].text,'1.0.0:3');
    await f.manager.settings('release-checklist',{tests:false});await f.manager.change('release-checklist','rollback','chat');
    assert.deepEqual((await f.manager.view())[0].values,{tests:false,notes:true});
    await assert.rejects(f.manager.activate(f.manager.prepare(files('1.2.0',{worker:true,broken:true}),'chat').previewId,'chat'),/previous generation was restored/);
    assert.equal((await f.external.call(alias,{},'chat')).content[0].text,'1.1.0:4');
  }finally{await f.close();}
});

test('disable kills an admitted delayed write even while another activation is waiting for approval',async()=>{
  const f=await fixture();try{
    await f.manager.activate(f.manager.prepare(files('1.0.0',{worker:true}),'one').previewId,'one');
    const alias=f.external.definitions[0].name,client=f.external.clients.get('pkg_release-checklist').client,pid=client.child.pid;
    const data=path.join(f.root,'release-checklist','data');
    const call=f.external.call(alias,{delay:true},'one');
    const deadline=Date.now()+3000;while(Date.now()<deadline){try{await readFile(path.join(data,'started.txt'));break;}catch{await delay(10);}}
    assert.equal(await readFile(path.join(data,'started.txt'),'utf8'),'started');
    const opened=deferred(),grant=deferred();f.manager.approve=async()=>{opened.resolve();return grant.promise;};
    const activation=f.manager.activate(f.manager.prepare(files('1.1.0',{worker:true}),'one').previewId,'one'),rejected=assert.rejects(activation,/turned off/);await opened.promise;
    const stopped=f.manager.change('release-checklist','disable','one');
    assert.equal((await call).isError,true);assert.equal(client.dead,true);
    grant.resolve(true);await rejected;await stopped;
    assert.equal((await f.manager.view())[0].enabled,false);assert.equal(f.external.clients.size,0);
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
    await delay(1000);await assert.rejects(readFile(path.join(data,'late.txt')),{code:'ENOENT'});
  }finally{await f.close();}
});

test('queued calls cannot move into a re-enabled or replaced worker generation',async()=>{
  const f=await fixture();try{
    await f.manager.activate(f.manager.prepare(files('1.0.0',{worker:true}),'one').previewId,'one');
    const alias=f.external.definitions[0].name,held=deferred(),opened=deferred();f.external.approve=async()=>{opened.resolve();return held.promise;};
    const first=f.external.call(alias,{},'one');await opened.promise;const queued=f.external.call(alias,{},'one');
    await f.manager.change('release-checklist','disable','one');const enabling=f.manager.change('release-checklist','enable','one');held.resolve(true);
    assert.equal((await first).isError,true);assert.equal((await queued).isError,true);await enabling;
    f.external.approve=async()=>true;assert.equal((await f.external.call(alias,{},'one')).content[0].text,'1.0.0:1');
  }finally{await f.close();}
});

test('prepare rejects path collisions and stale or expired reviews cannot overwrite newer code',async()=>{
  const f=await fixture();try{
    for(const name of ['../escape','C:/escape','x\\escape','.hidden','nul.txt','node_modules/x','a/../x'])assert.throws(()=>f.manager.prepare([...files(),{name,text:'x'}],'one'));
    assert.throws(()=>f.manager.prepare([...files(),{name:'PANEL.HTML',text:'x'}],'one'),/unique/);
    assert.throws(()=>f.manager.prepare([...files(),{name:'panel.html/child',text:'x'}],'one'),/overlap/);
    const stale=f.manager.prepare(files(),'one'),current=f.manager.prepare(files('1.1.0'),'two');await f.manager.activate(current.previewId,'two');
    assert.equal(f.manager.previewsFor('one')[0].stale,true);await assert.rejects(f.manager.activate(stale.previewId,'one'),/changed since/);
    const expiring=f.manager.prepare(files('1.2.0'),'one');f.manager.previews.get(expiring.previewId).expires=Date.now()-1;
    await assert.rejects(f.manager.activate(expiring.previewId,'one'),/expired/);assert.equal(f.manager.previewsFor('one').length,0);
    const discarded=f.manager.prepare(files('1.2.0'),'one');f.manager.discard(discarded.previewId,'one');await assert.rejects(f.manager.activate(discarded.previewId,'one'),/expired/);
  }finally{await f.close();}
});

test('revoked permission or stopped originating turn after approval prevents activation',async()=>{
  const f=await fixture();try{
    let live=true;f.manager.check=()=>{if(!live)throw Error('Originating turn stopped');};
    const preview=f.manager.prepare(files(),'one');f.manager.approve=async()=>{live=false;return true;};
    await assert.rejects(f.manager.activate(preview.previewId,'one'),/turn stopped/);assert.deepEqual(await readdir(f.root),[]);
    for(const action of ['prepare','source','discard'])assert.equal(hostAction('feature_package',{action}).kind,'read');
    for(const action of ['activate','enable','rollback','remove'])assert.equal(hostAction('feature_package',{action}).kind,'execute');
  }finally{await f.close();}
});

test('an unconfirmed feature stop retains a retry handle, and signal exit needs no pipe-close event',async()=>{
  const client=new StdioMcpClient({id:'fixture',command:process.execPath,featurePackage:'fixture'}),child=new EventEmitter();
  Object.assign(child,{exitCode:null,signalCode:null,kill:()=>false});client.child=child;
  await assert.rejects(client.close(),/did not confirm exit/);assert.equal(client.child,child);
  child.kill=()=>{child.signalCode='SIGTERM';child.emit('exit',null,'SIGTERM');return true;};
  await client.close();assert.equal(client.child,null);await client.close();
  const f=await fixture();try{
    let closes=0;const failing={close:async()=>{if(++closes===1)throw Error('Unconfirmed stop');}};
    f.external.clients.set('fixture',{client:failing});await assert.rejects(f.external.disconnect('fixture'),/Unconfirmed/);
    assert.equal(f.external.stopping.get('fixture').has(failing),true);await f.external.disconnect('fixture');assert.equal(closes,2);assert.equal(f.external.stopping.size,0);
  }finally{await f.close();}
});

test('revocation persists Off while a different activation approval is still waiting, even when stop fails',async()=>{
  const f=await fixture();try{
    await f.manager.activate(f.manager.prepare(files(),'one').previewId,'one');
    const opened=deferred(),grant=deferred();f.manager.approve=async()=>{opened.resolve();return grant.promise;};
    const pending=f.manager.activate(f.manager.prepare(files('1.1.0'),'one').previewId,'one'),cancelled=assert.rejects(pending,/turned off/);await opened.promise;
    const disconnect=f.external.disconnect.bind(f.external);f.external.disconnect=async()=>{throw Error('Unconfirmed fixture stop');};
    const stopping=f.manager.change('release-checklist','disable','one'),failed=assert.rejects(stopping,/Unconfirmed fixture stop/);
    await f.manager.persistence;
    assert.equal(JSON.parse(await readFile(path.join(f.root,'registry.json'),'utf8'))['release-checklist'].enabled,false);
    grant.resolve(true);await cancelled;await failed;f.external.disconnect=disconnect;
  }finally{await f.close();}
});

test('corrupt registries cannot be overwritten and invalid registrations survive later saves for recovery',async()=>{
  const f=await fixture();try{
    await writeFile(path.join(f.root,'registry.json'),'{broken','utf8');
    const replacement=await new FeaturePackages({root:f.root,approve:async()=>true,getServers:()=>[],saveServers:async()=>{},external:f.external}).init();
    await assert.rejects(replacement.activate(replacement.prepare(files(),'one').previewId,'one'),/registry could not be read/);
    assert.equal(await readFile(path.join(f.root,'registry.json'),'utf8'),'{broken');
    await writeFile(path.join(f.root,'registry.json'),JSON.stringify({broken:{recovery:'Keep this registration'}}),'utf8');
    const recovery=await new FeaturePackages({root:f.root,approve:async()=>true,getServers:()=>[],saveServers:async()=>{},external:f.external}).init();
    await recovery.activate(recovery.prepare(files(),'one').previewId,'one');
    assert.equal(JSON.parse(await readFile(path.join(f.root,'registry.json'),'utf8')).broken.recovery,'Keep this registration');
  }finally{await f.close();}
});

test('revision source obeys the same encoded-size limit as prepare',async()=>{
  const f=await fixture();try{
    const input=files(),preview=f.manager.prepare(input,'one');await f.manager.activate(preview.previewId,'one');
    const source=await f.manager.source({id:'release-checklist'},'one');assert.ok(f.manager.prepare(source.files,'one').previewId);
    const record=f.manager.records['release-checklist'],folder=f.manager.directory('release-checklist',record.generation);
    await writeFile(path.join(folder,'quoted.txt'),'"'.repeat(300_000),'utf8');const snapshot=await f.manager.snapshot(folder,{managed:true});record.digest=snapshot.digest;
    await assert.rejects(f.manager.source({id:'release-checklist'},'one'),/original project files.*encoded text/);
  }finally{await f.close();}
});
