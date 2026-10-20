import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {museQuota,museUsage,usageStale,UsageTracker} from '../desktop/usage.mjs';
import {UsagePoller} from '../desktop/usage-poller.mjs';
import {MuseProvider} from '../desktop/provider-muse.mjs';
const now=Date.now(),quota={observedAtMs:now,tier:'opaque-provider-tier',window:{usedPercent:3,windowDurationMins:300,resetsAtMs:now+3600000},weekly:{usedPercent:1,resetsAtMs:now+86400000}};
test('Muse quotas retain native percentage units, epoch-millisecond resets and truthful observation time',()=>{
 const entry=museUsage({usage:quota});assert.equal(entry.provider,'muse-code');assert.deepEqual(entry.windows.map(w=>w.usedPercent),[3,1]);assert.equal(entry.windows[0].label,'5-hour session');assert.equal(entry.windows[0].resetsAt,new Date(quota.window.resetsAtMs).toISOString());assert.equal(entry.updatedAt,new Date(now).toISOString());assert.equal(museUsage({usage:{...quota,tier:'27681631238169137'}}).plan,null);
 const cached=museUsage({usage:quota,fromCache:true});assert.equal(usageStale(cached),true);assert.equal(cached.updatedAt,entry.updatedAt);assert.equal(museUsage({}),null);assert.equal(museQuota({...quota,window:{...quota.window,usedPercent:null}}),null);
 const over=museUsage({usage:{...quota,window:{...quota.window,usedPercent:107}}});assert.equal(over.status,'rejected');assert.equal(over.windows[0].usedPercent,107);
});
test('Muse quota cache strips unrelated fields and older responses cannot replace newer readings',()=>{
 assert.deepEqual(museQuota({...quota,token:'private',email:'private',window:{...quota.window,token:'private'}}),quota);
 const current=museUsage({usage:quota});assert.equal(museUsage({usage:{...quota,observedAtMs:now-1}},current),current);
});
test('Muse polling joins other accounts without issuing inference, and preserves stale figures on failure',async()=>{
 const tracker=new UsageTracker();let calls=0,release;
 const poller=new UsagePoller({connected:id=>id==='muse-code',tracker,providers:{museUsage:options=>{assert.deepEqual(options,{publish:false});calls++;return new Promise(resolve=>release=resolve);}}});
 const first=poller.refresh(),second=poller.refresh();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);release({usage:quota});await Promise.all([first,second]);assert.equal(tracker.snapshot()['muse-code'].windows[0].usedPercent,3);
 poller.providers.museUsage=async()=>{throw Error('Synthetic metadata failure');};await poller.refresh();assert.equal(tracker.snapshot()['muse-code'].windows[0].usedPercent,3);assert.equal(usageStale(tracker.snapshot()['muse-code']),true);poller.stop();
});
test('Muse refresh reads active MSP hosts once, and cached refresh never starts a model or another process',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'exomina-muse-usage-')),profile=path.join(directory,'muse-home'),events=[];await mkdir(profile);await writeFile(path.join(profile,'account-signin.json'),JSON.stringify({method:'official-account',completedAt:'fixture-account-A'}));
 const adapter=new MuseProvider({dataDir:directory,prepare:async()=>{},environment:()=>({}),emit:event=>events.push(event)});let reads=0,release;
 const client={host:{connection:{request:(method,params)=>{assert.equal(method,'usage/read');assert.deepEqual(params,{});reads++;return new Promise(resolve=>release=resolve);}}}};adapter.clients.add(client);
 try{
  const one=adapter.usage({publish:false}),two=adapter.usage({publish:false});for(let wait=0;wait<400&&!reads;wait++)await new Promise(resolve=>setTimeout(resolve,5));await new Promise(resolve=>setTimeout(resolve,30));assert.equal(reads,1);release({usage:{...quota,credential:'private'}});const values=await Promise.all([one,two]);assert.equal(values[0].fromCache,false);adapter.clients.clear();
  const cached=await adapter.usage({publish:false});assert.equal(cached.fromCache,true);assert.equal(reads,1);const saved=JSON.parse(await readFile(path.join(profile,'subscription-usage.json'),'utf8'));assert.equal(saved.usage.credential,undefined);
  await writeFile(path.join(profile,'account-signin.json'),JSON.stringify({method:'official-account',completedAt:'fixture-account-B'}));await assert.rejects(adapter.usage(),/not reported/);
 }finally{adapter.close();assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));await rm(directory,{recursive:true,force:true});}
});
