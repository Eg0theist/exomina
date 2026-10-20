// Exact production Electron host, native browser child view and question IPC.
// All stores, browser content and provider responses are synthetic and isolated.
import {_electron as electron} from 'playwright';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {Store} from '../desktop/store.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {extractFile} from '@electron/asar';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),runtimeRoot=path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT||root);
const fixture=await createProtectedQaProfile('question-native-input'),{profile,output}=fixture,workspace=path.join(output,'workspace');await mkdir(workspace);
const server=http.createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<title>Synthetic native browser</title><main><h1>Synthetic browser input</h1><input id="browser-field" value="Unchanged browser field"></main>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port+'/fixture';
const store=new Store(profile,{workspace});await store.init();Object.assign(store.state.settings,{workspace,autoTitle:false,autoUpdate:false,closeToTray:false,memoryEnabled:false,chatMemorySummaries:false,browserEnabled:true,desktopEnabled:false,permissionMode:'ask',routing:'tools'});
const chat=store.create('codex');chat.title='Native question input QA';chat.titleSource='manual';await store.save();
const version=JSON.parse(runtimeRoot.endsWith('.asar')?extractFile(runtimeRoot,'package.json'):await readFile(path.join(runtimeRoot,'package.json'),'utf8')).version,moduleUrl=name=>JSON.stringify(pathToFileURL(path.join(runtimeRoot,name)).href);
const nativeInput={questions:[{question:'Which outputs should be enabled?',header:'Outputs',options:[{label:'Memory',description:'Save synthetic notes.'},{label:'Browser',description:'Read synthetic pages.'},{label:'Desktop',description:'Synthetic desktop output.'}],multiSelect:true}],metadata:{source:'synthetic-native-question'}};
const launcher=path.join(output,'launcher.cjs');await writeFile(launcher,`const {app,BrowserWindow,session,dialog}=require('electron');
app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',${JSON.stringify(path.join(profile,'browser-data'))});BrowserWindow.prototype.show=function(){};app.commandLine.appendSwitch('mute-audio');app.getVersion=()=>${JSON.stringify(version)};dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};
globalThis.qaNativeQuestion={pages:new Set(),transitions:[],decision:null};
(async()=>{await app.whenReady();for(const partition of [session.defaultSession,session.fromPartition('persist:exomina-browser')])partition.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)&&!details.url.startsWith(${JSON.stringify(new URL('/',url).href)})}));
const {BrowserPage}=await import(${moduleUrl('desktop/browser.mjs')});const show=BrowserPage.prototype.show;BrowserPage.prototype.show=function(visible){const qa=globalThis.qaNativeQuestion;qa.pages.add(this);const state=show.call(this,visible);qa.transitions.push({visible:this.visible,attached:this.window.contentView.children.includes(this.view)});return state;};
const {ProviderManager}=await import(${moduleUrl('desktop/providers.mjs')});const {PROVIDER_CATALOG}=await import(${moduleUrl('desktop/provider-catalog.mjs')});
ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,installed:true,connected:item.id==='codex',available:true,checking:false,detail:'Synthetic isolated QA connection.'}));for(const row of rows)onStatus?.(row);return rows};ProviderManager.prototype.subscriptionModels=async()=>({});ProviderManager.prototype.modelsFor=async()=>[];ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;ProviderManager.prototype.getCodex=async()=>{throw Error('Native account access prohibited in QA')};
ProviderManager.prototype.run=async function(request){const qa=globalThis.qaNativeQuestion;await new Promise(resolve=>qa.begin=resolve);const response=await this.callTool('request_permission',{tool_name:'AskUserQuestion',input:${JSON.stringify(nativeInput)}},request.conversationId);if(response.isError)throw Error(response.content[0].text);qa.decision=JSON.parse(response.content[0].text);await new Promise(resolve=>qa.finish=resolve);return {text:'Synthetic native question response received.',sessionId:'synthetic'};};await import(${moduleUrl('desktop/main.mjs')});})().catch(error=>{console.error(error);app.exit(1)});`);
const env={...process.env,EXOMINA_DATA_DIR:profile,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(/(?:token|secret|password|api_?key|credential|authorization)/i.test(key))delete env[key];
const report={runtimeRoot,output,scope:'Hidden production Electron host, real native browser attachment and trusted renderer mouse input. Synthetic callback uses native Claude AskUserQuestion shape through the real host tool dispatcher. No native Claude inference, sign-in, user profile or account stores.',checks:{},errors:[]};let app,page;
const attached=()=>app.evaluate(()=>[...globalThis.qaNativeQuestion.pages].filter(item=>item.window.contentView.children.includes(item.view)).length);
async function until(read,predicate=Boolean){const end=Date.now()+12000;for(;;){const value=await read();if(predicate(value))return value;if(Date.now()>end)throw Error('Native question QA condition timed out');await new Promise(resolve=>setTimeout(resolve,60));}}
try{
  app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',error=>report.errors.push(error.message));
  await page.locator('.chat-open').filter({hasText:chat.title}).click();await page.getByRole('button',{name:'Browser',exact:true}).click();await until(attached);
  await page.evaluate(({url,id})=>window.studio.invoke('browser.navigate',{url,conversationId:id}),{url,id:chat.id});
  await app.evaluate(()=>{const page=[...globalThis.qaNativeQuestion.pages].find(item=>item.visible);page.wc.focus();});
  await page.evaluate(id=>window.studio.invoke('chat.send',{conversationId:id,provider:'codex',text:'Synthetic native question input.',mode:'tools'}),chat.id);await until(()=>app.evaluate(()=>typeof globalThis.qaNativeQuestion.begin==='function'));
  await app.evaluate(()=>globalThis.qaNativeQuestion.begin());const popup=page.getByRole('dialog',{name:'Your input',exact:true});await popup.waitFor();await until(attached,value=>value===0);
  assert.equal(await page.locator('.app-frame').evaluate(element=>element.inert),true);assert.equal(await popup.evaluate(element=>!!element.closest('[inert]')),false);assert.equal(await page.locator('.approval-card').count(),0);
  const row=label=>popup.locator('.question-option').filter({hasText:label});
  for(const label of ['Memory','Browser']){const bounds=await row(label).boundingBox();assert.ok(bounds);await page.mouse.click(bounds.x+bounds.width-20,bounds.y+bounds.height/2);assert.equal(await row(label).locator('input').isChecked(),true);assert.match(await row(label).getAttribute('class'),/is-selected/);}
  assert.equal(await popup.getByRole('checkbox',{name:/^Desktop\b/}).isChecked(),false);
  await popup.getByRole('button',{name:'Later',exact:true}).click();await popup.waitFor({state:'hidden'});await until(attached,value=>value===1);await page.getByRole('button',{name:'Answer questions',exact:true}).click();await popup.waitFor();await until(attached,value=>value===0);
  assert.equal(await popup.getByRole('checkbox',{name:/^Memory\b/}).isChecked(),true);assert.equal(await popup.getByRole('checkbox',{name:/^Browser\b/}).isChecked(),true);await page.screenshot({path:path.join(output,'native-question.png')});
  await popup.getByRole('button',{name:'Send answer',exact:true}).click();await until(()=>app.evaluate(()=>globalThis.qaNativeQuestion.decision));await popup.waitFor({state:'hidden'});await until(attached,value=>value===1);
  const decision=await app.evaluate(()=>globalThis.qaNativeQuestion.decision);assert.equal(decision.behavior,'allow');assert.deepEqual(decision.updatedInput.questions,nativeInput.questions);assert.deepEqual(decision.updatedInput.metadata,nativeInput.metadata);assert.deepEqual(decision.updatedInput.answers,{'Which outputs should be enabled?':'Memory, Browser'});
  const browserValue=await app.evaluate(async()=>{const page=[...globalThis.qaNativeQuestion.pages].find(item=>item.visible);return page.wc.executeJavaScript('document.getElementById("browser-field").value');});assert.equal(browserValue,'Unchanged browser field');
  assert.equal(await page.locator('.app-frame').evaluate(element=>element.inert),false);await app.evaluate(()=>globalThis.qaNativeQuestion.finish());await page.getByText('Synthetic native question response received.',{exact:true}).waitFor();
  report.checks={nativeBrowserDetachedBeforeAnswerInput:true,backgroundFrameInertButPopupInteractive:true,trustedMouseClicksSelectWholeAnswerRows:true,selectedRowsShowBothChoices:true,dismissReopenRestoresBrowserAndSelections:true,nativeClaudeCallbackReturnsOriginalQuestionFieldsAndExactAnswers:true,noToolApprovalUsedForQuestion:true,hiddenNativeBrowserDidNotReceiveAnswerInput:true,browserAndMainFrameRestoredAfterAnswer:true};assert.deepEqual(report.errors,[]);report.passed=true;report.protection=await fixture.verify();
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;if(page)await page.screenshot({path:path.join(output,'native-question-failure.png')}).catch(()=>{});}
finally{if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}await new Promise(resolve=>server.close(resolve));await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
