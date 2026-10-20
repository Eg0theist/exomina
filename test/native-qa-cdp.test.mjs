import test from 'node:test';
import assert from 'node:assert/strict';
import {ownedBrowserEndpoint,classifyQaTargets,probeOwnedBrowser} from '../scripts/native-qa-cdp.mjs';

test('native diagnostic endpoint cannot access a remote or credential-bearing browser',()=>{
 for(const endpoint of ['ws://example.com:123/devtools/browser/test','ws://localhost:123/devtools/browser/test','ws://user@127.0.0.1:123/devtools/browser/test','ws://127.0.0.1:123/devtools/page/test','ws://127.0.0.1:123/devtools/browser/test?token=secret','http://127.0.0.1:123/devtools/browser/test'])assert.throws(()=>ownedBrowserEndpoint(endpoint));
 assert.equal(ownedBrowserEndpoint('ws://127.0.0.1:123/devtools/browser/test').port,'123');
});
test('native target diagnostics omit titles, paths and external URLs',()=>{
 const targets=classifyQaTargets([{type:'page',title:'secret title',url:'file:///private/example/dist/index.html'},{type:'page',url:'https://private.example/token'},{type:'injected:secret',url:'file:///private/settings.html'}]);
 assert.deepEqual(targets,[{type:'page',packagedRenderer:true},{type:'page',packagedRenderer:false},{type:'unknown',packagedRenderer:false}]);
 assert.equal(classifyQaTargets(Array.from({length:100},()=>({type:'page'}))).length,32);
});
test('native CDP diagnostics remain bounded when HTTP and transport are unavailable',async()=>{
 class MissingSocket extends EventTarget{constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('error')));}terminate(){}}
 const summary=await probeOwnedBrowser('ws://127.0.0.1:123/devtools/browser/test',{timeout:20,fetchImpl:async()=>{throw Error('sensitive failure');},WebSocketImpl:MissingSocket});
 assert.deepEqual(summary,{httpTargets:{reachable:false},commands:[],transportAvailable:false});
});
test('native CDP probes send only two read-only methods and keep sanitized replies',async()=>{
 const methods=[];let closed=false;
 class ResponsiveSocket extends EventTarget{
  constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
  send(payload){const {id,method}=JSON.parse(payload);methods.push(method);const result=method==='Browser.getVersion'?{product:'Chrome/152',sensitive:'private'}:{targetInfos:[{type:'page',title:'private',url:'file:///private/dist/index.html'}]};queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id,result})})));}
  terminate(){closed=true;}
 }
 const summary=await probeOwnedBrowser('ws://127.0.0.1:123/devtools/browser/test',{timeout:20,fetchImpl:async(url,options)=>{assert.equal(options.redirect,'error');return {status:200,json:async()=>[{type:'page',title:'private',url:'file:///private/dist/index.html'}]};},WebSocketImpl:ResponsiveSocket});
 assert.deepEqual(methods,['Browser.getVersion','Target.getTargets']);assert.equal(closed,true);
 assert.deepEqual(summary,{httpTargets:{reachable:true,status:200,targets:[{type:'page',packagedRenderer:true}]},commands:[{method:'Browser.getVersion',responded:true,versionReceived:true},{method:'Target.getTargets',responded:true,targets:[{type:'page',packagedRenderer:true}]}]});
 assert.equal(JSON.stringify(summary).includes('private'),false);
});
test('native CDP probes end when an open browser does not answer commands',async()=>{
 let closed=false;
 class SilentSocket extends EventTarget{constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}send(){}terminate(){closed=true;}}
 const summary=await probeOwnedBrowser('ws://127.0.0.1:123/devtools/browser/test',{timeout:10,fetchImpl:async()=>({status:200,json:async()=>[]}),WebSocketImpl:SilentSocket});
 assert.equal(closed,true);assert.deepEqual(summary.commands,[{method:'Browser.getVersion',responded:false},{method:'Target.getTargets',responded:false}]);
});
