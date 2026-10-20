import test from 'node:test';
import assert from 'node:assert/strict';
import {createCoalescedRefresh} from '../src/coalesced-refresh.js';
test('a burst of state changes has one in-flight read and one fresh trailing read',async()=>{
 let source=1,applied=[],calls=0,active=0,maxActive=0,release;
 const refresh=createCoalescedRefresh(async()=>{calls++;maxActive=Math.max(maxActive,++active);const snapshot=source;if(calls===1)await new Promise(resolve=>release=resolve);applied.push(snapshot);active--;});
 const first=refresh();for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,2));source=2;const waiters=Array.from({length:40},()=>refresh());assert.equal(calls,1);release();await Promise.all([first,...waiters]);
 assert.equal(calls,2);assert.equal(maxActive,1);assert.deepEqual(applied,[1,2]);
});

test('synchronous notification bursts start one fresh read after the burst',async()=>{
 let source=0,calls=0,seen;const refresh=createCoalescedRefresh(async()=>{calls++;seen=source;});
 const waits=[];for(let i=0;i<40;i++){source++;waits.push(refresh());}await Promise.all(waits);
 assert.equal(calls,1);assert.equal(seen,40);
});
test('a failed read does not prevent the next refresh',async()=>{
 let calls=0;const refresh=createCoalescedRefresh(async()=>{if(++calls===1)throw Error('Offline');});await assert.rejects(refresh(),/Offline/);await refresh();assert.equal(calls,2);
});
