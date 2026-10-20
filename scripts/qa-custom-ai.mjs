// Production host/renderer and API engine with an isolated synthetic local server.
// No personal account stores, native provider calls or external network requests.
import {_electron as electron} from 'playwright';
import {mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {extractFile} from '@electron/asar';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {Store} from '../desktop/store.mjs';

const root=process.cwd(),runtime=path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT||root);
const version=JSON.parse(runtime.endsWith('.asar')?extractFile(runtime,'package.json'):await readFile(path.join(runtime,'package.json'),'utf8')).version;
const fixture=await createProtectedQaProfile('custom-ai'),{output,profile}=fixture;
const workspace=path.join(profile,'workspace'),accounts=path.join(profile,'accounts');await mkdir(workspace);await mkdir(accounts);
const requests=[];let serverMode='text';
const server=http.createServer(async(request,response)=>{
  let raw='';for await(const chunk of request)raw+=chunk;
  const body=raw?JSON.parse(raw):undefined;requests.push({url:request.url,method:request.method,hasAuth:!!request.headers.authorization,body});
  if(request.url==='/v1/models'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({data:[{id:'fixture-local-model',display_name:'Fixture local model'}]}));return;}
  if(request.url!=='/v1/chat/completions'){response.writeHead(404).end();return;}
  response.setHeader('Content-Type','text/event-stream');
  const text=serverMode==='text'?'Text chat verified.':serverMode==='deny'?'Permission denial verified.':'Allowed write verified.';
  const delta=serverMode!=='text'&&body.messages.length===1?{tool_calls:[{index:0,id:'write-1',type:'function',function:{name:'workspace_write',arguments:JSON.stringify({path:'qa-result.txt',text:'Verified custom AI tool path.'})}}]}:{content:text};
  response.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const baseUrl='http://127.0.0.1:'+server.address().port+'/v1';
const store=new Store(profile,{workspace});await store.init();
Object.assign(store.state.settings,{provider:'codex',autoTitle:false,autoUpdate:false,closeToTray:false,quickAccess:false,memoryEnabled:false,chatMemorySummaries:false,browserEnabled:false,desktopEnabled:false,permissionMode:'ask',routing:'tools'});
const chat=store.create('codex');chat.title='Own AI QA';chat.titleSource='manual';await store.save();
const moduleUrl=file=>JSON.stringify(pathToFileURL(path.join(runtime,file)).href),launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const{app,BrowserWindow,dialog,session}=require('electron');(async()=>{
app.commandLine.appendSwitch('mute-audio');app.getVersion=()=>${JSON.stringify(version)};BrowserWindow.prototype.show=function(){this.webContents.setBackgroundThrottling(false)};
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};
await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,cb)=>cb({cancel:/^https?:/.test(details.url)&&!details.url.startsWith(${JSON.stringify(new URL('/',baseUrl).href)})}));
const{ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});const{PROVIDER_CATALOG}=await import(${moduleUrl('desktop/provider-catalog.mjs')});
ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,connected:item.id==='codex',installed:true,available:true,checking:false,detail:'Synthetic subscription status'}));rows.forEach(row=>onStatus?.(row));return rows};
ProviderManager.prototype.subscriptionModels=async()=>({});ProviderManager.prototype.modelsFor=async()=>[];
ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;
ProviderManager.prototype.connect=async()=>{throw Error('Native sign-in prohibited in QA')};ProviderManager.prototype.getCodex=async()=>{throw Error('Native account access prohibited in QA')};ProviderManager.prototype.run=async()=>{throw Error('Native model requests prohibited in QA')};
const{ApiAgent}=await import(${moduleUrl('desktop/api-agent.mjs')});const run=ApiAgent.prototype.run;ApiAgent.prototype.run=function(request){if(request.provider!=='custom-api')throw Error('Unexpected model request');return run.call(this,request)};
await import(${moduleUrl('desktop/main.mjs')});})().catch(error=>{console.error(error);app.exit(1)});`,'utf8');
const env={...process.env,EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:accounts,EXOMINA_WORKSPACE_DIR:workspace,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization/i.test(key))delete env[key];
const report={runtime,scope:'Hidden production host/renderer, real safeStorage and API engine, synthetic protected profile and local HTTP server. No personal account access or real model inference.',checks:{},errors:[]};let app,page;
async function until(read,accept=Boolean,label='state'){const end=Date.now()+15000;let value;do{value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,70));}while(Date.now()<end);throw Error('Timed out waiting for '+label+': '+JSON.stringify(value).slice(0,500));}
try{
  app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
  const invoke=(method,payload={})=>page.evaluate(({method,payload})=>window.studio.invoke(method,payload),{method,payload});
  const status=async()=>(await invoke('bootstrap')).connections.find(item=>item.id==='custom-api');
  await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
  await page.getByRole('combobox',{name:'Interface view',exact:true}).selectOption('advanced');
  const connections=async()=>{await page.keyboard.press('Control+,');await page.getByRole('navigation',{name:'Settings categories'}).getByRole('button',{name:'Connections & sync',exact:true}).click();await page.getByRole('button',{name:'Manage connections',exact:true}).click();};
  await connections();await page.getByRole('tab',{name:'Your own AI',exact:true}).click();
  await page.getByRole('button',{name:'Add your own AI',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Add your own AI',exact:true});await dialog.waitFor();
  await dialog.getByRole('button',{name:'LM Studio',exact:true}).click();assert.equal(await dialog.getByLabel('Server address',{exact:true}).inputValue(),'http://127.0.0.1:1234/v1');
  await dialog.getByRole('button',{name:'Ollama',exact:true}).click();assert.equal(await dialog.getByLabel('Server address',{exact:true}).inputValue(),'http://127.0.0.1:11434/v1');
  await dialog.getByLabel('Server address',{exact:true}).fill(baseUrl);await dialog.getByRole('button',{name:'Load models',exact:true}).click();
  await dialog.getByLabel('Available models',{exact:true}).selectOption('fixture-local-model');
  assert.equal(requests.length,1);assert.equal(requests[0].url,'/v1/models');assert.equal(await dialog.getByRole('checkbox',{name:/^Tools /}).isChecked(),false);
  await page.setViewportSize({width:740,height:700});await dialog.getByRole('button',{name:'Save connection',exact:true}).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(output,'narrow-setup.png')});
  await dialog.getByRole('button',{name:'Save connection',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(requests.length,1);
  assert.equal((await status()).configured,true);assert.equal((await status()).hasKey,false);assert.equal((await status()).supportsTools,false);
  assert.equal((await invoke('bootstrap')).providerModels['custom-api'][0].id,'fixture-local-model');report.checks.setupDiscoveryAndSaveWithoutCompletion=true;
  await page.setViewportSize({width:1260,height:850});await page.getByRole('button',{name:'Exomina home',exact:true}).click();
  await invoke('chat.send',{conversationId:chat.id,provider:'custom-api',text:'Test a text reply.',mode:'tools'});
  await until(()=>invoke('bootstrap'),state=>!state.activeRuns.length&&state.conversations.find(item=>item.id===chat.id).messages.at(-1)?.content==='Text chat verified.','text reply');
  assert.equal(requests.at(-1).body.tools,undefined);assert.equal(requests.at(-1).body.max_tokens,2048);report.checks.textChatUsesConfiguredModelWithoutTools=true;
  await page.locator(`[data-chat-id="${chat.id}"] .chat-open`).click();
  for(const view of ['standard','advanced']){
    await page.getByRole('combobox',{name:'Interface view',exact:true}).selectOption(view);await page.locator('.model-chip').click();
    if(view==='standard')await page.getByRole('combobox',{name:'Model',exact:true}).selectOption('fixture-local-model');
    else await page.getByRole('option',{name:'fixture-local-model',exact:true}).click();
    await page.keyboard.press('Escape');await until(()=>page.locator('.model-chip').innerText(),text=>text.includes('fixture-local-model'),'selected model in '+view);
  }
  report.checks.configuredModelVisibleInBothViews=true;
  await connections();await page.getByRole('tab',{name:'Your own AI',exact:true}).click();await page.locator('[data-provider="custom-api"]').getByRole('button',{name:'Manage connection',exact:true}).click();
  await dialog.getByRole('checkbox',{name:/^Tools /}).check();await dialog.getByRole('button',{name:'Save connection',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Exomina home',exact:true}).click();await page.locator(`[data-chat-id="${chat.id}"] .chat-open`).click();
  serverMode='deny';await invoke('chat.send',{conversationId:chat.id,provider:'custom-api',text:'Exercise a denied file write.',mode:'tools'});
  const approval=page.locator('.approval-card');await approval.waitFor();await assert.rejects(access(path.join(workspace,'qa-result.txt')));
  await approval.getByRole('button',{name:'Deny',exact:true}).click();await until(()=>invoke('bootstrap'),state=>!state.activeRuns.length,'denied reply');await assert.rejects(access(path.join(workspace,'qa-result.txt')));
  assert.match(JSON.stringify(requests.at(-1).body.messages.at(-1)),/denied|declined|not approved/i);report.checks.denialPreventsFileWrite=true;
  serverMode='allow';await invoke('chat.send',{conversationId:chat.id,provider:'custom-api',text:'Exercise an approved file write.',mode:'tools'});await approval.waitFor();await approval.getByRole('button',{name:'Allow once',exact:true}).click();
  await until(()=>invoke('bootstrap'),state=>!state.activeRuns.length,'approved reply');assert.equal(await readFile(path.join(workspace,'qa-result.txt'),'utf8'),'Verified custom AI tool path.');report.checks.allowOnceUsesRealPermissionDispatcher=true;
  await connections();await page.getByRole('tab',{name:'Your own AI',exact:true}).click();await page.locator('[data-provider="custom-api"]').getByRole('button',{name:'Manage connection',exact:true}).click();
  await dialog.getByRole('button',{name:'Hosted server',exact:true}).click();await dialog.getByLabel('Server address',{exact:true}).fill('https://hosted.example/v1');
  await dialog.locator('#provider-api-key').fill('synthetic-ui-key');await dialog.getByLabel('I trust this server',{exact:false}).check();
  const before=requests.length;await dialog.getByRole('button',{name:'Save connection',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(requests.length,before);assert.equal((await status()).hasKey,true);
  assert.ok(!(await readFile(path.join(profile,'api-connections.json'),'utf8')).includes('synthetic-ui-key'));report.checks.hostedConfigurationUsesProtectedKeyStorage=true;
  await page.locator('[data-provider="custom-api"]').getByRole('button',{name:'Manage connection',exact:true}).click();await dialog.getByLabel('Server address',{exact:true}).fill(baseUrl);await dialog.getByRole('button',{name:'Save connection',exact:true}).click();
  await dialog.getByRole('alert').filter({hasText:'Re-enter the API key'}).waitFor();assert.equal((await status()).baseUrl,'https://hosted.example/v1');
  await dialog.getByLabel('Remove saved key and connect without it',{exact:true}).check();await dialog.getByRole('button',{name:'Save connection',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal((await status()).hasKey,false);report.checks.destinationChangeCannotCarrySavedKey=true;
  await page.reload();await until(()=>status(),item=>item?.configured&&item.baseUrl===baseUrl,'configuration after reload');
  await connections();await page.getByRole('combobox',{name:'Interface view',exact:true}).selectOption('standard');assert.equal(await page.getByRole('tab',{name:'Your own AI',exact:true}).count(),0);
  await page.getByRole('combobox',{name:'Interface view',exact:true}).selectOption('advanced');await page.getByRole('tab',{name:'Your own AI',exact:true}).click();
  await page.locator('[data-provider="custom-api"]').getByRole('button',{name:'Manage connection',exact:true}).click();await dialog.getByRole('button',{name:'Remove connection',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal((await status()).configured,false);report.checks.optionalSetupAndRemoval=true;
  await page.screenshot({path:path.join(output,'custom-connection.png')});assert.deepEqual(report.errors,[]);report.protection=await fixture.verify();report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}
finally{await app?.close();await new Promise(resolve=>server.close(resolve));report.requests=requests.map(({url,method,hasAuth,body})=>({url,method,hasAuth,model:body?.model,tools:body?.tools?.length||0}));await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify({output,...report},null,2));}
