// Production host and renderer, synthetic data and providers. The reported
// screenshot question is reproduced without an interactive tool call.
import {_electron as electron} from 'playwright';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {Store} from '../desktop/store.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {extractFile} from '@electron/asar';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),runtimeRoot=path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT||root),cua=process.argv.includes('--cua');
const fixture=await createProtectedQaProfile('question-text'),{profile,output}=fixture,workspace=path.join(output,'workspace');await mkdir(workspace);
const prompt='How do you normally put the PC to sleep when this happens?',options=['Windows Start menu → Power → Sleep','A keyboard button, shortcut, or utility','It happens automatically after inactivity'];
const questionText='Your PC supports traditional S3 sleep, and the logs show several sleep requests that never reached a recorded sleep entry.\n'+prompt+'\n'+options.map(value=>'- '+value).join('\n');
const store=new Store(profile,{workspace});await store.init();Object.assign(store.state.settings,{workspace,autoTitle:false,autoUpdate:false,closeToTray:false,memoryEnabled:false,chatMemorySummaries:false,browserEnabled:false,desktopEnabled:false,permissionMode:'ask',routing:'tools'});
const make=title=>{const chat=store.create('codex');chat.title=title;chat.titleSource='manual';return chat;};
const historical=make('Historical question recovery'),other=make('Other QA chat'),completed=make('Completed question recovery'),userText=make('User text stays text'),live=make('Live question recovery');
historical.messages=[{id:'old-user',role:'user',content:'Diagnose synthetic sleep.'},{id:'old-reply',role:'assistant',provider:'codex',content:'Independent checks continued.',activity:[{id:'sleep-note',kind:'note',text:questionText,status:'done'}]}];
completed.messages=[{id:'final-reply',role:'assistant',provider:'codex',content:questionText}];userText.messages=[{id:'user-question',role:'user',content:questionText}];
await store.save();
const version=JSON.parse(runtimeRoot.endsWith('.asar')?extractFile(runtimeRoot,'package.json'):await readFile(path.join(runtimeRoot,'package.json'),'utf8')).version,moduleUrl=name=>JSON.stringify(pathToFileURL(path.join(runtimeRoot,name)).href);
const launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const {app,BrowserWindow,session,dialog}=require('electron');
BrowserWindow.prototype.show=function(){${cua?'this.showInactive();':''}};app.commandLine.appendSwitch('mute-audio');app.getVersion=()=>${JSON.stringify(version)};dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};
globalThis.qaText={calls:[],directions:[],turns:0};
(async()=>{await app.whenReady();for(const partition of [session.defaultSession,session.fromPartition('persist:exomina-browser')])partition.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
const {ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});const {PROVIDER_CATALOG}=await import(${moduleUrl('desktop/provider-catalog.mjs')});
ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,installed:true,connected:item.id==='codex',available:true,checking:false,detail:'Synthetic QA connection.'}));for(const row of rows)onStatus?.(row);return rows;};
ProviderManager.prototype.subscriptionModels=async()=>({});ProviderManager.prototype.modelsFor=async()=>[];ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;ProviderManager.prototype.getCodex=async()=>{throw Error('Native account/runtime access prohibited in question QA')};
ProviderManager.prototype.steer=async(_id,request)=>{globalThis.qaText.directions.push(request.prompt);return true;};
ProviderManager.prototype.run=async function(request){const qa=globalThis.qaText;qa.calls.push({id:request.conversationId,prompt:request.prompt});
if(request.conversationId!==${JSON.stringify(live.id)})return {text:'Synthetic saved answer received.',sessionId:'synthetic'};
if(request.noTools)return {text:'Synthetic answer tracked.',sessionId:'synthetic-side'};
if(request.prompt.includes('Continue the original task before issuing its final answer.')){const followups=JSON.parse(request.prompt.split('Follow-ups:\\n').at(-1).split('\\nVisible work checkpoint:')[0]);for(const item of followups)await this.callTool('followup_update',{id:item.id,status:'handled',summary:'The synthetic user answer was received and verified.'},request.conversationId);return {text:qa.turns===1?'Synthetic live question work finished.':'Synthetic required host question received.',sessionId:'synthetic'};}
if(++qa.turns===1){this.emit({type:'chat.delta',conversationId:request.conversationId,text:${JSON.stringify(questionText)},block:'plain-question'});this.emit({type:'chat.tool',conversationId:request.conversationId,id:'synthetic-read',name:'workspace_list',input:{path:'.'},status:'done'});await new Promise(resolve=>qa.finish=resolve);return {text:'Synthetic live question work finished.',sessionId:'synthetic-live'};}
qa.aliasResult=JSON.parse((await this.callTool('ask_user_question_async',{questions:[{id:'follow',question:'Which response style do you prefer?',options:['Concise','Detailed']}],require_answer:true,wait_seconds:10},request.conversationId)).content[0].text);
return {text:'Synthetic required host question received.',sessionId:'synthetic-alias'};};await import(${moduleUrl('desktop/main.mjs')});})().catch(error=>{console.error(error);app.exit(1)});`);
const env={...process.env,EXOMINA_DATA_DIR:profile,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(/(?:token|secret|password|api_?key|credential|authorization)/i.test(key))delete env[key];
const report={runtimeRoot,output,scope:'Production host and renderer with encrypted synthetic conversations and simulated providers. No personal account stores or authenticated inference.',checks:{},errors:[]};let app,page;
const until=async(read,predicate=Boolean,timeout=15000)=>{const end=Date.now()+timeout;for(;;){const result=await read();if(predicate(result))return result;if(Date.now()>end)throw Error('Question recovery QA timed out');await new Promise(resolve=>setTimeout(resolve,80));}};
const select=async title=>{await page.locator('.chat-open').filter({hasText:title}).click();};
const card=()=>page.locator('.text-question .question-card');
try{
  app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
  await select(historical.title);await card().waitFor();assert.equal(await card().count(),1);assert.equal(await card().getByRole('radio').count(),4);
  const bootstrap=()=>page.evaluate(()=>window.studio.invoke('bootstrap'));
  let state=await bootstrap();assert.equal(state.conversations.find(chat=>chat.id===historical.id).messages.at(-1).questions,undefined,'rendering must not create or submit a question');
  if(cua){
    const target=await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];const handle=win.getNativeWindowHandle();return {pid:process.pid,window_id:Number(handle.length>=8?handle.readBigUInt64LE():handle.readUInt32LE()),title:win.getTitle()};});
    console.log(JSON.stringify({cuaReady:target,output,option:options[0]}));
    await until(async()=>{const state=await bootstrap();return state.conversations.find(chat=>chat.id===historical.id).messages.find(message=>message.id==='old-reply')?.questions?.[0]?.deliveryState==='delivered';},Boolean,180000);
    report.checks.cuaSelectedAndSentScreenshotChoice=true;
  }else{
    assert.equal(await card().getByRole('button',{name:'Send answer',exact:true}).isEnabled(),false);
    const row=card().locator('.question-option').filter({hasText:options[0]});const bounds=await row.boundingBox();await page.mouse.click(bounds.x+bounds.width-18,bounds.y+bounds.height/2);
    assert.equal(await row.getByRole('radio').isChecked(),true);assert.match(await row.getAttribute('class'),/is-selected/);assert.equal(await card().getByRole('button',{name:'Send answer',exact:true}).isEnabled(),true);
    await select(other.title);await select(historical.title);assert.equal(await card().getByRole('radio',{name:options[0],exact:true}).isChecked(),true);
    await page.screenshot({path:path.join(output,'screenshot-question-selectable.png')});
    await card().getByRole('button',{name:'Send answer',exact:true}).click();
  }
  await until(async()=>{const state=await bootstrap();return state.conversations.find(chat=>chat.id===historical.id).messages.find(m=>m.id==='old-reply')?.questions?.[0]?.deliveryState==='delivered';});
  state=await bootstrap();const saved=state.conversations.find(chat=>chat.id===historical.id).messages.find(m=>m.id==='old-reply').questions[0];assert.equal(saved.answers.answer.answers[0],options[0]);assert.equal(saved.source.kind,'assistant-text');
  await until(()=>app.evaluate((_electron,id)=>globalThis.qaText.calls.filter(call=>call.id===id).length,historical.id),count=>count===1);await page.reload();await select(historical.title);await card().waitFor();assert.equal(await card().getByRole('button',{name:'Send answer',exact:true}).count(),0);assert.match(await card().textContent(),/Your answer/);assert.equal(await page.locator('.question-step').count(),0);
  report.checks={...report.checks,historicalProgressQuestionHasRealControls:true,choiceAndExplicitSubmissionPersist:true,savedAnswerDeliveredToOriginalChatExactlyOnce:true,reloadShowsCompactSavedAnswerWithoutDuplicateCard:true};
  if(!cua){
    await select(completed.title);await card().waitFor();await card().getByLabel('Write my own answer').check();await card().getByLabel('Your answer: '+prompt).fill('A custom synthetic answer');await card().getByRole('button',{name:'Send answer',exact:true}).click();
    await until(async()=>{const state=await bootstrap();return state.conversations.find(chat=>chat.id===completed.id).messages.find(m=>m.id==='final-reply')?.questions?.[0]?.deliveryState==='delivered';});
    await select(userText.title);assert.equal(await card().count(),0);report.checks.finalReplyCustomAnswerAndUserTextExclusion=true;
    await select(live.title);await page.evaluate(id=>window.studio.invoke('chat.send',{conversationId:id,provider:'codex',text:'Start the synthetic live question.',mode:'tools'}),live.id);await card().waitFor();
    await card().getByLabel(options[1],{exact:true}).check();await card().getByRole('button',{name:'Send answer',exact:true}).click();await until(()=>app.evaluate(()=>globalThis.qaText.directions.length===1));assert.match((await app.evaluate(()=>globalThis.qaText.directions))[0],/How do you normally.*User answer: A keyboard/s);
    await app.evaluate(()=>globalThis.qaText.finish());await page.getByText('Synthetic live question work finished.',{exact:true}).waitFor();report.checks.liveTextAnswerIsSteeredToWaitingTask=true;
    await page.evaluate(id=>window.studio.invoke('chat.send',{conversationId:id,provider:'codex',text:'Start the required host question.',mode:'tools'}),live.id);const popup=page.getByRole('dialog',{name:'Your input',exact:true});await popup.waitFor();
    state=await bootstrap();assert.equal(state.tools.find(tool=>tool.name==='ask_user_question').enabled,true);assert.equal(state.tools.find(tool=>tool.name==='ask_user_question_async').enabled,true);
    assert.equal(state.conversations.find(chat=>chat.id===live.id).messages.at(-1).finishedAt,undefined);await popup.getByLabel('Detailed',{exact:true}).check();await popup.getByRole('button',{name:'Send answer',exact:true}).click();await page.getByText('Synthetic required host question received.',{exact:true}).waitFor();report.checks.preferredHostToolWorksAndRequiredAnswerHoldsCompletion=true;
  }
  assert.deepEqual(report.errors,[]);report.passed=true;report.protection=await fixture.verify();
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;if(app)report.providerDebug=await app.evaluate(()=>({calls:globalThis.qaText.calls.map(call=>({id:call.id,promptEnd:call.prompt.slice(-700)})),turns:globalThis.qaText.turns,directions:globalThis.qaText.directions})).catch(()=>null);if(page){report.chatDebug=await page.evaluate(async()=>{const state=await window.studio.invoke('bootstrap');return {activeRuns:state.activeRuns,chats:state.conversations.map(chat=>({id:chat.id,title:chat.title,messages:chat.messages.map(m=>({id:m.id,role:m.role,error:m.error,continuationError:m.continuationError,content:String(m.content||'').slice(-500),questions:m.questions?.map(q=>({status:q.status,delivery:q.deliveryState,receipt:q.receipt}))}))}))};}).catch(()=>null);await page.screenshot({path:path.join(output,'question-recovery-failure.png')}).catch(()=>{});}}
finally{if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
