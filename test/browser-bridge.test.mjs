import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserBridge } from '../desktop/browser-bridge.mjs';
import { ConnectedBrowser, BrowserChoice } from '../desktop/browser-choice.mjs';

const origin='chrome-extension://'+'a'.repeat(32);
async function fixture(t){
  const bridge=new BrowserBridge({port:0,timeout:2000});const setup=await bridge.prepare();t.after(()=>bridge.close());
  const base=`http://127.0.0.1:${bridge.port}`;
  const request=(route,{method='GET',body,token,from=origin,extensionId}={})=>fetch(base+route,{method,headers:{...(from?{Origin:from}:{}),...(extensionId?{'X-Exomina-Extension':extensionId}:{}),...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const pair=await request('/pair',{method:'POST',body:{code:setup.code.split(':')[1],browser:'Edge'}});assert.equal(pair.status,200);const {token}=await pair.json();
  return {bridge,request,token};
}

test('pairing is one-use and authenticated commands reject websites, wrong extensions and wrong tokens',async t=>{
  const {bridge,request,token}=await fixture(t);
  assert.equal((await request('/commands',{from:'https://example.test',token})).status,403);
  assert.equal((await request('/commands',{from:'chrome-extension://'+'b'.repeat(32),token})).status,403);
  assert.equal((await request('/commands',{token:'wrong'})).status,403);
  assert.equal((await request('/pair',{method:'POST',body:{code:'stale'}})).status,403);
  assert.deepEqual(Object.keys(bridge.status()).sort(),['browser','connected','error','paired']);
  assert.equal(JSON.stringify(bridge.status()).includes(token),false);
});

test('extension commands and results retain the originating chat while another chat is active',async t=>{
  const {bridge,request,token}=await fixture(t);
  const job=bridge.request('navigate',{url:'https://example.test/a'},'a');
  const command=await (await request('/commands',{token})).json();assert.equal(command.chat,'a');
  const state={url:'https://example.test/a',title:'A',loading:false};
  await request('/result',{method:'POST',token,body:{id:command.id,result:{state}}});assert.deepEqual(await job,{state});
  assert.equal(bridge.pages.get('a').url,state.url);assert.equal(bridge.pages.has('b'),false);
  const queued=bridge.request('snapshot',{},'b');const rejection=assert.rejects(queued,/stopped/);bridge.cancel('b');await rejection;assert.equal(bridge.queue.length,0);
});

test('privileged extension GETs without Origin still require the paired identity and secret',async t=>{
  const {bridge,request,token}=await fixture(t);const extensionId='a'.repeat(32);
  assert.equal((await request('/commands',{from:null,token})).status,403);
  assert.equal((await request('/commands',{from:'https://example.test',extensionId,token})).status,403);
  assert.equal((await request('/commands',{from:null,extensionId,token:'wrong'})).status,403);
  const result=bridge.request('snapshot',{},'a');const rejected=assert.rejects(result,/stopped/);
  const command=await (await request('/commands',{from:null,extensionId,token})).json();assert.equal(command.chat,'a');bridge.cancel('a');await rejected;
});

test('browser tool approvals, tool enablement and active-run checks happen before extension dispatch',async()=>{
  const calls=[];let enabled=false,active=true,allow=true;
  const linked=new ConnectedBrowser({bridge:{status:()=>({connected:true}),pages:new Map(),request:async(...args)=>{calls.push(args);return {content:[{type:'text',text:'fixture'}]};}},getSettings:()=>({browserEnabled:enabled}),isActive:()=>active,approve:async()=>allow,emit:()=>{}});
  await assert.rejects(linked.call('browser_snapshot',{},'a'),/off/);enabled=true;allow=false;
  await assert.rejects(linked.call('browser_snapshot',{},'a'),/declined/);allow=true;active=false;
  await assert.rejects(linked.call('browser_snapshot',{},'a'),/stopped/);active=true;
  assert.equal(calls.length,0);await linked.call('browser_snapshot',{},'a');assert.equal(calls[0][2],'a');
});

test('switching to a connected browser detaches the built-in page and keeps chat identity',()=>{
  const shows=[];const embedded={show:(...args)=>shows.push(['embedded',...args]),definitions:[]};const connected={show:(...args)=>shows.push(['connected',...args])};
  const browser=new BrowserChoice({embedded,connected,getSource:()=> 'connected'});browser.show(true,'b');
  assert.deepEqual(shows,[['embedded',false,'b'],['connected',true,'b']]);assert.equal(browser.selectedId,'b');
});
