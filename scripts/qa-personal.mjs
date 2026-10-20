// Read-only verification of the prepared personal archive. Never prints record contents.
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url));
const output=path.resolve(root,'../../outputs');
const executable=path.join(output,'Exomina/win-unpacked/Exomina.exe');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.EXOMINA_DATA_DIR;
const child=spawn(executable,['--remote-debugging-port=0','--remote-debugging-address=127.0.0.1'],{cwd:path.dirname(executable),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
child.stdout.resume();let socket,sessionId;let nextId=0;const pending=new Map();
function request(method,params={},session){return new Promise((resolve,reject)=>{const id=++nextId;const timer=setTimeout(()=>{pending.delete(id);reject(Error('QA request timed out: '+method))},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(session?{sessionId:session}:{})}));});}
async function until(read,accept){const deadline=Date.now()+30000;while(Date.now()<deadline){const result=await read();if(accept(result))return result;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Prepared app was not ready.');}
async function evaluate(expression){const result=await request('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(result.exceptionDetails)throw Error('Prepared app evaluation failed: '+(result.exceptionDetails.exception?.description||result.exceptionDetails.text));return result.result?.value;}
async function screenshot(name){const result=await request('Page.captureScreenshot',{format:'png'},sessionId);await writeFile(path.join(output,name),Buffer.from(result.data,'base64'));}
try{
 const endpoint=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Prepared app did not open.')),30000);child.stderr.on('data',chunk=>{text=(text+chunk).slice(-16000);const match=text.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});child.once('error',reject);child.once('close',()=>reject(Error('Prepared app exited.')));});
 socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 socket.addEventListener('message',event=>{const value=JSON.parse(event.data);const item=pending.get(value.id);if(item){clearTimeout(item.timer);pending.delete(value.id);value.error?item.reject(Error(value.error.message)):item.resolve(value.result);}});
 const target=await until(async()=>(await request('Target.getTargets')).targetInfos.find(value=>value.type==='page'&&value.url.endsWith('/dist/index.html')),Boolean);
 ({sessionId}=await request('Target.attachToTarget',{targetId:target.targetId,flatten:true}));
 await request('Runtime.enable',{},sessionId);
 await until(()=>evaluate("Boolean(window.studio?.invoke) && document.readyState === 'complete'"),Boolean);
 const state=await until(()=>evaluate("window.studio.invoke('bootstrap')"),value=>value?.connections?.length===15);
 assert.equal(state.archive.documents,981);assert.equal(state.archive.conversationCount,505);assert.equal(state.archive.memoryCount,14);assert.equal(state.archive.projectCount,8);assert.equal(state.archive.artifactCount,454);
 assert.equal(state.providers.length,15);assert.equal(state.conversations.length,0);assert.ok(state.connections.every(value=>!value.connected));
 await until(()=>evaluate("document.body.innerText.includes('Your AI, with shared memory, a browser, and tools.')"),Boolean);
 await screenshot('Exomina-home.png');
  await evaluate("[...document.querySelectorAll('button')].find(button=>/^Memory(?:\\s*\\d+)?$/.test(button.textContent.trim())).click()");
 await until(()=>evaluate("document.body.innerText.includes('505') && document.body.innerText.includes('454')"),Boolean);
 await screenshot('Exomina-memory.png');
 await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Connections').click()");
 await until(()=>evaluate("document.body.innerText.includes('Connect your accounts')"),Boolean);
 await screenshot('Exomina-connections.png');
 const report={passed:true,scope:'Exact prepared Windows executable; local archive counts and visible screens only. No archive text was opened or sent to a model.',archive:state.archive,providerOptions:state.providers.map(p=>p.id),subscriptionsSignedIn:false,apiKeysConfigured:false};
 await writeFile(path.join(output,'Exomina-prepared-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{
 if(sessionId)await evaluate('window.close()').catch(()=>{});
 socket?.close();for(const item of pending.values())clearTimeout(item.timer);
 if(child.exitCode===null){await Promise.race([new Promise(resolve=>child.once('close',resolve)),new Promise(resolve=>setTimeout(resolve,3000))]);if(child.exitCode===null){const stop=spawn(path.join(process.env.SystemRoot,'System32/taskkill.exe'),['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});await new Promise(resolve=>stop.once('close',resolve));}}
}
