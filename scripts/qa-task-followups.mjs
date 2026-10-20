// Production host + approval flow, local synthetic streaming model, isolated encrypted QA data.
import { _electron as electron } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createProtectedQaProfile } from './qa-profile.mjs';

const root=process.cwd(),fixture=await createProtectedQaProfile('task-followups'),{profile,output}=fixture;
const marker='followup-marker.txt',contents='Approved follow-up completed.\n',requests=[],serverErrors=[];
const report={scope:'Production Electron host, real API streaming and approval lifecycle, synthetic loopback API connection and fresh encrypted QA profile; no personal account, voice or subscription requests',checks:{}};
let originalResponse;
function chunk(response,delta,finish=null){response.write(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:finish}]})}\n\n`);}
function end(response,text){chunk(response,{role:'assistant',content:text},'stop');response.end('data: [DONE]\n\n');}
function tool(response,name,args){chunk(response,{role:'assistant',tool_calls:[{index:0,id:'call-'+requests.length,type:'function',function:{name,arguments:JSON.stringify(args)}}]},'tool_calls');response.end('data: [DONE]\n\n');}
const server=http.createServer(async(request,response)=>{
 try{
  if(request.method==='GET'){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({data:[{id:'synthetic-followups'}],models:[{name:'synthetic-followups'}]}));return;}
  assert.equal(request.url,'/v1/chat/completions');let bytes=0;const chunks=[];for await(const data of request){bytes+=data.length;assert.ok(bytes<2*1024*1024);chunks.push(data);}
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8')),prompt=body.messages.find(message=>message.role==='user')?.content;
  const tools=body.tools?.map(entry=>entry.function.name)||[],replies=body.messages.filter(message=>message.role==='tool');
  response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
  if(prompt.includes("Answer the user's follow-up while their original task continues.")){assert.ok(tools.includes('workspace_read'));assert.ok(!tools.includes('workspace_write')&&!tools.includes('followup_update'));requests.push({stage:'parallel-answer'});end(response,'Your follow-up is tracked for the main task to handle.');return;}
  assert.ok(tools.includes('followup_update'));
  if(!prompt.includes('\nFollow-ups:\n')){requests.push({stage:'original-task'});originalResponse=response;chunk(response,{role:'assistant',content:'Working on the original task.'});return;}
  assert.ok(prompt.includes('SYNTHETIC original task: inspect the fixture and finish all accepted follow-ups.'));
  const item=JSON.parse(prompt.split('\nFollow-ups:\n')[1].split('\nVisible work checkpoint:\n')[0])[0];
  const calls=body.messages.flatMap(entry=>entry.tool_calls||[]),replyFor=name=>replies.find(entry=>calls.some(call=>call.id===entry.tool_call_id&&call.function.name===name));
  const writeReply=replyFor('workspace_write'),ack=replyFor('followup_update');
  if(ack){assert.equal(JSON.parse(ack.content).status,'handled');requests.push({stage:'main-final',id:item.id});end(response,'Original task and all accepted follow-ups are completed.');return;}
  if(writeReply){assert.equal(JSON.parse(writeReply.content).written,marker);assert.equal(await readFile(path.join(profile,'workspace',marker),'utf8'),contents);requests.push({stage:'verified-write',id:item.id});tool(response,'followup_update',{id:item.id,status:'handled',summary:'Created and checked the requested marker after approval.'});return;}
  if(item.request.includes('What changed')){requests.push({stage:'late-question',id:item.id});tool(response,'followup_update',{id:item.id,status:'handled',summary:'The requested marker was created and checked; the original work continued.'});return;}
  requests.push({stage:'requested-write',id:item.id});tool(response,'workspace_write',{path:marker,text:contents});
 }catch(error){serverErrors.push(error.message);if(!response.headersSent)response.writeHead(500,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{message:'Synthetic model assertion failed.'}}));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const moduleUrl=name=>JSON.stringify(pathToFileURL(path.join(root,name)).href),launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const {app,BrowserWindow}=require('electron');BrowserWindow.prototype.show=function(){};
(async()=>{await app.whenReady();const {ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});
ProviderManager.prototype.status=async function({onStatus}={}){const rows=[{id:'codex',connected:false},{id:'claude',connected:false}];rows.forEach(row=>onStatus?.(row));return rows};ProviderManager.prototype.subscriptionModels=async()=>({});
const {ApiConnections}=await import(${moduleUrl('desktop/api-connections.mjs')});const status=ApiConnections.prototype.status;
ApiConnections.prototype.status=function(){return status.call(this).map(row=>row.id==='openai-api'?{...row,connected:true,configured:true,model:'synthetic-followups'}:row)};
ApiConnections.prototype.getConnection=async()=>({provider:'openai-api',protocol:'openai',baseUrl:'http://127.0.0.1:${server.address().port}/v1',model:'synthetic-followups'});
ApiConnections.prototype.models=async()=>({models:[{id:'synthetic-followups'}]});
const {ApiAgent}=await import(${moduleUrl('desktop/api-agent.mjs')});const run=ApiAgent.prototype.run;
ApiAgent.prototype.run=async function(request){const tools=request.toolDefinitions??(await this.getTools()).filter(tool=>['workspace_read','workspace_write','followup_update'].includes(tool.name));return run.call(this,{...request,toolDefinitions:tools})};
await import(${moduleUrl('desktop/main.mjs')});})().catch(error=>{console.error(error);app.exit(1)});`,'utf8');
const env={...process.env,EXOMINA_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
let app;
async function until(read,accepted,timeout=30000){const deadline=Date.now()+timeout;for(;;){const value=await read();if(accepted(value))return value;if(Date.now()>deadline)throw Error('Task follow-up QA timed out.');await new Promise(resolve=>setTimeout(resolve,50));}}
try{
 const launch={args:[launcher],cwd:root};
 app=await electron.launch({...launch,env,timeout:30000});const page=await app.firstWindow();page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
 await app.evaluate(({BrowserWindow})=>{for(const win of BrowserWindow.getAllWindows())win.hide();});
 const security=await page.evaluate(()=>window.studio.invoke('security.status'));assert.equal(security.protected,true);
 await until(()=>page.evaluate(()=>window.studio.invoke('bootstrap')),state=>state.connections.some(item=>item.id==='openai-api'&&item.connected));
 await page.evaluate(()=>{window.__followupQaEvents=[];window.studio.onEvent(event=>window.__followupQaEvents.push(event));});
 const state=await page.evaluate(()=>window.studio.invoke('window.state'));assert.equal(state.borderless,true);
 await page.getByRole('banner',{name:'Exomina window'}).waitFor();report.checks.realHostHeader=true;
 await page.evaluate(()=>window.studio.invoke('settings.save',{autoTitle:false}));
 const sent=await page.evaluate(()=>window.studio.invoke('chat.send',{provider:'openai-api',model:'synthetic-followups',text:'SYNTHETIC original task: inspect the fixture and finish all accepted follow-ups.'}));
 await until(()=>requests.some(entry=>entry.stage==='original-task'),Boolean);
 const first=await page.evaluate(id=>window.studio.invoke('chat.send',{conversationId:id,provider:'openai-api',model:'synthetic-followups',text:'Also create followup-marker.txt and verify its contents.'}),sent.conversationId);
 await until(()=>page.evaluate(id=>window.studio.invoke('conversations.get',{id}),sent.conversationId),chat=>chat.messages.at(-1).followups?.some(item=>item.id===first.followup&&item.status==='answered'));
 end(originalResponse,'Original checks complete.');originalResponse=null;
 const approval=page.getByRole('alertdialog');await approval.waitFor();assert.ok((await approval.locator('.approval-target').innerText()).includes(marker));
 assert.ok((await page.evaluate(()=>window.studio.invoke('bootstrap'))).activeRuns.some(run=>run.conversationId===sent.conversationId));
 assert.equal((await page.evaluate(id=>window.__followupQaEvents.filter(event=>event.conversationId===id&&event.type==='chat.complete'),sent.conversationId)).length,0);
 report.checks.completionWaitsForRequestedActionAndApproval=true;
 const second=await page.evaluate(id=>window.studio.invoke('chat.send',{conversationId:id,provider:'openai-api',model:'synthetic-followups',text:'What changed while you handled the additional request?'}),sent.conversationId);
 const allow=approval.getByRole('button',{name:'Allow once',exact:true});assert.equal(await allow.isEnabled(),true);await allow.click({force:true});
 await until(()=>page.evaluate(id=>window.__followupQaEvents.filter(event=>event.conversationId===id),sent.conversationId),events=>events.some(event=>event.type==='chat.complete'||event.type==='chat.error'));
 const events=await page.evaluate(id=>window.__followupQaEvents.filter(event=>event.conversationId===id),sent.conversationId),failure=events.find(event=>event.type==='chat.error');assert.equal(failure,undefined,failure?.error);
 const chat=await page.evaluate(id=>window.studio.invoke('conversations.get',{id}),sent.conversationId),message=chat.messages.at(-1);
 assert.equal(message.followups.length,2);assert.ok(message.followups.every(item=>item.taskStatus==='handled'));
 assert.ok(message.followups.some(item=>item.id===second.followup));assert.match(message.content,/all accepted follow-ups/);
 assert.equal(requests.filter(item=>item.stage==='requested-write').length,1);assert.equal(await readFile(path.join(profile,'workspace',marker),'utf8'),contents);
 const completed=events.findIndex(event=>event.type==='chat.complete'),lastHandled=events.findLastIndex(event=>event.type==='chat.followup'&&event.followup.taskStatus==='handled');assert.ok(completed>lastHandled);
 report.checks.lateFollowupIncludedBeforeCompletion=true;report.checks.actualWriteApprovedVerifiedAndPerformedOnce=true;report.checks.statusesAndFinalAnswerPersisted=true;
 await page.evaluate(()=>window.studio.invoke('settings.save',{appearance:{borderless:false}}));
 assert.equal((await page.evaluate(()=>window.studio.invoke('window.state'))).borderless,true);assert.equal((await page.evaluate(()=>window.studio.invoke('bootstrap'))).settings.appearance.borderless,false);
 report.checks.classicChoiceSavedWithoutInterruptingWindow=true;
 assert.deepEqual(serverErrors,[]);assert.deepEqual(errors,[]);report.requests=requests;report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;report.requests=requests;report.serverErrors=serverErrors;if(app)report.renderer=await app.firstWindow().then(page=>page.evaluate(()=>({headings:[...document.querySelectorAll('h1,h2,h3')].map(el=>el.textContent),approvals:[...document.querySelectorAll('[role="alertdialog"],[role="dialog"]')].map(el=>el.textContent),events:window.__followupQaEvents?.filter(event=>event.type.startsWith('chat.')||event.type==='approval').slice(-10)}))).catch(()=>null);process.exitCode=1;}
finally{if(originalResponse)end(originalResponse,'Synthetic task stopped.');await app?.close().catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));report.completedAt=new Date().toISOString();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));}
