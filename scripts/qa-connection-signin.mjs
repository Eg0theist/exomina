// Real host + renderer, with synthetic official-runtime messages. No account access.
import {_electron as electron} from 'playwright';
import {createPlatformQaProfile as createProtectedQaProfile} from './qa-profile.mjs';
import {prepareWindowsQaOwner} from './native-qa-windows-owner.mjs';
import {Store} from '../desktop/store.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {extractFile} from '@electron/asar';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

await prepareWindowsQaOwner();
const root=path.resolve(import.meta.dirname,'..'),runtimeRoot=path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT||root);
const {profile,output}=await createProtectedQaProfile('connection-signin'),workspace=path.join(profile,'workspace'),accounts=path.join(profile,'accounts'),home=path.join(output,'home');
for(const directory of [workspace,accounts,home,path.join(home,'AppData/Roaming'),path.join(home,'AppData/Local')])await mkdir(directory,{recursive:true});
const store=new Store(profile,{workspace});await store.init();Object.assign(store.state.settings,{workspace,autoTitle:false,autoUpdate:false,closeToTray:false,quickAccess:false,memoryEnabled:false,chatMemoryEnabled:false,chatMemoryBackfill:false,chatMemorySummaries:false,browserEnabled:false,desktopEnabled:false,externalMcpServers:[],toolUpdates:{checkAutomatically:false,automatic:false,automaticConnections:false},optInProviders:{claude:true}});await store.save();
const pkg=JSON.parse(runtimeRoot.endsWith('.asar')?extractFile(runtimeRoot,'package.json'):await readFile(path.join(runtimeRoot,'package.json'),'utf8'));
const launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const {app,BrowserWindow,session,dialog,shell}=require('electron');const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');const path=require('node:path'),{pathToFileURL}=require('node:url'),runtimeRoot=process.env.EXOMINA_QA_RUNTIME_ROOT,moduleUrl=name=>pathToFileURL(path.join(runtimeRoot,name)).href;
app.setAppPath(runtimeRoot);app.getVersion=()=>process.env.EXOMINA_QA_APP_VERSION;BrowserWindow.prototype.show=function(){};app.commandLine.appendSwitch('mute-audio');dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};
globalThis.qaLogin={starts:0,opened:0,accepted:false,failStatus:false,signedOut:false};shell.openExternal=async()=>{globalThis.qaLogin.opened++;};
(async()=>{await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
const {ProviderManager}=await import(moduleUrl('desktop/providers.mjs'));
ProviderManager.prototype.executable=async()=>process.execPath;
ProviderManager.prototype.getCodex=async()=>({request:async method=>{if(method==='account/read'){if(globalThis.qaLogin.failStatus)throw Error('Synthetic temporary status failure');return {account:{type:'chatgpt',planType:'free'}};}return {data:[],nextCursor:null};}});
ProviderManager.prototype.capture=async()=>{if(globalThis.qaLogin.failStatus)throw Error('Synthetic temporary status failure');return {code:0,stdout:JSON.stringify({loggedIn:!globalThis.qaLogin.signedOut,authMethod:globalThis.qaLogin.signedOut?'none':'claude.ai'})};};
ProviderManager.prototype.subscriptionModels=async()=>({});ProviderManager.prototype.modelsFor=async()=>[];ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;ProviderManager.prototype.codexImageCapabilities=async()=>({available:false});
const connect=ProviderManager.prototype.connectOnce;ProviderManager.prototype.connectOnce=async function(provider){this.loginSpawnImpl=async()=>{const qa=globalThis.qaLogin;qa.starts++;const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null,signalCode:null});child.kill=()=>{child.signalCode='SIGTERM';child.emit('close',null);};let input='';child.stdin.on('data',value=>{input+=String(value);qa.accepted=input==='SYNTHETIC_CODE#SYNTHETIC_STATE\\r';if(qa.accepted)setTimeout(()=>{qa.signedOut=false;child.exitCode=0;child.emit('close',0);},50);});setTimeout(()=>child.stdout.write('https://claude.com/cai/oauth/authorize?state=synthetic\\r\\nPaste code here if prompted >'),50);return child;};return connect.call(this,provider);};
await import(moduleUrl('desktop/main.mjs'));})().catch(error=>{console.error(error);app.exit(1)});`,'utf8');
const env={...process.env,EXOMINA_QA_RUNTIME_ROOT:runtimeRoot,EXOMINA_QA_APP_VERSION:pkg.version,EXOMINA_WINDOWS_INDEPENDENT:randomUUID(),EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:accounts,EXOMINA_WORKSPACE_DIR:workspace,HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local'),TEMP:output,TMP:output,TMPDIR:output};
for(const key of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization|^(NODE_OPTIONS|BUN_OPTIONS|ELECTRON_RUN_AS_NODE|CODEX_HOME|CLAUDE_CONFIG_DIR)$/i.test(key))delete env[key];
const report={at:new Date().toISOString(),runtimeRoot,scope:'Synthetic subscription metadata and login process, actual production host and renderer, outbound HTTP blocked, no account stores or model requests.',checks:[],errors:[]};let app,page;
try{
 app=await electron.launch({args:[launcher],cwd:root,env,timeout:60000});app.process().stderr.on('data',value=>{report.processError=((report.processError||'')+value).slice(-8000);});page=await app.firstWindow({timeout:60000});page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
 await page.getByRole('button',{name:'AI connections',exact:true}).click();const claude=page.locator('[data-provider="claude"].connection-card');await claude.getByText('Connected',{exact:true}).waitFor();
 await claude.getByRole('button',{name:'Manage Claude',exact:true}).click();const banner=page.locator('.provider-auth-banner');await banner.getByLabel('Authorization code',{exact:true}).waitFor();
 assert.equal(await banner.locator('a').getAttribute('href'),'https://claude.com/cai/oauth/authorize?state=synthetic');
 const invalid=await page.evaluate(async()=>{try{await window.studio.invoke('provider.authCode',{provider:'claude',loginId:'stale',code:'SYNTHETIC_CODE'});return '';}catch(error){return error.message;}});assert.match(invalid,/no longer waiting/);report.checks.push('Current Claude domain displayed; stale login codes refused');
 await page.getByRole('button',{name:'Refresh',exact:true}).click();assert.equal(await banner.isVisible(),true);await banner.getByLabel('Authorization code',{exact:true}).fill('SYNTHETIC_CODE#SYNTHETIC_STATE');await banner.getByRole('button',{name:'Continue',exact:true}).click();await banner.waitFor({state:'hidden'});assert.equal(await app.evaluate(()=>globalThis.qaLogin.accepted),true);report.checks.push('Primary-window code form reaches only its waiting official process and closes on completion');
 await app.evaluate(()=>{globalThis.qaLogin.failStatus=true;});await page.getByRole('button',{name:'Refresh',exact:true}).click();await claude.getByText('Check unavailable',{exact:true}).waitFor();await claude.getByRole('button',{name:'Refresh Claude',exact:true}).waitFor();assert.equal(await claude.getByText('Sign in needed',{exact:true}).count(),0);assert.equal(await app.evaluate(()=>globalThis.qaLogin.starts),1);report.checks.push('Temporary metadata failure shows unknown status without reconnecting or losing last confirmed sign-in');
 await app.evaluate(()=>{globalThis.qaLogin.failStatus=false;globalThis.qaLogin.signedOut=true;});await page.getByRole('button',{name:'Refresh',exact:true}).click();await claude.getByText('Sign in needed',{exact:true}).waitFor();report.checks.push('Explicit official signed-out response still requires sign-in');
 await claude.getByRole('button',{name:'Connect Claude',exact:true}).click();await banner.getByLabel('Authorization code',{exact:true}).waitFor();await banner.getByRole('button',{name:'Cancel provider sign-in',exact:true}).click();await banner.waitFor({state:'hidden'});assert.equal(await app.evaluate(()=>globalThis.qaLogin.starts),2);report.checks.push('Cancelling the sign-in stops only the pending process');
 assert.deepEqual(report.errors,[]);report.passed=true;await page.screenshot({path:path.join(output,'verified.png')});
}catch(error){report.error=error.stack;if(page){report.ui=await page.locator('body').innerText().catch(()=>null);await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}}
finally{if(app)await app.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2),'utf8');}
console.log(JSON.stringify({passed:!!report.passed,output,checks:report.checks,error:report.error}));if(!report.passed)process.exitCode=1;
