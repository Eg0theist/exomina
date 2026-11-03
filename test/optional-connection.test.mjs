import test from 'node:test';
import assert from 'node:assert/strict';
import {enableOptionalConnection} from '../desktop/optional-connection.mjs';
test('failed optional first installation restores consent without discarding other connection choices',async()=>{
 const settings={optInProviders:{other:true}},saved=[];
 await assert.rejects(enableOptionalConnection({id:'claude',settings,save:async()=>saved.push(structuredClone(settings)),available:async()=>false,install:async()=>{throw Error('Download failed');}}),/Download failed/);
 assert.deepEqual(settings.optInProviders,{other:true});assert.deepEqual(saved.at(-1).optInProviders,{other:true});
});
test('existing opt-in and a deliberate disable during installation retain their choices',async()=>{
 for(const enabled of [false,true]){
  const settings={optInProviders:{claude:enabled}};
  await assert.rejects(enableOptionalConnection({id:'claude',settings,save:async()=>{},available:async()=>false,install:async()=>{if(!enabled)settings.optInProviders.claude=false;throw Error('Stopped');}}),/Stopped/);
  assert.equal(settings.optInProviders.claude,enabled);
 }
});
test('successful setup persists opt-in once and uses an existing verified runtime',async()=>{
 const settings={},saved=[];
 await enableOptionalConnection({id:'claude',settings,save:async()=>saved.push(structuredClone(settings)),available:async()=>'/verified/claude',install:async()=>assert.fail('must not download')});
 assert.equal(settings.optInProviders.claude,true);assert.equal(saved.length,1);
});
