import test from 'node:test';
import assert from 'node:assert/strict';
import {createUpdateStatusRefresh} from '../src/update-status-refresh.js';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(read){const timers=new Map(),values=[],errors=[];let index=0,visible=true;const refresh=createUpdateStatusRefresh({read,apply:value=>values.push(value),onError:error=>errors.push(error.message),visible:()=>visible,schedule:fn=>{timers.set(++index,fn);return index;},cancel:id=>timers.delete(id)});return {refresh,values,errors,timers,hide:()=>{visible=false;},show:()=>{visible=true;},flush:async()=>{for(const [id,fn] of [...timers]){timers.delete(id);fn();}await turn();}};}
test('40 state notifications require one host read instead of 40',async()=>{
  let calls=0;const f=fixture(async()=>++calls);for(let i=0;i<40;i++)f.refresh.request();
  assert.equal(calls,0);assert.equal(f.timers.size,1);await f.flush();assert.equal(calls,1);assert.deepEqual(f.values,[1]);
});
test('changes during a slow read retain one trailing latest read without overlap',async()=>{
  let calls=0,active=0,maxActive=0,source=1,release;const f=fixture(async()=>{calls++;maxActive=Math.max(maxActive,++active);const value=source;if(calls===1)await new Promise(resolve=>release=resolve);active--;return value;});
  const first=f.refresh.request({immediate:true});await turn();source=2;for(let i=0;i<40;i++)f.refresh.request();release();await first;
  assert.equal(calls,2);assert.equal(maxActive,1);assert.deepEqual(f.values,[1,2]);
});
test('an invalidation between applying a value and settling the read is not lost',async()=>{
  let calls=0;const values=[];const refresh=createUpdateStatusRefresh({read:async()=>++calls,apply:value=>{values.push(value);if(value===1)queueMicrotask(()=>refresh.request());}});
  await refresh.request({immediate:true});assert.equal(calls,2);assert.deepEqual(values,[1,2]);
});
test('hidden status work is deferred and visibility or focus refreshes immediately',async()=>{
  let calls=0;const f=fixture(async()=>++calls);f.hide();for(let i=0;i<40;i++)f.refresh.request();await f.flush();assert.equal(calls,0);
  f.show();await f.refresh.request({immediate:true});assert.equal(calls,1);assert.equal(f.timers.size,0);
  f.refresh.request();await f.refresh.request({immediate:true});assert.equal(calls,2);assert.equal(f.timers.size,0);
});
test('hiding during a read preserves the trailing invalidation until visible',async()=>{
  let calls=0,release;const f=fixture(async()=>{if(++calls===1)await new Promise(resolve=>release=resolve);return calls;});
  const first=f.refresh.request({immediate:true});await turn();f.refresh.request();f.hide();release();await first;assert.equal(calls,1);
  f.show();await f.refresh.request({immediate:true});assert.equal(calls,2);
});
test('explicit failures are reported, background errors are quiet and later reads recover',async()=>{
  let calls=0;const f=fixture(async()=>{if(++calls<3)throw Error('Offline');return 'fresh';});
  await f.refresh.request({immediate:true});assert.deepEqual(f.errors,[]);await f.refresh.request({immediate:true,reportError:true});assert.deepEqual(f.errors,['Offline']);
  await f.refresh.request({immediate:true});assert.deepEqual(f.values,['fresh']);
});
test('unmount cancels queued reads and discards late completion without updating UI',async()=>{
  let calls=0,release;const f=fixture(async()=>{calls++;await new Promise(resolve=>release=resolve);return 'late';});
  const first=f.refresh.request({immediate:true});await turn();f.refresh.request();f.refresh.dispose();release();await first;assert.deepEqual(f.values,[]);assert.equal(calls,1);
  const g=fixture(async()=>++calls);g.refresh.request();g.refresh.dispose();await g.flush();assert.equal(g.timers.size,0);assert.equal(calls,1);
});
