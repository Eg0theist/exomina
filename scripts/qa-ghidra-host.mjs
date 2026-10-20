// Hidden production host/renderer, real GhidraMCP and a fresh protected synthetic profile.
import {_electron as electron} from 'playwright';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {Store} from '../desktop/store.mjs';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),runtimeRoot=path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT||root).replace(/app\.asar\.unpacked$/i,'app.asar');
const fixture=await createProtectedQaProfile('ghidra-host'),{profile,output}=fixture,workspace=path.join(output,'workspace');
await mkdir(workspace,{recursive:true});
const base=path.resolve(root,'../Workspace/rea-native-verification'),target=path.join(workspace,'synthetic-fixture.exe');
await copyFile(path.join(base,'rea-native-fixture.exe'),target);
const originalHash=createHash('sha256').update(await readFile(target)).digest('hex');
const setup={ghidraPath:path.join(base,'ghidra/ghidra_12.1.4_PUBLIC'),javaPath:path.join(base,'jdk/jdk-21.0.12.1+1')};
const store=new Store(profile,{workspace});await store.init();
Object.assign(store.state.settings,{workspace,autoUpdate:false,autoTitle:false,closeToTray:false,memoryEnabled:false,chatMemoryEnabled:false,chatMemorySummaries:false,browserEnabled:false,permissionMode:'full'});
const chat=store.create('codex');chat.title='Ghidra host verification';chat.titleSource='manual';await store.save();
const url=name=>JSON.stringify(pathToFileURL(path.join(runtimeRoot,name)).href),launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const {app,BrowserWindow,dialog,session,shell}=require('electron');
(async()=>{
 app.commandLine.appendSwitch('mute-audio');app.commandLine.appendSwitch('disable-renderer-backgrounding');app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
 BrowserWindow.prototype.show=function(){this.webContents.setBackgroundThrottling(false);};
 dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1);};
 globalThis.qaGhidra={choosers:[],connects:[],runs:[],shown:[]};
 dialog.showOpenDialog=async(_owner,options)=>{if(!options.title.startsWith('Choose an app to inspect in '))throw Error('Unexpected chooser: '+options.title);globalThis.qaGhidra.choosers.push(options);return {canceled:false,filePaths:[${JSON.stringify(target)}]};};
 shell.showItemInFolder=file=>{globalThis.qaGhidra.shown.push(file);};
 await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
 const {ProviderManager}=await import(${url('desktop/providers.mjs')});const {PROVIDER_CATALOG}=await import(${url('desktop/provider-catalog.mjs')});
 ProviderManager.prototype.status=async function({onStatus}={}){const rows=PROVIDER_CATALOG.filter(item=>item.mode==='subscription').map(item=>({id:item.id,installed:true,connected:false,available:true,checking:false,detail:'Synthetic signed-out status.'}));for(const row of rows)onStatus?.(row);return rows;};
 ProviderManager.prototype.subscriptionModels=async()=>({});ProviderManager.prototype.modelsFor=async()=>[];ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;
 ProviderManager.prototype.connect=async id=>{globalThis.qaGhidra.connects.push(id);throw Error('QA sign-in prohibited.');};ProviderManager.prototype.run=async request=>{globalThis.qaGhidra.runs.push(request.provider);throw Error('QA inference prohibited.');};
 await import(${url('desktop/main.mjs')});
})().catch(error=>{console.error(error);app.exit(1);});`);
const environment={...process.env,EXOMINA_DATA_DIR:profile,EXOMINA_WORKSPACE_DIR:path.dirname(base),TEMP:output,TMP:output,TMPDIR:output};delete environment.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(environment))if(/(?:token|secret|password|api_?key|credential|authorization)/i.test(key)||/^(?:GHIDRA_INSTALL_DIR|JAVA_HOME)$/i.test(key))delete environment[key];
const report={passed:false,runtimeRoot,output,scope:'Production IPC and compiled renderer with real GhidraMCP core, an owned hidden process and a synthetic EXE. Provider status is explicitly synthetic; no live inference or personal account access. Vault, target validation, dependency setup and read-deny gates stay real.',checks:{},errors:[]};
let app,page;
const invoke=(method,payload={})=>page.evaluate(({method,payload})=>window.studio.invoke(method,payload),{method,payload});
async function until(check,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Ghidra host condition timed out.');}
try{
 app=await electron.launch({args:[launcher],cwd:root,env:environment,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
 await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();await page.locator(`[data-chat-id="${chat.id}"] .chat-open`).click();await page.getByRole('button',{name:'Tools',exact:true}).click();
 const analysisPane=page.getByRole('region',{name:'App analysis',exact:true});await analysisPane.waitFor();await analysisPane.getByRole('button',{name:'Choose file',exact:true}).click();await analysisPane.getByText('synthetic-fixture.exe',{exact:true}).waitFor();await analysisPane.getByRole('tab',{name:/Ghidra project/}).click();const pane=analysisPane.getByRole('region',{name:'Ghidra project',exact:true});await pane.waitFor();
 let status=await invoke('ghidra.status',{conversationId:chat.id});assert.equal(status.target.kind,'file');assert.equal(status.editing,false);report.checks.selectedBinaryAndEditsOffByDefault=true;
 const bootstrap=await invoke('bootstrap');for(const name of ['ghidra_status','ghidra_query','ghidra_edit'])assert.equal(bootstrap.tools.find(tool=>tool.name===name)?.enabled,true);report.checks.sharedToolsPublished=true;
 await invoke('settings.save',{permissionRules:[{effect:'deny',tool:'ghidra_*',match:''}]});await pane.getByRole('button',{name:'Start project',exact:true}).click();await pane.getByRole('alert').filter({hasText:'Blocked by your rule'}).waitFor();assert.equal((await invoke('ghidra.status',{conversationId:chat.id})).state,'stopped');report.checks.savedDenyRuleEnforced=true;
 await invoke('settings.save',{permissionRules:[]});await pane.getByRole('button',{name:'Start project',exact:true}).click();await pane.getByText('Connected',{exact:true}).waitFor({timeout:180000});status=await invoke('ghidra.status',{conversationId:chat.id});assert.equal(status.state,'connected');assert.equal(status.sha256,originalHash);assert.ok(status.program.languageId||status.program.language_id);report.program=status.program;report.checks.realCoreViaProductionHost=true;
 const configured=await invoke('analysis.nativeDependencies');assert.equal(configured.ghidraPath,setup.ghidraPath);assert.equal(configured.javaPath,setup.javaPath);assert.equal(configured.available,true);report.checks.automaticallySelectsInstalledTools=true;
 await analysisPane.getByRole('tab',{name:/Inspection reports/}).click();assert.equal((await invoke('ghidra.status',{conversationId:chat.id})).state,'connected');await analysisPane.getByRole('tab',{name:/Ghidra project/}).click();await pane.getByText('Connected',{exact:true}).waitFor();report.checks.modeSwitchKeepsRealProjectConnected=true;
 await pane.getByRole('checkbox',{name:'Allow project edits in this chat',exact:false}).click();await until(async()=>(await invoke('ghidra.status',{conversationId:chat.id})).editing);await until(()=>pane.getByRole('checkbox',{name:'Allow project edits in this chat',exact:false}).isChecked());report.checks.editOptInThroughUi=true;
 await pane.getByRole('button',{name:'Save & stop',exact:true}).click();await until(async()=>(await invoke('ghidra.status',{conversationId:chat.id})).state==='stopped');status=await invoke('ghidra.status',{conversationId:chat.id});assert.ok(status.program&&status.project);report.checks.savedProjectVisibleAfterStop=true;
 await pane.getByRole('button',{name:'Project & checkpoints',exact:true}).click();const shown=await app.evaluate(()=>globalThis.qaGhidra.shown);assert.deepEqual(shown,[path.join(status.project,'Exomina.gpr')]);report.checks.projectPickerUsesOwnedProject=true;
 await page.reload();await page.locator(`[data-chat-id="${chat.id}"] .chat-open`).click();await page.getByRole('button',{name:'Tools',exact:true}).click();await analysisPane.getByText('synthetic-fixture.exe',{exact:true}).waitFor();await analysisPane.getByRole('tab',{name:/Ghidra project/}).click();await pane.getByRole('button',{name:'Resume project',exact:true}).waitFor();assert.equal((await invoke('ghidra.status',{conversationId:chat.id})).sha256,originalHash);report.checks.rendererReloadPreservesProject=true;
 await page.screenshot({path:path.join(output,'ghidra-workspace.png')});assert.equal(createHash('sha256').update(await readFile(target)).digest('hex'),originalHash);report.checks.originalBinaryUnchanged=true;
 const activity=await app.evaluate(({BrowserWindow})=>({...globalThis.qaGhidra,visibleWindows:BrowserWindow.getAllWindows().filter(window=>window.isVisible()).length}));assert.equal(activity.visibleWindows,0);assert.deepEqual(activity.connects,[]);assert.deepEqual(activity.runs,[]);report.checks.hiddenNoProviderCalls=true;
 await fixture.verify();report.checks.realVaultProtectionVerified=true;assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.failure=error.stack;if(page){await writeFile(path.join(output,'failure-view.txt'),await page.locator('body').innerText().catch(()=>''));await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}throw error;}finally{await app?.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));
