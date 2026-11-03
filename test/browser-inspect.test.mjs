import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectPage,inspectOptions,plainDocument} from '../desktop/browser-extension/inspect-source.js';
import {toolErrorResult,toolErrorText} from '../desktop/tool-errors.mjs';
import {ConnectedBrowser,BrowserChoice} from '../desktop/browser-choice.mjs';
const frame={frame:{id:'one',loaderId:'a',url:'https://example.test/'},resources:[{url:'https://example.test/app.js',type:'Script',mimeType:'text/javascript'}]};
test('inspection lists loaded source, paginates it and refuses arbitrary resource addresses',async()=>{
  const calls=[];const adapter={send:async(method,args)=>{calls.push({method,args});return method==='Page.getResourceTree'?{frameTree:frame}:{content:'const model="test";'};},evaluate:async()=>'<html>source</html>'};
  const decode=result=>JSON.parse(result.content[0].text);
  assert.match(decode(await inspectPage(adapter,{operation:'resources'})).text,/app.js/);
  const chunk=decode(await inspectPage(adapter,{operation:'resource',url:frame.resources[0].url,limit:5}));assert.equal(chunk.text,'const');assert.equal(chunk.nextOffset,5);assert.equal(chunk.untrusted,true);
  const count=calls.filter(c=>c.method==='Page.getResourceContent').length;
  await assert.rejects(inspectPage(adapter,{operation:'resource',url:'https://example.test/private-api'}),/not loaded/);assert.equal(calls.filter(c=>c.method==='Page.getResourceContent').length,count);
  assert.throws(()=>inspectOptions({operation:'html',limit:30000}));
});
test('navigation invalidates inspection and binary resource bodies are refused',async()=>{
  let reads=0;await assert.rejects(inspectPage({send:async method=>method==='Page.enable'?{}:({frameTree:{...frame,frame:{...frame.frame,loaderId:++reads===1?'a':'b'}}}),evaluate:async()=>'<html/>'},{operation:'html'}),/changed/);
  await assert.rejects(inspectPage({send:async method=>method==='Page.getResourceTree'?{frameTree:frame}:{content:'abc',base64Encoded:true}},{operation:'resource',url:frame.resources[0].url}),/binary/);
});
test('connected inspection respects disabled tools, approval and the selected chat',async()=>{
  const calls=[];let enabled=false,approved=false;const connected=new ConnectedBrowser({bridge:{status:()=>({}),pages:new Map(),request:async(...args)=>{calls.push(args);return {content:[{type:'text',text:'source'}]};}},approve:async()=>approved,getSettings:()=>({browserEnabled:enabled}),isActive:()=>true,emit:()=>{}});
  await assert.rejects(connected.call('browser_inspect',{operation:'html'},'chat'),/off/);enabled=true;await assert.rejects(connected.call('browser_inspect',{operation:'html'},'chat'),/declined/);assert.equal(calls.length,0);approved=true;
  const choice=new BrowserChoice({embedded:{call:()=>assert.fail('Wrong browser')},connected,getSource:()=> 'connected'});await choice.call('browser_inspect',{operation:'html'},'chat');assert.equal(calls[0][0],'inspect');assert.equal(calls[0][2],'chat');
});
test('plain-text documents are inspected from the response body without running page script',async()=>{
  const plain={...frame,frame:{...frame.frame,url:'https://raw.example.test/a.tex',mimeType:'text/plain'}};
  const adapter={send:async(method,args)=>method==='Page.enable'?{}:method==='Page.getResourceTree'?{frameTree:plain}:(assert.equal(args.url,plain.frame.url),{content:'\section{Intro}'}),evaluate:()=>assert.fail('Page script must not run')};
  const result=JSON.parse((await inspectPage(adapter,{operation:'html'})).content[0].text);
  assert.equal(result.text,'\section{Intro}');assert.equal(result.source,'document response body');
  assert.equal(plainDocument('text/html; charset=utf-8'),false);assert.equal(plainDocument('application/xhtml+xml'),false);assert.equal(plainDocument('application/ld+json'),true);
});
test('a blocked HTML read gives a clear error, and tool errors always carry text',async()=>{
  await assert.rejects(inspectPage({send:async()=>({frameTree:{...frame,frame:{...frame.frame,mimeType:'text/html'}}}),evaluate:async()=>{throw undefined;}},{operation:'html'}),/blocked the script/);
  for(const error of [undefined,null,{},new Error(''),{message:42}])assert.equal(typeof toolErrorResult(error).content[0].text,'string');
  assert.equal(toolErrorText(new Error('kept')),'kept');assert.equal(toolErrorText('plain'),'plain');
});
